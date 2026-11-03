//! Native Windows Notification Center adapter.
//! This module never registers package identities, creates shortcuts,
//! grants approvals, changes browser focus, or creates network connections.
use super::Notification;
use windows::ApplicationModel::Package;
use windows::Data::Xml::Dom::XmlDocument;
use windows::UI::Notifications::{ToastNotification, ToastNotificationManager, ToastNotifier};
use windows::core::HSTRING;

const PACKAGE_NAME: &str = "ARCUSLabs.Tetherplane";

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

fn dispatch(notifier: &ToastNotifier, notice: &Notification) -> Result<(), DeliveryError> {
    let xml = XmlDocument::new()?;
    xml.LoadXml(&HSTRING::from(notice.to_toast_xml()))?;
    let toast = ToastNotification::CreateToastNotification(&xml)?;
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
    dispatch(&notifier, notice)
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
