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
