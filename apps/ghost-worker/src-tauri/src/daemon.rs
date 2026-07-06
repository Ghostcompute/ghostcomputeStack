use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

const DAEMON_PORT: u16 = 7421;
const HEALTH_TIMEOUT: Duration = Duration::from_secs(45);
const HEALTH_POLL: Duration = Duration::from_millis(400);

pub struct DaemonManager {
    app: tauri::AppHandle,
    child: Mutex<Option<Child>>,
    last_error: Mutex<Option<String>>,
}

impl DaemonManager {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self {
            app,
            child: Mutex::new(None),
            last_error: Mutex::new(None),
        }
    }

    fn set_error(&self, msg: Option<String>) {
        if let Ok(mut guard) = self.last_error.lock() {
            *guard = msg;
        }
    }

    pub fn start(&self) -> Result<DaemonStatus, String> {
        self.set_error(None);
        {
            let mut guard = self.child.lock().map_err(|e| e.to_string())?;
            if let Some(child) = guard.as_mut() {
                if child_running(child) {
                    return self.status_internal(&mut guard, "managed");
                }
                *guard = None;
            }
        }

        if is_daemon_responding(DAEMON_PORT) {
            if is_foreign_daemon(DAEMON_PORT) {
                return Err(format!(
                    "Port {DAEMON_PORT} is in use by a non-local worker daemon (often WSL or a remote port forward). \
                     Close that process and restart Ghost Worker to detect this machine's GPU."
                ));
            }
            return Ok(DaemonStatus {
                running: true,
                pid: None,
                healthy: true,
                port: DAEMON_PORT,
                mode: Some("external".to_string()),
                error: None,
            });
        }

        let env = self.build_env()?;
        // Dev builds: live venv Python picks up worker-python deps (e.g. huggingface_hub).
        let (child, mode) = if cfg!(debug_assertions) {
            self.spawn_python(&env)
                .map(|c| (c, "python"))
                .or_else(|e| {
                    eprintln!("[ghost-worker] python runtime unavailable: {e}");
                    self.spawn_bundled(&env).map(|c| (c, "bundled"))
                })?
        } else {
            self.spawn_bundled(&env)
                .map(|c| (c, "bundled"))
                .or_else(|e| {
                    eprintln!("[ghost-worker] bundled runtime unavailable: {e}");
                    self.spawn_python(&env).map(|c| (c, "python"))
                })?
        };

        {
            let mut guard = self.child.lock().map_err(|e| e.to_string())?;
            *guard = Some(child);
            let mode_str = mode.to_string();

            let deadline = Instant::now() + HEALTH_TIMEOUT;
            loop {
                let status = self.status_internal(&mut guard, &mode_str)?;
                if status.healthy {
                    return Ok(status);
                }
                if !status.running {
                    return Ok(status);
                }
                if Instant::now() >= deadline {
                    self.set_error(Some(format!(
                        "Daemon did not respond on port {} within {}s",
                        DAEMON_PORT,
                        HEALTH_TIMEOUT.as_secs()
                    )));
                    return Ok(DaemonStatus {
                        error: self.last_error.lock().ok().and_then(|g| g.clone()),
                        ..status
                    });
                }
                std::thread::sleep(HEALTH_POLL);
            }
        }
    }

    pub fn stop(&self) -> Result<DaemonStatus, String> {
        let mut guard = self.child.lock().map_err(|e| e.to_string())?;
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        Ok(DaemonStatus {
            running: false,
            pid: None,
            healthy: false,
            port: DAEMON_PORT,
            mode: None,
            error: None,
        })
    }

    pub fn status(&self) -> Result<DaemonStatus, String> {
        let mut guard = self.child.lock().map_err(|e| e.to_string())?;
        self.status_internal(&mut guard, "managed")
    }

    fn status_internal(
        &self,
        guard: &mut Option<Child>,
        mode: &str,
    ) -> Result<DaemonStatus, String> {
        let Some(child) = guard.as_mut() else {
            let healthy = is_daemon_responding(DAEMON_PORT);
            return Ok(DaemonStatus {
                running: healthy,
                pid: None,
                healthy,
                port: DAEMON_PORT,
                mode: if healthy {
                    Some("external".to_string())
                } else {
                    None
                },
                error: if healthy {
                    None
                } else {
                    self.last_error
                        .lock()
                        .ok()
                        .and_then(|g| g.clone())
                        .or_else(|| Some("Worker daemon is not running".to_string()))
                },
            });
        };

        if !child_running(child) {
            *guard = None;
            return Ok(DaemonStatus {
                running: false,
                pid: None,
                healthy: false,
                port: DAEMON_PORT,
                mode: None,
                error: self.last_error.lock().ok().and_then(|g| g.clone()).or_else(|| {
                    Some("Daemon process exited unexpectedly".to_string())
                }),
            });
        }

        let pid = child.id();
        let healthy = is_daemon_responding(DAEMON_PORT);
        Ok(DaemonStatus {
            running: true,
            pid: Some(pid),
            healthy,
            port: DAEMON_PORT,
            mode: Some(mode.to_string()),
            error: if healthy {
                None
            } else {
                Some("Daemon process running but /status is unreachable".to_string())
            },
        })
    }

    fn bundled_executable(&self) -> Option<PathBuf> {
        let names = if cfg!(windows) {
            vec!["ghost-daemon.exe", "ghost-daemon"]
        } else {
            vec!["ghost-daemon", "ghost-daemon.exe"]
        };

        if let Ok(res) = self.app.path().resource_dir() {
            let dir = res.join("worker-python");
            for name in &names {
                let path = dir.join(name);
                if path.is_file() {
                    return Some(path);
                }
            }
        }

        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                for name in &names {
                    let path = dir.join(name);
                    if path.is_file() {
                        return Some(path);
                    }
                }
            }
        }

        None
    }

    fn spawn_bundled(&self, env: &HashMap<String, String>) -> Result<Child, String> {
        let exe = self
            .bundled_executable()
            .ok_or_else(|| "Bundled ghost-daemon binary not found in app resources".to_string())?;

        let mut cmd = Command::new(&exe);
        cmd.args(["--port", &DAEMON_PORT.to_string()])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        if let Some(dir) = exe.parent() {
            cmd.current_dir(dir);
        }

        for (k, v) in env {
            cmd.env(k, v);
        }

        spawn_with_stderr_log(cmd, self)
    }

    fn spawn_python(&self, env: &HashMap<String, String>) -> Result<Child, String> {
        let (script, workdir) = self.resolve_script()?;

        let mut cmd = if let Some(venv_py) = worker_venv_python(&workdir) {
            Command::new(venv_py)
        } else {
            let (python, extra_args) = find_python_executable().ok_or_else(|| {
                "No Python runtime available. Install Ghost Worker from a release build that includes the bundled worker.".to_string()
            })?;
            let mut c = Command::new(&python);
            for arg in &extra_args {
                c.arg(arg);
            }
            c
        };

        cmd.arg(&script)
            .arg("--port")
            .arg(DAEMON_PORT.to_string())
            .current_dir(&workdir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        for (k, v) in env {
            cmd.env(k, v);
        }

        spawn_with_stderr_log(cmd, self)
    }

    fn resolve_script(&self) -> Result<(PathBuf, PathBuf), String> {
        if let Ok(res) = self.app.path().resource_dir() {
            let bundled = res.join("worker-python");
            let script = bundled.join("daemon.py");
            if script.is_file() {
                return Ok((script, bundled));
            }
        }

        let app = app_dir();
        let local = app.join("worker-python");
        let local_script = local.join("daemon.py");
        if local_script.is_file() {
            return Ok((local_script, local));
        }

        let monorepo = app.join("../../worker/python");
        let mono_script = monorepo.join("daemon.py");
        if mono_script.is_file() {
            return Ok((mono_script, monorepo));
        }

        Err("Worker daemon not found. Run: npm run prepare:daemon".to_string())
    }

    fn build_env(&self) -> Result<HashMap<String, String>, String> {
        let mut env = HashMap::new();

        let app = app_dir();
        env.extend(load_env_file(&app.join(".env")));

        if let Ok(root) = monorepo_root() {
            env.extend(load_env_file(&root.join(".env")));
        }

        let defaults = [
            ("VLLM_URL", "http://localhost:8000"),
            ("TEE_TYPE", "none"),
            ("COMPUTE_DEVICE", "auto"),
            ("GPU_INDEX", "0"),
        ];
        for (key, default) in defaults {
            env.entry(key.to_string())
                .or_insert_with(|| default.to_string());
        }
        env.insert(
            "GHOST_ORCHESTRATOR_URL".to_string(),
            "https://api.ghostcompute.tech".to_string(),
        );
        Ok(env)
    }
}

fn spawn_with_stderr_log(mut cmd: Command, manager: &DaemonManager) -> Result<Child, String> {
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn worker daemon: {e}"))?;

    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                eprintln!("[ghost-daemon] {line}");
            }
        });
    }

    std::thread::sleep(Duration::from_millis(400));
    if let Ok(Some(status)) = child.try_wait() {
        let msg = format!("Worker daemon exited immediately (code {status})");
        manager.set_error(Some(msg.clone()));
        return Err(msg);
    }

    Ok(child)
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DaemonStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub healthy: bool,
    pub port: u16,
    pub mode: Option<String>,
    pub error: Option<String>,
}

fn app_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has parent")
        .to_path_buf()
}

/** Monorepo root when ghost-worker lives at apps/ghost-worker — optional. */
fn monorepo_root() -> Result<PathBuf, String> {
    let root = app_dir()
        .parent()
        .and_then(|p| p.parent())
        .map(Path::to_path_buf);
    root.filter(|r| r.join("worker/python/daemon.py").is_file())
        .ok_or_else(|| "not in monorepo".to_string())
}

fn load_env_file(path: &Path) -> HashMap<String, String> {
    let mut vars = HashMap::new();
    let Ok(content) = fs::read_to_string(path) else {
        return vars;
    };
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim().to_string();
        let mut value = value.trim().to_string();
        if let Some(hash) = value.find('#') {
            value = value[..hash].trim().to_string();
        }
        if (value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\''))
        {
            value = value[1..value.len() - 1].to_string();
        }
        if !key.is_empty() {
            vars.insert(key, value);
        }
    }
    vars
}

fn is_daemon_responding(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{port}/status");
    ureq::get(&url)
        .call()
        .map(|resp| resp.status() == 200)
        .unwrap_or(false)
}

/// Detect daemons forwarded from Linux/WSL that report amdgpu/pyamdgpuinfo instead of local GPU.
fn is_foreign_daemon(port: u16) -> bool {
    if !cfg!(windows) {
        return false;
    }

    let url = format!("http://127.0.0.1:{port}/status");
    let Ok(resp) = ureq::get(&url).call() else {
        return false;
    };
    let Ok(body) = resp.into_string() else {
        return false;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) else {
        return false;
    };

    let Some(gpu) = json.get("gpu") else {
        return false;
    };

    if gpu
        .get("source")
        .and_then(|v| v.as_str())
        .is_some_and(|s| s == "pyamdgpuinfo")
    {
        return true;
    }

    if gpu
        .get("driver")
        .and_then(|v| v.as_str())
        .is_some_and(|s| s == "amdgpu")
    {
        return true;
    }

    gpu.get("pci_slot")
        .and_then(|v| v.as_str())
        .is_some_and(|pci| pci.starts_with("0000:"))
}

fn child_running(child: &mut Child) -> bool {
    match child.try_wait() {
        Ok(None) => true,
        Ok(Some(_)) => false,
        Err(_) => false,
    }
}

fn worker_venv_python(worker_py: &Path) -> Option<PathBuf> {
    let venv_py = if cfg!(windows) {
        worker_py.join(".venv/Scripts/python.exe")
    } else {
        worker_py.join(".venv/bin/python3")
    };
    venv_py.is_file().then_some(venv_py)
}

fn find_python_executable() -> Option<(String, Vec<String>)> {
    let candidates: Vec<(String, Vec<String>)> = if cfg!(windows) {
        vec![
            ("python".into(), vec![]),
            ("python3".into(), vec![]),
            ("py".into(), vec!["-3".into()]),
        ]
    } else {
        vec![("python3".into(), vec![]), ("python".into(), vec![])]
    };

    for (cmd, args) in candidates {
        if command_exists(&cmd, &args) {
            return Some((cmd, args));
        }
    }
    None
}

fn command_exists(cmd: &str, args: &[String]) -> bool {
    let mut command = Command::new(cmd);
    for arg in args {
        command.arg(arg);
    }
    command
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}
