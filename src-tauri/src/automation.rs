//! One disposable vision request. This module never signs or places an order.
use serde_json::{json, Value};
use std::{fs, path::PathBuf, time::Duration};
use tauri::Manager;
use zeroize::Zeroizing;

fn key_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("automation-openai.dpapi"))
}

#[tauri::command]
pub fn automation_key_status(app: tauri::AppHandle) -> Result<bool, String> {
    Ok(key_path(&app)?.is_file())
}

#[tauri::command]
pub fn automation_key_save(app: tauri::AppHandle, key: String) -> Result<(), String> {
    crate::features::require_strategies_enabled()?;
    let key = Zeroizing::new(key);
    if key.trim().is_empty() { return Err("Enter an OpenAI API key".into()); }
    crate::vault::write_plain(&key_path(&app)?, key.trim().as_bytes())
}

#[tauri::command]
pub async fn automation_decide(app: tauri::AppHandle, model: String, instructions: String, packet: Value, image: String) -> Result<String, String> {
    crate::features::require_strategies_enabled()?;
    if model.trim().is_empty() || instructions.trim().is_empty() { return Err("Enter a model and instructions".into()); }
    if !image.starts_with("data:image/png;base64,") { return Err("A fresh chart image is required".into()); }
    let path = key_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let encrypted = fs::read(path).map_err(|_| "Save an OpenAI API key in Automation first")?;
        let plain = Zeroizing::new(crate::vault::crypt(&encrypted, false)?);
        let key = std::str::from_utf8(&plain).map_err(|_| "Unable to read the automation API key")?;
        let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(120))
            .redirect(reqwest::redirect::Policy::none()).build().map_err(|e| e.to_string())?;
        let response = client.post("https://api.openai.com/v1/responses").bearer_auth(key)
            .json(&json!({"model": model.trim(), "store": false, "input": [{"role":"user", "content":[
                {"type":"input_text", "text":instructions},
                {"type":"input_text", "text":serde_json::to_string(&packet).map_err(|e| e.to_string())?},
                {"type":"input_image", "image_url":image, "detail":"high"}
            ]}]})).send().map_err(|e| format!("Model request failed: {e}"))?;
        let status = response.status();
        let body: Value = response.json().map_err(|_| "Model service returned an invalid response")?;
        if !status.is_success() {
            let message = body["error"]["message"].as_str().unwrap_or("Model request failed").replace(key, "[redacted]");
            return Err(format!("OpenAI {status}: {}", message.chars().take(600).collect::<String>()));
        }
        if body["status"] != "completed" { return Err("The model response was incomplete; no orders were accepted".into()); }
        let mut text = String::new();
        if let Some(output) = body["output"].as_array() {
            for item in output {
                if let Some(content) = item["content"].as_array() {
                    for part in content {
                        if part["type"] == "refusal" { return Err("The model declined this request".into()); }
                        if part["type"] == "output_text" { text.push_str(part["text"].as_str().unwrap_or("")); }
                    }
                }
            }
        }
        if text.is_empty() { return Err("The model returned no decision".into()); }
        Ok(text)
    }).await.map_err(|e| e.to_string())?
}
