//! Provider identity comes from verified HTTP declarations, never labels or module IDs.
use super::package::field;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub fn bindings(manifest: &Value) -> Result<BTreeMap<String, String>, String> {
    let mut destinations: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for endpoint in manifest["endpointDeclarations"].as_array().ok_or("Missing endpoint declarations")? {
        if let Some(auth) = endpoint.get("authentication") {
            let origin = reqwest::Url::parse(field(endpoint, "origin")?).map_err(|_| "Invalid credential origin")?;
            let placement = field(auth, "placement")?;
            let name = field(auth, "name")?;
            // Header names are case insensitive; JSON body pointers are not.
            let name = if placement == "header" { name.to_ascii_lowercase() } else { name.into() };
            let scope = serde_json::to_string(&(origin.origin().ascii_serialization(), placement, name, auth["prefix"].as_str().unwrap_or("")))
                .map_err(|_| "Unable to identify provider credential")?;
            destinations.entry(field(auth, "slotId")?.into()).or_default().insert(scope);
        }
    }
    // A key explicitly used across different destinations stays module-local.
    // Never export a provider key to an additional origin through a shared slot.
    Ok(destinations.into_iter().filter_map(|(slot, scopes)| {
        (scopes.len() == 1).then(|| (slot, scopes.into_iter().next().unwrap()))
    }).collect())
}


