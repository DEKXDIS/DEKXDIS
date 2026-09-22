//! Windows-user-bound, encrypted local persistence. No private key is returned by
//! normal startup/signing commands. Export is a separate explicit user action.
use ethers_core::types::H256;
use ethers_signers::{LocalWallet, MnemonicBuilder, Signer, coins_bip39::{English, Mnemonic}};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, io::Write, path::{Path, PathBuf}, str::FromStr, sync::Mutex};
use tauri::{Manager, State};
use zeroize::{Zeroizing, Zeroize};

const EXPOSED_LEGACY_WALLET: &str = "0xdd81c353024de3f42e173c273ffaddda1cd3eb5f";

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretWallet { address: String, private_key: String, mnemonic: Option<String>, is_custom: bool, #[serde(default)] backed_up: bool }
impl Drop for SecretWallet { fn drop(&mut self) { self.private_key.zeroize(); self.mnemonic.zeroize(); } }
#[derive(Clone, Serialize, Deserialize)]
struct Vault { version: u32, active: String, wallets: BTreeMap<String, SecretWallet>, data: BTreeMap<String, String>, notice: Option<String>,
    #[serde(default)] module_secrets: BTreeMap<String, BTreeMap<String, ModuleSecret>>,
    #[serde(default)] module_secret_revisions: BTreeMap<String, u64>,
    #[serde(default)] provider_secrets: BTreeMap<String, ModuleSecret>,
    #[serde(default)] module_secret_bindings: BTreeMap<String, BTreeMap<String, String>> }
#[derive(Clone, Serialize, Deserialize)]
struct ModuleSecret { value: String }
impl Drop for ModuleSecret { fn drop(&mut self) { self.value.zeroize(); } }
#[derive(Clone, Serialize)]
pub struct ModuleSecretStatus { pub revision: u64, pub configured: Vec<String>, pub shared: Vec<String>, pub conflicts: Vec<String> }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletInfo { address: String, is_custom: bool, needs_backup: bool }
#[derive(Serialize)]
pub struct Startup { wallet: WalletInfo, data: BTreeMap<String, String>, notice: Option<String> }
/// Everything a module needs to reach a provider: its keys, their revisions and which slot maps to
/// which provider. This is its own encrypted file so that saving a key never rewrites the wallet,
/// and the wallet never carries a module's credentials through a re-encrypt.
#[derive(Clone, Default, Serialize, Deserialize)]
struct Secrets {
    #[serde(default)] module_secrets: BTreeMap<String, BTreeMap<String, ModuleSecret>>,
    #[serde(default)] module_secret_revisions: BTreeMap<String, u64>,
    #[serde(default)] provider_secrets: BTreeMap<String, ModuleSecret>,
    #[serde(default)] module_secret_bindings: BTreeMap<String, BTreeMap<String, String>>,
}
pub struct VaultState {
    path: PathBuf,
    data_path: PathBuf,
    secrets_path: PathBuf,
    lock: Mutex<()>,
    cache: Mutex<Option<Zeroizing<Vec<u8>>>>,
    secrets_cache: Mutex<Option<Zeroizing<Vec<u8>>>>,
}



fn err(_: impl std::fmt::Display) -> String { "Unable to read or write the encrypted local vault. No replacement wallet was created. Restore your backup or resolve disk/Windows account access.".into() }
fn wallet_from_input(input: &str) -> Result<SecretWallet, String> {
    let input = input.trim();
    let wallet = if input.split_whitespace().count() > 1 {
        MnemonicBuilder::<English>::default().phrase(input).build().map_err(|_| "Invalid recovery phrase")?
    } else { LocalWallet::from_str(input).map_err(|_| "Invalid private key")? };
    Ok(SecretWallet { address: format!("{:#x}", wallet.address()), private_key: format!("0x{}", ethers_core::utils::hex::encode(wallet.signer().to_bytes())), mnemonic: if input.contains(' ') { Some(input.into()) } else { None }, is_custom: true, backed_up: true })
}
fn new_wallet() -> Result<SecretWallet, String> {
    let phrase = Zeroizing::new(Mnemonic::<English>::new(&mut rand::rngs::OsRng).to_phrase());
    let mut wallet = wallet_from_input(&phrase)
        .map_err(|_| "Unable to generate a recovery-phrase wallet. No wallet was created.".to_string())?;
    wallet.is_custom = false;
    wallet.backed_up = false;
    Ok(wallet)
}
fn info(w: &SecretWallet) -> WalletInfo { WalletInfo { address: w.address.clone(), is_custom: w.is_custom, needs_backup: !w.backed_up } }

fn confirm_backup(vault: &mut Vault, address: &str, suffix: &str) -> Result<WalletInfo, String> {
    if vault.active != address.to_lowercase() { return Err("Wallet changed; back up the active wallet.".into()); }
    let wallet = vault.wallets.get_mut(&vault.active).ok_or_else(|| err("missing wallet"))?;
    if suffix.len() != 6 || !wallet.private_key.ends_with(&suffix.to_lowercase()) {
        return Err("The last six characters do not match. Check your written private key.".into());
    }
    wallet.backed_up = true;
    Ok(info(wallet))
}

#[tauri::command]
pub fn wallet_confirm_backup(state: State<VaultState>, address: String, suffix: String) -> Result<WalletInfo, String> {
    let _guard = state.lock.lock().map_err(err)?;
    let mut vault = state.read()?;
    let result = confirm_backup(&mut vault, &address, &suffix)?;
    state.write(&vault)?;
    Ok(result)
}

#[cfg(windows)]
fn crypt(input: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::{Foundation::LocalFree, Security::Cryptography::{CRYPT_INTEGER_BLOB, CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN}};
    let source = CRYPT_INTEGER_BLOB { cbData: input.len().try_into().map_err(err)?, pbData: input.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    unsafe {
        let ok = if encrypt { CryptProtectData(&source, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output) }
        else { CryptUnprotectData(&source, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output) };
        if ok == 0 { return Err(err(std::io::Error::last_os_error())); }
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        std::ptr::write_bytes(output.pbData, 0, output.cbData as usize);
        LocalFree(output.pbData as *mut _);
        Ok(bytes)
    }
}
#[cfg(not(windows))]
fn crypt(_: &[u8], _: bool) -> Result<Vec<u8>, String> { Err("This secure wallet build requires Windows. No plaintext fallback is available.".into()) }

fn plain_bytes(vault: &Vault) -> Result<Zeroizing<Vec<u8>>, String> {
    // Older hosts must reject V3 instead of silently dropping provider credentials.
    let mut persisted = vault.clone();
    persisted.version = 3;
    Ok(Zeroizing::new(serde_json::to_vec(&persisted).map_err(err)?))
}
fn write_plain(path: &Path, plain: &[u8]) -> Result<(), String> {
    let encrypted = crypt(plain, true)?;
    let parent = path.parent().ok_or_else(|| err("path"))?;
    fs::create_dir_all(parent).map_err(err)?;
    let temp = path.with_extension("tmp");
    let mut file = fs::File::create(&temp).map_err(err)?;
    file.write_all(&encrypted).map_err(err)?;
    file.sync_all().map_err(err)?;
    drop(file);
    #[cfg(windows)] {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH};
        let from: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) } == 0 { return Err(err(std::io::Error::last_os_error())); }
    }
    #[cfg(not(windows))] fs::rename(temp, path).map_err(err)?;
    Ok(())
}
impl VaultState {
    /// The decrypted vault is held in memory after its first read. Every module event checks the
    /// active wallet and the credential revision, so without this each step of a strategy paid for
    /// a full disk read and DPAPI decrypt several times over.
    fn read(&self) -> Result<Vault, String> {
        if let Some(plain) = self.cache.lock().map_err(err)?.as_ref() {
            return parse(&plain);
        }
        let bytes = fs::read(&self.path).map_err(err)?;
        let plain = Zeroizing::new(crypt(&bytes, false)?);
        let vault = parse(&plain)?;
        *self.cache.lock().map_err(err)? = Some(plain);
        Ok(vault)
    }
    fn write(&self, vault: &Vault) -> Result<(), String> {
        let plain = plain_bytes(vault)?;
        write_plain(&self.path, &plain)?;
        *self.cache.lock().map_err(err)? = Some(plain);
        Ok(())
    }
    /// The module credentials live in their own encrypted file, read on first use and written only
    /// when a key is saved or removed.
    fn read_secrets(&self) -> Result<Secrets, String> {
        if let Some(plain) = self.secrets_cache.lock().map_err(err)?.as_ref() {
            return serde_json::from_slice(plain).map_err(err);
        }
        if !self.secrets_path.exists() { return Ok(Secrets::default()); }
        let bytes = fs::read(&self.secrets_path).map_err(err)?;
        let plain = Zeroizing::new(crypt(&bytes, false)?);
        let secrets: Secrets = serde_json::from_slice(&plain).map_err(err)?;
        *self.secrets_cache.lock().map_err(err)? = Some(plain);
        Ok(secrets)
    }
    fn write_secrets(&self, secrets: &Secrets) -> Result<(), String> {
        let plain = Zeroizing::new(serde_json::to_vec(secrets).map_err(err)?);
        write_plain(&self.secrets_path, &plain)?;
        *self.secrets_cache.lock().map_err(err)? = Some(plain);
        Ok(())
    }
}
fn parse(plain: &[u8]) -> Result<Vault, String> {
    let vault: Vault = serde_json::from_slice(plain).map_err(err)?;
    if !matches!(vault.version, 1 | 2 | 3) || !vault.wallets.contains_key(&vault.active) { return Err(err("invalid vault")); }
    Ok(vault)
}
pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let root = app.path().app_local_data_dir()?;
    app.manage(VaultState {
        path: root.join("haven-vault.dpapi"),
        data_path: root.join("haven-data.json"),
        secrets_path: root.join("haven-secrets.dpapi"),
        lock: Mutex::new(()),
        cache: Mutex::new(None),
        secrets_cache: Mutex::new(None),
    });
    Ok(())
}

/// Everything that is not a secret: settings, orders, chart markers, module state.
///
/// This is deliberately a separate plain file. It changes on almost every action, and keeping it
/// inside the encrypted vault meant the private key was re-encrypted and flushed to disk many times
/// a minute for data that has nothing to do with it. The wallet file is now written only when the
/// wallet itself changes.
fn read_data(path: &Path) -> BTreeMap<String, String> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => BTreeMap::new(),
    }
}
fn write_data(path: &Path, data: &BTreeMap<String, String>) -> Result<(), String> {
    let bytes = serde_json::to_vec(data).map_err(err)?;
    let parent = path.parent().ok_or_else(|| err("path"))?;
    fs::create_dir_all(parent).map_err(err)?;
    let temp = path.with_extension("json.tmp");
    let mut file = fs::File::create(&temp).map_err(err)?;
    file.write_all(&bytes).map_err(err)?;
    drop(file);
    // Atomic replace without a full disk flush: a rename cannot leave a half-written file, and
    // paying for a sync on every settings change is what made the whole program sluggish.
    #[cfg(windows)] {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING};
        let from: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_REPLACE_EXISTING) } == 0 { return Err(err(std::io::Error::last_os_error())); }
    }
    #[cfg(not(windows))] fs::rename(temp, path).map_err(err)?;
    Ok(())
}

#[tauri::command]
pub fn vault_open(state: State<VaultState>, legacy: BTreeMap<String, String>) -> Result<Startup, String> {
    let _guard = state.lock.lock().map_err(err)?;
    let mut vault = if state.path.exists() { state.read()? } else {
        // An interrupted first write is not silently replaced with a new identity.
        if state.path.with_extension("tmp").exists() { return Err(err("interrupted first write")); }
        let mut data = legacy;
        let old = data.remove("haven_defi_terminal_wallet");
        let prior: Option<SecretWallet> = match old {
            Some(raw) => {
                let val: serde_json::Value = serde_json::from_str(&raw).map_err(err)?;
                let input = val.get("privateKey").and_then(|v| v.as_str()).ok_or_else(|| err("legacy key"))?;
                let mut w = wallet_from_input(input)?;
                if val.get("address").and_then(|v| v.as_str()).map(|s| s.to_lowercase()) != Some(w.address.clone()) { return Err("Legacy wallet address/key mismatch. Migration stopped; original data retained.".into()); }
                if let Some(phrase) = val.get("mnemonic").and_then(|v| v.as_str()) {
                    if wallet_from_input(phrase)?.address != w.address { return Err("Legacy recovery phrase does not match the private key. Migration stopped.".into()); }
                    w.mnemonic = Some(phrase.into());
                }
                Some(w)
            }, None => None
        };
        let exposed_legacy_wallet = prior.as_ref().is_some_and(|w| w.address == EXPOSED_LEGACY_WALLET);
        let active = match prior.as_ref() { Some(wallet) => wallet.clone(), None => new_wallet()? };
        let mut wallets = BTreeMap::new();
        if let Some(w) = prior.as_ref() { wallets.insert(w.address.clone(), w.clone()); }
        wallets.insert(active.address.clone(), active.clone());
        // Legacy account-specific data belongs to the previous wallet, never a new one.
        if let Some(w) = prior {
            let keys: Vec<String> = data.keys().filter(|k| account_key(k)).cloned().collect();
            for key in keys { if let Some(value) = data.remove(&key) { data.insert(format!("{}:{}", w.address, key), value); } }
        }
        let vault = Vault { version: 2, active: active.address.clone(), wallets, data, module_secrets: BTreeMap::new(), module_secret_revisions: BTreeMap::new(), provider_secrets: BTreeMap::new(), module_secret_bindings: BTreeMap::new(), notice: if exposed_legacy_wallet { Some(format!("The active legacy wallet ({EXPOSED_LEGACY_WALLET}) was embedded in an earlier DEKXDIS build and may be accessible to others. Transfer its funds to a new wallet as soon as possible.")) } else { Some("Local wallet secured. Back up your private key before depositing funds; Windows-bound storage is not a recovery backup.".into()) } };
        state.write(&vault)?;
        vault
    };
    if vault.version < 3 { state.write(&vault)?; }
    // Settings live beside the vault, not inside it. Anything an older build kept in the encrypted
    // file is moved out once, and the vault is then written without it so the two never share a
    // write again.
    let mut stored = read_data(&state.data_path);
    let migrated = !vault.data.is_empty();
    if migrated {
        for (key, value) in vault.data.iter() { stored.insert(key.clone(), value.clone()); }
        write_data(&state.data_path, &stored)?;
        vault.data = BTreeMap::new();
        if vault.version >= 3 { state.write(&vault)?; }
    }
    // Module credentials move out of the wallet file and into their own encrypted file, so the
    // wallet is never rewritten to save or change a provider key.
    let carried = !vault.module_secrets.is_empty() || !vault.provider_secrets.is_empty()
        || !vault.module_secret_bindings.is_empty() || !vault.module_secret_revisions.is_empty();
    if carried {
        let mut secrets = state.read_secrets()?;
        for (id, slots) in vault.module_secrets.iter() {
            let entry = secrets.module_secrets.entry(id.clone()).or_default();
            for (slot, value) in slots.iter() { entry.insert(slot.clone(), value.clone()); }
        }
        for (id, pairs) in vault.module_secret_bindings.iter() {
            let entry = secrets.module_secret_bindings.entry(id.clone()).or_default();
            for (slot, provider) in pairs.iter() { entry.insert(slot.clone(), provider.clone()); }
        }
        for (provider, value) in vault.provider_secrets.iter() { secrets.provider_secrets.insert(provider.clone(), value.clone()); }
        for (id, revision) in vault.module_secret_revisions.iter() { secrets.module_secret_revisions.insert(id.clone(), *revision); }
        state.write_secrets(&secrets)?;
        vault.module_secrets = BTreeMap::new();
        vault.module_secret_revisions = BTreeMap::new();
        vault.provider_secrets = BTreeMap::new();
        vault.module_secret_bindings = BTreeMap::new();
        state.write(&vault)?;
    }
    Ok(Startup { wallet: info(&vault.wallets[&vault.active]), data: stored, notice: vault.notice })
}
fn account_key(k: &str) -> bool { ["orders", "chart_markers", "token_ladders", "impulse_ladder_settings", "token_strategies", "strategy_config", "tracked_tokens", "submissions", "module_runs", "module_order_intents", "module_config", "module_state", "module_events"].iter().any(|part| k.contains(part)) }

pub(crate) fn module_secret_status(state: &VaultState, module_id: &str) -> Result<ModuleSecretStatus,String> {
    let _guard=state.lock.lock().map_err(err)?;
    let secrets = state.read_secrets()?;
    Ok(secret_status(&secrets, module_id))
}
fn bump_secret_revision(secrets: &mut Secrets, module_id: &str) -> Result<(), String> {
    let revision = secrets.module_secret_revisions.entry(module_id.into()).or_default();
    *revision = revision.checked_add(1).ok_or("Secret revision exhausted")?;
    Ok(())
}
fn secret_status(secrets: &Secrets, module_id: &str) -> ModuleSecretStatus {
    let mut configured: std::collections::BTreeSet<String> = secrets.module_secrets.get(module_id).map(|m| m.keys().cloned().collect()).unwrap_or_default();
    let mut shared = Vec::new();
    let mut conflicts = Vec::new();
    if let Some(bindings) = secrets.module_secret_bindings.get(module_id) {
        for (slot, provider) in bindings {
            shared.push(slot.clone());
            if let Some(saved) = secrets.provider_secrets.get(provider) {
                configured.insert(slot.clone());
                if secrets.module_secrets.get(module_id).and_then(|m| m.get(slot)).is_some_and(|local| local.value != saved.value) {
                    conflicts.push(slot.clone());
                }
            }
        }
    }
    ModuleSecretStatus { revision: *secrets.module_secret_revisions.get(module_id).unwrap_or(&0), configured: configured.into_iter().collect(), shared, conflicts }
}
fn bump_provider_users(secrets: &mut Secrets, provider: &str) -> Result<(), String> {
    let ids: Vec<String> = secrets.module_secret_bindings.iter().filter(|(_, slots)| slots.values().any(|p| p == provider)).map(|(id, _)| id.clone()).collect();
    for id in ids { bump_secret_revision(secrets, &id)?; }
    Ok(())
}
/// Called only with a verified installed manifest under the registry mutation lock.
pub(crate) fn module_secrets_bind(state: &VaultState, module_id: &str, bindings: BTreeMap<String, String>) -> Result<(), String> {
    let _guard = state.lock.lock().map_err(err)?;
    let mut secrets = state.read_secrets()?;
    let mut changed = false;
    if secrets.module_secret_bindings.get(module_id) != Some(&bindings) {
        secrets.module_secret_bindings.insert(module_id.into(), bindings.clone());
        bump_secret_revision(&mut secrets, module_id)?;
        changed = true;
    }
    for (slot, provider) in &bindings {
        if let Some(local) = secrets.module_secrets.get(module_id).and_then(|m| m.get(slot)).cloned() {
            if !secrets.provider_secrets.contains_key(provider) {
                secrets.provider_secrets.insert(provider.clone(), local.clone());
                bump_provider_users(&mut secrets, provider)?;
                changed = true;
            }
            // Preserve unequal pre-existing keys and expose the conflict in status.
            // A user Save resolves it explicitly; no module changes account silently.
            if secrets.provider_secrets[provider].value == local.value {
                secrets.module_secrets.get_mut(module_id).unwrap().remove(slot);
                changed = true;
            }
        }
    }
    if changed { state.write_secrets(&secrets)?; }
    Ok(())
}
pub(crate) fn module_secret_write(state:&VaultState,module_id:&str,slot_id:&str,value:Option<String>)->Result<ModuleSecretStatus,String>{
    let value=value.map(Zeroizing::new);
    if value.as_ref().is_some_and(|s|s.is_empty()||s.len()>8192||s.chars().any(char::is_control)){return Err("Secret must contain 1 to 8192 characters without control characters".into());}
    let _guard=state.lock.lock().map_err(err)?;let mut secrets=state.read_secrets()?;
    if let Some(provider) = secrets.module_secret_bindings.get(module_id).and_then(|m| m.get(slot_id)).cloned() {
        if let Some(value) = value { secrets.provider_secrets.insert(provider.clone(), ModuleSecret { value: value.to_string() }); }
        else { secrets.provider_secrets.remove(&provider); }
        // Explicit replacement/deletion applies to every module using this provider,
        // including older unequal keys retained during migration.
        let users: Vec<(String, String)> = secrets.module_secret_bindings.iter().flat_map(|(id, slots)| slots.iter().filter(|(_, p)| *p == &provider).map(|(slot, _)| (id.clone(), slot.clone()))).collect();
        for (id, slot) in users { if let Some(slots) = secrets.module_secrets.get_mut(&id) { slots.remove(&slot); } }
        bump_provider_users(&mut secrets, &provider)?;
    } else {
        if let Some(value)=value {secrets.module_secrets.entry(module_id.into()).or_default().insert(slot_id.into(),ModuleSecret{value:value.to_string()});}
        else if let Some(slots)=secrets.module_secrets.get_mut(module_id){slots.remove(slot_id);}
        bump_secret_revision(&mut secrets, module_id)?;
    }
    let result=secret_status(&secrets,module_id);state.write_secrets(&secrets)?;Ok(result)
}
pub(crate) fn module_secrets_remove(state:&VaultState,module_id:&str)->Result<(),String>{
    let _guard=state.lock.lock().map_err(err)?;let mut secrets=state.read_secrets()?;
    if !secret_status(&secrets, module_id).conflicts.is_empty() { return Err("This module has a different saved provider key. Save the key you want to use before updating or removing the module.".into()); }
    secrets.module_secrets.remove(module_id);secrets.module_secret_bindings.remove(module_id);bump_secret_revision(&mut secrets,module_id)?;state.write_secrets(&secrets)
}
pub(crate) fn module_secret_inject(state:&VaultState,module_id:&str,slot_id:&str,expected_revision:u64)->Result<Zeroizing<String>,String>{
    let _guard=state.lock.lock().map_err(err)?;let secrets=state.read_secrets()?;
    if *secrets.module_secret_revisions.get(module_id).unwrap_or(&0)!=expected_revision{return Err("Module credential changed; request invalidated".into());}
    if secret_status(&secrets,module_id).conflicts.iter().any(|slot|slot==slot_id) { return Err("This module has a different saved provider key. Save the key you want to use.".into()); }
    let secret=secrets.module_secret_bindings.get(module_id).and_then(|s|s.get(slot_id)).and_then(|provider|secrets.provider_secrets.get(provider))
        .or_else(||secrets.module_secrets.get(module_id).and_then(|s|s.get(slot_id))).ok_or("Configure the module credential before making this request")?;
    Ok(Zeroizing::new(secret.value.clone()))
}
pub(crate) fn require_active_wallet(state:&VaultState,address:&str)->Result<(),String>{let _guard=state.lock.lock().map_err(err)?;if state.read()?.active!=address.to_lowercase(){return Err("Wallet changed; module operation invalidated".into());}Ok(())}

#[tauri::command]
pub fn vault_save(state: State<VaultState>, data: BTreeMap<String, String>) -> Result<(), String> {
    let _guard = state.lock.lock().map_err(err)?;
    if data.contains_key("haven_defi_terminal_wallet") { return Err("Wallet secrets must not be stored as settings".into()); }
    // The wallet file is not touched here. Only what the user's settings and the program's own
    // state need is written, to its own file.
    write_data(&state.data_path, &data)
}
#[tauri::command]
pub fn wallet_list(state: State<VaultState>) -> Result<Vec<WalletInfo>, String> {
    let _guard = state.lock.lock().map_err(err)?;
    let vault = state.read()?;
    Ok(vault.wallets.values().map(info).collect())
}
#[tauri::command]
pub fn wallet_switch(state: State<VaultState>, modules: State<crate::modules::ModuleState>, address: String) -> Result<WalletInfo, String> {
    modules.invalidate_wallet()?;
    let _guard = state.lock.lock().map_err(err)?;
    let mut vault = state.read()?;
    let result = select_wallet(&mut vault, &address)?;
    state.write(&vault)?;
    Ok(result)
}
fn select_wallet(vault: &mut Vault, address: &str) -> Result<WalletInfo, String> {
    let address = address.to_lowercase();
    let wallet = vault.wallets.get(&address).ok_or("Wallet is not saved on this PC")?;
    let result = info(wallet);
    vault.active = address;
    Ok(result)
}
#[tauri::command]
pub fn wallet_replace(state: State<VaultState>, modules: State<crate::modules::ModuleState>, input: Option<String>) -> Result<WalletInfo, String> {
    modules.invalidate_wallet()?;
    let _guard = state.lock.lock().map_err(err)?;
    let mut vault = state.read()?;
    let wallet = match input { Some(input) => { let secret = Zeroizing::new(input); wallet_from_input(&secret)? }, None => new_wallet()? };
    let result = activate_wallet(&mut vault, wallet);
    state.write(&vault)?;
    Ok(result)
}
fn activate_wallet(vault: &mut Vault, mut wallet: SecretWallet) -> WalletInfo {
    // Reimporting a saved private key must not erase its recovery phrase.
    if wallet.mnemonic.is_none() {
        if let Some(saved) = vault.wallets.get(&wallet.address) {
            wallet.mnemonic = saved.mnemonic.clone();
        }
    }
    vault.active = wallet.address.clone();
    let result = info(&wallet);
    vault.wallets.insert(wallet.address.clone(), wallet);
    result
}
#[tauri::command]
pub fn wallet_sign(state: State<VaultState>, address: String, digest: String) -> Result<String, String> {
    let _guard = state.lock.lock().map_err(err)?;
    let vault = state.read()?;
    if vault.active != address.to_lowercase() { return Err("Wallet changed; operation cancelled".into()); }
    let wallet = LocalWallet::from_str(&vault.wallets[&vault.active].private_key).map_err(err)?;
    let digest = H256::from_str(&digest).map_err(|_| "Invalid signing digest")?;
    Ok(format!("0x{}", wallet.sign_hash(digest).map_err(err)?))
}
#[tauri::command]
pub fn wallet_export(state: State<VaultState>, address: String) -> Result<SecretWallet, String> {
    let _guard = state.lock.lock().map_err(err)?;
    let vault = state.read()?;
    if vault.active != address.to_lowercase() { return Err("Wallet changed".into()); }
    Ok(vault.wallets[&vault.active].clone())
}


