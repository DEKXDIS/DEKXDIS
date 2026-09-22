//! Native module platform. The WebView receives declarations and bounded JSON,
//! never downloaded source execution or a read-credential capability.

pub mod http;
pub mod credentials;
pub mod package;
pub mod registry;
pub mod runtime;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, VecDeque},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModuleIdentity {
    pub module_id: String,
    pub package_hash: String,
    pub generation: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeScope {
    pub run_id: String,
    pub wallet_address: String,
    pub wallet_generation: u64,
    pub configuration_revision: u64,
    pub secret_revision: u64,
}
struct Registered {
    identity: ModuleIdentity,
    scope: NativeScope,
    requests: VecDeque<Instant>,
}
pub struct Services {
    store: registry::Store,
    scopes: Mutex<BTreeMap<String, Registered>>,
    blobs: Mutex<BTreeMap<String, http::Blob>>,
    runtime_jobs: AtomicUsize,
    http_jobs: AtomicUsize,
}
pub struct ModuleState(Arc<Services>);
impl ModuleState {
    pub(crate) fn invalidate_wallet(&self) -> Result<(), String> {
        self.0.scopes.lock().map_err(lock_error)?.clear();
        self.0.blobs.lock().map_err(lock_error)?.clear();
        Ok(())
    }
}
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn lock_error(_: impl std::fmt::Display) -> String {
    "Module host state is unavailable".into()
}
struct Job<'a>(&'a AtomicUsize);
impl Drop for Job<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}
fn job(counter: &AtomicUsize) -> Result<Job<'_>, String> {
    counter
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
            (n < 4).then_some(n + 1)
        })
        .map_err(|_| "Module native concurrency limit reached")?;
    Ok(Job(counter))
}
impl Services {
    fn check(
        &self,
        vault: &crate::vault::VaultState,
        identity: &ModuleIdentity,
        scope: &NativeScope,
    ) -> Result<(), String> {
        if !self.store.identity_current(identity)? {
            return Err("Module package generation changed".into());
        }
        let registered = self.scopes.lock().map_err(lock_error)?;
        if !registered
            .get(&scope.run_id)
            .is_some_and(|r| &r.identity == identity && &r.scope == scope)
        {
            return Err("Module run was paused or reconfigured".into());
        }
        drop(registered);
        crate::vault::require_active_wallet(vault, &scope.wallet_address)?;
        if crate::vault::module_secret_status(vault, &identity.module_id)?.revision
            != scope.secret_revision
        {
            return Err("Module credential revision changed".into());
        }
        Ok(())
    }
    fn invalidate(&self, id: &str) -> Result<(), String> {
        self.scopes
            .lock()
            .map_err(lock_error)?
            .retain(|_, r| r.identity.module_id != id);
        self.blobs
            .lock()
            .map_err(lock_error)?
            .retain(|_, b| b.identity.module_id != id);
        Ok(())
    }
    fn count(&self, run_id: &str, count: usize) -> Result<(), String> {
        let mut scopes = self.scopes.lock().map_err(lock_error)?;
        let scope = scopes.get_mut(run_id).ok_or("Module scope invalidated")?;
        let now = Instant::now();
        while scope
            .requests
            .front()
            .is_some_and(|t| now.duration_since(*t) > Duration::from_secs(60))
        {
            scope.requests.pop_front();
        }
        if scope.requests.len() + count > 120 {
            return Err("Native module event/request rate limit reached".into());
        }
        scope.requests.extend(std::iter::repeat_n(now, count));
        Ok(())
    }
}
pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let store = registry::Store::new(app.path().app_local_data_dir()?.join("modules"));
    let services = Arc::new(Services {
        store,
        scopes: Mutex::new(BTreeMap::new()),
        blobs: Mutex::new(BTreeMap::new()),
        runtime_jobs: AtomicUsize::new(0),
        http_jobs: AtomicUsize::new(0),
    });
    app.manage(ModuleState(services.clone()));
    if crate::features::strategies_enabled() { start_services(app.handle())?; }
    Ok(())
}
pub fn start_services(app: &tauri::AppHandle) -> Result<(), String> {
    static STARTED: Mutex<bool> = Mutex::new(false);
    let mut started = STARTED.lock().map_err(|_| "Module startup lock failed")?;
    if *started { return Ok(()); }
    let services = app.state::<ModuleState>().0.clone();
    services.store.recover(&app.state::<crate::vault::VaultState>())?;
    let handle = app.clone();
    // Bounded polling sees stable signed bytes twice, and shares precisely the
    // same installer with picker/drop and startup/manager-open discovery.
    std::thread::Builder::new()
        .name("dekxdis-module-inbox".into())
        .spawn(move || {
            let mut previous = String::new();
            loop {
                if !crate::features::strategies_enabled() { std::thread::sleep(Duration::from_secs(3)); continue; }
                match services
                    .store
                    .scan(&handle.state::<crate::vault::VaultState>())
                {
                    Ok(snapshot) => {
                        let current = serde_json::to_string(&snapshot).unwrap_or_default();
                        if current != previous {
                            previous = current;
                            let _ = handle.emit("dekxdis-modules-changed", snapshot);
                        }
                    }
                    Err(e) => services.store.diagnostic(e),
                }
                std::thread::sleep(Duration::from_secs(3));
            }
        }).map_err(|e| format!("Module inbox could not start: {e}"))?;
    *started = true;
    Ok(())
}
#[tauri::command]
pub fn modules_list(state: tauri::State<ModuleState>) -> Result<registry::Snapshot, String> {
    crate::features::require_strategies_enabled()?;
    state.0.store.snapshot()
}
#[tauri::command]
pub fn modules_scan_inbox(
    state: tauri::State<ModuleState>,
    vault: tauri::State<crate::vault::VaultState>,
) -> Result<registry::Snapshot, String> {
    crate::features::require_strategies_enabled()?;
    state.0.store.scan(&vault)
}
#[tauri::command]
pub fn modules_install(
    state: tauri::State<ModuleState>,
    vault: tauri::State<crate::vault::VaultState>,
    envelope: String,
) -> Result<registry::InstalledModule, String> {
    crate::features::require_strategies_enabled()?;
    let before = state.0.store.snapshot()?;
    let installed = state.0.store.install(envelope.as_bytes(), &vault)?;
    if !before.modules.iter().any(|m| {
        m.module_id == installed.module_id
            && m.generation == installed.generation
            && m.package_hash == installed.package_hash
    }) {
        state.0.invalidate(&installed.module_id)?;
    }
    Ok(installed)
}
#[tauri::command]
pub fn modules_install_path(
    state: tauri::State<ModuleState>,
    vault: tauri::State<crate::vault::VaultState>,
    path: String,
) -> Result<registry::InstalledModule, String> {
    crate::features::require_strategies_enabled()?;
    let path = std::path::Path::new(&path);
    if !matches!(path.extension().and_then(|s| s.to_str()), Some("dekxdis-module" | "haven-module")) {
        return Err("Select a .dekxdis-module package".into());
    }
    let bytes = registry::bounded_read(path)?;
    let before = state.0.store.snapshot()?;
    let installed = state.0.store.install(&bytes, &vault)?;
    if !before.modules.iter().any(|m| {
        m.module_id == installed.module_id
            && m.generation == installed.generation
            && m.package_hash == installed.package_hash
    }) {
        state.0.invalidate(&installed.module_id)?;
    }
    Ok(installed)
}
#[tauri::command]
pub fn modules_select(
    state: tauri::State<ModuleState>,
    module_id: Option<String>,
) -> Result<registry::Snapshot, String> {
    crate::features::require_strategies_enabled()?;
    // Selection is a per-token choice held by the WebView and a marker in the registry.
    // It must not retire another module's run registrations: those belong to the runs that
    // own them and are released when each run pauses, is removed, or the wallet changes.
    state.0.store.select(module_id)
}
#[tauri::command]
pub fn modules_remove_begin(
    state: tauri::State<ModuleState>,
    vault: tauri::State<crate::vault::VaultState>,
    module_id: String,
) -> Result<registry::InstalledModule, String> {
    crate::features::require_strategies_enabled()?;
    if state.0.store.snapshot()?.modules.iter().any(|m| m.module_id == module_id && m.status == "installed") {
      state.0.store.with_credentials(&vault, &module_id, |_| {
        if !crate::vault::module_secret_status(&vault, &module_id)?.conflicts.is_empty() {
            return Err("This module has a different saved provider key. Save the key you want to use before removing it.".into());
        }
        Ok(())
      })?;
    }
    let result = state.0.store.remove_begin(&module_id)?;
    state.0.invalidate(&module_id)?;
    Ok(result)
}
#[tauri::command]
pub fn modules_remove_finish(
    state: tauri::State<ModuleState>,
    vault: tauri::State<crate::vault::VaultState>,
    module_id: String,
) -> Result<registry::Snapshot, String> {
    crate::features::require_strategies_enabled()?;
    state.0.store.remove_finish(&module_id, &vault)
}
fn declared_slot(manifest: &Value, slot_id: &str) -> Result<(), String> {
    if !manifest["secretSlots"]
        .as_array()
        .is_some_and(|a| a.iter().any(|s| s["id"].as_str() == Some(slot_id)))
    {
        return Err("Secret slot is not declared by this installed module".into());
    }
    Ok(())
}
#[tauri::command]
pub fn modules_secret_status(
    state: tauri::State<ModuleState>,
    vault: tauri::State<crate::vault::VaultState>,
    module_id: String,
) -> Result<crate::vault::ModuleSecretStatus, String> {
    crate::features::require_strategies_enabled()?;
    state.0.store.with_credentials(&vault, &module_id, |_| crate::vault::module_secret_status(&vault, &module_id))
}
#[tauri::command]
pub fn modules_secret_set(
    state: tauri::State<ModuleState>,
    vault: tauri::State<crate::vault::VaultState>,
    module_id: String,
    slot_id: String,
    value: String,
) -> Result<crate::vault::ModuleSecretStatus, String> {
    crate::features::require_strategies_enabled()?;
    state.0.store.with_credentials(&vault, &module_id, |manifest| {
        declared_slot(manifest, &slot_id)?;
        state.0.invalidate(&module_id)?;
        crate::vault::module_secret_write(&vault, &module_id, &slot_id, Some(value))
    })
}
#[tauri::command]
pub fn modules_secret_delete(
    state: tauri::State<ModuleState>,
    vault: tauri::State<crate::vault::VaultState>,
    module_id: String,
    slot_id: String,
) -> Result<crate::vault::ModuleSecretStatus, String> {
    crate::features::require_strategies_enabled()?;
    state.0.store.with_credentials(&vault, &module_id, |manifest| {
        declared_slot(manifest, &slot_id)?;
        state.0.invalidate(&module_id)?;
        crate::vault::module_secret_write(&vault, &module_id, &slot_id, None)
    })
}
#[tauri::command]
pub fn modules_scope_register(
    state: tauri::State<ModuleState>,
    vault: tauri::State<crate::vault::VaultState>,
    identity: ModuleIdentity,
    scope: NativeScope,
) -> Result<(), String> {
    crate::features::require_strategies_enabled()?;
    state.0.store.package(&identity)?;
    if !runtime::request_id(&scope.run_id)
        || scope.wallet_address.len() != 42
        || !scope.wallet_address.starts_with("0x")
        || !scope.wallet_address[2..]
            .bytes()
            .all(|b| b.is_ascii_hexdigit())
    {
        return Err("Invalid module run scope".into());
    }
    crate::vault::require_active_wallet(&vault, &scope.wallet_address)?;
    if crate::vault::module_secret_status(&vault, &identity.module_id)?.revision
        != scope.secret_revision
    {
        return Err("Module secret revision changed".into());
    }
    let mut scopes = state.0.scopes.lock().map_err(lock_error)?;
    if let Some(previous) = scopes.get(&scope.run_id) {
        if previous.identity == identity && previous.scope == scope {
            return Ok(());
        }
        return Err("Invalidate the old module scope before replacing it".into());
    }
    if scopes.len() >= 256 {
        return Err("Native module run limit reached".into());
    }
    scopes.insert(
        scope.run_id.clone(),
        Registered {
            identity,
            scope,
            requests: VecDeque::new(),
        },
    );
    Ok(())
}
#[tauri::command]
pub fn modules_scope_invalidate(
    state: tauri::State<ModuleState>,
    run_id: String,
) -> Result<(), String> {
    state.0.scopes.lock().map_err(lock_error)?.remove(&run_id);
    state
        .0
        .blobs
        .lock()
        .map_err(lock_error)?
        .retain(|_, b| b.scope.run_id != run_id);
    Ok(())
}
#[tauri::command]
pub fn modules_scope_check(
    state: tauri::State<ModuleState>,
    vault: tauri::State<crate::vault::VaultState>,
    identity: ModuleIdentity,
    scope: NativeScope,
) -> Result<bool, String> {
    if !crate::features::strategies_enabled() { return Ok(false); }
    Ok(state.0.check(&vault, &identity, &scope).is_ok())
}
#[tauri::command]
pub async fn modules_invoke(
    app: tauri::AppHandle,
    identity: ModuleIdentity,
    scope: NativeScope,
    event: Value,
    context: Value,
    state: Value,
) -> Result<Value, String> {
    crate::features::require_strategies_enabled()?;
    let services = app.state::<ModuleState>().0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _job = job(&services.runtime_jobs)?;
        let vault = app.state::<crate::vault::VaultState>();
        services.check(&vault, &identity, &scope)?;
        let pkg = services.store.package(&identity)?;
        if context["moduleId"].as_str() != Some(&identity.module_id)
            || context["runId"].as_str() != Some(&scope.run_id)
            || context["hostApiVersion"] != 1
            || context["moduleVersion"] != pkg.payload.manifest["moduleVersion"]
            || !pkg.payload.manifest["supportedChains"]
                .as_array()
                .unwrap()
                .contains(&context["chainId"])
        {
            return Err("Module event context does not match its registered identity".into());
        }
        if !runtime::request_id(package::field(&event, "id")?)
            || !matches!(
                package::field(&event, "type")?,
                "start"
                    | "timer"
                    | "candle-close"
                    | "price"
                    | "order"
                    | "capability-result"
                    | "capability-error"
                    | "pause"
                    | "recovery"
                    | "ui"
            )
        {
            return Err(format!(
                "Unsupported module event: type={:?} id={:?}",
                package::field(&event, "type").unwrap_or("<missing>"),
                package::field(&event, "id").unwrap_or("<missing>")
            ));
        }
        services.count(&scope.run_id, 1)?;
        let output = runtime::invoke(&pkg.payload, &event, &context, &state)?;
        services.check(&vault, &identity, &scope)?;
        services.count(&scope.run_id, output["requests"].as_array().unwrap().len())?;
        Ok(output)
    })
    .await
    .map_err(|_| "Native module worker failed")?
}
#[tauri::command]
pub fn modules_blob_put(
    state: tauri::State<ModuleState>,
    vault: tauri::State<crate::vault::VaultState>,
    identity: ModuleIdentity,
    scope: NativeScope,
    request_id: String,
    data_url: String,
    metadata: Value,
) -> Result<Value, String> {
    crate::features::require_strategies_enabled()?;
    state.0.check(&vault, &identity, &scope)?;
    let pkg = state.0.store.package(&identity)?;
    if !package::has_capability(&pkg.payload.manifest, "chart.snapshot.v1")
        || !runtime::request_id(&request_id)
    {
        return Err("Chart capability is not declared or request ID invalid".into());
    }
    if data_url.len() > http::IMAGE_BYTES * 4 / 3 + 128 {
        return Err("Chart image exceeds 2 MiB".into());
    }
    let encoded = data_url
        .strip_prefix("data:image/png;base64,")
        .ok_or("Chart must be a PNG data URL")?;
    let data = STANDARD
        .decode(encoded)
        .map_err(|_| "Invalid PNG encoding")?;
    if data.len() > http::IMAGE_BYTES || !data.starts_with(b"\x89PNG\r\n\x1a\n") || data.len() < 24
    {
        return Err("Invalid or oversized PNG image".into());
    }
    let width = u32::from_be_bytes(data[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(data[20..24].try_into().unwrap());
    if !(640..=1600).contains(&width) || !(400..=1200).contains(&height) {
        return Err("PNG dimensions are outside supported chart bounds".into());
    }
    if !metadata.is_object() || serde_json::to_vec(&metadata).map_err(lock_error)?.len() > 4096 {
        return Err("Invalid chart metadata".into());
    }
    let sha256 = package::hash(&data);
    let handle = format!("image-{:032x}", rand::random::<u128>());
    let mut output = metadata.clone();
    let o = output.as_object_mut().unwrap();
    o.insert("handle".into(), handle.clone().into());
    o.insert("sha256".into(), sha256.into());
    o.insert("byteLength".into(), data.len().into());
    let mut blobs = state.0.blobs.lock().map_err(lock_error)?;
    blobs.retain(|_, b| b.created.elapsed() < Duration::from_secs(120));
    if blobs.len() >= 32
        || blobs.values().map(|b| b.data.len()).sum::<usize>() + data.len() > 32 * 1024 * 1024
    {
        return Err("Chart image memory budget reached".into());
    }
    blobs.insert(
        handle,
        http::Blob {
            identity,
            scope,
            data,
            created: Instant::now(),
            metadata,
        },
    );
    Ok(output)
}
#[tauri::command]
pub fn modules_blob_preview(
    state: tauri::State<ModuleState>,
    vault: tauri::State<crate::vault::VaultState>,
    identity: ModuleIdentity,
    scope: NativeScope,
    handle: String,
) -> Result<String, String> {
    crate::features::require_strategies_enabled()?;
    state.0.check(&vault, &identity, &scope)?;
    let blobs = state.0.blobs.lock().map_err(lock_error)?;
    let blob = blobs
        .get(&handle)
        .ok_or("Image handle expired or is unavailable")?;
    if blob.identity != identity
        || blob.scope != scope
        || blob.created.elapsed() > Duration::from_secs(120)
    {
        return Err("Image handle is outside this active run".into());
    }
    Ok(format!(
        "data:image/png;base64,{}",
        STANDARD.encode(&blob.data)
    ))
}
#[tauri::command]
pub async fn modules_http(
    app: tauri::AppHandle,
    identity: ModuleIdentity,
    scope: NativeScope,
    request: Value,
) -> Result<Value, String> {
    crate::features::require_strategies_enabled()?;
    let services = app.state::<ModuleState>().0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _job = job(&services.http_jobs)?;
        let vault = app.state::<crate::vault::VaultState>();
        services.check(&vault, &identity, &scope)?;
        let pkg = services.store.package(&identity)?;
        if !package::has_capability(&pkg.payload.manifest, "http.request.v1") {
            return Err("HTTP capability is not declared".into());
        }
        http::validate_request(&pkg.payload.manifest, &request)?;
        services.count(&scope.run_id, 1)?;
        let endpoint = pkg.payload.manifest["endpointDeclarations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["id"] == request["endpointId"])
            .unwrap();
        let secret = if let Some(auth) = endpoint.get("authentication") {
            Some(crate::vault::module_secret_inject(
                &vault,
                &identity.module_id,
                package::field(auth, "slotId")?,
                scope.secret_revision,
            )?)
        } else {
            None
        };
        let mut selected = BTreeMap::new();
        {
            let blobs = services.blobs.lock().map_err(lock_error)?;
            if let Some(attachments) = request["attachments"].as_array() {
                for a in attachments {
                    let handle = package::field(a, "handle")?;
                    let b = blobs.get(handle).ok_or("Image handle is unavailable")?;
                    selected.insert(
                        handle.to_string(),
                        http::Blob {
                            identity: b.identity.clone(),
                            scope: b.scope.clone(),
                            data: b.data.clone(),
                            created: b.created,
                            metadata: b.metadata.clone(),
                        },
                    );
                }
            }
        }
        http::execute(
            &pkg.payload.manifest,
            &request,
            &identity,
            &scope,
            &selected,
            secret,
            || services.check(&vault, &identity, &scope),
        )
    })
    .await
    .map_err(|_| "Native HTTP worker failed")?
}
