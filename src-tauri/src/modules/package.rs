//! Signed, bounded JSON packages. Public trust roots belong to the host build,
//! never to the downloaded envelope. No installation code is evaluated here.
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{
    de::{self, MapAccess, SeqAccess, Visitor},
    Deserialize, Deserializer, Serialize,
};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fmt};

pub const ENVELOPE_BYTES: usize = 2 * 1024 * 1024;
pub const PAYLOAD_BYTES: usize = 1024 * 1024;
pub const SOURCE_BYTES: usize = 512 * 1024;
pub const STATE_BYTES: usize = 256 * 1024;
pub const OUTPUT_BYTES: usize = 64 * 1024;
pub const HOST_API_VERSION: u64 = 1;
pub const HOST_VERSION: &str = "1.2.6";
pub const CAPABILITIES: &[&str] = &[
    "market.price.v1",
    "market.candles.v1",
    "chart.snapshot.v1",
    "events.schedule.v1",
    "state.module.v1",
    "http.request.v1",
    "secrets.inject.v1",
    "orders.limit-entry.v1", "orders.limit-exit.v1",
    "orders.protection.v1",
    "orders.observe.v1",
    "orders.funding.v1",
    "orders.cancel.v1",
    "ui.module.v1",
    "log.module.v1",
];

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    format_version: u32,
    publisher_key_id: String,
    base64_payload: String,
    signature: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Payload {
    pub manifest: Value,
    pub entrypoint_source: String,
    pub resources: BTreeMap<String, Value>,
}
#[derive(Clone)]
pub struct VerifiedPackage {
    pub payload: Payload,
    pub hash: String,
    pub envelope: Vec<u8>,
}

// serde_json::Value normally accepts duplicate members. Deserialize recursively
// through this visitor first so signatures cannot hide an alternative meaning.
struct Unique(Value);
impl<'de> Deserialize<'de> for Unique {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct UniqueVisitor;
        impl<'de> Visitor<'de> for UniqueVisitor {
            type Value = Unique;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("JSON without duplicate properties")
            }
            fn visit_bool<E: de::Error>(self, v: bool) -> Result<Unique, E> {
                Ok(Unique(Value::Bool(v)))
            }
            fn visit_i64<E: de::Error>(self, v: i64) -> Result<Unique, E> {
                Ok(Unique(v.into()))
            }
            fn visit_u64<E: de::Error>(self, v: u64) -> Result<Unique, E> {
                Ok(Unique(v.into()))
            }
            fn visit_f64<E: de::Error>(self, v: f64) -> Result<Unique, E> {
                serde_json::Number::from_f64(v)
                    .map(|n| Unique(Value::Number(n)))
                    .ok_or_else(|| E::custom("non-finite JSON"))
            }
            fn visit_str<E: de::Error>(self, v: &str) -> Result<Unique, E> {
                Ok(Unique(v.into()))
            }
            fn visit_string<E: de::Error>(self, v: String) -> Result<Unique, E> {
                Ok(Unique(v.into()))
            }
            fn visit_none<E: de::Error>(self) -> Result<Unique, E> {
                Ok(Unique(Value::Null))
            }
            fn visit_unit<E: de::Error>(self) -> Result<Unique, E> {
                Ok(Unique(Value::Null))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Unique, A::Error> {
                let mut v = Vec::new();
                while let Some(Unique(x)) = a.next_element()? {
                    v.push(x)
                }
                Ok(Unique(Value::Array(v)))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<Unique, A::Error> {
                let mut v = Map::new();
                while let Some(k) = a.next_key::<String>()? {
                    if v.contains_key(&k) {
                        return Err(de::Error::custom("duplicate JSON property"));
                    }
                    let Unique(x) = a.next_value()?;
                    v.insert(k, x);
                }
                Ok(Unique(Value::Object(v)))
            }
        }
        d.deserialize_any(UniqueVisitor)
    }
}
pub fn parse_json(bytes: &[u8], max: usize) -> Result<Value, String> {
    if bytes.len() > max {
        return Err("JSON size limit exceeded".into());
    }
    let Unique(v) =
        serde_json::from_slice(bytes).map_err(|_| "Invalid JSON or duplicate properties")?;
    fn depth(v: &Value, n: usize) -> bool {
        n <= 32
            && match v {
                Value::Array(a) => a.iter().all(|v| depth(v, n + 1)),
                Value::Object(o) => o.values().all(|v| depth(v, n + 1)),
                _ => true,
            }
    }
    if !depth(&v, 0) {
        return Err("JSON nesting limit exceeded".into());
    }
    Ok(v)
}
pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn signed_bytes(version: u32, key_id: &str, payload: &[u8]) -> Vec<u8> {
    let mut b = b"HAVEN-MODULE\0".to_vec();
    b.extend_from_slice(&version.to_be_bytes());
    b.extend_from_slice(&(key_id.len() as u32).to_be_bytes());
    b.extend_from_slice(key_id.as_bytes());
    b.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    b.extend_from_slice(payload);
    b
}
pub fn trusted_keys() -> Result<BTreeMap<String, [u8; 32]>, String> {
    let mut keys = BTreeMap::new();
    match (
        option_env!("DEKXDIS_MODULE_PUBLISHER_KEY_ID"),
        option_env!("DEKXDIS_MODULE_PUBLISHER_PUBLIC_KEY"),
    ) {
        (Some(id), Some(public)) => {
            if !identifier(id) {
                return Err("Invalid pinned publisher key ID".into());
            }
            let bytes = STANDARD
                .decode(public)
                .map_err(|_| "Invalid pinned publisher public key")?;
            keys.insert(
                id.into(),
                bytes
                    .try_into()
                    .map_err(|_| "Publisher key must be 32 bytes")?,
            );
        }
        (None, None) => {}
        _ => return Err("Incomplete publisher trust configuration".into()),
    }
    
    Ok(keys)
}
pub fn verify(bytes: &[u8], keys: &BTreeMap<String, [u8; 32]>) -> Result<VerifiedPackage, String> {
    let envelope: Envelope = serde_json::from_value(parse_json(bytes, ENVELOPE_BYTES)?)
        .map_err(|_| "Invalid package envelope fields")?;
    if envelope.format_version != 1 {
        return Err("Unsupported package format version".into());
    }
    let key = keys
        .get(&envelope.publisher_key_id)
        .ok_or("Publisher key is not trusted by this host build")?;
    let payload = STANDARD
        .decode(&envelope.base64_payload)
        .map_err(|_| "Invalid payload encoding")?;
    if payload.len() > PAYLOAD_BYTES {
        return Err("Package payload exceeds 1 MiB".into());
    }
    let signature = STANDARD
        .decode(&envelope.signature)
        .map_err(|_| "Invalid signature encoding")?;
    let signature =
        Signature::from_slice(&signature).map_err(|_| "Invalid Ed25519 signature length")?;
    VerifyingKey::from_bytes(key)
        .map_err(|_| "Invalid trusted publisher key")?
        .verify_strict(
            &signed_bytes(1, &envelope.publisher_key_id, &payload),
            &signature,
        )
        .map_err(|_| "Package signature verification failed")?;
    let decoded: Payload = serde_json::from_value(parse_json(&payload, PAYLOAD_BYTES)?)
        .map_err(|_| "Invalid package payload fields")?;
    validate_manifest(&decoded.manifest)?;
    if decoded.entrypoint_source.is_empty()
        || decoded.entrypoint_source.len() > SOURCE_BYTES
        || decoded.entrypoint_source.contains('\0')
    {
        return Err("Invalid or oversized JavaScript entrypoint".into());
    }
    // No loader is linked into the runtime. Reject authoring artifacts upfront;
    // dynamic import also cannot resolve anything in the isolated interpreter.
    if decoded.entrypoint_source.lines().any(|line| {
        let s = line.trim_start();
        s.starts_with("import ") || s.starts_with("export ")
    }) {
        return Err("Entrypoint must be bundled JavaScript without external imports".into());
    }
    if decoded.resources.len() > 32
        || decoded.resources.keys().any(|k| !identifier(k))
        || serde_json::to_vec(&decoded.resources)
            .map_err(|_| "Invalid package resources")?
            .len()
            > 32 * 1024
    {
        return Err("Invalid declarative resources".into());
    }
    Ok(VerifiedPackage {
        payload: decoded,
        hash: hash(&payload),
        envelope: bytes.to_vec(),
    })
}
pub fn identifier(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 96
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
}
fn field_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.as_bytes()[0].is_ascii_alphabetic()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}
fn module_id(id: &str) -> bool {
    (3..=64).contains(&id.len())
        && id.as_bytes()[0].is_ascii_lowercase()
        && !id.contains("..")
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'-'))
}
fn exact(v: &Value, required: &[&str], optional: &[&str]) -> Result<(), String> {
    let o = v.as_object().ok_or("Manifest element must be an object")?;
    if required.iter().any(|k| !o.contains_key(*k))
        || o.keys()
            .any(|k| !required.contains(&k.as_str()) && !optional.contains(&k.as_str()))
    {
        return Err("Manifest has missing or unsupported fields".into());
    }
    Ok(())
}
pub fn field<'a>(v: &'a Value, k: &str) -> Result<&'a str, String> {
    v.get(k)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Missing or invalid {k}"))
}
pub fn has_capability(m: &Value, cap: &str) -> bool {
    m["requestedCapabilities"]
        .as_array()
        .is_some_and(|a| a.iter().any(|c| c.as_str() == Some(cap)))
}
pub fn validate_manifest(m: &Value) -> Result<(), String> {
    if !m.is_object() {
        return Err("Manifest must be an object".into());
    }
    exact(
        m,
        &[
            "moduleId",
            "moduleVersion",
            "name",
            "description",
            "hostApiVersion",
            "minimumHostVersion",
            "requestedCapabilities",
            "supportedChains",
            "configurationSchema",
            "secretSlots",
            "viewSchema",
            "endpointDeclarations",
            "eventSubscriptions",
            "stateSchemaVersion",
            "resourceRequirements",
        ],
        &["tradeCountControl", "orderAmountControl"],
    )?;
    if m.get("tradeCountControl").is_some() && m["tradeCountControl"].as_str() != Some("module") {
        return Err("Invalid trade count control".into());
    }
    if m.get("orderAmountControl").is_some() && m["orderAmountControl"].as_str() != Some("module") {
        return Err("Invalid order amount control".into());
    }
    if !module_id(field(m, "moduleId")?) {
        return Err("Invalid module ID".into());
    }
    let version = semver::Version::parse(field(m, "moduleVersion")?)
        .map_err(|_| "Invalid module semantic version")?;
    if !version.pre.is_empty() || !version.build.is_empty() {
        return Err("Use a major.minor.patch module version".into());
    }
    if m["hostApiVersion"].as_u64() != Some(HOST_API_VERSION) {
        return Err("Unsupported host API version".into());
    }
    let min = semver::Version::parse(field(m, "minimumHostVersion")?)
        .map_err(|_| "Invalid minimum host version")?;
    if min > semver::Version::parse(HOST_VERSION).unwrap() {
        return Err("Module requires a newer DEKXDIS host".into());
    }
    for (key, max) in [("name", 100), ("description", 1000)] {
        let v = field(m, key)?;
        if v.trim().is_empty() || v.len() > max {
            return Err(format!("Invalid manifest {key}"));
        }
    }
    let caps = m["requestedCapabilities"]
        .as_array()
        .ok_or("Capabilities must be an array")?;
    if caps.len() > CAPABILITIES.len() {
        return Err("Too many capabilities".into());
    }
    let mut seen = std::collections::BTreeSet::new();
    for cap in caps {
        let c = cap.as_str().ok_or("Invalid capability")?;
        if !CAPABILITIES.contains(&c) || !seen.insert(c) {
            return Err(format!("Unsupported or duplicate capability: {c}"));
        }
    }
    let chains = m["supportedChains"]
        .as_array()
        .ok_or("supportedChains must be an array")?;
    if chains.is_empty()
        || chains.len() > 16
        || chains.iter().any(|c| {
            !matches!(
                c.as_u64(),
                Some(1 | 56 | 100 | 137 | 42161 | 8453 | 43114 | 10)
            )
        })
    {
        return Err("Unsupported chain".into());
    }
    if !m["stateSchemaVersion"]
        .as_u64()
        .is_some_and(|v| v > 0 && v <= 1000000)
    {
        return Err("Invalid state schema version".into());
    }
    let config = m["configurationSchema"]
        .as_array()
        .ok_or("Invalid configurationSchema")?;
    if config.len() > 32 {
        return Err("Too many configuration fields".into());
    }
    let mut config_keys = std::collections::BTreeSet::new();
    for f in config {
        exact(
            f,
            &["key", "label", "type", "default"],
            &[
                "required",
                "min",
                "max",
                "maxLength",
                "options",
                "description",
                "group",
                "lines",
            ],
        )?;
        let k = field(f, "key")?;
        if !field_id(k)
            || !config_keys.insert(k)
            || !matches!(
                field(f, "type")?,
                "string" | "number" | "boolean" | "select"
            )
            || field(f, "label")?.len() > 120
        {
            return Err("Invalid configuration field".into());
        }
        if f.get("required").is_some_and(|v| !v.is_boolean())
            || f.get("maxLength")
                .is_some_and(|v| !v.as_u64().is_some_and(|n| (1..=2048).contains(&n)))
            || f.get("lines")
                .is_some_and(|v| !v.as_u64().is_some_and(|n| (2..=40).contains(&n)))
        {
            return Err("Invalid configuration constraint".into());
        }
        for key in ["min", "max"] {
            if f.get(key).is_some_and(|v| !v.is_number()) {
                return Err("Invalid numeric constraint".into());
            }
        }
        if let (Some(min), Some(max)) = (f["min"].as_f64(), f["max"].as_f64()) {
            if min > max {
                return Err("Configuration minimum exceeds maximum".into());
            }
        }
        match field(f, "type")? {
            "boolean" => {
                if !f["default"].is_boolean() {
                    return Err("Boolean field requires boolean default".into());
                }
            }
            "number" => {
                if !f["default"].is_number()
                    && !f["default"]
                        .as_str()
                        .is_some_and(|s| s.is_empty() || s.parse::<f64>().is_ok_and(f64::is_finite))
                {
                    return Err("Number field requires a numeric default".into());
                }
            }
            _ => {
                if !f["default"]
                    .as_str()
                    .is_some_and(|s| s.len() <= f["maxLength"].as_u64().unwrap_or(2048) as usize)
                {
                    return Err("String field requires a bounded string default".into());
                }
            }
        }
        if f["type"] == "select" {
            let options = f["options"]
                .as_array()
                .ok_or("Select options are required")?;
            if options.is_empty()
                || options.len() > 32
                || !options.iter().any(|o| o["value"] == f["default"])
            {
                return Err("Invalid select choices/default".into());
            }
            let mut values = std::collections::BTreeSet::new();
            for option in options {
                exact(option, &["label", "value"], &[])?;
                if field(option, "label")?.len() > 120
                    || field(option, "value")?.len() > 256
                    || !values.insert(field(option, "value")?)
                {
                    return Err("Invalid select option".into());
                }
            }
        } else if f.get("options").is_some() {
            return Err("Options are only supported for select controls".into());
        }
    }
    exact(&m["viewSchema"], &["fields", "buttons"], &[])?;
    let views = m["viewSchema"]["fields"]
        .as_array()
        .ok_or("Invalid view fields")?;
    let buttons = m["viewSchema"]["buttons"]
        .as_array()
        .ok_or("Invalid view buttons")?;
    if views.len() > 32 || buttons.len() > 16 {
        return Err("Too many view controls".into());
    }
    let mut view_keys = std::collections::BTreeSet::new();
    for f in views {
        exact(f, &["key", "label", "type"], &[])?;
        if !field_id(field(f, "key")?)
            || !view_keys.insert(field(f, "key")?)
            || field(f, "label")?.len() > 120
            || !matches!(field(f, "type")?, "text" | "number" | "image" | "table")
        {
            return Err("Invalid view field".into());
        }
    }
    let mut button_ids = std::collections::BTreeSet::new();
    for b in buttons {
        exact(b, &["id", "label"], &[])?;
        if !field_id(field(b, "id")?)
            || !button_ids.insert(field(b, "id")?)
            || field(b, "label")?.len() > 120
        {
            return Err("Invalid view button".into());
        }
    }
    if (!views.is_empty() || !buttons.is_empty()) && !has_capability(m, "ui.module.v1") {
        return Err("Views require ui.module.v1".into());
    }
    let slots = m["secretSlots"]
        .as_array()
        .ok_or("secretSlots must be an array")?;
    if slots.len() > 16 {
        return Err("Too many secret slots".into());
    }
    let mut slot_ids = std::collections::BTreeSet::new();
    for slot in slots {
        exact(slot, &["id", "label", "required"], &[])?;
        let id = field(slot, "id")?;
        if !field_id(id)
            || !slot_ids.insert(id)
            || !slot["required"].is_boolean()
            || field(slot, "label")?.len() > 120
        {
            return Err("Invalid or duplicate secret slot".into());
        }
    }
    if !slots.is_empty() && !has_capability(m, "secrets.inject.v1") {
        return Err("Secret slots require secrets.inject.v1".into());
    }
    let endpoints = m["endpointDeclarations"]
        .as_array()
        .ok_or("endpointDeclarations must be an array")?;
    if endpoints.len() > 16 {
        return Err("Too many endpoints".into());
    }
    let mut endpoint_ids = std::collections::BTreeSet::new();
    for ep in endpoints {
        let id = field(ep, "id")?;
        if !field_id(id) || !endpoint_ids.insert(id) {
            return Err("Invalid or duplicate endpoint ID".into());
        }
        super::http::validate_endpoint(ep, &slot_ids)?;
    }
    if !endpoints.is_empty() && !has_capability(m, "http.request.v1") {
        return Err("Endpoints require http.request.v1".into());
    }
    let events = m["eventSubscriptions"]
        .as_array()
        .ok_or("eventSubscriptions must be an array")?;
    if events.len() > 16 {
        return Err("Too many event subscriptions".into());
    }
    for e in events {
        match field(e, "type")? {
            "timer" | "price" => {
                exact(e, &["type", "intervalMs"], &[])?;
                if !e["intervalMs"]
                    .as_u64()
                    .is_some_and(|n| (6000..=86_400_000).contains(&n))
                    || !has_capability(m, "events.schedule.v1")
                    || e["type"] == "price" && !has_capability(m, "market.price.v1")
                {
                    return Err("Invalid event interval or capability".into());
                }
            }
            "candle-close" => {
                exact(e, &["type", "timeframe"], &[])?;
                if !timeframe(field(e, "timeframe")?)
                    || !has_capability(m, "events.schedule.v1")
                    || !has_capability(m, "market.candles.v1")
                {
                    return Err("Unsupported candle subscription".into());
                }
            }
            "order" => {
                exact(e, &["type"], &[])?;
                if !has_capability(m, "orders.observe.v1") {
                    return Err("Order subscriptions require orders.observe.v1".into());
                }
            }
            _ => return Err("Unsupported event subscription".into()),
        }
    }
    exact(
        &m["resourceRequirements"],
        &["memoryMb", "cpuMs", "maxStateBytes"],
        &[],
    )?;
    for (name, limit) in [
        ("memoryMb", 32),
        ("cpuMs", 250),
        ("maxStateBytes", STATE_BYTES),
    ] {
        if !m["resourceRequirements"][name]
            .as_u64()
            .is_some_and(|n| n > 0 && n <= limit as u64)
        {
            return Err(format!("Unsupported resource requirement: {name}"));
        }
    }
    Ok(())
}
pub fn timeframe(v: &str) -> bool {
    matches!(v, "1m" | "5m" | "15m" | "1h" | "4h" | "1d")
}


