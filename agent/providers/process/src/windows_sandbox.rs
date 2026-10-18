//! Windows `AppContainer` isolation backend (Task 3 feasibility gate).
//!
//! This module implements [`IsolatedLauncher`] over the pinned
//! `sandboxrs-windows` `0.1.1` crate (crates.io tarball SHA256
//! `ac9782a67702598bcc4bd89a7fda90598a31096d479e142a57e0a69031f2aaf1`).
//! The enforced boundary is a **plain `AppContainer` profile with a
//! zero-capability token** — not `LPAC` (the crate exposes no low-privilege
//! token APIs) and not a hypervisor sandbox. `BackendPreference::AppContainer`
//! is passed for every launch, but the crate's preference is only a weak
//! ordering hint: its backend selection returns the first usable probe entry
//! and can still choose the experimental `Experimental_CreateProcessInSandbox`
//! backend. The selected backend is therefore re-verified after construction
//! and every launch is refused with `capability_unavailable` unless it reports
//! exactly `BackendKind::AppContainer`. That re-check is the sole,
//! load-bearing guarantee and must never be removed (an upstream report of the
//! ineffective preference is recommended).
//!
//! Every launch:
//!
//! - verifies the invocation profile against the locally commissioned
//!   [`WindowsSandboxConfig`] attachment (`supported_profile`) before any OS
//!   work, and propagates any denial unchanged;
//! - rejects `pty: true` with `capability_unavailable` and zero spawn
//!   attempts: only piped stdio is verified;
//! - builds the sandbox with the private scratch directory as the read-write
//!   builder root and the workspace as a disjoint read-only root, then creates
//!   the child suspended, attaches the Job Object, and resumes only afterwards
//!   (the crate's backend performs that ordering and terminates and reaps on
//!   every failure path);
//! - clears the environment and passes only a fixed explicit allowlist: the
//!   system root and `windir`, system drive, a system-directory `PATH`, and
//!   `TEMP`/`TMP` pointed at the scratch root, plus the remaining system and
//!   user-profile variables that the pinned crate itself supplies for cleared
//!   blocks (its guard adds them only when a cleared block would otherwise be
//!   empty; this consumer's block never is, so the same vetted names are
//!   provided here — without them `CreateProcessW` fails with Win32 error 203
//!   before any child is created; see the `ESSENTIAL_ENVIRONMENT_VARIABLES`
//!   constant below).
//!   Values are read from this agent's environment one fixed name at a time;
//!   no other host environment value is inherited and the crate's own probe
//!   variable cannot leak into sandboxed children. The crate additionally adds
//!   hidden drive-current-directory markers, which carry no credential
//!   material;
//! - reports every setup or launch failure as `capability_unavailable` with
//!   zero fallback to ambient spawning, a shell, or another backend.
//!
//! The sandboxed child owns raw OS handles and is not movable across threads,
//! so a dedicated owner thread creates it, keeps the backing [`Sandbox`]
//! (and therefore the `AppContainer` profile) alive for the child's lifetime,
//! and services status, termination, and stdin requests from the session.
//!
//! # Probe-contract requirement for future production wiring
//!
//! On the first `Sandbox::build()` of a process the crate runs a live probe
//! that copies the consuming executable into a temporary workspace and
//! executes it **with no arguments, expecting exit code 0 and applying no
//! timeout**. A future `tetherd` commissioning path must therefore provide a
//! `main` that exits 0 immediately when `SANDBOXRS_PROBE_SELF` is set (the
//! variable the crate sets in the host environment before launching the
//! probe); a no-argument hang or a non-zero exit would hang the first build or
//! permanently disable the backend. Tetherplane never sets the crate's
//! `SANDBOXRS_ATTACKER` hook and never relies on it. Task 3 does not wire this
//! backend into production dispatch: `tetherd` keeps zero commissioned
//! profiles and [`crate::DenyUnsupportedLauncher`] remains the shipped
//! launcher.
//!
//! # Upstream scope disclaimer
//!
//! Preserved verbatim from the crate's `README.md` (security posture section):
//! "`sandboxrs-windows` is not a promise that arbitrary hostile binaries are
//! perfectly contained. It is a no-admin process launcher with constrained
//! filesystem authority."
//!
//! # Known limitations and accepted risks (recorded for commissioning)
//!
//! - This is a **plain `AppContainer`** boundary: the crate exposes no `LPAC`
//!   or token-editing APIs. Loopback/network, clipboard/desktop, credential,
//!   and privileged-IPC denials are **not enforced by the crate** — they rest
//!   on the zero-capability token and OS defaults and are adjudicated by the
//!   native acceptance suite on the hosted runner, never by this code alone.
//! - The crate's filesystem grants are **persistent and are never revoked**
//!   on teardown (dropping the sandbox only deletes the profile). Task 3 uses
//!   fixture-owned directories only; re-evaluate at commissioning.
//! - The pinned crate is single-maintainer, AI-agent-authored, and dormant
//!   since 2026-08-11. Adoption stays conditioned on the hosted native
//!   evidence and the independent reviews of this change.
//! - **Stdin is served by a blocking write on the owner thread.** A sandboxed
//!   child that stops draining stdin can block that thread in `write_all`
//!   (the crate's stdio pipes are blocking 64 KiB pipes), delaying
//!   `Terminate` and kill-on-drop teardown until the child reads, exits, or
//!   the agent process exits (the Job Object still guarantees tree death with
//!   the agent). The acceptance suite never writes stdin. This must be fixed
//!   (dedicated stdin writer thread, bounded/overlapped writes, or a
//!   timeout) before production wiring; Task 4 lifecycle hardening is
//!   adjacent.

use std::collections::BTreeSet;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use async_trait::async_trait;
use sandboxrs_windows::{BackendKind, BackendPreference, Sandbox, SandboxChild, Stdio};
use tether_core::{
    AuthorizedLaunch, CapabilityError, ExecutionEffect, ExecutionProfile, ResourceAccess,
};

use crate::capability_unavailable;
use crate::isolation::IsolatedLauncher;
use crate::session::ProcessSession;

/// Backend identity reported by [`WindowsSandboxLauncher::supported_profile`].
/// Only the forced `AppContainer` path can ever be selected by this launcher.
const BACKEND_LABEL: &str = "sandboxrs-appcontainer";

/// Diagnostic label for the sandbox identity. The crate always appends a
/// unique per-build suffix (process id, time nonce, and a sequence counter),
/// so concurrent or repeated launches never share a profile.
const SANDBOX_IDENTITY_LABEL: &str = "tether-process";

/// Trusted, locally commissioned attachment of profile resource identities to
/// host paths. Never populated from invocation JSON.
#[derive(Clone, Debug)]
pub struct WindowsSandboxConfig {
    /// Resource identity of the read-only workspace attachment.
    pub workspace_resource_id: String,
    /// Host path of the read-only workspace root.
    pub workspace_path: PathBuf,
    /// Resource identity of the private read-write scratch attachment.
    pub scratch_resource_id: String,
    /// Host path of the private read-write scratch root; this is the sandbox's
    /// read-write builder root.
    pub scratch_path: PathBuf,
}

/// Windows isolation backend for the supported restricted profile.
///
/// Construction attaches locally commissioned resource identities to host
/// paths and performs no OS work. See the module docs for the exact boundary,
/// pin, and probe contract.
pub struct WindowsSandboxLauncher {
    config: WindowsSandboxConfig,
}

impl WindowsSandboxLauncher {
    /// Attaches the launcher to locally commissioned resource identities and
    /// host paths. Creates no profile and runs no sandbox code.
    #[must_use]
    pub fn new(config: WindowsSandboxConfig) -> Self {
        Self { config }
    }

    /// Verifies the profile is exactly the supported first-profile shape and
    /// that its resource identities match the locally commissioned attachment.
    /// Any mismatch or unsupported field is denied before any OS work.
    ///
    /// # Errors
    ///
    /// Returns `capability_unavailable` when the profile requires anything
    /// outside the supported restricted shape, or when its workspace or
    /// scratch resource identity does not match this launcher's commissioned
    /// configuration.
    pub fn supported_profile(
        &self,
        profile: &ExecutionProfile,
    ) -> Result<VerifiedPlatformGuarantees, CapabilityError> {
        if !is_supported_restricted_shape(profile) {
            return Err(capability_unavailable(
                "execution profile has unsupported or invalid requirements for the Windows restricted backend",
            ));
        }
        if profile.workspace.resource_id != self.config.workspace_resource_id
            || profile.scratch.resource_id != self.config.scratch_resource_id
        {
            return Err(capability_unavailable(
                "execution profile resource identities do not match the locally commissioned attachment",
            ));
        }

        Ok(VerifiedPlatformGuarantees {
            backend: BACKEND_LABEL,
            os_build: os_build(),
            piped_stdio: true,
            pty: false,
        })
    }
}

/// Only fields actually verified for this profile shape; no aspiration fields.
/// PTY mode stays reported as unavailable until separately proven.
#[derive(Clone, Debug)]
pub struct VerifiedPlatformGuarantees {
    /// The actually selected backend, e.g. `sandboxrs-appcontainer`.
    pub backend: &'static str,
    /// Operating-system build recorded from the local OS into evidence.
    pub os_build: String,
    /// Piped stdio is verified for this backend.
    pub piped_stdio: bool,
    /// PTY mode is never verified on this backend.
    pub pty: bool,
}

#[async_trait]
impl IsolatedLauncher for WindowsSandboxLauncher {
    async fn launch(
        &self,
        authority: &AuthorizedLaunch,
        program: &str,
        args: &[String],
        pty: bool,
    ) -> Result<ProcessSession, CapabilityError> {
        // Rule 1: only an exactly matching, locally commissioned profile may
        // reach OS setup; any denial propagates unchanged.
        let _guarantees = self.supported_profile(authority.profile())?;

        // Rule 2: PTY mode has no verified backend; deny before any spawn.
        if pty {
            return Err(capability_unavailable(
                "no verified PTY isolation backend is installed for the supported Windows profile",
            ));
        }

        // Rule 3: the program is launched directly with an argument vector —
        // never through a shell or command string — and must be an absolute
        // path so host `PATH` resolution cannot select the image.
        if !Path::new(program).is_absolute() {
            return Err(capability_unavailable(
                "the sandboxed program must be an absolute path; ambient executable resolution is not permitted",
            ));
        }
        validate_roots(&self.config)?;
        let environment = minimal_environment(&self.config)?;
        let (process, init_rx) = spawn_sandbox_owner(&self.config, program, args, &environment)?;

        let init = tokio::task::spawn_blocking(move || init_rx.recv())
            .await
            .map_err(|error| provider_error(&format!("sandbox launch task failed: {error}")))?
            .map_err(|_| {
                capability_unavailable(
                    "the sandbox owner thread ended before reporting its launch result",
                )
            })?
            .map_err(|message| capability_unavailable(&message))?;

        Ok(ProcessSession::from_sandbox(
            init.pid,
            process,
            init.stdout,
            init.stderr,
        ))
    }
}

/// Mirrors `ExecutionProfile::is_supported_restricted_shape` from `tether-core`
/// (crate-private there): non-private read-only workspace, private
/// non-executable scratch with read/write/create, only
/// `ReadWorkspace`/`WriteScratch` effects, and non-empty identifiers.
fn is_supported_restricted_shape(profile: &ExecutionProfile) -> bool {
    let identifiers = [
        &profile.profile_id,
        &profile.organization_id,
        &profile.principal_id,
        &profile.device_id,
        &profile.workspace.resource_id,
        &profile.scratch.resource_id,
    ];
    identifiers.iter().all(|id| !id.trim().is_empty())
        && profile.revision > 0
        && profile.enrollment_generation > 0
        && profile.workspace.resource_id != profile.scratch.resource_id
        && !profile.workspace.private
        && profile.workspace.access == BTreeSet::from([ResourceAccess::Read])
        && profile.scratch.private
        && BTreeSet::from([
            ResourceAccess::Read,
            ResourceAccess::Write,
            ResourceAccess::Create,
        ])
        .is_subset(&profile.scratch.access)
        && !profile.scratch.access.contains(&ResourceAccess::Execute)
        && profile.allowed_effects
            == BTreeSet::from([
                ExecutionEffect::ReadWorkspace,
                ExecutionEffect::WriteScratch,
            ])
}

/// Requires existing, disjoint commissioned roots: the scratch directory is
/// the read-write builder root and the workspace the read-only root; nested or
/// identical roots are unsupported and denied.
fn validate_roots(config: &WindowsSandboxConfig) -> Result<(), CapabilityError> {
    let scratch = std::fs::canonicalize(&config.scratch_path).map_err(|error| {
        capability_unavailable(&format!(
            "the commissioned scratch path is unavailable: {error}"
        ))
    })?;
    let workspace = std::fs::canonicalize(&config.workspace_path).map_err(|error| {
        capability_unavailable(&format!(
            "the commissioned workspace path is unavailable: {error}"
        ))
    })?;
    if scratch.starts_with(&workspace) || workspace.starts_with(&scratch) {
        return Err(capability_unavailable(
            "the commissioned workspace and scratch roots must be disjoint; nested or identical roots are not supported",
        ));
    }
    Ok(())
}

/// Environment variable names the pinned crate's `AppContainer` backend itself
/// supplies for a cleared block (`sandboxrs-windows` 0.1.1
/// `essential_env_entries()`, following upstream commit `693e7f1d`). The
/// crate's guard adds that list only when a cleared block would otherwise be
/// empty; this consumer's block never is (the crate seeds it with the host's
/// hidden drive markers and this module supplies the sandboxed overrides), so
/// the names are provided here instead. Without them `CreateProcessW` fails
/// with Win32 error 203 (`ERROR_ENVVAR_NOT_FOUND`; see Microsoft KB 305136,
/// `CreateEnvironmentBlock` and unloadable user environment) before any child
/// is created. Values are read from the host environment one fixed name at a
/// time — nothing outside this list is ever passed.
const ESSENTIAL_ENVIRONMENT_VARIABLES: [&str; 30] = [
    "SystemRoot",
    "windir",
    "SystemDrive",
    "ComSpec",
    "PATHEXT",
    "TEMP",
    "TMP",
    "PATH",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "ALLUSERSPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "CommonProgramFiles",
    "CommonProgramFiles(X86)",
    "OS",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
    "PROCESSOR_LEVEL",
    "PROCESSOR_REVISION",
    "PUBLIC",
    "COMPUTERNAME",
    "USERNAME",
    "USERDOMAIN",
    "SESSIONNAME",
];

/// Explicit minimal environment for sandboxed children: the sandboxed
/// overrides (`TEMP`/`TMP` redirected into the private scratch root, a
/// system-directory-only `PATH`, the system root and drive) plus the remaining
/// vetted essential names from [`ESSENTIAL_ENVIRONMENT_VARIABLES`] (host
/// values read by name; a missing name is skipped). No other host environment
/// value is passed through. The crate additionally appends hidden
/// drive-current-directory markers (`=X:`) that its public API cannot
/// suppress; they carry host drive paths, not credential material.
fn minimal_environment(
    config: &WindowsSandboxConfig,
) -> Result<Vec<(String, String)>, CapabilityError> {
    let system_root = std::env::var("SystemRoot")
        .ok()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            capability_unavailable(
                "SystemRoot is not set; the minimal sandbox environment cannot be constructed",
            )
        })?;
    let system_drive = std::env::var("SystemDrive")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| system_root.chars().take(2).collect());
    let system32 = format!("{system_root}\\System32");
    let scratch = config.scratch_path.display().to_string();

    let mut environment = vec![
        ("SystemRoot".to_owned(), system_root.clone()),
        ("windir".to_owned(), system_root.clone()),
        ("SystemDrive".to_owned(), system_drive),
        ("PATH".to_owned(), format!("{system32};{system_root}")),
        ("TEMP".to_owned(), scratch.clone()),
        ("TMP".to_owned(), scratch),
    ];
    for name in ESSENTIAL_ENVIRONMENT_VARIABLES {
        if environment
            .iter()
            .any(|(existing, _)| existing.eq_ignore_ascii_case(name))
        {
            continue;
        }
        if let Some(value) = std::env::var_os(name) {
            environment.push((name.to_owned(), value.to_string_lossy().into_owned()));
        }
    }
    Ok(environment)
}

/// OS build string taken from the local operating system for evidence.
fn os_build() -> String {
    sysinfo::System::os_version()
        .or_else(sysinfo::System::long_os_version)
        .unwrap_or_else(|| "unknown".to_owned())
}

/// Launch result reported by the owner thread once the child is running.
struct SandboxInit {
    pid: u32,
    stdout: Option<Box<dyn Read + Send>>,
    stderr: Option<Box<dyn Read + Send>>,
}

/// Requests sent from the session to the thread that owns the sandboxed
/// child. Replies travel over per-request channels so the async side never
/// blocks a runtime worker.
enum SandboxRequest {
    ExitCode(std::sync::mpsc::Sender<Result<Option<i32>, String>>),
    Terminate(std::sync::mpsc::Sender<Result<(), String>>),
    Input(Vec<u8>, std::sync::mpsc::Sender<Result<(), String>>),
    CloseInput,
}

/// Session-side handle to a running sandboxed child. The child itself lives on
/// its owner thread; this handle only carries requests to that thread.
pub(crate) struct SandboxProcess {
    requests: Mutex<std::sync::mpsc::Sender<SandboxRequest>>,
}

impl SandboxProcess {
    /// Whether the sandboxed child has exited, with its exit code when known.
    pub(crate) async fn try_exit_code(&self) -> Result<Option<i32>, CapabilityError> {
        self.request(SandboxRequest::ExitCode).await
    }

    /// Terminates the whole sandboxed process tree through the Job Object.
    pub(crate) async fn terminate(&self) -> Result<(), CapabilityError> {
        self.request(SandboxRequest::Terminate).await
    }

    /// Writes to the child's standard input.
    pub(crate) async fn write_input(&self, data: &[u8]) -> Result<(), CapabilityError> {
        self.request(|reply| SandboxRequest::Input(data.to_vec(), reply))
            .await
    }

    /// Closes the child's standard input; best effort because an exited owner
    /// thread means the child is already gone.
    pub(crate) fn close_input(&self) {
        let _ = self.send(SandboxRequest::CloseInput);
    }

    async fn request<T>(
        &self,
        build: impl FnOnce(std::sync::mpsc::Sender<Result<T, String>>) -> SandboxRequest,
    ) -> Result<T, CapabilityError>
    where
        T: Send + 'static,
    {
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        self.send(build(reply_tx))?;
        let received = tokio::task::spawn_blocking(move || reply_rx.recv())
            .await
            .map_err(|error| provider_error(&format!("sandbox request task failed: {error}")))?;
        let result =
            received.map_err(|_| provider_error("the sandbox owner thread stopped responding"))?;
        result.map_err(|message| provider_error(&message))
    }

    fn send(&self, request: SandboxRequest) -> Result<(), CapabilityError> {
        self.requests
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .send(request)
            .map_err(|_| provider_error("the sandbox owner thread is not available"))
    }
}

fn owner_channel() -> (SandboxProcess, std::sync::mpsc::Receiver<SandboxRequest>) {
    let (tx, rx) = std::sync::mpsc::channel();
    (
        SandboxProcess {
            requests: Mutex::new(tx),
        },
        rx,
    )
}

/// Starts the dedicated owner thread that builds the sandbox, creates the
/// suspended child, and then services session requests until the session is
/// dropped. The child never leaves this thread: the crate's child owns raw OS
/// handles and is not sendable.
fn spawn_sandbox_owner(
    config: &WindowsSandboxConfig,
    program: &str,
    args: &[String],
    environment: &[(String, String)],
) -> Result<
    (
        SandboxProcess,
        std::sync::mpsc::Receiver<Result<SandboxInit, String>>,
    ),
    CapabilityError,
> {
    let (init_tx, init_rx) = std::sync::mpsc::channel();
    let (process, requests_rx) = owner_channel();
    let config = config.clone();
    let program = program.to_owned();
    let args = args.to_vec();
    let environment = environment.to_vec();

    std::thread::Builder::new()
        .name("tether-sandbox-owner".to_owned())
        .spawn(move || {
            owner_main(
                &config,
                &program,
                &args,
                &environment,
                &init_tx,
                &requests_rx,
            );
        })
        .map_err(|error| {
            capability_unavailable(&format!(
                "sandbox owner thread could not be started: {error}"
            ))
        })?;

    Ok((process, init_rx))
}

fn owner_main(
    config: &WindowsSandboxConfig,
    program: &str,
    args: &[String],
    environment: &[(String, String)],
    init_tx: &std::sync::mpsc::Sender<Result<SandboxInit, String>>,
    requests_rx: &std::sync::mpsc::Receiver<SandboxRequest>,
) {
    match build_and_spawn(config, program, args, environment) {
        Ok((mut child, keep_alive)) => {
            let Some(pid) = child.id() else {
                let _ = init_tx.send(Err("the sandboxed child reported no process id".to_owned()));
                return;
            };
            let stdout = child
                .stdout
                .take()
                .map(|reader| Box::new(reader) as Box<dyn Read + Send>);
            let stderr = child
                .stderr
                .take()
                .map(|reader| Box::new(reader) as Box<dyn Read + Send>);

            if init_tx
                .send(Ok(SandboxInit {
                    pid,
                    stdout,
                    stderr,
                }))
                .is_err()
            {
                // The launch was abandoned. The drops are explicit and ordered:
                // the child must terminate (Job Object kill on drop) before the
                // keep-alive is released and the `AppContainer` profile is
                // deleted - implicit binding drops would run in the opposite
                // order (`keep_alive` is declared after `child`).
                drop(child);
                drop(keep_alive);
                return;
            }
            service_requests(child, keep_alive, requests_rx);
        }
        Err(message) => {
            let _ = init_tx.send(Err(message));
        }
    }
}

/// Builds the sandbox and creates the child. Fails closed on every step: a
/// setup or spawn failure returns an error string that the launcher maps to
/// `capability_unavailable`, with no fallback path.
fn build_and_spawn(
    config: &WindowsSandboxConfig,
    program: &str,
    args: &[String],
    environment: &[(String, String)],
) -> Result<(SandboxChild, Sandbox), String> {
    let sandbox = Sandbox::builder(&config.scratch_path)
        // Disjoint roots only: the scratch directory is the read-write root
        // and the workspace a separate read-only root.
        .read_only(&config.workspace_path)
        .preferred_backend(BackendPreference::AppContainer)
        .identity(SANDBOX_IDENTITY_LABEL)
        .build()
        .map_err(|error| format!("sandbox backend setup failed: {error}"))?;

    if sandbox.backend() != BackendKind::AppContainer {
        return Err(format!(
            "the forced AppContainer backend was not selected; got {}",
            sandbox.backend().label()
        ));
    }

    let mut command = sandbox.command(program);
    command.args(args);
    command.env_clear();
    command.current_dir(&config.scratch_path);
    command.stdin(Stdio::Piped);
    command.stdout(Stdio::Piped);
    command.stderr(Stdio::Piped);
    for (key, value) in environment {
        command.env(key, value);
    }

    let child = command
        .spawn()
        .map_err(|error| format!("sandboxed process creation failed: {error}"))?;
    Ok((child, sandbox))
}

/// Serves session requests on the owner thread until the session (its request
/// sender) is dropped, then terminates the child and releases the sandbox.
fn service_requests(
    mut child: SandboxChild,
    keep_alive: Sandbox,
    requests: &std::sync::mpsc::Receiver<SandboxRequest>,
) {
    while let Ok(request) = requests.recv() {
        match request {
            SandboxRequest::ExitCode(reply) => {
                let result = child
                    .try_wait()
                    .map(|status| status.and_then(|status| status.code()))
                    .map_err(|error| format!("status query failed: {error}"));
                let _ = reply.send(result);
            }
            SandboxRequest::Terminate(reply) => {
                let result = child
                    .kill()
                    .map_err(|error| format!("job termination failed: {error}"));
                let _ = reply.send(result);
            }
            SandboxRequest::Input(data, reply) => {
                let _ = reply.send(write_stdin(&mut child, &data));
            }
            SandboxRequest::CloseInput => {
                child.stdin.take();
            }
        }
    }

    // The child must terminate (Job Object kill on drop) before the
    // keep-alive is released and the `AppContainer` profile is deleted.
    drop(child);
    drop(keep_alive);
}

fn write_stdin(child: &mut SandboxChild, data: &[u8]) -> Result<(), String> {
    use std::io::Write as _;
    let stdin = child
        .stdin
        .as_mut()
        .ok_or_else(|| "sandboxed child stdin is closed".to_owned())?;
    stdin
        .write_all(data)
        .map_err(|error| format!("stdin write failed: {error}"))?;
    stdin
        .flush()
        .map_err(|error| format!("stdin flush failed: {error}"))
}

fn provider_error(message: &str) -> CapabilityError {
    CapabilityError {
        code: tether_core::ErrorCode::ProviderFailure,
        message: message.to_owned(),
        recovery_hint: None,
        details: serde_json::json!({}),
    }
}

#[cfg(test)]
mod tests {
    //! Pure construction tests for the cleared sandbox environment.
    //!
    //! These tests never launch a sandbox and never execute a child process:
    //! they build the explicit environment list and assert its contract. The
    //! related native failure (`CreateProcessW` Win32 error 203 before any
    //! child is created) is only adjudicated by the frozen `windows_isolation`
    //! suite on the hosted runner, never on a developer desktop.

    use std::collections::{BTreeMap, BTreeSet};

    use super::{PathBuf, WindowsSandboxConfig, minimal_environment};

    /// Independent copy of the vetted essential environment names
    /// (`sandboxrs-windows` 0.1.1 `essential_env_entries()`, following
    /// upstream commit `693e7f1d`). Duplicated here on purpose: the test pins
    /// the required contract while the implementation mirrors the crate. An
    /// extra implementation name fails the allowlist check below; a missing
    /// one fails the host-supply check whenever the host provides that name.
    const VETTED_ESSENTIAL_NAMES: [&str; 30] = [
        "SystemRoot",
        "windir",
        "SystemDrive",
        "ComSpec",
        "PATHEXT",
        "TEMP",
        "TMP",
        "PATH",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "ALLUSERSPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "PROGRAMDATA",
        "PROGRAMFILES",
        "PROGRAMFILES(X86)",
        "CommonProgramFiles",
        "CommonProgramFiles(X86)",
        "OS",
        "NUMBER_OF_PROCESSORS",
        "PROCESSOR_ARCHITECTURE",
        "PROCESSOR_IDENTIFIER",
        "PROCESSOR_LEVEL",
        "PROCESSOR_REVISION",
        "PUBLIC",
        "COMPUTERNAME",
        "USERNAME",
        "USERDOMAIN",
        "SESSIONNAME",
    ];

    /// The names this module always overrides with sandboxed values; host
    /// values for these names are never passed through.
    const SANDBOXED_OVERRIDES: [&str; 6] =
        ["SystemRoot", "windir", "SystemDrive", "PATH", "TEMP", "TMP"];

    fn fixture_config() -> WindowsSandboxConfig {
        // The environment builder only reads `scratch_path` as a string; no
        // filesystem access happens in these tests.
        WindowsSandboxConfig {
            workspace_resource_id: "fixture-workspace".to_owned(),
            workspace_path: PathBuf::from(r"C:\tether-fixture\workspace"),
            scratch_resource_id: "fixture-scratch".to_owned(),
            scratch_path: PathBuf::from(r"C:\tether-fixture\scratch"),
        }
    }

    fn built_environment() -> BTreeMap<String, String> {
        minimal_environment(&fixture_config())
            .expect("the minimal environment builds when SystemRoot is present")
            .into_iter()
            .collect()
    }

    /// Every vetted essential name present on the host must be supplied from
    /// the host environment (except the sandboxed overrides). Before the
    /// 203-defect fix this fails: the block only carried the overrides, so a
    /// cleared `AppContainer` launch could not resolve the user environment.
    #[test]
    fn essential_variables_present_on_the_host_are_supplied() {
        let environment = built_environment();
        let mut checked = 0usize;
        for name in VETTED_ESSENTIAL_NAMES {
            if SANDBOXED_OVERRIDES.contains(&name) {
                continue;
            }
            if let Some(value) = std::env::var_os(name) {
                let value = value.to_string_lossy().into_owned();
                assert_eq!(
                    environment.get(name),
                    Some(&value),
                    "{name} is set on the host and must be supplied in the cleared environment"
                );
                checked += 1;
            }
        }
        assert!(
            checked >= 5,
            "expected the host to provide several essential variables; checked {checked}"
        );
    }

    /// The explicit sandboxed values must survive the allowlist extension:
    /// `TEMP`/`TMP` point at the private scratch root, the system paths at the
    /// host system locations, and the exactly derived system drive.
    #[test]
    fn explicit_sandboxed_overrides_are_never_replaced_by_host_values() {
        let environment = built_environment();
        let config = fixture_config();
        let scratch = config.scratch_path.display().to_string();
        let system_root =
            std::env::var("SystemRoot").expect("SystemRoot is present on Windows hosts");
        let system_drive = std::env::var("SystemDrive")
            .ok()
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| system_root.chars().take(2).collect());
        let expected = [
            ("SystemRoot", system_root.clone()),
            ("windir", system_root.clone()),
            ("SystemDrive", system_drive),
            ("PATH", format!("{system_root}\\System32;{system_root}")),
            ("TEMP", scratch.clone()),
            ("TMP", scratch),
        ];
        for (name, value) in expected {
            assert_eq!(
                environment.get(name),
                Some(&value),
                "{name} must keep its explicit sandboxed value"
            );
        }
    }

    /// No name outside the vetted allowlist may enter the cleared environment
    /// (no blanket host inheritance), and no name may appear twice.
    #[test]
    fn only_the_fixed_allowlist_enters_the_cleared_environment() {
        let environment = built_environment();
        let mut seen = BTreeSet::new();
        for name in environment.keys() {
            assert!(
                VETTED_ESSENTIAL_NAMES.contains(&name.as_str()),
                "unexpected environment name in the cleared block: {name}"
            );
            assert!(
                seen.insert(name.to_ascii_uppercase()),
                "duplicate environment name in the cleared block: {name}"
            );
        }
    }
}
