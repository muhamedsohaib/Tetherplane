//! Native Windows isolation acceptance tests for `process.run`.
//!
//! **Hosted CI only.** This target performs native sandbox launches and
//! human-interface probes; it must never be executed on a developer desktop
//! (Leno). Local work with this file is compile-only.
//!
//! # Custom harness (`harness = false`)
//!
//! `sandboxrs-windows` runs a live probe on the first backend build of a
//! process: it copies the consumer executable into a temporary workspace and
//! executes it with no arguments, expecting exit code 0 with no timeout, and
//! signals that mode to the copy by setting `SANDBOXRS_PROBE_SELF=1` in the
//! host environment. This target therefore provides its own `main` that exits
//! 0 when `SANDBOXRS_PROBE_SELF` is present and otherwise runs the five named
//! tests sequentially, printing `PASS`/`FAIL` per test and exiting non-zero on
//! any failure. The non-Windows build compiles an empty target so the Ubuntu
//! job stays green.
//!
//! # Worker mode
//!
//! Sandboxed children are this same executable launched with
//! `--sandbox-probe=<operation>` arguments; `main` dispatches those arguments
//! before the probe-variable check (the variable remains set in the host
//! environment after the first backend build, and host-side control runs must
//! not be mistaken for the no-argument probe). The worker reports one
//! machine-readable line per operation:
//!
//! ```text
//! sandbox_probe op=<op> outcome=ok ...
//! sandbox_probe op=<op> outcome=denied error_kind=permission_denied os_error=<code>
//! sandbox_probe op=<op> outcome=error error_kind=<kind> os_error=<code>
//! ```
//!
//! `outcome=denied` is emitted only for `PermissionDenied` failures and the
//! tests additionally require explicit access-denied OS error codes
//! (`5 == ERROR_ACCESS_DENIED`, `10013 == WSAEACCES`), so a missing fixture or
//! an unavailable environment can never masquerade as a sandbox denial.
//!
//! # Anti-vacuity controls
//!
//! Every negative assertion is paired with a native control in the same test:
//! the parent performs the same operation outside the sandbox first (marker
//! writes, credential-standin read), the parent proves the loopback listener
//! accepts a host connection, and the clipboard and fixture-window surfaces
//! are proven observable outside the sandbox with the same probe script the
//! sandboxed child runs. Tests use only fixture-owned `tempfile` directories
//! and clean up after themselves.

#[cfg(not(windows))]
fn main() {}

#[cfg(windows)]
fn main() {
    let args: Vec<String> = std::env::args_os()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    if let Some(position) = args
        .iter()
        .position(|arg| arg.starts_with("--sandbox-probe="))
    {
        std::process::exit(windows_impl::run_worker(&args, position));
    }
    if std::env::var_os("SANDBOXRS_PROBE_SELF").is_some() {
        // sandboxrs AppContainer probe contract: the backend probe executes a
        // copy of this executable with no arguments and expects exit code 0.
        std::process::exit(0);
    }
    std::process::exit(windows_impl::run_suite());
}

#[cfg(windows)]
mod windows_impl {
    use std::collections::BTreeMap;
    use std::net::{TcpListener, TcpStream};
    use std::path::{Path, PathBuf};
    use std::process::{Child, Command, Stdio};
    use std::sync::Arc;
    use std::time::Duration;

    use serde_json::{Value, json};
    use tether_core::{
        Actor, ActorKind, CapabilityRouter, ErrorCode, InvocationEnvelope, LocalPolicyBroker,
        LocalPolicyConfig, ResponseMode, TrustedOwnershipRegistry,
    };
    use tether_process_provider::ProcessProvider;
    use tether_process_provider::test_support::{
        TEST_DEVICE_ID, TEST_PRINCIPAL_ID, fixture_authorizer, fixture_profile,
    };
    use tether_process_provider::windows_sandbox::{WindowsSandboxConfig, WindowsSandboxLauncher};
    use tokio::runtime::Runtime;

    /// Workspace-readable fixture content; the sandboxed child must read it.
    const WORKSPACE_FIXTURE_BYTES: &[u8] = b"tether-workspace-fixture\n";
    /// Payload written by the worker's `write-file` operation.
    const WORKER_WRITE_PAYLOAD: &[u8] = b"tether-worker-write\n";
    /// Image name of the sandbox-executable copy placed in the workspace.
    const WORKER_IMAGE_NAME: &str = "sandbox_probe_worker.exe";
    /// Hex dump cap used by both the worker and the expected-value helper.
    const HEX_CAP: usize = 256;
    /// Time budget handed to the provider for worker children.
    const WORKER_WAIT_MS: u64 = 15_000;
    /// Time budget handed to the provider for PowerShell children.
    const POWERSHELL_WAIT_MS: u64 = 30_000;

    /// Clipboard/fixture-window probe executed both on the host (control) and
    /// inside the sandbox (assertion). `__READABLE__` and `__WINDOW_MATCH__`
    /// are replaced with fixture paths before the script is written.
    const HUMAN_INTERFACE_PROBE_SCRIPT: &str = r"
param([string]$Readable, [string]$WindowMatch)
[Console]::WriteLine('sandbox_probe op=ps-live outcome=ok')
try {
  $bytes = [System.IO.File]::ReadAllBytes($Readable)
  [Console]::WriteLine('sandbox_probe op=ps-workspace-read outcome=ok len=' + $bytes.Length + ' hex=' + [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant())
} catch {
  [Console]::WriteLine('sandbox_probe op=ps-workspace-read outcome=error type=' + $_.Exception.GetType().Name)
}
try {
  $content = Get-Clipboard -Raw -ErrorAction Stop
  $length = -1
  if ($null -ne $content) { $length = $content.Length }
  [Console]::WriteLine('sandbox_probe op=ps-clipboard-read outcome=ok len=' + $length)
} catch {
  [Console]::WriteLine('sandbox_probe op=ps-clipboard-read outcome=denied hresult=' + ('{0:X8}' -f $_.Exception.HResult) + ' type=' + $_.Exception.GetType().Name)
}
try {
  $found = 0
  $procs = @(Get-Process -ErrorAction Stop)
  foreach ($p in $procs) {
    try {
      if ($p.MainWindowTitle -like ('*' + $WindowMatch + '*')) { $found = $found + 1 }
    } catch { }
  }
  [Console]::WriteLine('sandbox_probe op=ps-window-enum outcome=ok found=' + $found)
} catch {
  [Console]::WriteLine('sandbox_probe op=ps-window-enum outcome=denied hresult=' + ('{0:X8}' -f $_.Exception.HResult) + ' type=' + $_.Exception.GetType().Name)
}
";

    /// Fixture-owned window kept alive for the duration of the
    /// human-interface test; killed by the test during cleanup.
    const FIXTURE_WINDOW_SCRIPT: &str = r"
param([string]$Title)
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.Width = 320
$form.Height = 200
$form.Show()
while ($true) {
  [System.Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds 200
}
";

    /// Parent-side clipboard control: set the marker, then read it back.
    const CLIPBOARD_CONTROL_COMMAND: &str = "Set-Clipboard -Value '__MARKER__'; $roundtrip = Get-Clipboard -Raw; if ($roundtrip -eq '__MARKER__') { Write-Output 'clipboard_control=ok' } else { Write-Output ('clipboard_control=mismatch value=' + $roundtrip) }";
    /// Best-effort cleanup of the runner clipboard after the test.
    const CLIPBOARD_CLEAR_COMMAND: &str = "Set-Clipboard -Value ''";

    /// One named suite case: a printable name and a synchronous runner that
    /// drives its async body on the shared runtime.
    type SuiteCase = (&'static str, fn(&Runtime));

    #[allow(clippy::too_many_lines)]
    pub(crate) fn run_suite() -> i32 {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("tokio runtime for the isolation suite");
        println!("windows_isolation: harness start");
        record_environment();
        let tests: &[SuiteCase] = &[
            (
                "read_only_workspace_and_private_scratch_are_enforced",
                test_read_only_workspace_and_private_scratch_are_enforced,
            ),
            (
                "failed_setup_never_executes_child",
                test_failed_setup_never_executes_child,
            ),
            (
                "loopback_network_and_host_credentials_denied",
                test_loopback_network_and_host_credentials_denied,
            ),
            (
                "human_input_clipboard_window_read_denied",
                test_human_input_clipboard_window_read_denied,
            ),
            ("unsupported_pty_denied", test_unsupported_pty_denied),
        ];
        let mut failures: Vec<&str> = Vec::new();
        for (name, test) in tests {
            println!("windows_isolation: running {name}");
            let result =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (*test)(&runtime)));
            if result.is_ok() {
                println!("windows_isolation: PASS {name}");
            } else {
                println!("windows_isolation: FAIL {name}");
                failures.push(name);
            }
        }
        if failures.is_empty() {
            println!("windows_isolation: {0}/{0} tests passed", tests.len());
            0
        } else {
            println!(
                "windows_isolation: {} of {} tests failed: {}",
                failures.len(),
                tests.len(),
                failures.join(", ")
            );
            1
        }
    }

    /// Records the local OS build, executable, profile revision, and the
    /// backend identity reported by the launcher's `supported_profile`. This
    /// is GREEN evidence taken from the test process itself.
    fn record_environment() {
        println!(
            "windows_isolation: environment os_version={:?} long_os_version={:?} exe={:?} profile_revision={}",
            sysinfo::System::os_version(),
            sysinfo::System::long_os_version(),
            std::env::current_exe().ok(),
            fixture_profile().revision,
        );
        let root = tempfile::tempdir().expect("environment recording tempdir");
        let workspace = root.path().join("record-workspace");
        let scratch = root.path().join("record-scratch");
        std::fs::create_dir_all(&workspace).expect("record workspace directory");
        std::fs::create_dir_all(&scratch).expect("record scratch directory");
        let profile = fixture_profile();
        let launcher = WindowsSandboxLauncher::new(WindowsSandboxConfig {
            workspace_resource_id: profile.workspace.resource_id,
            workspace_path: workspace,
            scratch_resource_id: profile.scratch.resource_id,
            scratch_path: scratch,
        });
        match launcher.supported_profile(&fixture_profile()) {
            Ok(guarantees) => println!(
                "windows_isolation: backend={} verified_os_build={} piped_stdio={} pty={}",
                guarantees.backend, guarantees.os_build, guarantees.piped_stdio, guarantees.pty,
            ),
            Err(error) => {
                println!("windows_isolation: backend verification failed: {error:?}");
            }
        }
    }

    // ---------------------------------------------------------------------
    // Worker mode
    // ---------------------------------------------------------------------

    /// Runs one worker operation and returns the process exit code.
    pub(crate) fn run_worker(argv: &[String], position: usize) -> i32 {
        let flag = &argv[position];
        let op = flag.strip_prefix("--sandbox-probe=").unwrap_or_default();
        let Some(argument) = argv.get(position + 1) else {
            println!("sandbox_probe op={op} outcome=error error_kind=missing_argument");
            return 2;
        };
        match op {
            "write-file" => probe_write_file(argument),
            "read-file" => probe_read_file(argument),
            "connect-tcp" => probe_connect_tcp(argument),
            other => {
                println!("sandbox_probe op={other} outcome=error error_kind=unknown_operation");
                return 2;
            }
        }
        0
    }

    fn probe_write_file(path: &str) {
        match std::fs::write(path, WORKER_WRITE_PAYLOAD) {
            Ok(()) => println!(
                "sandbox_probe op=write-file outcome=ok bytes={}",
                WORKER_WRITE_PAYLOAD.len()
            ),
            Err(error) => println_probe_error("write-file", &error),
        }
    }

    fn probe_read_file(path: &str) {
        match std::fs::read(path) {
            Ok(bytes) => println!(
                "sandbox_probe op=read-file outcome=ok bytes={} hex={}",
                bytes.len(),
                hex_prefix(&bytes, HEX_CAP)
            ),
            Err(error) => println_probe_error("read-file", &error),
        }
    }

    fn probe_connect_tcp(target: &str) {
        let Ok(address) = target.parse::<std::net::SocketAddr>() else {
            println!("sandbox_probe op=connect-tcp outcome=error error_kind=invalid_address");
            return;
        };
        match TcpStream::connect_timeout(&address, Duration::from_secs(3)) {
            Ok(stream) => {
                drop(stream);
                println!("sandbox_probe op=connect-tcp outcome=ok");
            }
            Err(error) if error.kind() == std::io::ErrorKind::TimedOut => {
                println!(
                    "sandbox_probe op=connect-tcp outcome=timeout os_error={}",
                    os_error_text(&error)
                );
            }
            Err(error) => println_probe_error("connect-tcp", &error),
        }
    }

    /// `outcome=denied` is reserved for `PermissionDenied` failures; every
    /// other failure is reported as `outcome=error` with the error kind, so a
    /// broken fixture can never satisfy a denial assertion.
    fn println_probe_error(op: &str, error: &std::io::Error) {
        let os_error = os_error_text(error);
        if error.kind() == std::io::ErrorKind::PermissionDenied {
            println!(
                "sandbox_probe op={op} outcome=denied error_kind=permission_denied os_error={os_error}"
            );
        } else {
            println!(
                "sandbox_probe op={op} outcome=error error_kind={:?} os_error={os_error}",
                error.kind()
            );
        }
    }

    fn os_error_text(error: &std::io::Error) -> String {
        error
            .raw_os_error()
            .map_or_else(|| "none".to_owned(), |code| code.to_string())
    }

    fn hex_prefix(bytes: &[u8], cap: usize) -> String {
        use std::fmt::Write as _;
        let mut out = String::with_capacity(cap * 2);
        for byte in bytes.iter().take(cap) {
            let _ = write!(out, "{byte:02x}");
        }
        out
    }

    // ---------------------------------------------------------------------
    // Provider fixtures and invocation helpers
    // ---------------------------------------------------------------------

    struct SandboxFixture {
        root: tempfile::TempDir,
        workspace: PathBuf,
        scratch: PathBuf,
        worker: PathBuf,
    }

    impl SandboxFixture {
        fn new() -> Self {
            let root = tempfile::tempdir().expect("fixture tempdir");
            let workspace = root.path().join("workspace");
            let scratch = root.path().join("scratch");
            std::fs::create_dir(&workspace).expect("fixture workspace directory");
            std::fs::create_dir(&scratch).expect("fixture scratch directory");
            std::fs::write(workspace.join("readable.txt"), WORKSPACE_FIXTURE_BYTES)
                .expect("workspace fixture file");
            let source = std::env::current_exe().expect("test executable path");
            let worker = workspace.join(WORKER_IMAGE_NAME);
            std::fs::copy(source, &worker).expect("worker image copied into workspace");
            Self {
                root,
                workspace,
                scratch,
                worker,
            }
        }
    }

    fn sandbox_config(fixture: &SandboxFixture) -> WindowsSandboxConfig {
        let profile = fixture_profile();
        WindowsSandboxConfig {
            workspace_resource_id: profile.workspace.resource_id,
            workspace_path: fixture.workspace.clone(),
            scratch_resource_id: profile.scratch.resource_id,
            scratch_path: fixture.scratch.clone(),
        }
    }

    fn restricted_router(config: WindowsSandboxConfig) -> CapabilityRouter {
        let provider = ProcessProvider::with_authorizer(
            Arc::new(TrustedOwnershipRegistry::new()),
            fixture_authorizer(),
            Arc::new(WindowsSandboxLauncher::new(config)),
        );
        let mut router = CapabilityRouter::with_policy(Arc::new(LocalPolicyBroker::new(
            LocalPolicyConfig::new(vec![]),
        )));
        router
            .register(Arc::new(provider))
            .expect("process provider registers");
        router
    }

    fn invocation(arguments: Value) -> InvocationEnvelope {
        InvocationEnvelope {
            protocol_version: "1.0".into(),
            request_id: "00000000-0000-4000-8000-000000000031".parse().unwrap(),
            device_id: Some(TEST_DEVICE_ID.into()),
            principal_id: Some(TEST_PRINCIPAL_ID.into()),
            job_id: None,
            capability: "process.run".into(),
            arguments,
            actor: Actor {
                id: "windows-isolation-test".into(),
                kind: ActorKind::AiClient,
            },
            session_id: None,
            response_mode: ResponseMode::Compact,
            idempotency_key: None,
            preconditions: vec![],
            expectations: vec![],
        }
    }

    fn worker_arguments(worker: &Path, op: &str, argument: &str, wait_ms: u64) -> Value {
        json!({
            "program": worker.display().to_string(),
            "args": [format!("--sandbox-probe={op}"), argument.to_owned()],
            "wait_ms": wait_ms,
            "pty": false,
        })
    }

    struct RunOutcome {
        stdout: String,
        stderr: String,
        exit_code: Option<i64>,
    }

    /// Executes through the provider/router and requires a completed child
    /// with exit code 0; returns the captured streams.
    async fn run_exec_ok(router: &CapabilityRouter, arguments: Value, label: &str) -> RunOutcome {
        let result = router.execute(invocation(arguments)).await;
        if let Some(error) = &result.error {
            panic!("{label}: expected an executed run, got error {error:?}");
        }
        let Some(data) = result.data else {
            panic!("{label}: executed run returned no data");
        };
        assert!(
            data["running"].as_bool() == Some(false),
            "{label}: sandboxed child still running after the wait budget; stdout={:?} stderr={:?}",
            data["stdout"],
            data["stderr"]
        );
        let exit_code = data["exit_code"].as_i64();
        assert_eq!(
            exit_code,
            Some(0),
            "{label}: exit_code={exit_code:?} stderr={:?}",
            data["stderr"]
        );
        let outcome = RunOutcome {
            stdout: data["stdout"].as_str().unwrap_or_default().to_owned(),
            stderr: data["stderr"].as_str().unwrap_or_default().to_owned(),
            exit_code,
        };
        println!("[sandboxed] {label}: stdout={:?}", outcome.stdout);
        if !outcome.stderr.is_empty() {
            println!("[sandboxed] {label}: stderr={:?}", outcome.stderr);
        }
        outcome
    }

    /// Requires a fail-closed `capability_unavailable` denial with no data.
    async fn run_expect_capability_unavailable(
        router: &CapabilityRouter,
        arguments: Value,
        label: &str,
    ) {
        let result = router.execute(invocation(arguments)).await;
        let Some(error) = result.error else {
            panic!("{label}: expected capability_unavailable, run was not denied");
        };
        assert_eq!(
            error.code,
            ErrorCode::CapabilityUnavailable,
            "{label}: expected capability_unavailable, observed {error:?}"
        );
        assert!(
            result.data.is_none(),
            "{label}: denied run must not return data"
        );
    }

    // ---------------------------------------------------------------------
    // Probe-line parsing and assertions
    // ---------------------------------------------------------------------

    fn probe_fields(stdout: &str, op: &str) -> Option<BTreeMap<String, String>> {
        stdout.lines().find_map(|line| {
            let mut fields = BTreeMap::new();
            for token in line.split_whitespace() {
                if token == "sandbox_probe" {
                    continue;
                }
                let (key, value) = token.split_once('=')?;
                fields.insert(key.to_owned(), value.to_owned());
            }
            (fields.get("op").map(String::as_str) == Some(op)).then_some(fields)
        })
    }

    fn probe_value<'a>(fields: &'a BTreeMap<String, String>, key: &str) -> Option<&'a str> {
        fields.get(key).map(String::as_str)
    }

    fn expect_probe_line(outcome: &RunOutcome, op: &str, label: &str) -> BTreeMap<String, String> {
        let Some(fields) = probe_fields(&outcome.stdout, op) else {
            panic!(
                "{label}: no sandbox_probe line for op={op}; stdout={:?} stderr={:?} exit_code={:?}",
                outcome.stdout, outcome.stderr, outcome.exit_code
            );
        };
        fields
    }

    /// Requires an explicit access-denied denial: `outcome=denied` plus one of
    /// the allowed access-denied OS error codes.
    fn assert_probe_denied(
        fields: &BTreeMap<String, String>,
        allowed_os_errors: &[i64],
        label: &str,
    ) {
        assert_eq!(
            probe_value(fields, "outcome"),
            Some("denied"),
            "{label}: expected access-denied failure, observed {fields:?}"
        );
        let os_error = probe_value(fields, "os_error").and_then(|value| value.parse::<i64>().ok());
        assert!(
            os_error.is_some_and(|code| allowed_os_errors.contains(&code)),
            "{label}: denial must carry an access-denied OS error code from {allowed_os_errors:?}; observed os_error={:?} fields={fields:?}",
            probe_value(fields, "os_error")
        );
    }

    // ---------------------------------------------------------------------
    // Tests
    // ---------------------------------------------------------------------

    /// Workspace reads succeed, private scratch writes succeed, workspace and
    /// off-scope writes fail with access-denied codes. Parent controls prove
    /// the same writes succeed outside the sandbox first.
    #[allow(clippy::too_many_lines)]
    fn test_read_only_workspace_and_private_scratch_are_enforced(runtime: &Runtime) {
        runtime.block_on(async {
            let fixture = SandboxFixture::new();
            let forbidden = tempfile::tempdir().expect("forbidden tempdir");
            let forbidden_marker = forbidden.path().join("offscope-write.txt");
            let workspace_write_attempt = fixture.workspace.join("workspace-write-attempt.txt");

            // Parent controls: the same write operations succeed outside the
            // sandbox, then the control files are removed so the sandboxed
            // attempts below start from an absent target.
            std::fs::write(&forbidden_marker, b"parent-control\n")
                .expect("parent control write to forbidden path");
            std::fs::write(&workspace_write_attempt, b"parent-control\n")
                .expect("parent control write inside workspace");
            std::fs::remove_file(&forbidden_marker).expect("remove forbidden control file");
            std::fs::remove_file(&workspace_write_attempt).expect("remove workspace control file");

            let router = restricted_router(sandbox_config(&fixture));

            let readable = fixture.workspace.join("readable.txt");
            let outcome = run_exec_ok(
                &router,
                worker_arguments(
                    &fixture.worker,
                    "read-file",
                    &readable.display().to_string(),
                    WORKER_WAIT_MS,
                ),
                "read workspace fixture",
            )
            .await;
            let fields = expect_probe_line(&outcome, "read-file", "read workspace fixture");
            assert_eq!(
                probe_value(&fields, "outcome"),
                Some("ok"),
                "workspace read must succeed, observed {fields:?}"
            );
            assert_eq!(
                probe_value(&fields, "hex"),
                Some(hex_prefix(WORKSPACE_FIXTURE_BYTES, HEX_CAP).as_str()),
                "workspace read must return the fixture content, observed {fields:?}"
            );

            let permitted_scratch_artifact = fixture.scratch.join("permitted_scratch_artifact.txt");
            let outcome = run_exec_ok(
                &router,
                worker_arguments(
                    &fixture.worker,
                    "write-file",
                    &permitted_scratch_artifact.display().to_string(),
                    WORKER_WAIT_MS,
                ),
                "write permitted scratch artifact",
            )
            .await;
            let fields =
                expect_probe_line(&outcome, "write-file", "write permitted scratch artifact");
            assert_eq!(
                probe_value(&fields, "outcome"),
                Some("ok"),
                "scratch write must succeed, observed {fields:?}"
            );
            assert!(
                permitted_scratch_artifact.exists(),
                "permitted_scratch_artifact must exist after the sandboxed compute"
            );

            let outcome = run_exec_ok(
                &router,
                worker_arguments(
                    &fixture.worker,
                    "write-file",
                    &workspace_write_attempt.display().to_string(),
                    WORKER_WAIT_MS,
                ),
                "write inside read-only workspace",
            )
            .await;
            let fields =
                expect_probe_line(&outcome, "write-file", "write inside read-only workspace");
            assert_probe_denied(&fields, &[5], "write inside read-only workspace");
            assert!(
                !workspace_write_attempt.exists(),
                "read-only workspace must not accept writes"
            );

            let outcome = run_exec_ok(
                &router,
                worker_arguments(
                    &fixture.worker,
                    "write-file",
                    &forbidden_marker.display().to_string(),
                    WORKER_WAIT_MS,
                ),
                "write to off-scope forbidden path",
            )
            .await;
            let fields =
                expect_probe_line(&outcome, "write-file", "write to off-scope forbidden path");
            assert_probe_denied(&fields, &[5], "write to off-scope forbidden path");
            assert!(
                !forbidden_marker.exists(),
                "test_owned_forbidden_marker must not exist"
            );
        });
    }

    /// A mismatched resource commissioning and a nonexistent program both fail
    /// closed without executing the child or leaving a process behind. The
    /// canary command is proven functional by a direct host run first.
    #[allow(clippy::too_many_lines)]
    fn test_failed_setup_never_executes_child(runtime: &Runtime) {
        runtime.block_on(async {
            let fixture = SandboxFixture::new();
            let canary_marker = fixture.scratch.join("canary_marker.txt");
            let canary_program = fixture.worker.display().to_string();
            let canary_args = [
                "--sandbox-probe=write-file".to_owned(),
                canary_marker.display().to_string(),
            ];

            // Anti-vacuity control: the exact canary command creates the
            // marker when executed directly on the host.
            let control = Command::new(std::env::current_exe().expect("test executable path"))
                .args(&canary_args)
                .output()
                .expect("host canary control executes");
            assert!(
                control.status.success(),
                "host canary control failed: status={:?} stderr={:?}",
                control.status,
                String::from_utf8_lossy(&control.stderr)
            );
            assert!(
                canary_marker.exists(),
                "host canary control must create the marker"
            );
            std::fs::remove_file(&canary_marker).expect("remove canary control marker");

            // (a) Mismatched resource commissioning: the profile's resource
            // identities do not match the locally commissioned attachment.
            let mut mismatched = sandbox_config(&fixture);
            mismatched.workspace_resource_id =
                format!("{}-not-commissioned", mismatched.workspace_resource_id);
            let router = restricted_router(mismatched);
            run_expect_capability_unavailable(
                &router,
                json!({
                    "program": canary_program,
                    "args": canary_args,
                    "wait_ms": WORKER_WAIT_MS,
                    "pty": false,
                }),
                "mismatched resource commissioning",
            )
            .await;
            assert!(
                !canary_marker.exists(),
                "mismatched commissioning must not execute the child"
            );

            // (b) Correct commissioning but a nonexistent program path.
            let router = restricted_router(sandbox_config(&fixture));
            let missing_program = fixture.workspace.join("missing-program.exe");
            run_expect_capability_unavailable(
                &router,
                json!({
                    "program": missing_program.display().to_string(),
                    "args": canary_args,
                    "wait_ms": WORKER_WAIT_MS,
                    "pty": false,
                }),
                "nonexistent program path",
            )
            .await;
            assert!(
                !canary_marker.exists(),
                "nonexistent program must not execute anything"
            );

            // No orphan: poll for two seconds for any process whose image is
            // owned by this fixture root. A canary that actually ran would
            // either still be visible here or have created the marker above.
            assert_no_fixture_processes(fixture.root.path(), "failed setup");
        });
    }

    /// Loopback TCP connect and credential-adjacent reads/writes are denied.
    /// Parent controls prove the listener accepts connections and the same
    /// credential-adjacent operations succeed outside the sandbox.
    #[allow(clippy::too_many_lines)]
    fn test_loopback_network_and_host_credentials_denied(runtime: &Runtime) {
        runtime.block_on(async {
            let fixture = SandboxFixture::new();
            let credentials = tempfile::tempdir().expect("credential standin tempdir");
            let credential_file = credentials.path().join("credential_standin.txt");
            let credential_content = b"tether-credential-standin\n";
            std::fs::write(&credential_file, credential_content).expect("credential standin");
            let forbidden_marker = credentials.path().join("forbidden-credential-marker.txt");

            // Parent control: the loopback listener accepts a host connection.
            let listener = TcpListener::bind("127.0.0.1:0").expect("loopback listener");
            let address = listener.local_addr().expect("listener address");
            let control_connection =
                TcpStream::connect(address).expect("parent loopback control connect");
            let (_accepted, _) = listener.accept().expect("parent loopback control accept");
            drop(control_connection);

            // Parent control: credential-adjacent operations work outside the
            // sandbox, and the marker write target is valid.
            assert_eq!(
                std::fs::read(&credential_file).expect("parent credential read"),
                credential_content,
                "parent control must read the credential standin"
            );
            std::fs::write(&forbidden_marker, b"parent-control\n")
                .expect("parent credential marker write");
            std::fs::remove_file(&forbidden_marker).expect("remove credential marker control");

            let router = restricted_router(sandbox_config(&fixture));

            let target = address.to_string();
            let outcome = run_exec_ok(
                &router,
                worker_arguments(&fixture.worker, "connect-tcp", &target, WORKER_WAIT_MS),
                "loopback TCP connect",
            )
            .await;
            let fields = expect_probe_line(&outcome, "connect-tcp", "loopback TCP connect");
            assert_probe_denied(&fields, &[5, 10013], "loopback TCP connect");

            let outcome = run_exec_ok(
                &router,
                worker_arguments(
                    &fixture.worker,
                    "read-file",
                    &credential_file.display().to_string(),
                    WORKER_WAIT_MS,
                ),
                "read credential standin",
            )
            .await;
            let fields = expect_probe_line(&outcome, "read-file", "read credential standin");
            assert_probe_denied(&fields, &[5], "read credential standin");

            let outcome = run_exec_ok(
                &router,
                worker_arguments(
                    &fixture.worker,
                    "write-file",
                    &forbidden_marker.display().to_string(),
                    WORKER_WAIT_MS,
                ),
                "write credential marker",
            )
            .await;
            let fields = expect_probe_line(&outcome, "write-file", "write credential marker");
            assert_probe_denied(&fields, &[5], "write credential marker");
            assert!(
                !forbidden_marker.exists(),
                "test_owned_forbidden_marker must not exist in the credential standin"
            );
        });
    }

    /// Clipboard reads and observation of a fixture-owned window are denied
    /// inside the sandbox. The same probe script runs on the host first and
    /// must succeed there (clipboard round trip and window enumeration), so a
    /// sandboxed failure cannot be caused by a broken fixture or an
    /// unavailable surface. If the host control cannot be established the
    /// test fails: that is STOP-path evidence, never a weak assertion.
    #[allow(clippy::too_many_lines)]
    fn test_human_input_clipboard_window_read_denied(runtime: &Runtime) {
        runtime.block_on(async {
            let fixture = SandboxFixture::new();
            let nonce = unique_nonce();
            let window_title = format!("tether-fixture-window-{nonce}");
            let clipboard_marker = format!("tether-clipboard-fixture-{nonce}");
            let readable = fixture.workspace.join("readable.txt");
            let powershell = powershell_path();

            let probe_script_path = fixture.workspace.join("human_interface_probe.ps1");
            std::fs::write(&probe_script_path, HUMAN_INTERFACE_PROBE_SCRIPT)
                .expect("human-interface probe script");

            // Parent control 1: clipboard round trip outside the sandbox.
            let clipboard_command =
                CLIPBOARD_CONTROL_COMMAND.replace("__MARKER__", &clipboard_marker);
            let control = host_powershell(&powershell, &clipboard_command);
            let control_stdout = String::from_utf8_lossy(&control.stdout).into_owned();
            assert!(
                control_stdout.contains("clipboard_control=ok"),
                "clipboard surface is not exercisable on this runner; cannot establish the human-interface control: stdout={control_stdout:?} stderr={:?}",
                String::from_utf8_lossy(&control.stderr)
            );

            // Parent control 2: a fixture-owned window exists and the same
            // probe script observes it from the host.
            let mut window_helper =
                spawn_fixture_window(&powershell, &fixture, &window_title);
            let host_probe = poll_host_probe_until_window_visible(
                &powershell,
                &probe_script_path,
                &readable,
                &window_title,
            );
            let host_workspace =
                expect_host_probe_line(&host_probe, "ps-workspace-read", "host workspace control");
            assert_eq!(
                probe_value(&host_workspace, "outcome"),
                Some("ok"),
                "host must read the workspace fixture, observed {host_workspace:?}"
            );
            assert_eq!(
                probe_value(&host_workspace, "hex"),
                Some(hex_prefix(WORKSPACE_FIXTURE_BYTES, HEX_CAP).as_str()),
                "host must read the exact fixture bytes, observed {host_workspace:?}"
            );
            let host_fields = expect_host_probe_line(&host_probe, "ps-window-enum", "host window control");
            let host_found = probe_value(&host_fields, "found")
                .and_then(|value| value.parse::<i64>().ok())
                .unwrap_or(0);
            assert!(
                host_found >= 1,
                "fixture-owned window was not observable from the host; window observation cannot be established: {host_probe:?}"
            );
            let host_clipboard = expect_host_probe_line(
                &host_probe,
                "ps-clipboard-read",
                "host clipboard control",
            );
            let host_clipboard_len = probe_value(&host_clipboard, "len")
                .and_then(|value| value.parse::<i64>().ok());
            assert_eq!(
                probe_value(&host_clipboard, "outcome"),
                Some("ok"),
                "host clipboard control must read the marker, observed {host_clipboard:?}"
            );
            let expected_marker_len =
                i64::try_from(clipboard_marker.len()).expect("marker length fits in i64");
            assert_eq!(
                host_clipboard_len,
                Some(expected_marker_len),
                "host clipboard control must read the marker content, observed {host_clipboard:?}"
            );

            // Sandboxed probe through the provider: identical script, program,
            // and arguments as the host control.
            let router = restricted_router(sandbox_config(&fixture));
            let arguments = json!({
                "program": powershell.display().to_string(),
                "args": [
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    probe_script_path.display().to_string(),
                    "-Readable",
                    readable.display().to_string(),
                    "-WindowMatch",
                    window_title,
                ],
                "wait_ms": POWERSHELL_WAIT_MS,
                "pty": false,
            });
            let sandbox_outcome =
                run_exec_ok(&router, arguments, "sandboxed human-interface probe").await;

            // Liveness and permitted-read controls: PowerShell itself runs in
            // the sandbox and can read the workspace fixture.
            let live = expect_probe_line(&sandbox_outcome, "ps-live", "sandboxed PowerShell liveness");
            assert_eq!(
                probe_value(&live, "outcome"),
                Some("ok"),
                "sandboxed PowerShell liveness fails; the human-interface controls cannot be established (STOP candidate)"
            );
            let workspace_read = expect_probe_line(
                &sandbox_outcome,
                "ps-workspace-read",
                "sandboxed workspace read control",
            );
            assert_eq!(
                probe_value(&workspace_read, "outcome"),
                Some("ok"),
                "sandboxed PowerShell must read the workspace fixture, observed {workspace_read:?}"
            );
            assert_eq!(
                probe_value(&workspace_read, "hex"),
                Some(hex_prefix(WORKSPACE_FIXTURE_BYTES, HEX_CAP).as_str()),
                "sandboxed PowerShell must read the expected fixture bytes, observed {workspace_read:?}"
            );

            // Clipboard: reading the marker content inside the sandbox is a
            // failure; any denied/error outcome with liveness established is
            // acceptance evidence. `outcome=ok` is never accepted, even with
            // empty content.
            let clipboard = expect_probe_line(
                &sandbox_outcome,
                "ps-clipboard-read",
                "sandboxed clipboard read",
            );
            assert_ne!(
                probe_value(&clipboard, "outcome"),
                Some("ok"),
                "clipboard was readable inside the sandbox; human-interface isolation is not established (STOP candidate): {clipboard:?}"
            );

            // Window observation: the fixture-owned window must not be
            // observable from inside the sandbox, and the enumeration must
            // report something (proving PowerShell executed the probe).
            let windows = expect_probe_line(
                &sandbox_outcome,
                "ps-window-enum",
                "sandboxed window enumeration",
            );
            if probe_value(&windows, "outcome") == Some("ok") {
                let found = probe_value(&windows, "found")
                    .and_then(|value| value.parse::<i64>().ok())
                    .unwrap_or(-1);
                assert!(
                    found < 1,
                    "fixture-owned window was observable from the sandbox; window isolation is not established (STOP candidate): {windows:?}"
                );
            }

            // Cleanup: stop the fixture window and clear the marker clipboard.
            let _ = window_helper.kill();
            let _ = window_helper.wait();
            let _ = host_powershell(&powershell, CLIPBOARD_CLEAR_COMMAND);
        });
    }

    /// A `pty: true` request is denied before any spawn. The identical
    /// request in piped mode executes first, proving the denial is the pty
    /// gate and not a broken fixture.
    fn test_unsupported_pty_denied(runtime: &Runtime) {
        runtime.block_on(async {
            let fixture = SandboxFixture::new();
            let router = restricted_router(sandbox_config(&fixture));

            let control_marker = fixture.scratch.join("piped-control-marker.txt");
            let outcome = run_exec_ok(
                &router,
                worker_arguments(
                    &fixture.worker,
                    "write-file",
                    &control_marker.display().to_string(),
                    WORKER_WAIT_MS,
                ),
                "piped positive control",
            )
            .await;
            let fields = expect_probe_line(&outcome, "write-file", "piped positive control");
            assert_eq!(
                probe_value(&fields, "outcome"),
                Some("ok"),
                "piped positive control must execute, observed {fields:?}"
            );
            assert!(
                control_marker.exists(),
                "piped positive control must create its marker"
            );
            std::fs::remove_file(&control_marker).expect("remove piped control marker");

            let denied_marker = fixture.scratch.join("pty-denied-marker.txt");
            let mut arguments = worker_arguments(
                &fixture.worker,
                "write-file",
                &denied_marker.display().to_string(),
                WORKER_WAIT_MS,
            );
            arguments["pty"] = json!(true);
            run_expect_capability_unavailable(&router, arguments, "unsupported pty").await;
            assert!(
                !denied_marker.exists(),
                "unverified PTY must be denied without any spawn"
            );
        });
    }

    // ---------------------------------------------------------------------
    // Process / fixture helpers
    // ---------------------------------------------------------------------

    /// Polls for two seconds for any process whose image lives under the
    /// fixture root. Combined with the absent marker this verifies "no orphan
    /// process left" for the failed-setup cases: a canary that ran would have
    /// written its marker, and a canary still alive would be observed here.
    fn assert_no_fixture_processes(fixture_root: &Path, label: &str) {
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let mut samples = 0_u32;
        loop {
            let system = sysinfo::System::new_all();
            for (pid, process) in system.processes() {
                if let Some(image) = process.exe() {
                    assert!(
                        !path_is_within(image, fixture_root),
                        "{label}: fixture-owned process {pid} is still running at {}",
                        image.display()
                    );
                }
            }
            samples += 1;
            if std::time::Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        println!(
            "{label}: orphan check sampled {samples} times over two seconds; no fixture-owned process image observed"
        );
    }

    fn path_is_within(candidate: &Path, root: &Path) -> bool {
        let normalize = |path: &Path| path.to_string_lossy().replace('/', "\\").to_lowercase();
        let candidate = normalize(candidate);
        let root = normalize(root);
        candidate.starts_with(&format!("{root}\\"))
    }

    fn unique_nonce() -> String {
        use std::fmt::Write as _;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_nanos());
        let mut nonce = String::with_capacity(32);
        let _ = write!(nonce, "{:08x}{now:016x}", std::process::id());
        nonce
    }

    fn powershell_path() -> PathBuf {
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_owned());
        let path = Path::new(&system_root)
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");
        assert!(path.is_file(), "PowerShell not found at {}", path.display());
        path
    }

    fn host_powershell(powershell: &Path, command: &str) -> std::process::Output {
        Command::new(powershell)
            .args(["-NoProfile", "-NonInteractive", "-Command", command])
            .output()
            .expect("host PowerShell probe executes")
    }

    fn host_powershell_script(
        powershell: &Path,
        script: &Path,
        readable: &Path,
        window_match: &str,
    ) -> (String, String, Option<i32>) {
        let output = Command::new(powershell)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(script)
            .arg("-Readable")
            .arg(readable)
            .arg("-WindowMatch")
            .arg(window_match)
            .output()
            .expect("host probe script executes");
        (
            String::from_utf8_lossy(&output.stdout).into_owned(),
            String::from_utf8_lossy(&output.stderr).into_owned(),
            output.status.code(),
        )
    }

    fn spawn_fixture_window(
        powershell: &Path,
        fixture: &SandboxFixture,
        window_title: &str,
    ) -> Child {
        let script = fixture.workspace.join("fixture_window.ps1");
        std::fs::write(&script, FIXTURE_WINDOW_SCRIPT).expect("fixture window script");
        Command::new(powershell)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(&script)
            .arg("-Title")
            .arg(window_title)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("fixture window helper starts")
    }

    /// Bounded poll: run the host probe until it observes the fixture window
    /// (or a ten-second budget expires), so the host control never depends on
    /// a fixed sleep.
    fn poll_host_probe_until_window_visible(
        powershell: &Path,
        script: &Path,
        readable: &Path,
        window_match: &str,
    ) -> String {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            let (stdout, _stderr, _code) =
                host_powershell_script(powershell, script, readable, window_match);
            let found = probe_fields(&stdout, "ps-window-enum")
                .and_then(|fields| {
                    probe_value(&fields, "found").and_then(|value| value.parse::<i64>().ok())
                })
                .unwrap_or(0);
            if found >= 1 || std::time::Instant::now() >= deadline {
                return stdout;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }

    fn expect_host_probe_line(stdout: &str, op: &str, label: &str) -> BTreeMap<String, String> {
        let Some(fields) = probe_fields(stdout, op) else {
            panic!("{label}: host probe produced no line for op={op}; stdout={stdout:?}");
        };
        fields
    }
}
