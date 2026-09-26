//! Disposable model requests. This module never signs or places an order.
pub mod profiles;
mod providers;
use serde_json::{json, Value};
use tauri::Manager;

#[tauri::command]
pub async fn automation_decide(session_id: String, instructions: String, packet: Value, image: String) -> Result<String, String> {
    crate::features::require_strategies_enabled()?;
    let profile = profiles::session(&session_id)?;
    let response = tauri::async_runtime::spawn_blocking(move || providers::request(&profile, &instructions, &packet, &image))
        .await.map_err(|_| "The model request could not finish")??;
    // A stopped session cannot deliver a late decision, including after a profile switch.
    profiles::session(&session_id)?;
    Ok(response)
}

#[tauri::command]
pub async fn automation_profile_test(app: tauri::AppHandle, input: profiles::ProfileInput) -> Result<String, String> {
    crate::features::require_strategies_enabled()?;
    let directory = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    let profile = profiles::resolve_draft(&directory, input)?;
    tauri::async_runtime::spawn_blocking(move || {
        let response = providers::request(&profile,
            "Identify the dominant color of the image using one basic English color word. Return only JSON with this shape: {\"color\":\"color name\",\"reason\":\"connection test\",\"orders\":[],\"cancelOrderIds\":[]}. Do not request any trades.",
            &json!({"purpose":"connection test"}), providers::TEST_IMAGE)?;
        let value: Value = serde_json::from_str(providers::strip_fence(&response)).map_err(|_| "The model responded, but did not return valid JSON")?;
        if value["color"].as_str().map(str::to_lowercase).as_deref() != Some("blue")
            || value["orders"] != json!([]) || value["cancelOrderIds"] != json!([]) || !value["reason"].is_string() {
            return Err("The model responded, but did not pass the image and JSON check".into());
        }
        Ok("Connection, image input and JSON response verified".into())
    }).await.map_err(|_| "The connection test could not finish")?
}
