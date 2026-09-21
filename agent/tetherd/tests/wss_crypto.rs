#[test]
fn fresh_process_can_build_rustls_client_config() {
    let _ = rustls::ClientConfig::builder();
}
