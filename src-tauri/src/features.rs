use serde::Deserialize;

pub fn strategies_enabled() -> bool {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Features { strategies: bool }
    serde_json::from_str::<Features>(include_str!("../../src/config/releaseFeatures.json")).expect("Invalid release features").strategies
}

pub fn require_strategies_enabled() -> Result<(), String> {
    if strategies_enabled() { Ok(()) } else { Err("Automations are unavailable in this build.".into()) }
}
