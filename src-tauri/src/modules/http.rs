//! Provider-independent public HTTPS transport. Endpoints and credential
//! destinations are signed declarations; packages never receive secret text.
use super::{
    package::{self, field},
    ModuleIdentity, NativeScope,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{
    blocking::Client,
    header::{HeaderName, HeaderValue},
    Url,
};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Read,
    net::{IpAddr, SocketAddr, ToSocketAddrs},
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};
use zeroize::Zeroizing;
pub const IMAGE_BYTES: usize = 2 * 1024 * 1024;
pub const RESPONSE_BYTES: usize = 32 * 1024;

pub struct Blob {
    pub identity: ModuleIdentity,
    pub scope: NativeScope,
    pub data: Vec<u8>,
    pub created: Instant,
    pub metadata: Value,
}
pub fn origin(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "Invalid HTTPS origin")?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() != Some(443)
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || value != url.origin().ascii_serialization()
    {
        return Err("Endpoint must be an exact public HTTPS origin on port 443".into());
    }
    let host = url.host_str().ok_or("HTTPS endpoint needs a hostname")?;
    if host.parse::<IpAddr>().is_ok()
        || !host.contains('.')
        || host.ends_with('.')
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host.ends_with(".test")
        || host.ends_with(".invalid")
        || host == "metadata.google.internal"
    {
        return Err("Only public DNS HTTPS destinations are supported".into());
    }
    Ok(url)
}
fn pointer(value: &str) -> bool {
    value.starts_with('/')
        && value.len() <= 512
        && !value.contains("__proto__")
        && !value.contains("constructor")
        && !value.contains("prototype")
}
pub fn validate_endpoint(ep: &Value, slots: &BTreeSet<&str>) -> Result<(), String> {
    let fields = ep.as_object().ok_or("Invalid endpoint")?;
    if fields.keys().any(|k| {
        !matches!(
            k.as_str(),
            "id" | "origin" | "path" | "method" | "authentication"
        )
    }) {
        return Err("Unsupported endpoint field".into());
    }
    origin(field(ep, "origin")?)?;
    let path = field(ep, "path")?;
    if !path.starts_with('/')
        || path.starts_with("//")
        || path.len() > 1024
        || path
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || matches!(c, '?' | '#' | '\\' | '%'))
        || path.split('/').any(|p| matches!(p, "." | ".."))
    {
        return Err(
            "Endpoint path must be exact without query, fragment, escaping or traversal".into(),
        );
    }
    if !matches!(field(ep, "method")?, "GET" | "POST") {
        return Err("HTTPS v1 supports GET and POST".into());
    }
    if let Some(auth) = ep.get("authentication") {
        if auth
            .as_object()
            .ok_or("Invalid endpoint authentication")?
            .keys()
            .any(|k| !matches!(k.as_str(), "slotId" | "placement" | "name" | "prefix"))
        {
            return Err("Unsupported authentication declaration".into());
        }
        if !slots.contains(field(auth, "slotId")?) {
            return Err("Endpoint references an undeclared secret slot".into());
        }
        let name = field(auth, "name")?;
        match field(auth, "placement")? {
            "header" => {
                HeaderName::from_bytes(name.as_bytes())
                    .map_err(|_| "Invalid authentication header")?;
                if forbidden_header(name) {
                    return Err("Authentication cannot change transport headers".into());
                }
            }
            "body" => {
                if !pointer(name) || ep["method"] != "POST" {
                    return Err(
                        "Body authentication requires POST and an existing JSON pointer".into(),
                    );
                }
            }
            _ => return Err("Unsupported secret injection placement".into()),
        }
        if let Some(prefix) = auth.get("prefix") {
            let p = prefix.as_str().ok_or("Invalid authentication prefix")?;
            if p.len() > 64 || p.chars().any(char::is_control) {
                return Err("Invalid authentication prefix".into());
            }
        }
    }
    Ok(())
}
fn forbidden_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "host"
            | "cookie"
            | "set-cookie"
            | "proxy-authorization"
            | "proxy-connection"
            | "connection"
            | "content-length"
            | "transfer-encoding"
            | "upgrade"
            | "te"
            | "trailer"
            | "expect"
            | "forwarded"
            | "x-forwarded-for"
    )
}
pub fn validate_request(m: &Value, v: &Value) -> Result<(), String> {
    if v.as_object().ok_or("Invalid HTTPS input")?.keys().any(|k| {
        !matches!(
            k.as_str(),
            "endpointId" | "body" | "headers" | "attachments"
        )
    }) {
        return Err("Unsupported HTTPS request field".into());
    }
    let endpoint = m["endpointDeclarations"]
        .as_array()
        .ok_or("Missing endpoint declarations")?
        .iter()
        .find(|e| e["id"].as_str() == v["endpointId"].as_str())
        .ok_or("Undeclared HTTPS endpoint")?;
    if endpoint["method"] == "GET" && (v.get("body").is_some() || v.get("attachments").is_some()) {
        return Err("GET request must not have a body or attachments".into());
    }
    if let Some(headers) = v.get("headers") {
        let headers = headers.as_object().ok_or("Headers must be an object")?;
        if headers.len() > 16 {
            return Err("Too many request headers".into());
        }
        for (k, value) in headers {
            let value = value.as_str().ok_or("Invalid header value")?;
            if k.len() > 128
                || value.len() > 2048
                || forbidden_header(k)
                || k.eq_ignore_ascii_case("authorization")
                || k.eq_ignore_ascii_case(endpoint["authentication"]["name"].as_str().unwrap_or(""))
            {
                return Err("Module cannot supply authentication or transport headers".into());
            }
            HeaderName::from_bytes(k.as_bytes()).map_err(|_| "Invalid header name")?;
            HeaderValue::from_str(value).map_err(|_| "Invalid header value")?;
        }
    }
    if let Some(attachments) = v.get("attachments") {
        let a = attachments.as_array().ok_or("Invalid image attachments")?;
        if a.len() > 4 {
            return Err("Too many image attachments".into());
        }
        let mut pointers = BTreeSet::new();
        for a in a {
            if a.as_object()
                .ok_or("Invalid image attachment")?
                .keys()
                .any(|k| !matches!(k.as_str(), "handle" | "pointer" | "encoding"))
            {
                return Err("Unsupported image attachment field".into());
            }
            let p = field(a, "pointer")?;
            if !pointer(p)
                || !pointers.insert(p)
                || v["body"].pointer(p).is_none()
                || !matches!(field(a, "encoding")?, "data-url" | "base64")
                || field(a, "handle")?.len() > 128
            {
                return Err("Invalid image attachment handle, pointer or encoding".into());
            }
        }
    }
    if endpoint["authentication"]["placement"] == "body"
        && v["body"]
            .pointer(field(&endpoint["authentication"], "name")?)
            .is_none()
    {
        return Err("Body authentication JSON pointer does not exist".into());
    }
    if serde_json::to_vec(v)
        .map_err(|_| "Invalid HTTP JSON")?
        .len()
        > 64 * 1024
    {
        return Err("HTTPS request control exceeds 64 KiB".into());
    }
    Ok(())
}
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let o = ip.octets();
            !ip.is_private()
                && !ip.is_loopback()
                && !ip.is_link_local()
                && !ip.is_unspecified()
                && !ip.is_broadcast()
                && !ip.is_multicast()
                && o[0] != 0
                && o[0] < 224
                && !(o[0] == 100 && (64..=127).contains(&o[1]))
                && !(o[0] == 192 && matches!((o[1], o[2]), (0, 0) | (0, 2) | (88, 99)))
                && !(o[0] == 198 && (o[1] == 18 || o[1] == 19 || o[1] == 51 && o[2] == 100))
                && !(o[0] == 203 && o[1] == 0 && o[2] == 113)
        }
        IpAddr::V6(ip) => {
            let s = ip.segments();
            (s[0] & 0xe000) == 0x2000
                && !(s[0] == 0x2001 && (s[1] < 0x200 || s[1] == 0xdb8))
                && s[0] != 0x2002
        }
    }
}
static DNS_JOBS: AtomicUsize = AtomicUsize::new(0);
fn resolve(host: &str) -> Result<Vec<SocketAddr>, String> {
    if DNS_JOBS
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
            (n < 4).then_some(n + 1)
        })
        .is_err()
    {
        return Err("HTTPS resolver concurrency limit reached".into());
    }
    let host = host.to_string();
    let (tx, rx) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let result = (host.as_str(), 443)
            .to_socket_addrs()
            .map(|a| a.collect::<Vec<_>>());
        let _ = tx.send(result);
        DNS_JOBS.fetch_sub(1, Ordering::SeqCst);
    });
    let addrs = rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "HTTPS DNS resolution timed out")?
        .map_err(|_| "HTTPS DNS resolution failed")?;
    if addrs.is_empty() || addrs.len() > 32 || addrs.iter().any(|a| !is_public(a.ip())) {
        return Err("HTTPS destination resolved to a blocked address".into());
    }
    Ok(addrs)
}
fn prepare_request(
    client: &Client,
    manifest: &Value,
    input: &Value,
    identity: &ModuleIdentity,
    scope: &NativeScope,
    blobs: &BTreeMap<String, Blob>,
    secret: Option<&str>,
) -> Result<reqwest::blocking::Request, String> {
    validate_request(manifest, input)?;
    let endpoint = manifest["endpointDeclarations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == input["endpointId"])
        .unwrap();
    let origin = origin(field(endpoint, "origin")?)?;
    let url = format!(
        "{}{}",
        origin.origin().ascii_serialization(),
        field(endpoint, "path")?
    );
    let mut builder = if endpoint["method"] == "GET" {
        client.get(url)
    } else {
        client.post(url)
    };
    if let Some(headers) = input["headers"].as_object() {
        for (k, v) in headers {
            builder = builder.header(k, v.as_str().unwrap());
        }
    }
    let mut body = input.get("body").cloned().unwrap_or(Value::Null);
    if let Some(attachments) = input["attachments"].as_array() {
        for a in attachments {
            let blob = blobs
                .get(field(a, "handle")?)
                .ok_or("Image handle expired or is unavailable")?;
            if &blob.identity != identity
                || &blob.scope != scope
                || blob.created.elapsed() > Duration::from_secs(120)
            {
                return Err("Image handle belongs to a different or expired run".into());
            }
            let encoded = STANDARD.encode(&blob.data);
            let value = if a["encoding"] == "data-url" {
                format!("data:image/png;base64,{encoded}")
            } else {
                encoded
            };
            *body
                .pointer_mut(field(a, "pointer")?)
                .ok_or("Image attachment pointer is missing")? = Value::String(value);
        }
    }
    if let Some(auth) = endpoint.get("authentication") {
        let secret = secret.ok_or("Module credential is not configured")?;
        let injected = Zeroizing::new(format!(
            "{}{}",
            auth["prefix"].as_str().unwrap_or(""),
            secret
        ));
        match auth["placement"].as_str() {
            Some("header") => {
                let mut value = HeaderValue::from_str(&injected)
                    .map_err(|_| "Credential cannot be encoded in the declared header")?;
                value.set_sensitive(true);
                builder = builder.header(field(auth, "name")?, value);
            }
            Some("body") => {
                *body
                    .pointer_mut(field(auth, "name")?)
                    .ok_or("Authentication pointer is missing")? =
                    Value::String(injected.to_string());
            }
            _ => return Err("Unsupported credential placement".into()),
        }
    }
    if endpoint["method"] == "POST" {
        let bytes =
            Zeroizing::new(serde_json::to_vec(&body).map_err(|_| "Unable to encode HTTPS body")?);
        if bytes.len() > 12 * 1024 * 1024 {
            return Err("HTTPS body exceeds attachment limit".into());
        }
        builder = builder
            .header("content-type", "application/json")
            .body(bytes.to_vec());
    }
    builder
        .build()
        .map_err(|_| "Unable to prepare bounded HTTPS request".to_string())
}
pub fn execute(
    manifest: &Value,
    input: &Value,
    identity: &ModuleIdentity,
    scope: &NativeScope,
    blobs: &BTreeMap<String, Blob>,
    secret: Option<Zeroizing<String>>,
    still_current: impl Fn() -> Result<(), String>,
) -> Result<Value, String> {
    validate_request(manifest, input)?;
    let endpoint = manifest["endpointDeclarations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["id"] == input["endpointId"])
        .unwrap();
    let origin = origin(field(endpoint, "origin")?)?;
    let host = origin.host_str().unwrap();
    let addrs = resolve(host)?;
    let client = Client::builder()
        .https_only(true)
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(5))
        .resolve_to_addrs(host, &addrs)
        .user_agent("DEKXDIS-Module-Host/1")
        .build()
        .map_err(|_| "Unable to initialize HTTPS transport")?;
    let request = prepare_request(
        &client,
        manifest,
        input,
        identity,
        scope,
        blobs,
        secret.as_ref().map(|s| s.as_str()),
    )?;
    still_current()?;
    let response = client.execute(request).map_err(|e| {
        if e.is_timeout() {
            "HTTPS request timed out"
        } else {
            "HTTPS transport failed; check the configured endpoint and connection"
        }
    })?;
    let status = response.status().as_u16();
    if response.status().is_redirection() {
        return Err("HTTPS redirects are forbidden".into());
    }
    if response
        .content_length()
        .is_some_and(|n| n > RESPONSE_BYTES as u64)
    {
        return Err("HTTPS response exceeds 32 KiB".into());
    }
    let mut bytes = Zeroizing::new(Vec::new());
    response
        .take((RESPONSE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "Unable to read HTTPS response")?;
    if bytes.len() > RESPONSE_BYTES {
        return Err("HTTPS response exceeds 32 KiB".into());
    }
    if let Some(secret) = secret.as_ref() {
        if bytes.windows(secret.len()).any(|w| w == secret.as_bytes()) {
            return Err("HTTPS response contained credential material and was withheld".into());
        }
    }
    still_current()?;
    let result = response_value(&bytes, secret.as_ref().map(|s| s.as_str()))?;
    Ok(serde_json::json!({"status":status,"body":result,"receivedAt":super::now_ms()}))
}
fn response_value(bytes: &[u8], secret: Option<&str>) -> Result<Value, String> {
    let result = package::parse_json(bytes, RESPONSE_BYTES).or_else(|_| {
        String::from_utf8(bytes.to_vec())
            .map(Value::String)
            .map_err(|_| "HTTPS response must be UTF-8 text or JSON".to_string())
    })?;
    fn contains(v: &Value, secret: &str) -> bool {
        match v {
            Value::String(s) => s.contains(secret),
            Value::Array(a) => a.iter().any(|v| contains(v, secret)),
            Value::Object(o) => o
                .iter()
                .any(|(k, v)| k.contains(secret) || contains(v, secret)),
            _ => false,
        }
    }
    if secret.is_some_and(|s| !s.is_empty() && contains(&result, s)) {
        return Err("HTTPS response contained credential material and was withheld".into());
    }
    Ok(result)
}


