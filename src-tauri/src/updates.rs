#[tauri::command]
pub fn open_dekxdis_repository() -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer.exe")
            .arg("https://github.com/DEKXDIS/DEKXDIS")
            .creation_flags(0x08000000).spawn()
            .map_err(|error| format!("Unable to open GitHub: {error}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    { Err("Opening GitHub requires the Windows desktop app".into()) }
}
#[tauri::command]
pub fn open_dekxdis_guide() -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer.exe")
            .arg("https://dekxdis.com/user-guide.html")
            .creation_flags(0x08000000).spawn()
            .map_err(|error| format!("Unable to open user guide: {error}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    { Err("Opening the user guide requires the Windows desktop app".into()) }
}
