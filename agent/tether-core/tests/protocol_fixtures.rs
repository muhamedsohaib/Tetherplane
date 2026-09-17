use tether_core::{CapabilityError, ErrorCode, InvocationEnvelope, ResponseMode, ResultEnvelope};

#[test]
fn invocation_fixture_round_trips() {
    let raw = include_str!("../../../protocol/fixtures/invocation-device-status.json");
    let parsed: InvocationEnvelope = serde_json::from_str(raw).unwrap();

    assert_eq!(parsed.capability, "device.status");
    assert_eq!(parsed.response_mode, ResponseMode::Compact);

    let encoded = serde_json::to_value(parsed).unwrap();
    assert_eq!(encoded["protocol_version"], "1.0");
    assert_eq!(
        encoded["request_id"],
        "11111111-1111-4111-8111-111111111111"
    );
}

#[test]
fn result_fixture_round_trips() {
    let raw = include_str!("../../../protocol/fixtures/result-device-status.json");
    let parsed: ResultEnvelope = serde_json::from_str(raw).unwrap();

    assert!(parsed.error.is_none());
    let encoded = serde_json::to_value(parsed).unwrap();
    assert_eq!(encoded["status"], "success");
    assert_eq!(encoded["verification"], "not_applicable");
}
#[test]
fn capability_error_fixture_round_trips() {
    let raw = include_str!("../../../protocol/fixtures/error-capability-unavailable.json");
    let parsed: CapabilityError = serde_json::from_str(raw).unwrap();

    assert_eq!(parsed.code, ErrorCode::CapabilityUnavailable);
    assert_eq!(parsed.message, "Browser provider is not installed.");

    let encoded = serde_json::to_value(parsed).unwrap();
    assert_eq!(encoded["code"], "capability_unavailable");
    assert_eq!(encoded["details"]["capability"], "browser.observe");
}
