//! Manual, packaged-only smoke test.
//! Cannot register an app identity, authorize devices or assert connectivity.
#[cfg(windows)]
fn main() {
    use tether_notifications::{Notification, windows_native};
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.as_slice() != ["--smoke"] {
        eprintln!(
            "Usage: tetherplane-toast-smoke --smoke (requires installed Tetherplane package identity)"
        );
        std::process::exit(2);
    }
    match windows_native::show_packaged(&Notification::diagnostic_smoke()) {
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
