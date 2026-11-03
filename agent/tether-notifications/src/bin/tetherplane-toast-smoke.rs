//! Explicit manual diagnostic only. Does not accept generic device/event data.
//! Cannot install identities, request approvals, or assert any connection state.
#[cfg(windows)]
fn main() {
    use tether_notifications::{Notification, windows_native};
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() != 3 || args[0] != "--smoke" || args[1] != "--registered-app-id" {
        eprintln!(
            "Usage: tetherplane-toast-smoke --smoke --registered-app-id <registered Tetherplane AUMID>"
        );
        std::process::exit(2);
    }
    match windows_native::show_registered(&args[2], &Notification::diagnostic_smoke()) {
        Ok(()) => println!("TOAST_DISPATCH_ACCEPTED_VISIBILITY_UNVERIFIED"),
        Err(error) => {
            eprintln!("TOAST_DISPATCH_FAILED: {error}");
            std::process::exit(1);
        }
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("Windows-only diagnostic binary");
    std::process::exit(2);
}
