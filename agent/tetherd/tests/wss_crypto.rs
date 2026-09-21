#[tokio::test]
async fn fresh_process_can_construct_wss_connector() {
    let result = tokio_tungstenite::connect_async("wss://127.0.0.1:1/device").await;
    assert!(
        result.is_err(),
        "closed local WSS endpoint should return a connection error",
    );
}
