use std::{fs, path::Path, sync::{atomic::{AtomicBool, Ordering}, Mutex}, time::{SystemTime, UNIX_EPOCH}};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Manager;

const BETA_KEY: &str = "HAVEN-12B0832EC3999268";
const TERMS: &str = include_str!("../../src/config/betaTerms.json");
static BETA_ENABLED: AtomicBool = AtomicBool::new(false);
static ACTIVATION: Mutex<()> = Mutex::new(());
#[derive(Deserialize, Serialize)]
struct Acceptance { terms_version: String, terms_hash: String, accepted_at: u64, app_version: String }
fn terms_version() -> String { serde_json::from_str::<serde_json::Value>(TERMS).expect("Invalid beta terms")["version"].as_str().expect("Missing terms version").into() }
fn terms_hash() -> String { format!("{:x}", Sha256::digest(TERMS.as_bytes())) }
fn compiled_enabled() -> bool {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Features { strategies: bool }
    serde_json::from_str::<Features>(include_str!("../../src/config/releaseFeatures.json")).expect("Invalid release features").strategies
}
pub fn strategies_enabled() -> bool { compiled_enabled() || BETA_ENABLED.load(Ordering::Acquire) }
pub fn require_strategies_enabled() -> Result<(), String> {
    if strategies_enabled() { Ok(()) } else { Err("Strategies are locked. Beta access requires a valid key and acceptance in Settings.".into()) }
}
fn valid_key(key: &str) -> bool { key.trim() == BETA_KEY }
fn read_acceptance(path: &Path) -> Result<bool, String> {
    let bytes = match fs::read(path) { Ok(bytes) => bytes, Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false), Err(e) => return Err(format!("Could not read beta acceptance: {e}")) };
    let saved: Acceptance = serde_json::from_slice(&bytes).map_err(|_| "Saved beta acceptance is invalid. Enter the beta key and accept the terms again.".to_string())?;
    Ok(saved.terms_version == terms_version() && saved.terms_hash == terms_hash() && saved.accepted_at > 0)
}
fn write_acceptance(path: &Path, key: &str, agreed: bool, version: &str, app_version: &str) -> Result<(), String> {
    if !valid_key(key) { return Err("Invalid beta key.".into()); }
    if !agreed || version != terms_version() { return Err("You must accept the current beta testing agreement.".into()); }
    let saved = Acceptance { terms_version: version.into(), terms_hash: terms_hash(), accepted_at: SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_secs(), app_version: app_version.into() };
    let bytes = serde_json::to_vec_pretty(&saved).map_err(|e| e.to_string())?;
    fs::write(path, bytes).map_err(|e| format!("Could not save beta acceptance: {e}"))?;
    if !read_acceptance(path)? { return Err("Beta acceptance could not be verified.".into()); }
    Ok(())
}
#[tauri::command]
pub fn beta_validate_key(key: String) -> Result<(), String> {
    if valid_key(&key) { Ok(()) } else { Err("Invalid beta key.".into()) }
}
#[tauri::command]
pub fn beta_status(app: tauri::AppHandle) -> Result<bool, String> {
    let _guard = ACTIVATION.lock().map_err(|_| "Beta access lock failed")?;
    if !strategies_enabled() {
        let accepted = read_acceptance(&app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("beta-acceptance.json"))?;
        if accepted {
            crate::modules::start_services(&app)?;
            BETA_ENABLED.store(true, Ordering::Release);
        }
    }
    Ok(strategies_enabled())
}
#[tauri::command]
pub fn beta_accept(app: tauri::AppHandle, key: String, agreed: bool, terms_version: String) -> Result<bool, String> {
    let _guard = ACTIVATION.lock().map_err(|_| "Beta access lock failed")?;
    let folder = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&folder).map_err(|e| format!("Could not create beta settings folder: {e}"))?;
    write_acceptance(&folder.join("beta-acceptance.json"), &key, agreed, &terms_version, &app.package_info().version.to_string())?;
    crate::modules::start_services(&app)?;
    BETA_ENABLED.store(true, Ordering::Release);
    Ok(true)
}

