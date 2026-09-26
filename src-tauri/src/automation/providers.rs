use super::profiles::{ApiFormat, AuthMode, ProfileConfig, ResolvedProfile};
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE}, Url};
use serde_json::{json, Value};
use std::{collections::BTreeMap, io::Read, time::Duration};

// A 64 x 64 blue PNG; connection tests contain no wallet, chart or trading data.
pub const TEST_IMAGE: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdNvJ8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ2oPcf88OIhvJ6vAAAAAElFTkSuQmCC";
const INCOMPLETE: &str = "The model response was incomplete or refused; no orders were accepted";

pub fn endpoint(config: &ProfileConfig) -> Result<Url, String> {
    let base = Url::parse(config.base_url.trim()).map_err(|_| "Enter a valid server URL")?;
    let local = matches!(base.host_str(), Some("localhost" | "127.0.0.1" | "[::1]" | "::1"));
    if base.scheme() != "https" && !(base.scheme() == "http" && local) { return Err("Use HTTPS, or HTTP for a server on localhost".into()); }
    if base.host_str().is_none() || !base.username().is_empty() || base.password().is_some() || base.query().is_some() || base.fragment().is_some() {
        return Err("The server URL must not contain credentials, query parameters or a fragment".into());
    }
    let path = config.endpoint.trim();
    if !path.starts_with('/') || path.starts_with("//") || path.contains(['\\', '#']) || path.contains("://") {
        return Err("Enter an endpoint path beginning with /".into());
    }
    let model: String = config.model.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect();
    let url = Url::parse(&format!("{}{}", base.as_str().trim_end_matches('/'), path.replace("{model}", &model))).map_err(|_| "Invalid endpoint path")?;
    if url.origin() != base.origin() { return Err("The endpoint must use the configured server".into()); }
    if url.query_pairs().any(|(key, _)| ["key", "api_key", "api-key", "apikey", "access_token", "token"].contains(&key.to_lowercase().as_str())) {
        return Err("Put API keys in the authentication fields, not in the endpoint URL".into());
    }
    Ok(url)
}

pub fn validate_config(c: &ProfileConfig) -> Result<(), String> {
    if c.name.trim().is_empty() || c.name.len() > 120 || c.model.trim().is_empty() || c.model.len() > 200 { return Err("Enter a configuration name and model ID".into()); }
    endpoint(c)?;
    if !(5..=600).contains(&c.timeout_seconds) { return Err("Request timeout must be between 5 and 600 seconds".into()); }
    if c.max_output_tokens.is_some_and(|n| n == 0 || n > 1_000_000) { return Err("Maximum output tokens must be between 1 and 1000000".into()); }
    if c.temperature.is_some_and(|t| !t.is_finite() || !(0.0..=2.0).contains(&t)) { return Err("Temperature must be between 0 and 2, or blank".into()); }
    if c.auth_mode != AuthMode::None {
        HeaderName::from_bytes(c.auth_name().as_bytes()).map_err(|_| "Enter a valid authentication header name")?;
        HeaderValue::from_str(&format!("{}test", c.auth_prefix)).map_err(|_| "Invalid authentication prefix")?;
        if matches!(c.auth_name().to_lowercase().as_str(), "host" | "content-type" | "content-length" | "connection" | "transfer-encoding") {
            return Err("This header cannot be used for authentication".into());
        }
    }
    if !["max_tokens", "max_completion_tokens"].contains(&c.max_token_parameter.as_str()) { return Err("Invalid output token parameter".into()); }
    if c.api_version.len() > 100 { return Err("Invalid API version".into()); }
    HeaderValue::from_str(&c.api_version).map_err(|_| "Invalid API version")?;
    let efforts: &[&str] = match c.format {
        ApiFormat::Anthropic => &["", "low", "medium", "high", "max"],
        ApiFormat::Gemini => &["", "minimal", "low", "medium", "high"],
        _ => &["", "none", "minimal", "low", "medium", "high", "xhigh", "max"],
    };
    if !efforts.contains(&c.reasoning_effort.as_str()) { return Err("This reasoning level is not supported by the selected API format".into()); }
    if let Some(budget) = c.thinking_budget {
        if !matches!(c.format, ApiFormat::Anthropic | ApiFormat::Gemini) || !c.reasoning_effort.is_empty() {
            return Err("Choose either a reasoning level or a thinking budget for Anthropic/Gemini".into());
        }
        if budget > 1_000_000 || (c.format == ApiFormat::Anthropic && (budget < 1024 || budget >= c.max_output_tokens.unwrap_or(4096))) {
            return Err("Anthropic thinking budget must be at least 1024 and below maximum output tokens".into());
        }
    }
    if c.format == ApiFormat::Anthropic && c.temperature.is_some() && (!c.reasoning_effort.is_empty() || c.thinking_budget.is_some()) {
        return Err("Leave temperature blank when enabling Anthropic thinking".into());
    }
    let extras = c.extra_body.as_object().ok_or("Additional request parameters must be a JSON object")?;
    if c.extra_body.to_string().len() > 32768 { return Err("Additional request parameters are too large".into()); }
    // Additional options cannot replace the chart, strategy instructions, execution contract or stateless request.
    const RESERVED: &[&str] = &["model", "messages", "input", "contents", "instructions", "system", "systemInstruction", "system_instruction",
        "tools", "tool_choice", "toolChoice", "toolConfig", "tool_config", "stream", "n", "store", "background", "conversation", "previous_response_id", "cachedContent", "cached_content",
        "max_tokens", "max_completion_tokens", "max_output_tokens", "temperature", "reasoning", "reasoning_effort", "thinking", "api_key", "apiKey", "authorization", "headers"];
    if extras.keys().any(|key| RESERVED.contains(&key.as_str())) { return Err("Additional parameters cannot override model, input, authentication, token/reasoning controls, tools or request lifecycle fields".into()); }
    if let Some(generation) = extras.get("generationConfig") {
        let generation = generation.as_object().ok_or("generationConfig must be a JSON object")?;
        if generation.keys().any(|key| ["candidateCount", "candidate_count", "maxOutputTokens", "max_output_tokens", "temperature", "thinkingConfig", "thinking_config"].contains(&key.as_str())) {
            return Err("Use the form controls for output limits, temperature and thinking; only one response is supported".into());
        }
    }
    if extras.contains_key("generation_config") { return Err("Use generationConfig for additional Gemini options".into()); }
    Ok(())
}

pub fn validate_headers(c: &ProfileConfig, headers: &BTreeMap<String, String>) -> Result<(), String> {
    if headers.len() > 32 { return Err("At most 32 custom headers are supported".into()); }
    let mut names = std::collections::BTreeSet::new();
    for (name, value) in headers {
        let lower = name.to_lowercase();
        if !names.insert(lower.clone()) || ["host", "content-type", "content-length", "connection", "transfer-encoding", "authorization", "x-api-key", "x-goog-api-key"].contains(&lower.as_str())
            || (c.auth_mode != AuthMode::None && lower == c.auth_name().to_lowercase()) {
            return Err("Use the authentication fields for API keys; duplicate and transport headers are not allowed".into());
        }
        HeaderName::from_bytes(name.as_bytes()).map_err(|_| "Invalid custom header name")?;
        HeaderValue::from_str(value).map_err(|_| "Invalid custom header value")?;
        if value.len() > 8192 { return Err("Custom header value is too long".into()); }
    }
    Ok(())
}

fn headers(profile: &ResolvedProfile) -> Result<HeaderMap, String> {
    let c = &profile.config;
    validate_headers(c, &profile.headers)?;
    let mut headers = HeaderMap::new(); headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    if c.auth_mode != AuthMode::None {
        let prefix = if c.auth_mode == AuthMode::Bearer { "Bearer " } else { &c.auth_prefix };
        let mut value = HeaderValue::from_str(&format!("{prefix}{}", profile.key.as_str())).map_err(|_| "Invalid API key or authentication prefix")?;
        value.set_sensitive(true);
        headers.insert(HeaderName::from_bytes(c.auth_name().as_bytes()).map_err(|_| "Invalid authentication header")?, value);
    }
    if c.format == ApiFormat::Anthropic {
        headers.insert("anthropic-version", HeaderValue::from_str(if c.api_version.is_empty() { "2023-06-01" } else { &c.api_version }).map_err(|_| "Invalid API version")?);
    }
    for (name, value) in &profile.headers {
        let mut value = HeaderValue::from_str(value).map_err(|_| "Invalid custom header")?; value.set_sensitive(true);
        headers.insert(HeaderName::from_bytes(name.as_bytes()).map_err(|_| "Invalid custom header")?, value);
    }
    Ok(headers)
}

fn payload(c: &ProfileConfig, instructions: &str, packet: &Value, image: &str) -> Result<Value, String> {
    validate_config(c)?;
    if instructions.trim().is_empty() { return Err("Enter strategy instructions".into()); }
    let image_data = image.strip_prefix("data:image/png;base64,").ok_or("A fresh PNG chart image is required")?;
    if image_data.len() > 28_000_000 { return Err("Chart image is too large for a model request".into()); }
    let decoded = STANDARD.decode(image_data).map_err(|_| "The chart image is not valid base64")?;
    if !decoded.starts_with(b"\x89PNG\r\n\x1a\n") { return Err("The chart image is not a PNG".into()); }
    let text = format!("{instructions}\n\n{}", serde_json::to_string(packet).map_err(|_| "Unable to prepare the strategy data")?);
    let mut body = c.extra_body.clone();
    match c.format {
        ApiFormat::Responses => {
            body["model"] = json!(c.model.trim()); body["store"] = json!(false);
            body["input"] = json!([{"role":"user","content":[{"type":"input_text","text":text},{"type":"input_image","image_url":image,"detail":"high"}]}]);
            if let Some(n) = c.max_output_tokens { body["max_output_tokens"] = json!(n); }
            if !c.reasoning_effort.is_empty() { body["reasoning"] = json!({"effort":c.reasoning_effort}); }
        },
        ApiFormat::ChatCompletions => {
            body["model"] = json!(c.model.trim());
            body["messages"] = json!([{"role":"user","content":[{"type":"text","text":text},{"type":"image_url","image_url":{"url":image}}]}]);
            if let Some(n) = c.max_output_tokens { body[&c.max_token_parameter] = json!(n); }
            if !c.reasoning_effort.is_empty() { body["reasoning_effort"] = json!(c.reasoning_effort); }
        },
        ApiFormat::Anthropic => {
            body["model"] = json!(c.model.trim()); body["max_tokens"] = json!(c.max_output_tokens.unwrap_or(4096));
            body["messages"] = json!([{"role":"user","content":[{"type":"text","text":text},{"type":"image","source":{"type":"base64","media_type":"image/png","data":image_data}}]}]);
            if let Some(budget) = c.thinking_budget { body["thinking"] = json!({"type":"enabled","budget_tokens":budget}); }
            if !c.reasoning_effort.is_empty() { body["thinking"] = json!({"type":"adaptive"});
                if body.get("output_config").is_none() { body["output_config"] = json!({}); }
                if !body["output_config"].is_object() { return Err("output_config must be a JSON object".into()); }
                body["output_config"]["effort"] = json!(c.reasoning_effort);
            }
        },
        ApiFormat::Gemini => {
            body["contents"] = json!([{"role":"user","parts":[{"text":text},{"inlineData":{"mimeType":"image/png","data":image_data}}]}]);
            if body.get("generationConfig").is_none() { body["generationConfig"] = json!({}); }
            let generation = &mut body["generationConfig"];
            if generation.get("responseMimeType").is_none() { generation["responseMimeType"] = json!("application/json"); }
            if let Some(n) = c.max_output_tokens { generation["maxOutputTokens"] = json!(n); }
            if let Some(t) = c.temperature { generation["temperature"] = json!(t); }
            if let Some(budget) = c.thinking_budget { generation["thinkingConfig"] = json!({"thinkingBudget":budget}); }
            if !c.reasoning_effort.is_empty() { generation["thinkingConfig"] = json!({"thinkingLevel":c.reasoning_effort}); }
        }
    }
    if c.format != ApiFormat::Gemini { if let Some(t) = c.temperature { body["temperature"] = json!(t); } }
    Ok(body)
}

fn response_text(format: &ApiFormat, body: &Value) -> Result<String, String> {
    let mut text = String::new();
    match format {
        ApiFormat::Responses => {
            if body["status"] != "completed" { return Err(INCOMPLETE.into()); }
            for item in body["output"].as_array().ok_or(INCOMPLETE)? {
                if item["type"] == "reasoning" { continue; }
                if item["type"] != "message" || item["status"].as_str().is_some_and(|s| s != "completed") { return Err(INCOMPLETE.into()); }
                for part in item["content"].as_array().ok_or(INCOMPLETE)? {
                    if part["type"] != "output_text" { return Err(INCOMPLETE.into()); }
                    text.push_str(part["text"].as_str().ok_or(INCOMPLETE)?);
                }
            }
        },
        ApiFormat::ChatCompletions => {
            let choices = body["choices"].as_array().ok_or(INCOMPLETE)?;
            if choices.len() != 1 || choices[0]["finish_reason"] != "stop" { return Err(INCOMPLETE.into()); }
            let message = &choices[0]["message"];
            if !message["refusal"].is_null() && message["refusal"] != "" { return Err(INCOMPLETE.into()); }
            if message["tool_calls"].as_array().is_some_and(|a| !a.is_empty()) || !message["function_call"].is_null() { return Err(INCOMPLETE.into()); }
            text.push_str(message["content"].as_str().ok_or(INCOMPLETE)?);
        },
        ApiFormat::Anthropic => {
            if body["stop_reason"] != "end_turn" { return Err(INCOMPLETE.into()); }
            for part in body["content"].as_array().ok_or(INCOMPLETE)? {
                match part["type"].as_str() {
                    Some("text") => text.push_str(part["text"].as_str().ok_or(INCOMPLETE)?),
                    Some("thinking" | "redacted_thinking") => {},
                    _ => return Err(INCOMPLETE.into()),
                }
            }
        },
        ApiFormat::Gemini => {
            if !body["promptFeedback"]["blockReason"].is_null() { return Err(INCOMPLETE.into()); }
            let candidates = body["candidates"].as_array().ok_or(INCOMPLETE)?;
            if candidates.len() != 1 || candidates[0]["finishReason"] != "STOP" { return Err(INCOMPLETE.into()); }
            for part in candidates[0]["content"]["parts"].as_array().ok_or(INCOMPLETE)? {
                if !part["functionCall"].is_null() { return Err(INCOMPLETE.into()); }
                if part["thought"] != true { text.push_str(part["text"].as_str().ok_or(INCOMPLETE)?); }
            }
        }
    }
    if text.trim().is_empty() { return Err("The model returned no decision".into()); }
    Ok(text)
}
pub fn strip_fence(text: &str) -> &str {
    let text = text.trim();
    text.strip_prefix("```json").or_else(|| text.strip_prefix("```"))
        .and_then(|t| t.trim_end().strip_suffix("```" )).unwrap_or(text).trim()
}
fn redact(profile: &ResolvedProfile, message: &str) -> String {
    let mut message = message.to_string();
    for secret in std::iter::once(profile.key.as_str()).chain(profile.headers.values().map(String::as_str)) {
        if !secret.is_empty() { message = message.replace(secret, "[redacted]"); }
    }
    message.chars().take(600).collect()
}
pub fn request(profile: &ResolvedProfile, instructions: &str, packet: &Value, image: &str) -> Result<String, String> {
    let c = &profile.config;
    let body = payload(c, instructions, packet, image)?;
    let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(c.timeout_seconds))
        .redirect(reqwest::redirect::Policy::none()).build().map_err(|_| "Unable to initialize the model connection")?;
    let response = client.post(endpoint(c)?).headers(headers(profile)?).json(&body).send().map_err(|e| {
        if e.is_timeout() { "The model request timed out. Increase the timeout or try a faster model." }
        else { "Unable to connect to the model service. Check the server URL and network connection." }
    })?;
    let status = response.status(); let mut bytes = Vec::new();
    response.take(4_194_305).read_to_end(&mut bytes).map_err(|_| "Unable to read the model response")?;
    if bytes.len() > 4_194_304 { return Err("The model response was too large".into()); }
    let body: Value = serde_json::from_slice(&bytes).map_err(|_| format!("Model service returned HTTP {status} without a valid JSON response"))?;
    if !status.is_success() {
        let message = body["error"]["message"].as_str().or_else(|| body["message"].as_str()).unwrap_or("Model request failed; check the model ID, API key and parameters");
        return Err(format!("Model service HTTP {status}: {}", redact(profile, message)));
    }
    response_text(&c.format, &body)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn all_formats_include_the_chart_and_only_this_request() {
        for format in [ApiFormat::Responses, ApiFormat::ChatCompletions, ApiFormat::Anthropic, ApiFormat::Gemini] {
            let mut c = ProfileConfig::legacy("model-a"); c.format = format.clone(); c.max_output_tokens = Some(2048);
            let body = payload(&c, "my strategy", &json!({"token":"token-a"}), TEST_IMAGE).unwrap();
            let serialized = body.to_string(); assert!(serialized.contains("my strategy")); assert!(serialized.contains("token-a"));
            assert!(serialized.contains(TEST_IMAGE.split(',').nth(1).unwrap()));
            match format {
                ApiFormat::Responses => { assert_eq!(body["store"], false); assert_eq!(body["max_output_tokens"], 2048); },
                ApiFormat::ChatCompletions | ApiFormat::Anthropic => assert_eq!(body["max_tokens"], 2048),
                ApiFormat::Gemini => assert_eq!(body["generationConfig"]["maxOutputTokens"], 2048),
            }
        }
    }
    #[test]
    fn refuses_truncated_refused_or_tool_responses_for_every_format() {
        let cases = [
            (ApiFormat::Responses, json!({"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"{}"}]}]}), "status", "incomplete"),
            (ApiFormat::Anthropic, json!({"stop_reason":"end_turn","content":[{"type":"thinking","thinking":"private"},{"type":"text","text":"{}"}]}), "stop_reason", "max_tokens"),
        ];
        for (format, mut value, field, bad) in cases { assert_eq!(response_text(&format, &value).unwrap(), "{}"); value[field] = json!(bad); assert!(response_text(&format, &value).is_err()); }
        let mut chat = json!({"choices":[{"finish_reason":"stop","message":{"content":"{}"}}]});
        assert_eq!(response_text(&ApiFormat::ChatCompletions, &chat).unwrap(), "{}");
        chat["choices"][0]["finish_reason"] = json!("length"); assert!(response_text(&ApiFormat::ChatCompletions, &chat).is_err());
        chat["choices"][0]["finish_reason"] = json!("stop"); chat["choices"][0]["message"]["refusal"] = json!("refused"); assert!(response_text(&ApiFormat::ChatCompletions, &chat).is_err());
        let mut gemini = json!({"candidates":[{"finishReason":"STOP","content":{"parts":[{"text":"private","thought":true},{"text":"{}"}]}}]});
        assert_eq!(response_text(&ApiFormat::Gemini, &gemini).unwrap(), "{}");
        gemini["candidates"][0]["finishReason"] = json!("MAX_TOKENS"); assert!(response_text(&ApiFormat::Gemini, &gemini).is_err());
        assert!(response_text(&ApiFormat::Anthropic, &json!({"stop_reason":"tool_use","content":[]})).is_err());
    }
    #[test]
    fn custom_options_cannot_replace_inputs_or_send_keys_to_redirects() {
        let mut c = ProfileConfig::legacy("model");
        for field in ["input", "messages", "contents", "tools", "previous_response_id", "store"] { c.extra_body = json!({field:[]}); assert!(validate_config(&c).is_err()); }
        c.extra_body = json!({"top_p":0.8}); assert!(validate_config(&c).is_ok());
        for base in ["http://remote.example", "https://key@host.example", "https://host.example?key=secret"] { c.base_url = base.into(); assert!(endpoint(&c).is_err()); }
        c.base_url = "http://localhost:1234".into(); assert!(endpoint(&c).is_ok());
        c.endpoint = "//other.example/endpoint".into(); assert!(endpoint(&c).is_err());
        c.endpoint = "/v1/models/{model}:generateContent".into(); c.model = "escape?key=secret".into();
        assert!(endpoint(&c).unwrap().query().is_none());
        c.endpoint = "/v1/responses?key=secret".into(); assert!(endpoint(&c).is_err());
        c.endpoint = "/v1/responses?api-version=2025-01-01".into(); assert!(endpoint(&c).is_ok());
    }
}
