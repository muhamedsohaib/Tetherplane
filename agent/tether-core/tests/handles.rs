use std::time::Duration;

use tether_core::{ErrorCode, HandleRegistry};

#[test]
fn handles_are_typed_opaque_and_unique() {
    let registry = HandleRegistry::new();

    let first = registry.insert("proc", String::from("alpha"));
    let second = registry.insert("proc", String::from("beta"));

    assert!(first.starts_with("proc_"));
    assert!(second.starts_with("proc_"));
    assert_ne!(first, second);
    assert!(!first.contains("alpha"));
    assert!(!second.contains("beta"));
    assert_eq!(registry.with(&first, Clone::clone).unwrap(), "alpha");
}

#[test]
fn missing_handle_returns_invalid_arguments() {
    let registry = HandleRegistry::<String>::new();

    let error = registry.with("proc_missing", Clone::clone).unwrap_err();

    assert_eq!(error.code, ErrorCode::InvalidArguments);
}

#[test]
fn removing_a_handle_returns_the_value_and_invalidates_it() {
    let registry = HandleRegistry::new();
    let handle = registry.insert("search", 42_u32);

    assert_eq!(registry.remove(&handle), Some(42));
    let error = registry.with(&handle, |value| *value).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidArguments);
}

#[test]
fn expired_handle_fails_as_invalid_arguments() {
    let registry = HandleRegistry::with_ttl(Duration::from_millis(50));
    let handle = registry.insert("proc", String::from("alpha"));

    std::thread::sleep(Duration::from_millis(150));

    let error = registry.with(&handle, Clone::clone).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidArguments);
}

#[test]
fn access_slides_expiry_forward() {
    let registry = HandleRegistry::with_ttl(Duration::from_millis(200));
    let handle = registry.insert("proc", String::from("alpha"));

    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(registry.with(&handle, Clone::clone).unwrap(), "alpha");

    // The access above refreshed the deadline: 100ms later the handle
    // must still be live even though 200ms passed since insert.
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(registry.with(&handle, Clone::clone).unwrap(), "alpha");

    // Without further access the handle expires.
    std::thread::sleep(Duration::from_millis(250));
    let error = registry.with(&handle, Clone::clone).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidArguments);
}

#[test]
fn insert_sweeps_expired_handles_so_stale_entries_cannot_leak() {
    let registry = HandleRegistry::with_ttl(Duration::from_millis(50));
    let stale = registry.insert("proc", String::from("alpha"));

    std::thread::sleep(Duration::from_millis(150));

    let fresh = registry.insert("proc", String::from("beta"));
    assert_eq!(registry.len(), 1);
    assert_eq!(registry.remove(&stale), None);
    assert_eq!(registry.with(&fresh, Clone::clone).unwrap(), "beta");
}

#[test]
fn removing_an_expired_handle_returns_none() {
    let registry = HandleRegistry::with_ttl(Duration::from_millis(50));
    let handle = registry.insert("search", 42_u32);

    std::thread::sleep(Duration::from_millis(150));

    assert_eq!(registry.remove(&handle), None);
}
