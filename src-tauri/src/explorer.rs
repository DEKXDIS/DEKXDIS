fn explorer_url(raw: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw).map_err(|_| "Invalid explorer URL")?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some()
        || url.port_or_known_default() != Some(443)
        || !matches!(url.host_str(), Some("explorer.cow.fi" | "bscscan.com" | "etherscan.io" | "arbiscan.io" | "basescan.org" | "gnosisscan.io"))
    { return Err("Unsupported explorer URL".into()); }
    Ok(url)
}

#[tauri::command]
pub fn open_explorer_url(url: String) -> Result<(), String> {
    let url = explorer_url(&url)?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer.exe")
            .arg(url.as_str()).creation_flags(0x08000000).spawn()
            .map_err(|error| format!("Unable to open browser: {error}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    { let _ = url; Err("Explorer opening requires the Windows desktop app".into()) }
}


