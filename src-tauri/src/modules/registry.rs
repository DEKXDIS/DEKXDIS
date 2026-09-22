use super::{
    package::{self, VerifiedPackage},
    ModuleIdentity,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant, SystemTime},
};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstalledModule {
    pub module_id: String,
    pub package_hash: String,
    pub generation: u64,
    pub manifest: Value,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Registry {
    version: u32,
    modules: BTreeMap<String, InstalledModule>,
    selected_module_id: Option<String>,
    generations: BTreeMap<String, u64>,
    content_history: BTreeMap<String, String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub modules: Vec<InstalledModule>,
    pub selected_module_id: Option<String>,
    pub inbox_path: String,
    pub diagnostics: Vec<String>,
}
struct Observation {
    length: u64,
    modified: SystemTime,
    hash: String,
    first_seen: Instant,
    attempted: bool,
}
pub struct Store {
    pub root: PathBuf,
    keys: BTreeMap<String, [u8; 32]>,
    mutation: Mutex<()>,
    registry: Mutex<Registry>,
    observations: Mutex<BTreeMap<PathBuf, Observation>>,
    diagnostics: Mutex<Vec<String>>,
    fault: Option<String>,
}

fn io_error(e: impl std::fmt::Display) -> String {
    format!("Module storage error: {e}")
}
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    fs::create_dir_all(path.parent().ok_or("Invalid module storage path")?).map_err(io_error)?;
    let temp = path.with_extension("pending");
    let mut file = fs::File::create(&temp).map_err(io_error)?;
    file.write_all(bytes).map_err(io_error)?;
    file.sync_all().map_err(io_error)?;
    drop(file);
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let from: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe {
            MoveFileExW(
                from.as_ptr(),
                to.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(io_error(std::io::Error::last_os_error()));
        }
    }
    #[cfg(not(windows))]
    fs::rename(temp, path).map_err(io_error)?;
    Ok(())
}
pub fn bounded_read(path: &Path) -> Result<Vec<u8>, String> {
    let meta = fs::symlink_metadata(path).map_err(io_error)?;
    if !meta.is_file()
        || meta.file_type().is_symlink()
        || meta.len() > package::ENVELOPE_BYTES as u64
    {
        return Err("Package is not a regular bounded file".into());
    }
    let mut file = fs::File::open(path).map_err(io_error)?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take((package::ENVELOPE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() > package::ENVELOPE_BYTES {
        return Err("Package envelope exceeds 2 MiB".into());
    }
    Ok(bytes)
}
impl Store {
    pub fn new(root: PathBuf) -> Self {
        let keys = package::trusted_keys();
        let path = root.join("registry.json");
        let result = (|| {
            fs::create_dir_all(root.join("inbox")).map_err(io_error)?;
            fs::create_dir_all(root.join("installed")).map_err(io_error)?;
            if path.exists() {
                let data = fs::read(&path).map_err(io_error)?;
                let registry: Registry =
                    serde_json::from_value(package::parse_json(&data, 4 * 1024 * 1024)?)
                        .map_err(io_error)?;
                if registry.version != 1 {
                    return Err("Unsupported module registry version".into());
                }
                for (id, m) in &registry.modules {
                    if id != &m.module_id
                        || !package::identifier(id)
                        || m.package_hash.len() != 64
                        || !m.package_hash.bytes().all(|b| b.is_ascii_hexdigit())
                        || !matches!(m.status.as_str(), "installed" | "disabled" | "removing")
                    {
                        return Err("Invalid module registry identity".into());
                    }
                }
                Ok(registry)
            } else if path.with_extension("pending").exists() {
                Err(
                    "Interrupted initial module registry write; recovery requires inspection"
                        .into(),
                )
            } else {
                Ok(Registry {
                    version: 1,
                    ..Default::default()
                })
            }
        })();
        let fault = result
            .as_ref()
            .err()
            .cloned()
            .or_else(|| keys.as_ref().err().cloned());
        Self {
            root,
            keys: keys.unwrap_or_default(),
            mutation: Mutex::new(()),
            registry: Mutex::new(result.unwrap_or_default()),
            observations: Mutex::new(BTreeMap::new()),
            diagnostics: Mutex::new(vec![]),
            fault,
        }
    }
    fn healthy(&self) -> Result<(), String> {
        if let Some(f) = &self.fault {
            return Err(f.clone());
        }
        Ok(())
    }
    fn commit(&self, registry: &Registry) -> Result<(), String> {
        self.healthy()?;
        atomic_write(
            &self.root.join("registry.json"),
            &serde_json::to_vec(registry).map_err(io_error)?,
        )
    }
    pub fn snapshot(&self) -> Result<Snapshot, String> {
        let registry = self.registry.lock().map_err(io_error)?;
        let mut diagnostics = self.diagnostics.lock().map_err(io_error)?.clone();
        if let Some(f) = &self.fault {
            diagnostics.push(f.clone());
        }
        if self.keys.is_empty() {
            diagnostics.push("This host build has no pinned module publisher public key. Signed module installation requires a configured release trust root.".into());
        }
        
        Ok(Snapshot {
            modules: registry.modules.values().cloned().collect(),
            selected_module_id: registry.selected_module_id.clone(),
            inbox_path: self.root.join("inbox").to_string_lossy().into(),
            diagnostics,
        })
    }
    fn code_path(&self, hash: &str) -> PathBuf {
        let installed = self.root.join("installed");
        let current = installed.join(format!("{hash}.dekxdis-module"));
        let legacy = installed.join(format!("{hash}.haven-module"));
        // Existing signed packages keep their original bytes and registry hash.
        if !current.exists() && legacy.exists() { legacy } else { current }
    }
    pub fn install(
        &self,
        bytes: &[u8],
        vault: &crate::vault::VaultState,
    ) -> Result<InstalledModule, String> {
        let pkg = package::verify(bytes, &self.keys)?;
        self.install_prepared(&pkg, || {
            let id = package::field(&pkg.payload.manifest, "moduleId")?;
            if self.registry.lock().map_err(io_error)?.modules.contains_key(id) {
                self.preserve_provider_credentials(vault, id)?;
                if !crate::vault::module_secret_status(vault, id)?.conflicts.is_empty() {
                    return Err("This module has a different saved provider key. Save the key you want to use before updating it.".into());
                }
            }
            Ok(())
        }, || crate::vault::module_secrets_remove(vault, package::field(&pkg.payload.manifest, "moduleId")?))
    }
    
    fn install_prepared(
        &self,
        pkg: &VerifiedPackage,
        prepare: impl FnOnce() -> Result<(), String>,
        clear_secrets: impl FnOnce() -> Result<(), String>,
    ) -> Result<InstalledModule, String> {
        self.healthy()?;
        let _mutation = self.mutation.lock().map_err(io_error)?;
        prepare()?;
        let mut guard = self.registry.lock().map_err(io_error)?;
        let id = package::field(&pkg.payload.manifest, "moduleId")?.to_string();
        let version = package::field(&pkg.payload.manifest, "moduleVersion")?;
        let content_key = format!("{id}@{version}");
        if guard
            .content_history
            .get(&content_key)
            .is_some_and(|h| h != &pkg.hash)
        {
            return Err("Identical module ID/version has different signed content".into());
        }
        if let Some(existing) = guard.modules.get(&id) {
            if existing.status == "removing" {
                return Err("Module removal must finish before reinstall".into());
            }
            if existing.package_hash == pkg.hash && existing.status == "installed" {
                self.verify_installed(existing)?;
                return Ok(existing.clone());
            }
        }
        let generation = guard
            .generations
            .get(&id)
            .copied()
            .unwrap_or(0)
            .checked_add(1)
            .ok_or("Module generation exhausted")?;
        // Commit invalidation first for updates. A failed later write leaves the
        // previous version visible but disabled; it can never silently resume.
        if guard.modules.contains_key(&id) {
            let existing = guard.modules.get(&id).unwrap();
            let previous = self.verify_installed(existing)?;
            let previous_envelope: serde_json::Value = serde_json::from_slice(&previous.envelope).map_err(io_error)?;
            let next_envelope: serde_json::Value = serde_json::from_slice(&pkg.envelope).map_err(io_error)?;
            let preserve_secrets = previous_envelope["publisherKeyId"] == next_envelope["publisherKeyId"]
                && existing.manifest["secretSlots"] == pkg.payload.manifest["secretSlots"]
                && existing.manifest["endpointDeclarations"] == pkg.payload.manifest["endpointDeclarations"];
            let mut disabled = guard.clone();
            let old = disabled.modules.get_mut(&id).unwrap();
            old.status = "disabled".into();
            old.generation = generation;
            old.error = Some("Update pending; start a new run after the update completes".into());
            disabled.generations.insert(id.clone(), generation);
            self.commit(&disabled)?;
            *guard = disabled;
            drop(guard);
            if !preserve_secrets {
                clear_secrets()?;
            }
            guard = self.registry.lock().map_err(io_error)?;
        }
        let path = self.code_path(&pkg.hash);
        if path.exists() {
            if bounded_read(&path)? != pkg.envelope {
                return Err("Immutable module artifact differs from verified package".into());
            }
        } else {
            atomic_write(&path, &pkg.envelope)?;
        }
        let installed = InstalledModule {
            module_id: id.clone(),
            package_hash: pkg.hash.clone(),
            generation,
            manifest: pkg.payload.manifest.clone(),
            status: "installed".into(),
            error: None,
        };
        let mut next = guard.clone();
        next.modules.insert(id.clone(), installed.clone());
        next.generations.insert(id, generation);
        next.content_history.insert(content_key, pkg.hash.clone());
        self.commit(&next)?;
        *guard = next;
        Ok(installed)
    }
    fn verify_installed(&self, m: &InstalledModule) -> Result<VerifiedPackage, String> {
        let pkg = package::verify(&bounded_read(&self.code_path(&m.package_hash))?, &self.keys)?;
        if pkg.hash != m.package_hash || pkg.payload.manifest != m.manifest {
            return Err("Installed module content was changed".into());
        }
        Ok(pkg)
    }
    pub fn package(&self, identity: &ModuleIdentity) -> Result<VerifiedPackage, String> {
        self.healthy()?;
        let mut guard = self.registry.lock().map_err(io_error)?;
        let m = guard
            .modules
            .get(&identity.module_id)
            .ok_or("Module is not installed")?;
        if m.status != "installed"
            || m.package_hash != identity.package_hash
            || m.generation != identity.generation
        {
            return Err("Module was disabled, updated or removed".into());
        }
        match self.verify_installed(m) {
            Ok(p) => Ok(p),
            Err(error) => {
                let mut next = guard.clone();
                let m = next.modules.get_mut(&identity.module_id).unwrap();
                m.status = "disabled".into();
                m.generation = m
                    .generation
                    .checked_add(1)
                    .ok_or("Module generation exhausted")?;
                m.error = Some(error.clone());
                next.generations.insert(m.module_id.clone(), m.generation);
                self.commit(&next)?;
                *guard = next;
                Err(error)
            }
        }
    }
    pub fn identity_current(&self, identity: &ModuleIdentity) -> Result<bool, String> {
        self.healthy()?;
        let guard = self.registry.lock().map_err(io_error)?;
        Ok(guard.modules.get(&identity.module_id).is_some_and(|m| {
            m.status == "installed"
                && m.generation == identity.generation
                && m.package_hash == identity.package_hash
        }))
    }
    pub fn module(&self, id: &str) -> Result<InstalledModule, String> {
        self.healthy()?;
        self.registry
            .lock()
            .map_err(io_error)?
            .modules
            .get(id)
            .filter(|m| m.status == "installed")
            .cloned()
            .ok_or("Module is not installed".into())
    }
    /// Serialize credential bindings with install/remove and verify the source manifest.
    pub fn with_credentials<T>(&self, vault: &crate::vault::VaultState, id: &str, operation: impl FnOnce(&Value) -> Result<T, String>) -> Result<T, String> {
        self.healthy()?;
        let _mutation = self.mutation.lock().map_err(io_error)?;
        let installed = self.module(id)?;
        // Migrate all installed legacy users before an explicit provider replacement
        // or deletion, so an unvisited module cannot later resurrect an old key.
        for module in self.snapshot()?.modules.into_iter().filter(|m| m.status == "installed") {
            self.verify_installed(&module)?;
            crate::vault::module_secrets_bind(vault, &module.module_id, super::credentials::bindings(&module.manifest)?)?;
        }
        operation(&installed.manifest)
    }
    // Caller already holds the mutation lock, including during disabled/removing states.
    fn preserve_provider_credentials(&self, vault: &crate::vault::VaultState, id: &str) -> Result<(), String> {
        let installed = self.registry.lock().map_err(io_error)?.modules.get(id).cloned().ok_or("Module is not installed")?;
        // Recovery after a crash between artifact deletion and registry commit:
        // finish_with already persisted key migration/removal before deleting it.
        if installed.status == "removing" && !self.code_path(&installed.package_hash).exists() { return Ok(()); }
        self.verify_installed(&installed)?;
        crate::vault::module_secrets_bind(vault, id, super::credentials::bindings(&installed.manifest)?)
    }
    pub fn select(&self, id: Option<String>) -> Result<Snapshot, String> {
        self.healthy()?;
        let mut guard = self.registry.lock().map_err(io_error)?;
        if let Some(id) = &id {
            if !guard
                .modules
                .get(id)
                .is_some_and(|m| m.status == "installed")
            {
                return Err("Select an installed module".into());
            }
        }
        let mut next = guard.clone();
        next.selected_module_id = id;
        self.commit(&next)?;
        *guard = next;
        drop(guard);
        self.snapshot()
    }
    pub fn remove_begin(&self, id: &str) -> Result<InstalledModule, String> {
        self.healthy()?;
        let _mutation = self.mutation.lock().map_err(io_error)?;
        let mut guard = self.registry.lock().map_err(io_error)?;
        let mut next = guard.clone();
        let m = next.modules.get_mut(id).ok_or("Module is not installed")?;
        if m.status != "removing" {
            m.status = "removing".into();
            m.generation = m
                .generation
                .checked_add(1)
                .ok_or("Module generation exhausted")?;
            next.generations.insert(id.into(), m.generation);
        }
        let result = m.clone();
        if next.selected_module_id.as_deref() == Some(id) {
            next.selected_module_id = None;
        }
        self.commit(&next)?;
        *guard = next;
        Ok(result)
    }
    pub fn remove_finish(
        &self,
        id: &str,
        vault: &crate::vault::VaultState,
    ) -> Result<Snapshot, String> {
        self.finish_with(id, || {
            self.preserve_provider_credentials(vault, id)?;
            crate::vault::module_secrets_remove(vault, id)
        })?;
        self.snapshot()
    }
    fn finish_with(
        &self,
        id: &str,
        clear: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        self.healthy()?;
        let _mutation = self.mutation.lock().map_err(io_error)?;
        {
            let guard = self.registry.lock().map_err(io_error)?;
            if !guard
                .modules
                .get(id)
                .is_some_and(|m| m.status == "removing")
            {
                return Err("Removal must be durably invalidated first".into());
            }
        }
        clear()?;
        let mut guard = self.registry.lock().map_err(io_error)?;
        let mut next = guard.clone();
        let m = next.modules.get(id).ok_or("Module removal state changed")?;
        if m.status != "removing" {
            return Err("Module removal state changed".into());
        }
        let path = self.code_path(&m.package_hash);
        if path.exists() {
            fs::remove_file(path).map_err(io_error)?;
        }
        next.modules.remove(id);
        self.commit(&next)?;
        *guard = next;
        Ok(())
    }
    pub fn recover(&self, vault: &crate::vault::VaultState) -> Result<(), String> {
        self.healthy()?;
        let pending: Vec<String> = self
            .registry
            .lock()
            .map_err(io_error)?
            .modules
            .values()
            .filter(|m| m.status == "removing")
            .map(|m| m.module_id.clone())
            .collect();
        for id in pending {
            self.remove_finish(&id, vault)?;
        }
        let installed = self.snapshot()?.modules;
        for m in installed.into_iter().filter(|m| m.status == "installed") {
            if let Err(e) = self.package(&ModuleIdentity {
                module_id: m.module_id,
                package_hash: m.package_hash,
                generation: m.generation,
            }) {
                self.diagnostic(e);
            }
        }
        Ok(())
    }
    pub fn diagnostic(&self, message: String) {
        if let Ok(mut d) = self.diagnostics.lock() {
            if !d.contains(&message) {
                if d.len() >= 32 {
                    d.remove(0);
                }
                d.push(message);
            }
        }
    }
    pub fn scan(&self, vault: &crate::vault::VaultState) -> Result<Snapshot, String> {
        self.healthy()?;
        let files = fs::read_dir(self.root.join("inbox")).map_err(io_error)?;
        let mut observed = self.observations.lock().map_err(io_error)?;
        let mut active = std::collections::BTreeSet::new();
        let mut ready = Vec::new();
        for entry in files.take(128) {
            let entry = entry.map_err(io_error)?;
            let path = entry.path();
            if !matches!(path.extension().and_then(|s| s.to_str()), Some("dekxdis-module" | "haven-module")) {
                continue;
            }
            active.insert(path.clone());
            let meta = fs::symlink_metadata(&path).map_err(io_error)?;
            let bytes = match bounded_read(&path) {
                Ok(b) => b,
                Err(e) => {
                    self.diagnostic(format!("Inbox package rejected: {e}"));
                    continue;
                }
            };
            let digest = package::hash(&bytes);
            let modified = meta.modified().map_err(io_error)?;
            if let Some(previous) = observed.get_mut(&path) {
                if previous.length == meta.len()
                    && previous.modified == modified
                    && previous.hash == digest
                {
                    if !previous.attempted
                        && previous.first_seen.elapsed() >= Duration::from_secs(1)
                    {
                        previous.attempted = true;
                        ready.push((path, bytes));
                    }
                    continue;
                }
            }
            observed.insert(
                path,
                Observation {
                    length: meta.len(),
                    modified,
                    hash: digest,
                    first_seen: Instant::now(),
                    attempted: false,
                },
            );
        }
        observed.retain(|p, _| active.contains(p));
        drop(observed);
        for (path, bytes) in ready {
            match self.install(&bytes, vault) {
                Err(e) => self.diagnostic(format!("Inbox package rejected: {e}")),
                Ok(_) => {
                    if bounded_read(&path).ok().as_deref() == Some(bytes.as_slice()) {
                        let processed = self
                            .root
                            .join("processed")
                            .join(format!("{}.dekxdis-module", package::hash(&bytes)));
                        if let Err(e) = atomic_write(&processed, &bytes)
                            .and_then(|_| fs::remove_file(&path).map_err(io_error))
                        {
                            self.diagnostic(format!("Installed package inbox cleanup failed: {e}"));
                        }
                    }
                }
            }
        }
        self.snapshot()
    }
}


