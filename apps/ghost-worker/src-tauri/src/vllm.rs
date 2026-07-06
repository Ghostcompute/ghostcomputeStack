use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

const VLLM_PORT: u16 = 8000;
const VLLM_HEALTH_TIMEOUT: Duration = Duration::from_secs(600);
const HEALTH_POLL: Duration = Duration::from_millis(500);

pub struct VllmManager {
    app: tauri::AppHandle,
    child: Mutex<Option<Child>>,
    last_error: Mutex<Option<String>>,
    spawn_mode: Mutex<Option<String>>,
}

impl VllmManager {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self {
            app,
            child: Mutex::new(None),
            last_error: Mutex::new(None),
            spawn_mode: Mutex::new(None),
        }
    }

    fn set_error(&self, msg: Option<String>) {
        if let Ok(mut guard) = self.last_error.lock() {
            *guard = msg;
        }
    }

    pub fn start(&self) -> Result<VllmStatus, String> {
        self.set_error(None);
        {
            let mut guard = self.child.lock().map_err(|e| e.to_string())?;
            if let Some(child) = guard.as_mut() {
                if child_running(child) {
                    return self.status_internal(&mut guard);
                }
                *guard = None;
            }
        }

        if is_vllm_responding(VLLM_PORT) {
            return Ok(VllmStatus {
                running: true,
                pid: None,
                healthy: true,
                port: VLLM_PORT,
                mode: Some("external".to_string()),
                model: self.default_model(),
                error: None,
            });
        }

        let env = self.build_env()?;
        let auto_start = env
            .get("GHOST_AUTO_START_VLLM")
            .map(|v| v == "0" || v.eq_ignore_ascii_case("false"))
            .map(|disabled| !disabled)
            .unwrap_or(false);

        let worker_py = self.resolve_worker_py()?;
        let python = self.resolve_python(&worker_py)?;

        let model = env
            .get("DEFAULT_MODEL")
            .cloned()
            .unwrap_or_else(|| "llama3.2:3b".to_string());

        let (child, mode) = if auto_start && self.vllm_installed(&python, &worker_py)? {
            eprintln!("[ghost-vllm] starting vLLM with model {model}");
            (
                self.spawn_vllm(&python, &worker_py, &env, &model)?,
                "vllm".to_string(),
            )
        } else {
            eprintln!(
                "[ghost-vllm] vLLM not installed — using Ollama on :11434 (auto-installed by worker daemon)"
            );
            return Ok(VllmStatus {
                running: false,
                pid: None,
                healthy: false,
                port: VLLM_PORT,
                mode: Some("ollama".to_string()),
                model: self.default_model(),
                error: None,
            });
        };

        {
            let mut guard = self.child.lock().map_err(|e| e.to_string())?;
            *guard = Some(child);
            if let Ok(mut mode_guard) = self.spawn_mode.lock() {
                *mode_guard = Some(mode.clone());
            }
            let timeout = VLLM_HEALTH_TIMEOUT;

            let deadline = Instant::now() + timeout;
            loop {
                let status = self.status_internal(&mut guard)?;
                if status.healthy {
                    return Ok(status);
                }
                if !status.running {
                    return Ok(status);
                }
                if Instant::now() >= deadline {
                    let msg = format!(
                        "Inference server did not respond on port {VLLM_PORT} within {}s",
                        timeout.as_secs()
                    );
                    self.set_error(Some(msg.clone()));
                    return Ok(VllmStatus {
                        error: Some(msg),
                        ..status
                    });
                }
                std::thread::sleep(HEALTH_POLL);
            }
        }
    }

    pub fn stop(&self) -> Result<VllmStatus, String> {
        let mut guard = self.child.lock().map_err(|e| e.to_string())?;
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Ok(mut mode_guard) = self.spawn_mode.lock() {
            *mode_guard = None;
        }
        Ok(VllmStatus {
            running: false,
            pid: None,
            healthy: false,
            port: VLLM_PORT,
            mode: None,
            model: self.default_model(),
            error: None,
        })
    }

    pub fn status(&self) -> Result<VllmStatus, String> {
        let mut guard = self.child.lock().map_err(|e| e.to_string())?;
        self.status_internal(&mut guard)
    }

    fn status_internal(&self, guard: &mut Option<Child>) -> Result<VllmStatus, String> {
        let Some(child) = guard.as_mut() else {
            let healthy = is_vllm_responding(VLLM_PORT);
            return Ok(VllmStatus {
                running: healthy,
                pid: None,
                healthy,
                port: VLLM_PORT,
                mode: if healthy {
                    Some("external".to_string())
                } else {
                    None
                },
                model: self.default_model(),
                error: if healthy {
                    None
                } else {
                    self.last_error
                        .lock()
                        .ok()
                        .and_then(|g| g.clone())
                        .or_else(|| Some("Inference server is not running".to_string()))
                },
            });
        };

        if !child_running(child) {
            *guard = None;
            return Ok(VllmStatus {
                running: false,
                pid: None,
                healthy: false,
                port: VLLM_PORT,
                mode: None,
                model: self.default_model(),
                error: self.last_error.lock().ok().and_then(|g| g.clone()).or_else(|| {
                    Some("Inference server exited unexpectedly".to_string())
                }),
            });
        }

        let pid = child.id();
        let healthy = is_vllm_responding(VLLM_PORT);
        let mode = self
            .spawn_mode
            .lock()
            .ok()
            .and_then(|g| g.clone())
            .or(Some("managed".to_string()));
        Ok(VllmStatus {
            running: true,
            pid: Some(pid),
            healthy,
            port: VLLM_PORT,
            mode,
            model: self.default_model(),
            error: if healthy {
                None
            } else {
                Some("Inference process running but /health is unreachable".to_string())
            },
        })
    }

    fn default_model(&self) -> String {
        self.build_env()
            .ok()
            .and_then(|env| env.get("DEFAULT_MODEL").cloned())
            .unwrap_or_else(|| "llama3.2:3b".to_string())
    }

    fn build_env(&self) -> Result<HashMap<String, String>, String> {
        let mut env = HashMap::new();
        let app = app_dir();
        env.extend(load_env_file(&app.join(".env")));
        if let Ok(root) = monorepo_root() {
            env.extend(load_env_file(&root.join(".env")));
        }
        env.entry("DEFAULT_MODEL".to_string())
            .or_insert_with(|| "llama3.2:3b".to_string());
        env.entry("VLLM_URL".to_string())
            .or_insert_with(|| format!("http://127.0.0.1:{VLLM_PORT}"));
        Ok(env)
    }

    fn resolve_worker_py(&self) -> Result<PathBuf, String> {
        if let Ok(res) = self.app.path().resource_dir() {
            let bundled = res.join("worker-python");
            if bundled.join("daemon.py").is_file() {
                return Ok(bundled);
            }
        }
        let local = app_dir().join("worker-python");
        if local.join("daemon.py").is_file() {
            return Ok(local);
        }
        Err("worker-python runtime not found. Run: pnpm ghost-worker:prepare".to_string())
    }

    fn resolve_python(&self, worker_py: &Path) -> Result<PathBuf, String> {
        let venv_py = if cfg!(windows) {
            worker_py.join(".venv/Scripts/python.exe")
        } else {
            worker_py.join(".venv/bin/python3")
        };
        if venv_py.is_file() {
            return Ok(venv_py);
        }
        find_system_python().ok_or_else(|| {
            "Python not found. Run: pnpm ghost-worker:prepare".to_string()
        })
    }

    fn vllm_installed(&self, python: &Path, worker_py: &Path) -> Result<bool, String> {
        let mut cmd = Command::new(python);
        cmd.arg("-c")
            .arg("import vllm")
            .current_dir(worker_py)
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        Ok(cmd.status().map(|s| s.success()).unwrap_or(false))
    }

    fn spawn_vllm(
        &self,
        python: &Path,
        worker_py: &Path,
        env: &HashMap<String, String>,
        model: &str,
    ) -> Result<Child, String> {
        let mut cmd = Command::new(python);
        cmd.args([
            "-m",
            "vllm.entrypoints.openai.api_server",
            "--model",
            model,
            "--host",
            "127.0.0.1",
            "--port",
            &VLLM_PORT.to_string(),
            "--served-model-name",
            model,
        ])
        .current_dir(worker_py)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

        for (k, v) in env {
            cmd.env(k, v);
        }
        spawn_with_logs(cmd, "ghost-vllm", self)
    }
}

fn spawn_with_logs(
    mut cmd: Command,
    prefix: &str,
    manager: &VllmManager,
) -> Result<Child, String> {
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn inference server: {e}"))?;

    let log_prefix = prefix.to_string();
    if let Some(stderr) = child.stderr.take() {
        let stderr_prefix = log_prefix.clone();
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                eprintln!("[{stderr_prefix}] {line}");
            }
        });
    }
    if let Some(stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            use std::io::{BufRead, BufReader};
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                eprintln!("[{log_prefix}] {line}");
            }
        });
    }

    std::thread::sleep(Duration::from_millis(400));
    if let Ok(Some(status)) = child.try_wait() {
        let msg = format!("Inference server exited immediately (code {status})");
        manager.set_error(Some(msg.clone()));
        return Err(msg);
    }
    Ok(child)
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VllmStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub healthy: bool,
    pub port: u16,
    pub mode: Option<String>,
    pub model: String,
    pub error: Option<String>,
}

fn app_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has parent")
        .to_path_buf()
}

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

fn is_vllm_responding(port: u16) -> bool {
    let url = format!("http://127.0.0.1:{port}/health");
    ureq::get(&url)
        .call()
        .map(|resp| resp.status() == 200)
        .unwrap_or(false)
}

fn child_running(child: &mut Child) -> bool {
    match child.try_wait() {
        Ok(None) => true,
        Ok(Some(_)) => false,
        Err(_) => false,
    }
}

fn find_system_python() -> Option<PathBuf> {
    let candidates: Vec<(&str, Vec<&str>)> = if cfg!(windows) {
        vec![("python", vec![]), ("py", vec!["-3"]), ("python3", vec![])]
    } else {
        vec![("python3", vec![]), ("python", vec![])]
    };

    for (cmd, args) in candidates {
        let mut command = Command::new(cmd);
        for arg in &args {
            command.arg(*arg);
        }
        if command
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
        {
            return Some(PathBuf::from(cmd));
        }
    }
    None
}
