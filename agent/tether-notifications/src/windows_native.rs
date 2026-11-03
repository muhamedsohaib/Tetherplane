//! Native Windows Notification Center adapter.
//! This module never registers package identities, creates shortcuts,
//! grants approvals, changes browser focus, or creates network connections.
use super::Notification;
#[cfg(feature = "dev-beta")]
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(feature = "dev-beta")]
use std::time::{SystemTime, UNIX_EPOCH};
use windows::ApplicationModel::Package;
use windows::Data::Xml::Dom::XmlDocument;
use windows::UI::Notifications::{ToastNotification, ToastNotificationManager, ToastNotifier};
use windows::core::HSTRING;

const PACKAGE_NAME: &str = "ARCUSLabs.Tetherplane";
/// Dedicated per-user, unpackaged beta identity. Presentation only; not an authentication principal.
#[cfg(feature = "dev-beta")]
pub const DEV_BETA_APP_ID: &str = "ARCUSLabs.Tetherplane.DevBeta";
#[cfg(feature = "dev-beta")]
pub const DEV_BETA_GROUP: &str = "tetherplane-beta";
#[cfg(feature = "dev-beta")]
static BETA_TOAST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[cfg(feature = "dev-beta")]
fn new_beta_tag(notice: &Notification) -> String {
    // Public event class only: no device identity, request ID, credential or source path.
    let kind = if notice.key.starts_with("DeviceConnected:") {
        "cn"
    } else if notice.key.starts_with("LocalStatusUnknown:") {
        "uk"
    } else if notice.key.starts_with("DeviceDisconnected:") {
        "of"
    } else if notice.key.starts_with("Unstable:") {
        "fl"
    } else if notice.key == "LocalSmoke" {
        "sm"
    } else {
        "nt"
    };
    let millis: u64 = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX);
    let sequence = BETA_TOAST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!(
        "tb-{kind}-{:x}-{:x}-{:x}",
        std::process::id(),
        millis,
        sequence
    )
}

#[derive(Debug)]
pub enum DeliveryError {
    WrongPackageIdentity,
    Windows(windows::core::Error),
}

impl From<windows::core::Error> for DeliveryError {
    fn from(value: windows::core::Error) -> Self {
        Self::Windows(value)
    }
}

impl std::fmt::Display for DeliveryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::WrongPackageIdentity => {
                f.write_str("notification source is not the installed Tetherplane package")
            }
            Self::Windows(error) => write!(f, "Windows notification API rejected request: {error}"),
        }
    }
}

impl std::error::Error for DeliveryError {}

fn validate_package_name(value: &str) -> Result<(), DeliveryError> {
    if value == PACKAGE_NAME {
        Ok(())
    } else {
        Err(DeliveryError::WrongPackageIdentity)
    }
}

fn require_package_identity() -> Result<(), DeliveryError> {
    // Package::Current fails on unpackaged desktop executables; fail closed.
    // Do not assume that a caller-supplied application ID is trustworthy.
    let current = Package::Current()?;
    let name = current.Id()?.Name()?.to_string();
    validate_package_name(&name)
}

fn dispatch(
    notifier: &ToastNotifier,
    notice: &Notification,
    beta_tagged: bool,
) -> Result<(), DeliveryError> {
    let xml = XmlDocument::new()?;
    xml.LoadXml(&HSTRING::from(notice.to_toast_xml()))?;
    let toast = ToastNotification::CreateToastNotification(&xml)?;
    #[cfg(feature = "dev-beta")]
    if beta_tagged {
        toast.SetTag(&HSTRING::from(new_beta_tag(notice)))?;
        toast.SetGroup(&HSTRING::from(DEV_BETA_GROUP))?;
    }
    #[cfg(not(feature = "dev-beta"))]
    let _ = beta_tagged;
    notifier.Show(&toast)?;
    // API success establishes dispatch only. Windows Do Not Disturb and
    // notification policy determine whether the user actually sees a toast.
    Ok(())
}

/// Send a text-only notification from a Tetherplane package-owned process.
/// This method never creates authorization buttons, launch arguments or links.
///
/// # Errors
/// Fails closed if the process lacks an installed Tetherplane package identity
/// or the Windows notification API rejects the request.
pub fn show_packaged(notice: &Notification) -> Result<(), DeliveryError> {
    require_package_identity()?;
    let notifier = ToastNotificationManager::CreateToastNotifier()?;
    dispatch(&notifier, notice, false)
}

/// Dispatch text-only notifications from an *unpackaged* developer-beta executable.
/// Requires the matching per-user Start-menu shortcut with System.AppUserModel.ID.
/// This identifier is only a Windows notification presentation label; it does
/// not establish device identity, grant scopes or authenticate the event source.
///
/// # Errors
/// Returns a Windows API error if the registered desktop notifier rejects dispatch.
#[cfg(feature = "dev-beta")]
pub fn show_dev_beta(notice: &Notification) -> Result<(), DeliveryError> {
    let notifier =
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(DEV_BETA_APP_ID))?;
    dispatch(&notifier, notice, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unexpected_package_names_cannot_dispatch_as_tetherplane() {
        assert!(validate_package_name("ARCUSLabs.Tetherplane").is_ok());
        for invalid in [
            "",
            "OtherCompany.Tetherplane",
            "ARCUSLabs.Tetherplane.Fake",
            "ARCUSLabs.Tetherplane\n",
        ] {
            assert!(matches!(
                validate_package_name(invalid),
                Err(DeliveryError::WrongPackageIdentity)
            ));
        }
    }

    #[cfg(feature = "dev-beta")]
    #[test]
    fn dev_beta_id_does_not_claim_store_package_identity() {
        assert_ne!(DEV_BETA_APP_ID, PACKAGE_NAME);
        assert!(DEV_BETA_APP_ID.ends_with(".DevBeta"));
        assert!(validate_package_name(DEV_BETA_APP_ID).is_err());
    }

    #[cfg(feature = "dev-beta")]
    #[test]
    fn beta_toast_tags_are_unique_bounded_and_hide_device_identifiers() {
        let sample = Notification {
            title: "A secret device has connected".into(),
            body: "No external links".into(),
            severity: super::super::Severity::Normal,
            key: "DeviceConnected:PRIVATE_DEVICE_NAME:".into(),
        };
        let first = new_beta_tag(&sample);
        let second = new_beta_tag(&sample);
        assert!(first.starts_with("tb-cn-"));
        assert_ne!(first, second);
        assert!(first.len() <= 64);
        assert!(!first.contains("PRIVATE_DEVICE_NAME"));
        assert_eq!(DEV_BETA_GROUP, "tetherplane-beta");

        let lost = Notification {
            key: "LocalStatusUnknown:PRIVATE_DEVICE_NAME:".into(),
            ..sample
        };
        assert!(new_beta_tag(&lost).starts_with("tb-uk-"));
    }

    #[test]
    fn notification_xml_parses_with_real_windows_xml_dom() {
        let xml = XmlDocument::new().expect("Windows XML DOM must be available");
        let content = Notification {
            title: "Leno <waiting> & ready".to_string(),
            body: "A test that requires no device operations".to_string(),
            severity: super::super::Severity::Normal,
            key: "xml-test".to_string(),
        };
        xml.LoadXml(&HSTRING::from(content.to_toast_xml()))
            .expect("Toast XML must be accepted by Windows XML DOM");
    }
}
