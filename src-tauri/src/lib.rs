mod vault;
mod startup;
mod modules;
mod explorer;
mod updates;
mod features;
pub use startup::run_watchdog_if_requested;

pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_single_instance::init(|app, _, _| {
      use tauri::Manager;
      if let Some(window) = app.get_webview_window("main") { let _ = window.set_focus(); }
    }))
    .setup(|app| {
      use tauri::{Emitter, Manager};
      vault::setup(app)?;
      modules::setup(app)?;
      startup::start_watchdog().map_err(|e| Box::<dyn std::error::Error>::from(e))?;
      if let Some(window) = app.get_webview_window("main") {
        let handle = app.handle().clone();
        window.on_window_event(move |event| if let tauri::WindowEvent::CloseRequested { api, .. } = event {
          api.prevent_close();
          let _ = handle.emit("dekxdis-close-requested", ());
        });
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![features::beta_status, features::beta_validate_key, features::beta_accept, vault::vault_open, vault::vault_save, vault::wallet_replace, vault::wallet_list, vault::wallet_switch, vault::wallet_sign, vault::wallet_export, vault::wallet_confirm_backup, startup::startup_state, startup::set_startup_enabled, startup::confirm_app_exit,
      modules::modules_list, modules::modules_scan_inbox, modules::modules_install, modules::modules_install_path, modules::modules_select, modules::modules_remove_begin, modules::modules_remove_finish,
      modules::modules_secret_status, modules::modules_secret_set, modules::modules_secret_delete, modules::modules_scope_register, modules::modules_scope_invalidate, modules::modules_scope_check,
      modules::modules_invoke, modules::modules_blob_put, modules::modules_blob_preview, modules::modules_http, explorer::open_explorer_url, updates::open_dekxdis_repository, updates::open_dekxdis_guide])
    .plugin(tauri_plugin_log::Builder::new().build())
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}



