use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, path::Path, sync::{Arc, LazyLock, Mutex}};
use tauri::Manager;
use zeroize::{Zeroize, Zeroizing};

static STORE_LOCK: Mutex<()> = Mutex::new(());
static SESSIONS: LazyLock<Mutex<BTreeMap<String, Arc<ResolvedProfile>>>> = LazyLock::new(|| Mutex::new(BTreeMap::new()));
const STORE_FILE: &str = "automation-llm-profiles.dpapi";
const STORE_ERROR: &str = "Unable to read the saved LLM configurations. Existing data has been preserved.";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum ApiFormat { Responses, ChatCompletions, Anthropic, Gemini }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AuthMode { Bearer, Header, None }

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileConfig {
    pub name: String,
    pub format: ApiFormat,
    pub base_url: String,
    pub endpoint: String,
    pub model: String,
    pub auth_mode: AuthMode,
    pub auth_header: String,
    pub auth_prefix: String,
    pub max_output_tokens: Option<u32>,
    pub timeout_seconds: u64,
    pub temperature: Option<f64>,
    pub reasoning_effort: String,
    pub thinking_budget: Option<u32>,
    pub api_version: String,
    pub max_token_parameter: String,
    pub extra_body: Value,
}
impl ProfileConfig {
    pub fn legacy(model: &str) -> Self {
        Self { name: format!("OpenAI · {model}"), format: ApiFormat::Responses,
            base_url: "https://api.openai.com".into(), endpoint: "/v1/responses".into(), model: model.into(),
            auth_mode: AuthMode::Bearer, auth_header: String::new(), auth_prefix: String::new(),
            max_output_tokens: None, timeout_seconds: 120, temperature: None, reasoning_effort: String::new(),
            thinking_budget: None, api_version: String::new(), max_token_parameter: "max_tokens".into(), extra_body: json!({}) }
    }
    pub fn auth_name(&self) -> &str { if self.auth_mode == AuthMode::Bearer { "authorization" } else { &self.auth_header } }
    pub fn scope(&self) -> Result<String, String> {
        let url = super::providers::endpoint(self)?;
        Ok(format!("{}|{:?}|{}|{}", url.origin().ascii_serialization(), self.auth_mode,
            self.auth_name().to_lowercase(), if self.auth_mode == AuthMode::Bearer { "Bearer " } else { &self.auth_prefix }))
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct Credential { label: String, scope: String, key: String }
impl Drop for Credential { fn drop(&mut self) { self.key.zeroize(); } }
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedProfile { config: ProfileConfig, credential_id: Option<String>, headers: BTreeMap<String, String>, revision: u64 }
impl Drop for SavedProfile { fn drop(&mut self) { self.headers.values_mut().for_each(Zeroize::zeroize); } }
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileStore {
    version: u32, profiles: BTreeMap<String, SavedProfile>, credentials: BTreeMap<String, Credential>,
    default_profile_id: Option<String>, legacy_models: BTreeMap<String, String>,
}
impl Default for ProfileStore {
    fn default() -> Self { Self { version: 1, profiles: BTreeMap::new(), credentials: BTreeMap::new(), default_profile_id: None, legacy_models: BTreeMap::new() } }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInput {
    pub id: Option<String>, pub expected_revision: Option<u64>, pub config: ProfileConfig,
    #[serde(default)] pub save_as_new: bool,
    pub credential_id: Option<String>, pub new_key: Option<String>,
    // None preserves saved values. Some({}) explicitly clears them.
    pub headers: Option<BTreeMap<String, String>>, pub make_default: bool,
}
impl Drop for ProfileInput {
    fn drop(&mut self) { if let Some(key) = self.new_key.as_mut() { key.zeroize(); }
        if let Some(headers) = self.headers.as_mut() { headers.values_mut().for_each(Zeroize::zeroize); } }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileView { id: String, config: ProfileConfig, credential_id: Option<String>, header_names: Vec<String>, revision: u64, ready: bool }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialView { id: String, label: String, scope: String }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileList {
    profiles: Vec<ProfileView>, credentials: Vec<CredentialView>, default_profile_id: Option<String>, legacy_models: BTreeMap<String, String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult { pub id: String, pub list: ProfileList }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionView { profile_id: String, name: String, model: String }
pub struct ResolvedProfile { pub profile_id: String, pub config: ProfileConfig, pub key: Zeroizing<String>, pub headers: BTreeMap<String, String> }
impl Drop for ResolvedProfile { fn drop(&mut self) { self.headers.values_mut().for_each(Zeroize::zeroize); } }

fn new_id() -> String { format!("llm-{:032x}", rand::random::<u128>()) }
fn read(directory: &Path) -> Result<ProfileStore, String> {
    let bytes = match fs::read(directory.join(STORE_FILE)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(ProfileStore::default()),
        Err(_) => return Err(STORE_ERROR.into()),
    };
    let plain = Zeroizing::new(crate::vault::crypt(&bytes, false).map_err(|_| STORE_ERROR)?);
    let store: ProfileStore = serde_json::from_slice(&plain).map_err(|_| STORE_ERROR)?;
    if store.version != 1 { return Err("This version of the app cannot read the saved LLM configurations".into()); }
    Ok(store)
}
fn write(directory: &Path, store: &ProfileStore) -> Result<(), String> {
    let plain = Zeroizing::new(serde_json::to_vec(store).map_err(|_| "Unable to save LLM configurations")?);
    crate::vault::write_plain(&directory.join(STORE_FILE), &plain)
}
fn view(store: &ProfileStore) -> ProfileList {
    ProfileList { profiles: store.profiles.iter().map(|(id, p)| ProfileView {
        id: id.clone(), config: p.config.clone(), credential_id: p.credential_id.clone(),
        header_names: p.headers.keys().cloned().collect(), revision: p.revision,
        ready: p.config.auth_mode == AuthMode::None || p.credential_id.as_ref().is_some_and(|id| store.credentials.contains_key(id)),
    }).collect(), credentials: store.credentials.iter().map(|(id, c)| CredentialView { id: id.clone(), label: c.label.clone(), scope: c.scope.clone() }).collect(),
        default_profile_id: store.default_profile_id.clone(), legacy_models: store.legacy_models.clone() }
}
fn migrate(store: &mut ProfileStore, models: &[String], legacy_key: Option<&str>) -> Result<bool, String> {
    let mut changed = false;
    for model in models {
        if model.trim().is_empty() || model.len() > 200 || store.legacy_models.contains_key(model) { continue; }
        let config = ProfileConfig::legacy(model);
        let credential_id = if let Some(key) = legacy_key {
            let id = "legacy-openai-key".to_string();
            store.credentials.entry(id.clone()).or_insert(Credential { label: "Existing OpenAI key".into(), scope: config.scope()?, key: key.into() }); Some(id)
        } else { None };
        let id = new_id();
        store.profiles.insert(id.clone(), SavedProfile { config, credential_id, headers: BTreeMap::new(), revision: 1 });
        store.legacy_models.insert(model.clone(), id.clone());
        if store.default_profile_id.is_none() { store.default_profile_id = Some(id); }
        changed = true;
    }
    Ok(changed)
}

#[tauri::command]
pub fn automation_profiles_list(app: tauri::AppHandle, mut legacy_models: Vec<String>) -> Result<ProfileList, String> {
    crate::features::require_strategies_enabled()?;
    let directory = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let _guard = STORE_LOCK.lock().map_err(|_| STORE_ERROR)?;
    let mut store = read(&directory)?;
    if legacy_models.len() > 1000 { return Err("Too many legacy model settings".into()); }
    let legacy_path = directory.join("automation-openai.dpapi");
    if legacy_models.is_empty() && store.legacy_models.is_empty() && legacy_path.exists() { legacy_models.push("gpt-6-luna".into()); }
    // Read the old key only for unmigrated settings. Never overwrite/delete the legacy file.
    if legacy_models.iter().any(|m| !store.legacy_models.contains_key(m)) {
        let legacy_key = match fs::read(legacy_path) {
            Ok(bytes) => Some(Zeroizing::new(String::from_utf8(crate::vault::crypt(&bytes, false)?).map_err(|_| "Unable to read the existing OpenAI key")?)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return Err("Unable to read the existing OpenAI key; migration was not saved".into()),
        };
        if migrate(&mut store, &legacy_models, legacy_key.as_deref().map(String::as_str))? { write(&directory, &store)?; }
    }
    Ok(view(&store))
}

fn prepare(store: &mut ProfileStore, input: &ProfileInput) -> Result<SavedProfile, String> {
    super::providers::validate_config(&input.config)?;
    let existing = input.id.as_ref().map(|id| store.profiles.get(id).ok_or("The saved configuration no longer exists")).transpose()?;
    if let Some(existing) = existing {
        if input.expected_revision != Some(existing.revision) { return Err("This configuration changed. Reopen it before saving.".into()); }
    }
    let scope = input.config.scope()?;
    let headers = match &input.headers {
        Some(headers) => headers.clone(),
        None => {
            if let Some(previous) = existing {
                if !previous.headers.is_empty() && previous.config.scope()? != scope {
                    return Err("The server or authentication changed. Replace or clear the saved headers for this connection.".into());
                }
            }
            existing.map(|p| p.headers.clone()).unwrap_or_default()
        }
    };
    super::providers::validate_headers(&input.config, &headers)?;
    let revision = existing.map_or(1, |p| p.revision + 1);
    let credential_id = if input.config.auth_mode == AuthMode::None { None }
    else if let Some(key) = input.new_key.as_ref().filter(|key| !key.trim().is_empty()) {
        if key.len() > 8192 || key.contains(['\r', '\n']) { return Err("Invalid API key".into()); }
        // New credentials leave other profiles and active snapshots intact.
        let id = new_id();
        store.credentials.insert(id.clone(), Credential { label: format!("{} · saved key", input.config.name), scope, key: key.trim().into() }); Some(id)
    } else if let Some(id) = &input.credential_id {
        let credential = store.credentials.get(id).ok_or("The saved API key no longer exists")?;
        if credential.scope != scope { return Err("This API key belongs to a different server or authentication method. Select a compatible key or enter a new one.".into()); }
        Some(id.clone())
    } else { None };
    Ok(SavedProfile { config: input.config.clone(), credential_id, headers, revision })
}
fn resolve(store: &ProfileStore, id: &str, saved: &SavedProfile) -> Result<ResolvedProfile, String> {
    super::providers::validate_config(&saved.config)?;
    let key = if saved.config.auth_mode == AuthMode::None { String::new() } else {
        let credential = saved.credential_id.as_ref().and_then(|id| store.credentials.get(id)).ok_or("Save an API key for this LLM configuration first")?;
        if credential.scope != saved.config.scope()? { return Err("The saved API key does not match this server".into()); }
        credential.key.clone()
    };
    Ok(ResolvedProfile { profile_id: id.into(), config: saved.config.clone(), key: Zeroizing::new(key), headers: saved.headers.clone() })
}
pub fn resolve_draft(directory: &Path, input: ProfileInput) -> Result<ResolvedProfile, String> {
    let _guard = STORE_LOCK.lock().map_err(|_| STORE_ERROR)?;
    let mut store = read(directory)?;
    let profile = prepare(&mut store, &input)?;
    resolve(&store, "test", &profile)
}

#[tauri::command]
pub fn automation_profile_save(app: tauri::AppHandle, input: ProfileInput) -> Result<SaveResult, String> {
    crate::features::require_strategies_enabled()?;
    let directory = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let _guard = STORE_LOCK.lock().map_err(|_| STORE_ERROR)?;
    let mut store = read(&directory)?;
    let profile = prepare(&mut store, &input)?;
    let id = if input.save_as_new { new_id() } else { input.id.clone().unwrap_or_else(new_id) };
    store.profiles.insert(id.clone(), profile);
    if input.make_default { store.default_profile_id = Some(id.clone()); }
    else if store.default_profile_id.as_ref() == Some(&id) { store.default_profile_id = None; }
    write(&directory, &store)?;
    Ok(SaveResult { id, list: view(&store) })
}

#[tauri::command]
pub fn automation_profile_delete(app: tauri::AppHandle, id: String) -> Result<ProfileList, String> {
    crate::features::require_strategies_enabled()?;
    let directory = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let _guard = STORE_LOCK.lock().map_err(|_| STORE_ERROR)?;
    if SESSIONS.lock().map_err(|_| STORE_ERROR)?.values().any(|p| p.profile_id == id) { return Err("Stop the strategies using this configuration before deleting it".into()); }
    let mut store = read(&directory)?;
    store.profiles.remove(&id);
    if store.default_profile_id.as_ref() == Some(&id) { store.default_profile_id = None; }
    // Credentials survive profile removal and can be reused.
    write(&directory, &store)?;
    Ok(view(&store))
}

#[tauri::command]
pub fn automation_session_open(app: tauri::AppHandle, profile_id: String, session_id: String) -> Result<SessionView, String> {
    crate::features::require_strategies_enabled()?;
    if session_id.is_empty() || session_id.len() > 100 { return Err("Invalid strategy session".into()); }
    let directory = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let _guard = STORE_LOCK.lock().map_err(|_| STORE_ERROR)?;
    let store = read(&directory)?;
    let saved = store.profiles.get(&profile_id).ok_or("Select a saved LLM configuration first")?;
    let resolved = resolve(&store, &profile_id, saved)?;
    let result = SessionView { profile_id, name: resolved.config.name.clone(), model: resolved.config.model.clone() };
    let mut sessions = SESSIONS.lock().map_err(|_| STORE_ERROR)?;
    if sessions.contains_key(&session_id) { return Err("The strategy session already exists".into()); }
    sessions.insert(session_id, Arc::new(resolved));
    Ok(result)
}
#[tauri::command]
pub fn automation_session_close(session_id: String) -> Result<(), String> {
    SESSIONS.lock().map_err(|_| STORE_ERROR)?.remove(&session_id); Ok(())
}
pub fn session(id: &str) -> Result<Arc<ResolvedProfile>, String> {
    SESSIONS.lock().map_err(|_| STORE_ERROR)?.get(id).cloned().ok_or("The strategy was stopped; its model response was discarded".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> ProfileInput { ProfileInput { id: None, expected_revision: None, config: ProfileConfig::legacy("test-model"),
        credential_id: None, new_key: Some("test-secret".into()), headers: None, make_default: false, save_as_new: false } }
    #[test]
    fn migration_preserves_distinct_models_and_shared_key() {
        let mut store = ProfileStore::default(); let models = vec!["model-a".into(), "model-b".into()];
        assert!(migrate(&mut store, &models, Some("old-key")).unwrap());
        assert!(!migrate(&mut store, &models, Some("old-key")).unwrap());
        assert_eq!(store.profiles.len(), 2); assert_eq!(store.credentials.len(), 1);
        assert!(!serde_json::to_string(&view(&store)).unwrap().contains("old-key"));
    }
    #[test]
    fn keys_are_scoped_and_active_snapshots_do_not_change() {
        let mut store = ProfileStore::default(); let mut draft = input();
        let first = prepare(&mut store, &draft).unwrap(); let snapshot = resolve(&store, "first", &first).unwrap();
        draft.new_key = None; draft.credential_id = first.credential_id.clone();
        let other = prepare(&mut store, &draft).unwrap(); assert_eq!(first.credential_id, other.credential_id);
        draft.config.base_url = "https://different.example".into(); assert!(prepare(&mut store, &draft).is_err());
        draft.config.base_url = "https://api.openai.com".into(); draft.new_key = Some("replacement".into());
        let replacement = prepare(&mut store, &draft).unwrap(); assert_ne!(first.credential_id, replacement.credential_id);
        assert_eq!(snapshot.key.as_str(), "test-secret"); assert_eq!(resolve(&store, "other", &other).unwrap().key.as_str(), "test-secret");
    }
    #[test]
    fn secret_headers_never_leave_native_store_or_follow_an_origin_change() {
        let mut store = ProfileStore::default(); let mut draft = input();
        draft.headers = Some(BTreeMap::from([("x-private-token".into(), "private-value".into())]));
        let saved = prepare(&mut store, &draft).unwrap(); store.profiles.insert("one".into(), saved);
        let public = serde_json::to_string(&view(&store)).unwrap(); assert!(!public.contains("private-value")); assert!(!public.contains("test-secret"));
        draft.id = Some("one".into()); draft.expected_revision = Some(1); draft.headers = None;
        draft.config.base_url = "https://different.example".into(); assert!(prepare(&mut store, &draft).is_err());
        draft.config.base_url = "https://api.openai.com".into(); draft.expected_revision = Some(0); assert!(prepare(&mut store, &draft).is_err());
    }
    #[cfg(windows)]
    #[test]
    fn encrypted_profiles_reopen_and_corrupt_storage_is_never_replaced() {
        let directory = std::env::temp_dir().join(format!("dekxdis-llm-test-{}", new_id()));
        let mut store = ProfileStore::default();
        let profile = prepare(&mut store, &input()).unwrap();
        store.profiles.insert("saved".into(), profile); store.default_profile_id = Some("saved".into());
        write(&directory, &store).unwrap();
        let path = directory.join(STORE_FILE);
        let encrypted = fs::read(&path).unwrap();
        assert!(!encrypted.windows(b"test-secret".len()).any(|w| w == b"test-secret"));
        let reopened = read(&directory).unwrap();
        assert_eq!(reopened.default_profile_id.as_deref(), Some("saved"));
        assert_eq!(resolve(&reopened, "saved", &reopened.profiles["saved"]).unwrap().key.as_str(), "test-secret");
        fs::write(&path, b"invalid encrypted file").unwrap();
        assert!(read(&directory).is_err()); assert_eq!(fs::read(&path).unwrap(), b"invalid encrypted file");
        fs::remove_file(path).unwrap(); fs::remove_dir(directory).unwrap();
    }
    #[test]
    fn closing_a_session_blocks_delivery_and_keeps_other_sessions() {
        let mut store = ProfileStore::default(); let profile = prepare(&mut store, &input()).unwrap();
        let first = new_id(); let second = new_id();
        {
            let mut sessions = SESSIONS.lock().unwrap();
            sessions.insert(first.clone(), Arc::new(resolve(&store, "a", &profile).unwrap()));
            sessions.insert(second.clone(), Arc::new(resolve(&store, "b", &profile).unwrap()));
        }
        let pending = session(&first).unwrap();
        automation_session_close(first.clone()).unwrap();
        assert!(session(&first).is_err()); assert_eq!(pending.profile_id, "a");
        assert_eq!(session(&second).unwrap().profile_id, "b"); automation_session_close(second).unwrap();
    }
}
