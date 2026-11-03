//! Native Windows Notification Center adapter.
//! This module does not register package identities, create shortcuts, ask for
//! consent, control devices or open an approval surface.
use super::Notification;
use windows::Data::Xml::Dom::XmlDocument;
use windows::UI::Notifications::{ToastNotification, ToastNotificationManager, ToastNotifier};
use windows::core::HSTRING;

#[derive(Debug)]
pub enum DeliveryError {
    InvalidAppId,
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
            Self::InvalidAppId => f.write_str("a registered Tetherplane app identity is required"),
            Self::Windows(error) => write!(f, "Windows toast API rejected dispatch: {error}"),
        }
    }
}

impl std::error::Error for DeliveryError {}

fn validate_app_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'!'))
}

fn dispatch(notifier: &ToastNotifier, notice: &Notification) -> Result<(), DeliveryError> {
    let xml = XmlDocument::new()?;
    xml.LoadXml(&HSTRING::from(notice.to_toast_xml()))?;
    let toast = ToastNotification::CreateToastNotification(&xml)?;
    notifier.Show(&toast)?;
    // The API returning success means dispatch was accepted, not that
    // Windows actually displayed the toast (e.g. Do Not Disturb).
    Ok(())
}

/// Use only within the actual signed/packaged Tetherplane user-session process.
/// Unpackaged processes cannot assume this identity exists.
///
/// # Errors
/// Returns a Windows API error if the app identity or toast dispatch fails.
pub fn show_packaged(notice: &Notification) -> Result<(), DeliveryError> {
    let notifier = ToastNotificationManager::CreateToastNotifier()?;
    dispatch(&notifier, notice)
}

/// For explicit-AUMID, registered classic desktop callers. This function does
/// not create/install/register the AUMID or bypass Windows notification settings.
///
/// # Errors
/// Rejects invalid app IDs or Windows API failures while dispatching a toast.
pub fn show_registered(
    registered_app_id: &str,
    notice: &Notification,
) -> Result<(), DeliveryError> {
    if !validate_app_id(registered_app_id) {
        return Err(DeliveryError::InvalidAppId);
    }
    let notifier =
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(registered_app_id))?;
    dispatch(&notifier, notice)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn app_id_validation_has_no_shell_or_xml_metacharacters() {
        assert!(validate_app_id("ARCUSLabs.Tetherplane_abc123!Runtime"));
        for invalid in ["", "x y", "<b>", "thing;calc", "x\n", "a\\b"] {
            assert!(!validate_app_id(invalid));
        }
    }
}
