use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, process::Command, sync::atomic::{AtomicBool, Ordering}};

static WATCHDOG_STARTED: AtomicBool = AtomicBool::new(false);

#[derive(Default, Serialize, Deserialize)]
pub struct StartupState { pub enabled: bool }

fn directory() -> Result<PathBuf, String> {
    let base = std::env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA is unavailable")?;
    let path = PathBuf::from(base).join("com.antigravity.haven-defi-terminal");
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    Ok(path)
}
fn config_path() -> Result<PathBuf, String> { Ok(directory()?.join("startup.json")) }
fn clean_path() -> Result<PathBuf, String> { Ok(directory()?.join("clean-exit")) }
fn read_state() -> StartupState { config_path().ok().and_then(|p| fs::read(p).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default() }
fn write_state(state: &StartupState) -> Result<(), String> { fs::write(config_path()?, serde_json::to_vec(state).map_err(|e| e.to_string())?).map_err(|e| e.to_string()) }

#[cfg(windows)]
fn set_windows_run(enabled: bool) -> Result<(), String> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    let key = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags("Software\\Microsoft\\Windows\\CurrentVersion\\Run", winreg::enums::KEY_SET_VALUE).map_err(|e| e.to_string())?;
    if enabled {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        key.set_value("HavenDeFiTerminal", &format!("\"{}\"", exe.display())).map_err(|e| e.to_string())
    } else {
        match key.delete_value("HavenDeFiTerminal") { Ok(()) => Ok(()), Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()), Err(e) => Err(e.to_string()) }
    }
}
#[cfg(not(windows))]
fn set_windows_run(_: bool) -> Result<(), String> { Err("Startup control is currently available only on Windows".into()) }

pub fn start_watchdog() -> Result<(), String> {
    
    if !read_state().enabled || WATCHDOG_STARTED.swap(true, Ordering::SeqCst) { return Ok(()); }
    let _ = fs::remove_file(clean_path()?);
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    Command::new(exe).args(["--dekxdis-watchdog", &std::process::id().to_string()]).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn run_watchdog_if_requested() -> bool {
    let args: Vec<String> = std::env::args().collect();
    
    let Some(index) = args.iter().position(|a| a == "--dekxdis-watchdog") else { return false };
    let Some(pid) = args.get(index + 1).and_then(|s| s.parse::<u32>().ok()) else { return true };
    #[cfg(windows)] unsafe {
        use windows_sys::Win32::{Foundation::{CloseHandle, WAIT_OBJECT_0}, System::Threading::{OpenProcess, WaitForSingleObject}};
        const PROCESS_SYNCHRONIZE: u32 = 0x0010_0000;
        let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
        if !handle.is_null() { let _ = WaitForSingleObject(handle, u32::MAX); CloseHandle(handle); }
        if read_state().enabled && !clean_path().map(|p| p.exists()).unwrap_or(true) {
            if let Ok(exe) = std::env::current_exe() { let _ = Command::new(exe).spawn(); }
        }
        let _ = WAIT_OBJECT_0;
    }
    true
}

#[tauri::command]
pub fn startup_state() -> StartupState { { read_state() } }

#[tauri::command]
pub fn set_startup_enabled(enabled: bool) -> Result<StartupState, String> {
    
    set_windows_run(enabled)?;
    let state = StartupState { enabled };
    write_state(&state)?;
    if enabled { start_watchdog()?; }
    Ok(state)
}

#[tauri::command]
pub fn confirm_app_exit(app: tauri::AppHandle) -> Result<(), String> {
    
    fs::write(clean_path()?, b"intentional").map_err(|e| e.to_string())?;
    app.exit(0);
    Ok(())
}
