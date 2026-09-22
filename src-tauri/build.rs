fn main() {
    println!("cargo:rerun-if-changed=module-publisher.conf");
    println!("cargo:rerun-if-env-changed=DEKXDIS_MODULE_PUBLISHER_KEY_ID");
    println!("cargo:rerun-if-env-changed=DEKXDIS_MODULE_PUBLISHER_PUBLIC_KEY");
    // Explicit environment overrides must supply both values; native validation
    // rejects incomplete overrides. The checked-in file contains public data only.
    if std::env::var_os("DEKXDIS_MODULE_PUBLISHER_KEY_ID").is_none()
        && std::env::var_os("DEKXDIS_MODULE_PUBLISHER_PUBLIC_KEY").is_none()
    {
        let config = std::fs::read_to_string("module-publisher.conf")
            .expect("Missing public module publisher configuration");
        let values: Vec<_> = config.lines().collect();
        assert!(values.len() == 2 && values.iter().all(|v| !v.is_empty()),
            "Module publisher configuration requires key ID and public key");
        println!("cargo:rustc-env=DEKXDIS_MODULE_PUBLISHER_KEY_ID={}", values[0]);
        println!("cargo:rustc-env=DEKXDIS_MODULE_PUBLISHER_PUBLIC_KEY={}", values[1]);
    }
    tauri_build::build()
}
