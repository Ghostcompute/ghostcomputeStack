mod daemon;
mod vllm;

use daemon::{DaemonManager, DaemonStatus};
use tauri::Manager;
use vllm::{VllmManager, VllmStatus};

#[tauri::command]
fn daemon_start(state: tauri::State<'_, DaemonManager>) -> Result<DaemonStatus, String> {
    state.start()
}

#[tauri::command]
fn daemon_stop(state: tauri::State<'_, DaemonManager>) -> Result<DaemonStatus, String> {
    state.stop()
}

#[tauri::command]
fn daemon_status(state: tauri::State<'_, DaemonManager>) -> Result<DaemonStatus, String> {
    state.status()
}

#[tauri::command]
fn vllm_start(state: tauri::State<'_, VllmManager>) -> Result<VllmStatus, String> {
    state.start()
}

#[tauri::command]
fn vllm_stop(state: tauri::State<'_, VllmManager>) -> Result<VllmStatus, String> {
    state.stop()
}

#[tauri::command]
fn vllm_status(state: tauri::State<'_, VllmManager>) -> Result<VllmStatus, String> {
    state.status()
}

#[tauri::command]
fn vllm_restart(state: tauri::State<'_, VllmManager>) -> Result<VllmStatus, String> {
    state.stop()?;
    state.start()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {    tauri::Builder::default()
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_theme(Some(tauri::Theme::Dark));
                let _ = window.set_min_size(Some(tauri::Size::Logical(tauri::LogicalSize {
                    width: 1080.0,
                    height: 720.0,
                })));
                let _ = window.set_max_size(Some(tauri::Size::Logical(tauri::LogicalSize {
                    width: 1280.0,
                    height: 860.0,
                })));
                let _ = window.set_maximizable(false);
            }

            let handle = app.handle().clone();
            let vllm_manager = VllmManager::new(handle.clone());
            let daemon_manager = DaemonManager::new(handle.clone());
            app.manage(vllm_manager);
            app.manage(daemon_manager);

            let h = handle.clone();
            std::thread::spawn(move || {
                if let Some(vllm) = h.try_state::<VllmManager>() {
                    match vllm.start() {
                        Ok(status) => eprintln!(
                            "[ghost-worker] inference {} on :{} ({})",
                            if status.healthy { "ready" } else { "starting/failed" },
                            status.port,
                            status.mode.as_deref().unwrap_or("unknown")
                        ),
                        Err(err) => eprintln!("[ghost-worker] inference start failed: {err}"),
                    }
                }
                if let Some(daemon) = h.try_state::<DaemonManager>() {
                    let _ = daemon.start();
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            daemon_start,
            daemon_stop,
            daemon_status,
            vllm_start,
            vllm_stop,
            vllm_status,
            vllm_restart,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(vllm) = app.try_state::<VllmManager>() {
                    let _ = vllm.stop();
                }
                if let Some(daemon) = app.try_state::<DaemonManager>() {
                    let _ = daemon.stop();
                }
            }
        });
}
