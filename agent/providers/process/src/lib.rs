#![forbid(unsafe_code)]

mod output;
mod session;

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Mutex as AsyncMutex;

const MAX_RETAINED_SESSIONS: usize = 128;

use async_trait::async_trait;
use serde_json::{Value, json};
use sysinfo::System;
use tether_core::{
    CapabilityError, CapabilityProvider, ErrorCode, HandleRegistry, InvocationEnvelope,
    ProviderResult, ResourceKey, ResourceOrigin, ResponseBudget, TrustedOwnershipRegistry,
    VerificationStatus,
};

use session::ProcessSession;

pub struct ProcessProvider {
    sessions: HandleRegistry<Arc<ProcessSession>>,
    handles: Mutex<VecDeque<String>>,
    ownership: Arc<TrustedOwnershipRegistry>,
    admission: AsyncMutex<()>,
    max_sessions: usize,
}

impl ProcessProvider {
    #[must_use]
    pub fn new() -> Self {
        Self::with_ownership(Arc::new(TrustedOwnershipRegistry::new()))
    }

    #[must_use]
    pub fn with_ownership(ownership: Arc<TrustedOwnershipRegistry>) -> Self {
        Self {
            sessions: HandleRegistry::new(),
            handles: Mutex::new(VecDeque::new()),
            ownership,
            admission: AsyncMutex::new(()),
            max_sessions: MAX_RETAINED_SESSIONS,
        }
    }

    #[cfg(test)]
    fn with_session_limit(max_sessions: usize) -> Self {
        let mut provider = Self::new();
        provider.max_sessions = max_sessions;
        provider
    }

    async fn reclaim_finished_sessions(&self) -> Result<(), CapabilityError> {
        let handles = self
            .handles
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        if handles.len() < self.max_sessions {
            return Ok(());
        }
        for handle in handles {
            let session = self.sessions.with(&handle, Arc::clone)?;
            let (running, _) = session.status().await?;
            if !running {
                self.sessions.remove(&handle);
                self.handles
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .retain(|candidate| candidate != &handle);
                self.ownership
                    .unregister(&ResourceKey::Process(session.pid()));
            }
            if self
                .handles
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .len()
                < self.max_sessions
            {
                return Ok(());
            }
        }
        Err(CapabilityError {
            code: ErrorCode::ResourceConflict,
            message: "process session capacity exhausted; terminate or wait for owned sessions"
                .into(),
            recovery_hint: None,
            details: json!({ "max_sessions": self.max_sessions }),
        })
    }

    async fn run(
        &self,
        arguments: &Value,
        invocation: &InvocationEnvelope,
    ) -> Result<Value, CapabilityError> {
        let program = string_argument(arguments, "program")?;
        let args = string_array_argument(arguments, "args")?;
        let wait_ms = u64_argument(arguments, "wait_ms", 250)?;
        let pty = bool_argument(arguments, "pty", false)?;
        // Serialize admissions only; wait_for_exit must not monopolize this lock.
        let (session, handle) = {
            let _admission = self.admission.lock().await;
            self.reclaim_finished_sessions().await?;
            let session = Arc::new(ProcessSession::spawn(program, &args, pty).await?);
            self.ownership.register(
                ResourceKey::Process(session.pid()),
                ResourceOrigin::Tetherplane,
            );
            let handle = self.sessions.insert("proc", Arc::clone(&session));
            self.handles
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push_back(handle.clone());
            (session, handle)
        };

        let _ = session
            .wait_for_exit(Duration::from_millis(wait_ms))
            .await?;
        let (running, exit_code) = session.status().await?;
        if !running {
            self.ownership
                .unregister(&ResourceKey::Process(session.pid()));
        }
        let budget = ResponseBudget::for_mode(invocation.response_mode.clone());
        let (raw_stdout, raw_stderr, output_truncated) = session.take_unseen_output();
        let stdout = budget.apply_text(&raw_stdout, 0)?;
        let stderr = budget.apply_text(&raw_stderr, 0)?;

        Ok(json!({
            "handle": handle,
            "pid": session.pid(),
            "origin": "tetherplane",
            "pty": session.is_pty(),
            "running": running,
            "exit_code": exit_code,
            "terminal_reason": session.terminal_reason(),
            "stdout": stdout.content,
            "stderr": stderr.content,
            "output_truncated": output_truncated,
            "stdout_continuation": stdout.continuation.map(|cursor| cursor.offset),
            "stderr_continuation": stderr.continuation.map(|cursor| cursor.offset),
        }))
    }

    async fn input(&self, arguments: &Value) -> Result<Value, CapabilityError> {
        let handle = string_argument(arguments, "handle")?;
        let data = string_argument(arguments, "data")?;
        let session = self.sessions.with(handle, Arc::clone)?;
        let bytes_written = session.input(data.as_bytes()).await?;
        Ok(json!({
            "handle": handle,
            "bytes_written": bytes_written,
        }))
    }

    async fn read(
        &self,
        arguments: &Value,
        invocation: &InvocationEnvelope,
    ) -> Result<Value, CapabilityError> {
        let handle = string_argument(arguments, "handle")?;
        let timeout_ms = u64_argument(arguments, "timeout_ms", 0)?;
        let session = self.sessions.with(handle, Arc::clone)?;
        let mode = arguments
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or("unseen");

        if mode == "unseen" {
            session
                .wait_for_unseen_output(Duration::from_millis(timeout_ms))
                .await?;
        }

        let (running, exit_code) = session.status().await?;
        if !running {
            self.ownership
                .unregister(&ResourceKey::Process(session.pid()));
        }
        let (raw_stdout, raw_stderr, output_truncated) = match mode {
            "unseen" => session.take_unseen_output(),
            "absolute" => {
                let offset = u64_argument(arguments, "offset", 0)?;
                session.output_from(offset)
            }
            "tail" => {
                let tail_bytes = usize::try_from(u64_argument(arguments, "tail_bytes", 4096)?)
                    .map_err(|_| invalid_arguments("tail_bytes is too large"))?;
                let (stdout, stderr) = session.output_tail(tail_bytes);
                (stdout, stderr, false)
            }
            _ => return Err(invalid_arguments("mode must be unseen, absolute, or tail")),
        };

        let budget = ResponseBudget::for_mode(invocation.response_mode.clone());
        let stdout = budget.apply_text(&raw_stdout, 0)?;
        let stderr = budget.apply_text(&raw_stderr, 0)?;

        Ok(json!({
            "handle": handle,
            "running": running,
            "exit_code": exit_code,
            "terminal_reason": session.terminal_reason(),
            "stdout": stdout.content,
            "stderr": stderr.content,
            "output_truncated": output_truncated,
            "stdout_continuation": stdout.continuation.map(|cursor| cursor.offset),
            "stderr_continuation": stderr.continuation.map(|cursor| cursor.offset),
        }))
    }
    async fn list_sessions(&self) -> Result<Value, CapabilityError> {
        let handles: Vec<String> = self
            .handles
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .cloned()
            .collect();

        let mut sessions = Vec::with_capacity(handles.len());
        for handle in handles {
            let session = self.sessions.with(&handle, Arc::clone)?;
            let (running, exit_code) = session.status().await?;
            if !running {
                self.ownership
                    .unregister(&ResourceKey::Process(session.pid()));
            }
            sessions.push(json!({
                "handle": handle,
                "pid": session.pid(),
                "origin": "tetherplane",
                "pty": session.is_pty(),
                "running": running,
                "exit_code": exit_code,
                "terminal_reason": session.terminal_reason(),
            }));
        }

        Ok(json!({ "sessions": sessions }))
    }

    fn list_system(&self, arguments: &Value) -> Result<Value, CapabilityError> {
        let max_results = usize::try_from(u64_argument(arguments, "max_results", 256)?)
            .map_err(|_| invalid_arguments("max_results is too large"))?;
        let system = System::new_all();
        let mut processes: Vec<Value> = system
            .processes()
            .iter()
            .map(|(pid, process)| {
                json!({
                    "pid": pid.as_u32(),
                    "name": process.name().to_string_lossy(),
                    "exe": process.exe().map(|path| path.to_string_lossy().into_owned()),
                    "origin": if self
                        .ownership
                        .is_tetherplane_owned(&ResourceKey::Process(pid.as_u32()))
                    {
                        "tetherplane"
                    } else {
                        "human_or_external"
                    },
                })
            })
            .collect();
        processes.sort_by_key(|process| process["pid"].as_u64().unwrap_or_default());
        processes.truncate(max_results);
        Ok(json!({ "processes": processes }))
    }

    async fn terminate(&self, arguments: &Value) -> Result<Value, CapabilityError> {
        let Some(handle) = arguments.get("handle").and_then(Value::as_str) else {
            if arguments.get("pid").is_some() {
                return Err(permission_denied(
                    "system PIDs cannot be terminated without a Tetherplane session handle",
                ));
            }
            return Err(invalid_arguments(
                "handle must be a Tetherplane process handle",
            ));
        };

        let grace_ms = u64_argument(arguments, "grace_ms", 250)?;
        let force = bool_argument(arguments, "force", false)?;
        let session = self.sessions.with(handle, Arc::clone)?;
        let (running, exit_code, terminal_reason) = session
            .terminate(Duration::from_millis(grace_ms), force)
            .await?;
        if !running {
            self.ownership
                .unregister(&ResourceKey::Process(session.pid()));
        }

        Ok(json!({
            "handle": handle,
            "pid": session.pid(),
            "origin": "tetherplane",
            "running": running,
            "exit_code": exit_code,
            "terminal_reason": terminal_reason,
        }))
    }
}

impl Default for ProcessProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl CapabilityProvider for ProcessProvider {
    fn namespace(&self) -> &'static str {
        "process"
    }

    async fn execute(
        &self,
        invocation: &InvocationEnvelope,
    ) -> Result<ProviderResult, CapabilityError> {
        let operation = invocation
            .capability
            .strip_prefix("process.")
            .ok_or_else(|| invalid_arguments("capability must use the process namespace"))?;

        let data = match operation {
            "run" => self.run(&invocation.arguments, invocation).await?,
            "read" => self.read(&invocation.arguments, invocation).await?,
            "input" => self.input(&invocation.arguments).await?,
            "list_sessions" => self.list_sessions().await?,
            "list_system" => self.list_system(&invocation.arguments)?,
            "terminate" => self.terminate(&invocation.arguments).await?,
            _ => {
                return Err(CapabilityError {
                    code: ErrorCode::CapabilityUnavailable,
                    message: format!("process operation is unavailable: {operation}"),
                    recovery_hint: None,
                    details: json!({ "operation": operation }),
                });
            }
        };

        Ok(ProviderResult {
            data,
            delta: None,
            verification: VerificationStatus::NotApplicable,
        })
    }
}

fn string_argument<'a>(arguments: &'a Value, key: &str) -> Result<&'a str, CapabilityError> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_arguments(&format!("{key} must be a string")))
}

fn string_array_argument(arguments: &Value, key: &str) -> Result<Vec<String>, CapabilityError> {
    let values = arguments
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| invalid_arguments(&format!("{key} must be an array of strings")))?;

    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(ToOwned::to_owned)
                .ok_or_else(|| invalid_arguments(&format!("{key} must contain only strings")))
        })
        .collect()
}

fn u64_argument(arguments: &Value, key: &str, default: u64) -> Result<u64, CapabilityError> {
    match arguments.get(key) {
        None | Some(Value::Null) => Ok(default),
        Some(value) => value
            .as_u64()
            .ok_or_else(|| invalid_arguments(&format!("{key} must be a non-negative integer"))),
    }
}

fn bool_argument(arguments: &Value, key: &str, default: bool) -> Result<bool, CapabilityError> {
    match arguments.get(key) {
        None | Some(Value::Null) => Ok(default),
        Some(Value::Bool(value)) => Ok(*value),
        Some(_) => Err(invalid_arguments(&format!("{key} must be a boolean"))),
    }
}

fn invalid_arguments(message: &str) -> CapabilityError {
    CapabilityError {
        code: ErrorCode::InvalidArguments,
        message: message.to_owned(),
        recovery_hint: None,
        details: serde_json::json!({}),
    }
}

fn permission_denied(message: &str) -> CapabilityError {
    CapabilityError {
        code: ErrorCode::PermissionDenied,
        message: message.to_owned(),
        recovery_hint: None,
        details: serde_json::json!({}),
    }
}

pub const CRATE_NAME: &str = "tether-process-provider";

#[cfg(test)]
mod lifecycle_tests {
    use super::ProcessProvider;
    use serde_json::{Value, json};
    use tether_core::CapabilityProvider;

    fn request(capability: &str, arguments: &Value) -> tether_core::InvocationEnvelope {
        serde_json::from_value(json!({
            "protocol_version": "1.0",
            "request_id": "00000000-0000-4000-8000-000000000009",
            "device_id": "Leno",
            "principal_id": null,
            "job_id": null,
            "capability": capability,
            "arguments": arguments,
            "actor": { "id": "session-retention-test", "kind": "ai_client" },
            "session_id": null,
            "response_mode": "compact",
            "idempotency_key": null,
            "preconditions": [],
            "expectations": []
        }))
        .unwrap()
    }

    fn current_rss_bytes() -> u64 {
        let mut system = sysinfo::System::new();
        system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        sysinfo::get_current_pid()
            .ok()
            .and_then(|pid| system.process(pid))
            .map_or(0, sysinfo::Process::memory)
    }

    #[tokio::test]
    async fn completed_sessions_are_bounded_and_oldest_expire() {
        let provider = ProcessProvider::with_session_limit(4);
        let rss_before = current_rss_bytes();
        let started = std::time::Instant::now();
        let mut handles = Vec::new();
        for _ in 0..12 {
            #[cfg(windows)]
            let args = json!({ "program":"cmd.exe", "args":["/C", "echo finished"], "wait_ms":1000, "pty":false });
            #[cfg(not(windows))]
            let args = json!({ "program":"/bin/sh", "args":["-c", "echo finished"], "wait_ms":1000, "pty":false });
            let run = provider
                .execute(&request("process.run", &args))
                .await
                .unwrap();
            handles.push(run.data["handle"].as_str().unwrap().to_owned());
        }
        let list = provider
            .execute(&request("process.list_sessions", &json!({})))
            .await
            .unwrap();
        let sessions = list.data["sessions"].as_array().unwrap();
        assert_eq!(
            sessions.len(),
            4,
            "retained sessions must have a fixed ceiling"
        );
        assert!(sessions.iter().all(|session| session["running"] == false));
        let old = provider
            .execute(&request("process.read", &json!({"handle":handles[0]})))
            .await;
        assert!(
            old.is_err(),
            "evicted session handle must not alias a newer process"
        );
        let latest = provider
            .execute(&request("process.read", &json!({"handle":handles[11]})))
            .await;
        assert!(latest.is_ok(), "latest completed session remains readable");
        println!(
            "PROCESS_RETENTION={{\"created\":12,\"retained\":{},\"capacity\":4,\"rss_before_bytes\":{},\"rss_after_bytes\":{},\"elapsed_ms\":{}}}",
            sessions.len(),
            rss_before,
            current_rss_bytes(),
            started.elapsed().as_millis(),
        );
    }
    #[tokio::test]
    async fn active_processes_are_never_evicted_and_overflow_fails_closed() {
        let provider = ProcessProvider::with_session_limit(4);
        let mut handles = Vec::new();
        for _ in 0..4 {
            #[cfg(windows)]
            let args = json!({ "program":"cmd.exe", "args":["/C", "ping -n 9 127.0.0.1 >NUL"], "wait_ms":0, "pty":false });
            #[cfg(not(windows))]
            let args =
                json!({ "program":"/bin/sh", "args":["-c", "sleep 8"], "wait_ms":0, "pty":false });
            let run = provider
                .execute(&request("process.run", &args))
                .await
                .unwrap();
            assert_eq!(run.data["running"], true);
            handles.push(run.data["handle"].as_str().unwrap().to_owned());
        }

        #[cfg(windows)]
        let extra =
            json!({ "program":"cmd.exe", "args":["/C", "echo denied"], "wait_ms":0, "pty":false });
        #[cfg(not(windows))]
        let extra =
            json!({ "program":"/bin/sh", "args":["-c", "echo denied"], "wait_ms":0, "pty":false });
        let error = provider
            .execute(&request("process.run", &extra))
            .await
            .expect_err("fifth running child must not be spawned");
        assert_eq!(error.code, tether_core::ErrorCode::ResourceConflict);

        let count = provider
            .execute(&request("process.list_sessions", &json!({})))
            .await
            .unwrap()
            .data["sessions"]
            .as_array()
            .unwrap()
            .len();
        assert_eq!(count, 4);
        for handle in handles {
            let _ = provider
                .execute(&request(
                    "process.terminate",
                    &json!({
                        "handle":handle,"grace_ms":0,"force":true
                    }),
                ))
                .await
                .unwrap();
        }
    }
    #[cfg(target_os = "linux")]
    fn os_handle_thread_counts() -> (usize, usize) {
        let handles = std::fs::read_dir("/proc/self/fd").map_or(0, Iterator::count);
        let threads = std::fs::read_dir("/proc/self/task").map_or(0, Iterator::count);
        (handles, threads)
    }

    #[cfg(windows)]
    fn os_handle_thread_counts() -> (usize, usize) {
        let query = format!(
            "$p=Get-Process -Id {}; Write-Output $p.HandleCount; Write-Output $p.Threads.Count",
            std::process::id()
        );
        let output = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", &query])
            .output();
        let Ok(output) = output else {
            return (0, 0);
        };
        let text = String::from_utf8_lossy(&output.stdout);
        let mut lines = text
            .lines()
            .filter_map(|line| line.trim().parse::<usize>().ok());
        (lines.next().unwrap_or(0), lines.next().unwrap_or(0))
    }

    #[cfg(not(any(target_os = "linux", windows)))]
    fn os_handle_thread_counts() -> (usize, usize) {
        (0, 0)
    }

    #[tokio::test]
    async fn configured_128_session_ceiling_endurance_samples_resource_trends() {
        // Real child processes; no network and no human-owned processes.
        let provider = ProcessProvider::with_session_limit(128);
        let start = std::time::Instant::now();
        // An optional bounded soak separates bursts, allowing steady-state
        // RSS, CPU, thread and handle trends to be observed without paid hosts.
        let soak_seconds = std::env::var("TETHERPLANE_PHASE4_SOAK_SECONDS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0)
            .min(300);
        let content = "X".repeat(1024);
        let mut snapshots = Vec::new();
        let mut first_handle = String::new();
        let mut last_handle = String::new();
        let mut processes = sysinfo::System::new();
        for index in 0..288 {
            #[cfg(windows)]
            let args = json!({
                "program":"cmd.exe","args":["/C", format!("echo {content}")],
                "wait_ms":1200,"pty":false
            });
            #[cfg(not(windows))]
            let args = json!({
                "program":"/bin/sh","args":["-c", format!("printf '%s\\n' '{content}'")],
                "wait_ms":1200,"pty":false
            });
            let run = provider
                .execute(&request("process.run", &args))
                .await
                .unwrap();
            assert_eq!(run.data["running"], false);
            let handle = run.data["handle"].as_str().unwrap().to_owned();
            if index == 0 {
                first_handle = handle.clone();
            }
            last_handle = handle;
            if (index + 1) % 48 == 0 {
                let retained = provider.handles.lock().unwrap().len();
                let (os_handles, os_threads) = os_handle_thread_counts();
                processes.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
                let process = sysinfo::get_current_pid()
                    .ok()
                    .and_then(|pid| processes.process(pid));
                let rss = process.map_or(0, sysinfo::Process::memory);
                let cpu = process.map_or(0.0, sysinfo::Process::cpu_usage);
                assert!(retained <= 128, "session handle count must stay bounded");
                let sample = json!({
                    "created":index + 1,"retained":retained,"rss_bytes":rss,
                    "os_handles":os_handles,"threads":os_threads,
                    "cpu_pct_sample":cpu,
                    "elapsed_ms":start.elapsed().as_millis()
                });
                println!("PROCESS_ENDURANCE_SAMPLE={sample}");
                snapshots.push(sample);
                if index < 287 && soak_seconds > 0 {
                    tokio::time::sleep(std::time::Duration::from_secs(soak_seconds / 5)).await;
                }
            }
        }
        assert_eq!(snapshots.len(), 6);
        assert_eq!(provider.handles.lock().unwrap().len(), 128);
        let gone = provider
            .execute(&request("process.read", &json!({"handle":first_handle})))
            .await;
        assert!(gone.is_err(), "old completed handle must be evicted");
        let current = provider
            .execute(&request(
                "process.read",
                &json!({"handle":last_handle,"mode":"tail","tail_bytes":8}),
            ))
            .await;
        assert!(current.is_ok(), "newest output must remain readable");
    }
}
