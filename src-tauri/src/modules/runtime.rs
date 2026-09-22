//! Pure event invocation: no loader, DOM, filesystem, network, native functions,
//! Tauri or environment bindings. A fresh bounded interpreter owns each event.
use super::package::{self, field, has_capability, Payload, OUTPUT_BYTES, STATE_BYTES};
use rquickjs::{CaughtError, Context, Ctx, Function, Object, Runtime, Value as JsValue};
use serde_json::Value;
use std::time::{Duration, Instant};

// Order snapshots are data, not the bounded command list returned by a module.
// Keep input finite without applying the 64 KiB outgoing-command budget to history.
const EVENT_INPUT_BYTES: usize = 4 * 1024 * 1024;

fn runtime_error(_: impl std::fmt::Display) -> String {
    "Module invocation failed or exceeded its memory, stack or CPU limit".into()
}

#[cfg(test)]
mod rebrand_tests {
    use super::*;

    #[test]
    fn invokes_current_and_pre_rebrand_module_packages() {
        for global in ["dekxdisModule", "havenModule"] {
            let package = Payload {
                manifest: serde_json::json!({}),
                entrypoint_source: format!("var {global} = {{handle: function(event, context, state) {{return {{nextState: {{count: state.count + 1}}, requests: []}};}}}};"),
                resources: Default::default(),
            };
            let output = invoke(&package, &serde_json::json!({}), &serde_json::json!({}), &serde_json::json!({"count": 4})).unwrap();
            assert_eq!(output["nextState"]["count"], 5);
        }
    }

    #[test]
    fn malformed_current_package_is_rejected() {
        let package = Payload {
            manifest: serde_json::json!({}),
            entrypoint_source: "var dekxdisModule = {};".into(),
            resources: Default::default(),
        };
        assert!(invoke(&package, &serde_json::json!({}), &serde_json::json!({}), &serde_json::json!({})).unwrap_err().contains("dekxdisModule.handle"));
    }
}
fn invocation_error(ctx: &Ctx<'_>, error: rquickjs::Error) -> String {
    let message = match CaughtError::from_error(ctx, error) {
        CaughtError::Exception(exception) => exception.message(),
        CaughtError::Value(value) => value.as_string().and_then(|value| value.to_string().ok()),
        CaughtError::Error(error) => Some(error.to_string()),
    };
    match message.filter(|message| !message.is_empty()) {
        Some(message) => format!("Module error: {}", message.chars().take(512)
            .map(|c| if c.is_control() { ' ' } else { c }).collect::<String>()),
        None => runtime_error("exception unavailable"),
    }
}
pub fn invoke(
    package: &Payload,
    event: &Value,
    context: &Value,
    state: &Value,
) -> Result<Value, String> {
    let mut invocation_context = context.clone();
    invocation_context
        .as_object_mut()
        .ok_or("Module context must be an object")?
        .insert(
            "resources".into(),
            serde_json::to_value(&package.resources).map_err(runtime_error)?,
        );
    let state_bytes = serde_json::to_vec(state).map_err(runtime_error)?;
    let max_state = package.manifest["resourceRequirements"]["maxStateBytes"]
        .as_u64()
        .unwrap_or(STATE_BYTES as u64) as usize;
    package::parse_json(&state_bytes, max_state)?;
    let event_bytes = serde_json::to_vec(event).map_err(runtime_error)?;
    let context_bytes = serde_json::to_vec(&invocation_context).map_err(runtime_error)?;
    if event_bytes.len() > EVENT_INPUT_BYTES {
        return Err(format!("Module event input is {} bytes; limit is {} bytes", event_bytes.len(), EVENT_INPUT_BYTES));
    }
    if context_bytes.len() > OUTPUT_BYTES {
        return Err(format!("Module context input is {} bytes; limit is {} bytes", context_bytes.len(), OUTPUT_BYTES));
    }
    let rt = Runtime::new().map_err(runtime_error)?;
    rt.set_memory_limit(
        package.manifest["resourceRequirements"]["memoryMb"]
            .as_u64()
            .unwrap_or(32) as usize
            * 1024
            * 1024,
    );
    rt.set_max_stack_size(256 * 1024);
    let deadline = Instant::now()
        + Duration::from_millis(
            package.manifest["resourceRequirements"]["cpuMs"]
                .as_u64()
                .unwrap_or(250),
        );
    rt.set_interrupt_handler(Some(Box::new(move || Instant::now() >= deadline)));
    let ctx = Context::full(&rt).map_err(runtime_error)?;
    let output = ctx.with(|ctx| -> Result<String, String> {
        let event = ctx
            .json_parse(event_bytes)
            .map_err(runtime_error)?;
        let context = ctx
            .json_parse(context_bytes)
            .map_err(runtime_error)?;
        // Freeze the invocation copy before loading package code. Resources
        // come from verified signed bytes and cannot be replaced by IPC input.
        let freeze:Function=ctx.eval("(function freeze(x){if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x)}return x})").map_err(runtime_error)?;
        let context:JsValue=freeze.call((context,)).map_err(runtime_error)?;
        let state = ctx.json_parse(state_bytes).map_err(runtime_error)?;
        ctx.eval::<(), _>(package.entrypoint_source.as_bytes())
            .map_err(|error| invocation_error(&ctx, error))?;
        let module: Object = ctx
            .globals()
            .get("dekxdisModule")
            .or_else(|_| ctx.globals().get("havenModule"))
            .map_err(|_| "Package must define dekxdisModule.handle")?;
        let handler: Function = module
            .get("handle")
            .map_err(|_| "Package must define dekxdisModule.handle")?;
        let result: JsValue = handler
            .call((event, context, state))
            .map_err(|error| invocation_error(&ctx, error))?;
        if result.is_promise() {
            return Err(
                "Module handle must return synchronously; use capability-result events".into(),
            );
        }
        let string = ctx
            .json_stringify(result)
            .map_err(runtime_error)?
            .ok_or("Module returned no JSON result")?;
        let value = string.to_string().map_err(runtime_error)?;
        if value.len() > max_state + OUTPUT_BYTES {
            return Err("Module output exceeds bounded state/control limit".into());
        }
        Ok(value)
    })?;
    let out = package::parse_json(output.as_bytes(), max_state + OUTPUT_BYTES)?;
    validate_output(&package.manifest, context, &out)?;
    Ok(out)
}
pub fn validate_output(manifest: &Value, context: &Value, out: &Value) -> Result<(), String> {
    let object = out.as_object().ok_or("Module output must be an object")?;
    if object
        .keys()
        .any(|k| !matches!(k.as_str(), "nextState" | "requests" | "view"))
        || !object.contains_key("nextState")
    {
        return Err("Invalid module output fields".into());
    }
    let max = manifest["resourceRequirements"]["maxStateBytes"]
        .as_u64()
        .unwrap_or(STATE_BYTES as u64) as usize;
    package::parse_json(
        &serde_json::to_vec(&out["nextState"]).map_err(runtime_error)?,
        max,
    )?;
    let mut control = out.clone();
    control.as_object_mut().unwrap().remove("nextState");
    package::parse_json(
        &serde_json::to_vec(&control).map_err(runtime_error)?,
        OUTPUT_BYTES,
    )?;
    let requests = out["requests"]
        .as_array()
        .ok_or("Module requests must be an array")?;
    if requests.len() > 16 {
        return Err("Module requested more than 16 capabilities in one event".into());
    }
    let mut ids = std::collections::BTreeSet::new();
    for request in requests {
        let id = field(request, "id")?;
        if !request_id(id) || !ids.insert(id) {
            return Err("Invalid or duplicate request ID".into());
        }
        validate_request(manifest, context, request)?;
    }
    if let Some(view) = out.get("view") {
        if !view.is_object() {
            return Err("Module view must be an object".into());
        }
        let fields = manifest["viewSchema"]["fields"]
            .as_array()
            .ok_or("Invalid view schema")?;
        for (k, v) in view.as_object().unwrap() {
            let f = fields
                .iter()
                .find(|f| f["key"].as_str() == Some(k))
                .ok_or("Undeclared module view field")?;
            match f["type"].as_str() {
                Some("number") if !v.is_number() => {
                    return Err("Expected numeric view value".into())
                }
                Some("text") if !v.is_string() => return Err("Expected text view value".into()),
                Some("table") if !v.is_array() => return Err("Expected table view value".into()),
                Some("image") if !v.is_string() => {
                    return Err("Expected image handle view value".into())
                }
                _ => {}
            }
        }
    }
    Ok(())
}
pub fn request_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 120
        && id.as_bytes()[0].is_ascii_alphanumeric()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b':'))
}
fn number(v: &Value, key: &str, min: f64, max: f64) -> Result<f64, String> {
    let n = v[key]
        .as_f64()
        .ok_or_else(|| format!("Invalid numeric {key}"))?;
    if !n.is_finite() || n < min || n > max {
        return Err(format!("{key} outside host bounds"));
    }
    Ok(n)
}
fn integer(v: &Value, key: &str, min: u64, max: u64) -> Result<u64, String> {
    let n = v[key]
        .as_u64()
        .ok_or_else(|| format!("Invalid integer {key}"))?;
    if n < min || n > max {
        return Err(format!("{key} outside host bounds"));
    }
    Ok(n)
}
fn exact_keys(v: &Value, keys: &[&str]) -> Result<(), String> {
    if v.as_object()
        .ok_or("Capability input must be an object")?
        .keys()
        .any(|k| !keys.contains(&k.as_str()))
    {
        return Err("Unsupported capability input field".into());
    }
    Ok(())
}
pub fn validate_request(m: &Value, _context: &Value, r: &Value) -> Result<(), String> {
    exact_keys(r, &["id", "capability", "input"])?;
    let cap = field(r, "capability")?;
    if !has_capability(m, cap) {
        return Err("Module requested an undeclared capability".into());
    }
    let v = &r["input"];
    if !v.is_object() {
        return Err("Capability input must be an object".into());
    }
    match cap {
        "market.price.v1" | "orders.observe.v1" => exact_keys(v, &[])?,
        "orders.funding.v1" => {
            exact_keys(v, &["quoteAmount"])?;
            let quote = field(v, "quoteAmount")?;
            let amount = quote.parse::<f64>().map_err(|_| "Invalid funding amount")?;
            if quote.len() > 80 || quote.bytes().any(|b| !b.is_ascii_digit() && b != b'.')
                || !amount.is_finite() || amount <= 0.0 {
                return Err("Funding check requires a positive USD amount".into());
            }
        }
        "market.candles.v1" => {
            exact_keys(v, &["timeframe", "count", "closedOnly"])?;
            if !package::timeframe(field(v, "timeframe")?) {
                return Err("Unsupported timeframe".into());
            }
            integer(v, "count", 2, 200)?;
            if v.get("closedOnly").is_some_and(|v| !v.is_boolean()) {
                return Err("closedOnly must be boolean".into());
            }
        }
        "chart.snapshot.v1" => {
            exact_keys(v, &["timeframe", "count", "width", "height", "indicators"])?;
            if !package::timeframe(field(v, "timeframe")?) {
                return Err("Unsupported timeframe".into());
            }
            let count = integer(v, "count", 30, 500)?;
            if v.get("width").is_some() {
                integer(v, "width", 640, 1600)?;
            }
            if v.get("height").is_some() {
                integer(v, "height", 400, 1200)?;
            }
            if let Some(indicators) = v.get("indicators") {
                exact_keys(indicators, &["ema", "sma", "rsi", "macd", "volume"])?;
                for key in ["ema", "sma"] {
                    if let Some(periods) = indicators.get(key) {
                        let periods = periods
                            .as_array()
                            .ok_or("Indicator periods must be an array")?;
                        let mut unique = std::collections::BTreeSet::new();
                        if periods.len() > 4
                            || periods.iter().any(|p| {
                                !p.as_u64().is_some_and(|n| {
                                    n >= 2 && n <= 200.min(count) && unique.insert(n)
                                })
                            })
                        {
                            return Err("Invalid or duplicate indicator periods".into());
                        }
                    }
                }
                if indicators.get("rsi").is_some() {
                    integer(indicators, "rsi", 2, 200.min(count - 1))?;
                }
                for key in ["macd", "volume"] {
                    if indicators.get(key).is_some_and(|b| !b.is_boolean()) {
                        return Err("Indicator switches must be boolean".into());
                    }
                }
                if indicators["macd"] == true && count < 35 {
                    return Err("MACD requires at least 35 candles".into());
                }
                if indicators["macd"] == true
                    && indicators.get("rsi").is_some()
                    && v["height"].as_u64().unwrap_or(720) < 640
                {
                    return Err("RSI and MACD together require height at least 640".into());
                }
            }
        }
        "http.request.v1" => super::http::validate_request(m, v)?,
        "orders.limit-entry.v1" => {
            exact_keys(v, &["price", "quoteAmount", "protection", "basisRequestId"])?;
            number(v, "price", f64::MIN_POSITIVE, 1e30)?;
            let quote = field(v, "quoteAmount")?;
            if quote.len() > 80 || quote.bytes().any(|b| !b.is_ascii_digit() && b != b'.') {
                return Err("Invalid quote amount".into());
            }
            let amount = quote.parse::<f64>().map_err(|_| "Invalid quote amount")?;
            // No per-order ceiling is imposed here. What an order may be worth is the strategy's own
            // Order amount setting, and whether it can be placed at all is decided by the balance.
            if !amount.is_finite() || amount <= 0.0 {
                return Err("Order amount must be a positive number".into());
            }
            if let Some(p) = v.get("protection") {
                if !has_capability(m, "orders.protection.v1") {
                    return Err("Protection capability not declared".into());
                }
                exact_keys(p, &["basis", "takeProfit", "stopLoss", "takeProfitValidity"])?;
                if p.get("takeProfitValidity").is_some()
                    && (p["takeProfitValidity"].as_str() != Some("maximum")
                        || p.get("takeProfit").is_none())
                {
                    return Err("Invalid take-profit validity".into());
                }
                if !matches!(field(p, "basis")?, "fixed" | "actual-fill") {
                    return Err("Unsupported protection basis".into());
                }
                if p.get("takeProfit").is_none() && p.get("stopLoss").is_none() {
                    return Err("Empty order protection".into());
                }
                for key in ["takeProfit", "stopLoss"] {
                    if p.get(key).is_some() {
                        number(p, key, f64::MIN_POSITIVE, 1e30)?;
                    }
                }
            }
            if let Some(id) = v.get("basisRequestId") {
                if !id.as_str().is_some_and(request_id) {
                    return Err("Invalid basis request ID".into());
                }
            }
        }
        "orders.limit-exit.v1" => {
            exact_keys(v, &["parentOrderId", "price", "quantity", "basisRequestId"])?;
            number(v, "price", f64::MIN_POSITIVE, 1e30)?;
            let parent = field(v, "parentOrderId")?;
            if parent.is_empty() || parent.len() > 200 { return Err("Invalid parent order ID".into()); }
            if let Some(quantity) = v.get("quantity") {
                let value = quantity.as_str().ok_or("Invalid sell quantity")?;
                let parsed = value.parse::<f64>().map_err(|_| "Invalid sell quantity")?;
                if value.len() > 80 || value.bytes().any(|b| !b.is_ascii_digit() && b != b'.') || !parsed.is_finite() || parsed <= 0.0 {
                    return Err("Invalid sell quantity".into());
                }
            }
            if let Some(id) = v.get("basisRequestId") {
                if !id.as_str().is_some_and(request_id) { return Err("Invalid basis request ID".into()); }
            }
        }
        "orders.cancel.v1" => {
            exact_keys(v, &["orderId"])?;
            if field(v, "orderId")?.len() > 200 {
                return Err("Invalid order ID".into());
            }
        }
        "log.module.v1" => {
            exact_keys(v, &["level", "message"])?;
            if v.get("level").is_some() && !matches!(field(v, "level")?, "info" | "warn" | "error")
                || field(v, "message")?.len() > 512
            {
                return Err("Invalid module log message".into());
            }
        }
        "events.schedule.v1" => {
            exact_keys(v, &["afterMs", "name"])?;
            integer(v, "afterMs", 6000, 86_400_000)?;
            if let Some(name) = v.get("name") {
                if !name
                    .as_str()
                    .is_some_and(|s| !s.is_empty() && s.len() <= 120)
                {
                    return Err("Invalid schedule name".into());
                }
            }
        }
        // These declarations qualify state, view, injection and entry requests;
        // they do not independently expose mutable secrets or order primitives.
        "state.module.v1" | "ui.module.v1" | "secrets.inject.v1" | "orders.protection.v1" => {
            return Err("Capability is declarative; use nextState/view or a parent request".into())
        }
        _ => return Err("Unsupported capability".into()),
    }
    Ok(())
}


