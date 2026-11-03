//! Explicit, local diagnostic only. Does not authorize devices or claim connectivity.
//! Production/package mode remains separate from an opt-in unpackaged beta mode.
#[cfg(windows)]
fn main() {
    use tether_notifications::{Notification, windows_native};
    let args: Vec<String> = std::env::args().skip(1).collect();
    let notification = Notification::diagnostic_smoke();
    let result = match args.as_slice() {
        [one] if one == "--smoke" => windows_native::show_packaged(&notification),
        #[cfg(feature = "dev-beta")]
        [one, two] if one == "--smoke" && two == "--developer-beta" => {
            windows_native::show_dev_beta(&notification)
        }
        _ => {
            eprintln!(
                "Usage: tetherplane-toast-smoke --smoke [--developer-beta (build with --features dev-beta)]"
            );
            std::process::exit(2);
        }
    };
    match result {
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
