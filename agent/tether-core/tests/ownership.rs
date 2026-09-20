use tether_core::{ResourceKey, ResourceOrigin, TrustedOwnershipRegistry};

#[test]
fn trusted_registry_tracks_only_locally_registered_resources() {
    let registry = TrustedOwnershipRegistry::new();

    assert_eq!(registry.origin(&ResourceKey::Process(4242)), None);
    assert!(!registry.is_tetherplane_owned(&ResourceKey::Process(4242)));

    registry.register(ResourceKey::Process(4242), ResourceOrigin::Tetherplane);

    assert_eq!(
        registry.origin(&ResourceKey::Process(4242)),
        Some(ResourceOrigin::Tetherplane)
    );
    assert!(registry.is_tetherplane_owned(&ResourceKey::Process(4242)));
}

#[test]
fn trusted_registry_keeps_desktop_resource_kinds_distinct() {
    let registry = TrustedOwnershipRegistry::new();
    let window = ResourceKey::DesktopWindow("win_abc".into());
    let element = ResourceKey::DesktopElement("el_abc".into());

    registry.register(window.clone(), ResourceOrigin::Human);
    registry.register(element.clone(), ResourceOrigin::Tetherplane);

    assert_eq!(registry.origin(&window), Some(ResourceOrigin::Human));
    assert_eq!(registry.origin(&element), Some(ResourceOrigin::Tetherplane));
}

#[test]
fn unregister_removes_authority_instead_of_leaving_a_stale_owned_resource() {
    let registry = TrustedOwnershipRegistry::new();
    let process = ResourceKey::Process(9001);
    registry.register(process.clone(), ResourceOrigin::Tetherplane);

    assert_eq!(
        registry.unregister(&process),
        Some(ResourceOrigin::Tetherplane)
    );
    assert_eq!(registry.origin(&process), None);
    assert!(!registry.is_tetherplane_owned(&process));
}
