use std::io::{self, Read, Write};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde_json::{Value, json};
use sysinfo::{Pid, System};
use tether_core::{CapabilityError, ErrorCode};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;
use tokio::time;

use crate::output::OutputBuffer;

#[derive(Clone, Copy)]
struct TerminalExit {
    code: Option<i64>,
    reason: &'static str,
}

enum ProcessBackend {
    Piped(Box<AsyncMutex<Child>>),
    Pty {
        child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
        writer: Arc<Mutex<Option<Box<dyn Write + Send>>>>,
        master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    },
}

struct PtySpawn {
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    reader: Box<dyn Read + Send>,
    writer: Box<dyn Write + Send>,
    pid: u32,
}

pub(crate) struct ProcessSession {
    backend: ProcessBackend,
    stdout: Arc<OutputBuffer>,
    stderr: Arc<OutputBuffer>,
    stdout_cursor: Mutex<u64>,
    stderr_cursor: Mutex<u64>,
    terminal: Mutex<Option<TerminalExit>>,
    readers: AsyncMutex<Vec<JoinHandle<io::Result<()>>>>,
    pid: u32,
}

impl ProcessSession {
    pub(crate) async fn spawn(
        program: &str,
        args: &[String],
        pty: bool,
    ) -> Result<Self, CapabilityError> {
        if pty {
            return Self::spawn_pty(program.to_owned(), args.to_vec()).await;
        }
        Self::spawn_piped(program, args)
    }

    fn spawn_piped(program: &str, args: &[String]) -> Result<Self, CapabilityError> {
        let mut command = Command::new(program);
        command
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = command
            .spawn()
            .map_err(|error| provider_error("failed to spawn process", program, &error))?;
        let pid = child
            .id()
            .ok_or_else(|| provider_error_message("spawned process has no pid", program))?;
        let stdout_stream = child
            .stdout
            .take()
            .ok_or_else(|| provider_error_message("stdout pipe unavailable", program))?;
        let stderr_stream = child
            .stderr
            .take()
            .ok_or_else(|| provider_error_message("stderr pipe unavailable", program))?;

        let stdout = Arc::new(OutputBuffer::new());
        let stderr = Arc::new(OutputBuffer::new());
        let readers = vec![
            tokio::spawn(pump_output(stdout_stream, Arc::clone(&stdout))),
            tokio::spawn(pump_output(stderr_stream, Arc::clone(&stderr))),
        ];

        Ok(Self {
            backend: ProcessBackend::Piped(Box::new(AsyncMutex::new(child))),
            stdout,
            stderr,
            stdout_cursor: Mutex::new(0),
            stderr_cursor: Mutex::new(0),
            terminal: Mutex::new(None),
            readers: AsyncMutex::new(readers),
            pid,
        })
    }

    async fn spawn_pty(program: String, args: Vec<String>) -> Result<Self, CapabilityError> {
        let spawned = tokio::task::spawn_blocking(move || spawn_pty_blocking(&program, &args))
            .await
            .map_err(|error| {
                provider_error_message(&format!("PTY spawn task failed: {error}"), "")
            })??;

        let stdout = Arc::new(OutputBuffer::new());
        let stderr = Arc::new(OutputBuffer::new());
        let output = Arc::clone(&stdout);
        let writer = Arc::new(Mutex::new(Some(spawned.writer)));
        let reader_writer = Arc::clone(&writer);
        let reader = spawned.reader;
        let reader_handle =
            tokio::task::spawn_blocking(move || pump_pty_output(reader, &output, &reader_writer));

        Ok(Self {
            backend: ProcessBackend::Pty {
                child: Arc::new(Mutex::new(spawned.child)),
                writer,
                master: Mutex::new(Some(spawned.master)),
            },
            stdout,
            stderr,
            stdout_cursor: Mutex::new(0),
            stderr_cursor: Mutex::new(0),
            terminal: Mutex::new(None),
            readers: AsyncMutex::new(vec![reader_handle]),
            pid: spawned.pid,
        })
    }

    pub(crate) const fn pid(&self) -> u32 {
        self.pid
    }

    pub(crate) fn terminal_reason(&self) -> Option<&'static str> {
        self.terminal
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .map(|exit| exit.reason)
    }

    pub(crate) fn is_pty(&self) -> bool {
        matches!(self.backend, ProcessBackend::Pty { .. })
    }

    pub(crate) async fn wait_for_exit(&self, duration: Duration) -> Result<bool, CapabilityError> {
        let deadline = time::Instant::now() + duration;
        loop {
            let (running, _) = self.status().await?;
            if !running {
                return Ok(true);
            }
            if time::Instant::now() >= deadline {
                return Ok(false);
            }
            time::sleep(Duration::from_millis(10)).await;
        }
    }

    pub(crate) async fn terminate(
        &self,
        grace: Duration,
        allow_force: bool,
    ) -> Result<(bool, Option<i64>, Option<&'static str>), CapabilityError> {
        let (running, exit_code) = self.status().await?;
        if !running {
            return Ok((false, exit_code, self.terminal_reason()));
        }

        self.close_input().await;
        if self.wait_for_exit(grace).await? {
            let (_, exit_code) = self.status().await?;
            self.set_terminal(exit_code, "graceful_termination");
            return Ok((false, exit_code, self.terminal_reason()));
        }

        if !allow_force {
            let (running, exit_code) = self.status().await?;
            return Ok((running, exit_code, self.terminal_reason()));
        }

        self.force_kill().await?;
        if !self.wait_for_exit(Duration::from_secs(2)).await? {
            return Err(CapabilityError {
                code: ErrorCode::Timeout,
                message: "process did not terminate after force request".into(),
                recovery_hint: None,
                details: json!({ "pid": self.pid }),
            });
        }

        let (_, exit_code) = self.status().await?;
        self.set_terminal(exit_code, "forced_termination");
        Ok((false, exit_code, self.terminal_reason()))
    }

    async fn close_input(&self) {
        match &self.backend {
            ProcessBackend::Piped(child) => {
                child.lock().await.stdin.take();
            }
            ProcessBackend::Pty { writer, .. } => {
                writer
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .take();
            }
        }
    }

    async fn force_kill(&self) -> Result<(), CapabilityError> {
        let pid = self.pid;
        tokio::task::spawn_blocking(move || kill_descendants(pid))
            .await
            .map_err(|error| {
                provider_error_message(&format!("process-tree kill task failed: {error}"), "")
            })?;

        match &self.backend {
            ProcessBackend::Piped(child) => {
                child.lock().await.start_kill().map_err(|error| {
                    provider_error("failed to force terminate process", "", &error)
                })
            }
            ProcessBackend::Pty { child, .. } => {
                let child = Arc::clone(child);
                tokio::task::spawn_blocking(move || {
                    child
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .kill()
                })
                .await
                .map_err(|error| {
                    provider_error_message(&format!("PTY kill task failed: {error}"), "")
                })?
                .map_err(|error| {
                    provider_error("failed to force terminate PTY process", "", &error)
                })
            }
        }
    }

    pub(crate) async fn input(&self, data: &[u8]) -> Result<usize, CapabilityError> {
        if self
            .terminal
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_some()
        {
            return Err(process_finished());
        }

        match &self.backend {
            ProcessBackend::Piped(child) => {
                let mut child = child.lock().await;
                let stdin = child.stdin.as_mut().ok_or_else(process_finished)?;
                stdin
                    .write_all(data)
                    .await
                    .map_err(|error| provider_error("failed writing process input", "", &error))?;
                stdin
                    .flush()
                    .await
                    .map_err(|error| provider_error("failed flushing process input", "", &error))?;
            }
            ProcessBackend::Pty { writer, .. } => {
                let writer = Arc::clone(writer);
                let data = data.to_vec();
                tokio::task::spawn_blocking(move || -> io::Result<()> {
                    let mut writer = writer
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    let writer = writer.as_mut().ok_or_else(|| {
                        io::Error::new(io::ErrorKind::BrokenPipe, "PTY input is closed")
                    })?;
                    writer.write_all(&data)?;
                    writer.flush()
                })
                .await
                .map_err(|error| {
                    provider_error_message(&format!("PTY input task failed: {error}"), "")
                })?
                .map_err(|error| provider_error("failed writing PTY input", "", &error))?;
            }
        }
        Ok(data.len())
    }

    pub(crate) async fn status(&self) -> Result<(bool, Option<i64>), CapabilityError> {
        if let Some(exit) = *self
            .terminal
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
        {
            return Ok((false, exit.code));
        }

        let exit_code = match &self.backend {
            ProcessBackend::Piped(child) => {
                let mut child = child.lock().await;
                match child
                    .try_wait()
                    .map_err(|error| provider_error("failed to query process state", "", &error))?
                {
                    Some(status) => status.code().map(i64::from),
                    None => return Ok((true, None)),
                }
            }
            ProcessBackend::Pty { child, .. } => {
                let child = Arc::clone(child);
                let status = tokio::task::spawn_blocking(move || {
                    child
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .try_wait()
                })
                .await
                .map_err(|error| {
                    provider_error_message(&format!("PTY status task failed: {error}"), "")
                })?
                .map_err(|error| provider_error("failed to query PTY process state", "", &error))?;
                match status {
                    Some(status) => Some(i64::from(status.exit_code())),
                    None => return Ok((true, None)),
                }
            }
        };

        self.set_terminal(exit_code, "exited");
        self.close_pty_io();
        self.finish_readers().await?;
        Ok((false, exit_code))
    }

    fn close_pty_io(&self) {
        if let ProcessBackend::Pty { writer, master, .. } = &self.backend {
            writer
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take();
            master
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take();
        }
    }

    pub(crate) fn take_unseen_output(&self) -> (String, String, bool) {
        let (stdout, stdout_dropped) = take_stream(&self.stdout, &self.stdout_cursor);
        let (stderr, stderr_dropped) = take_stream(&self.stderr, &self.stderr_cursor);
        (stdout, stderr, stdout_dropped || stderr_dropped)
    }

    pub(crate) fn output_from(&self, offset: u64) -> (String, String, bool) {
        let (stdout, _, stdout_dropped) = self.stdout.text_since(offset);
        let (stderr, _, stderr_dropped) = self.stderr.text_since(offset);
        (stdout, stderr, stdout_dropped || stderr_dropped)
    }

    pub(crate) fn output_tail(&self, tail_bytes: usize) -> (String, String) {
        (
            self.stdout.text_tail(tail_bytes),
            self.stderr.text_tail(tail_bytes),
        )
    }

    pub(crate) async fn wait_for_unseen_output(
        &self,
        duration: Duration,
    ) -> Result<(), CapabilityError> {
        let deadline = time::Instant::now() + duration;
        loop {
            if self.has_unseen_output() {
                return Ok(());
            }
            let (running, _) = self.status().await?;
            if !running || time::Instant::now() >= deadline {
                return Ok(());
            }
            time::sleep(Duration::from_millis(10)).await;
        }
    }

    fn has_unseen_output(&self) -> bool {
        let stdout_cursor = *self
            .stdout_cursor
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let stderr_cursor = *self
            .stderr_cursor
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.stdout.end_offset() > stdout_cursor || self.stderr.end_offset() > stderr_cursor
    }

    fn set_terminal(&self, code: Option<i64>, reason: &'static str) {
        *self
            .terminal
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) =
            Some(TerminalExit { code, reason });
    }

    async fn finish_readers(&self) -> Result<(), CapabilityError> {
        let handles = {
            let mut readers = self.readers.lock().await;
            std::mem::take(&mut *readers)
        };

        for handle in handles {
            match handle.await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    return Err(provider_error("failed reading process output", "", &error));
                }
                Err(error) => {
                    return Err(CapabilityError {
                        code: ErrorCode::ProviderFailure,
                        message: format!("process output task failed: {error}"),
                        recovery_hint: None,
                        details: Value::Null,
                    });
                }
            }
        }
        Ok(())
    }
}

fn kill_descendants(root_pid: u32) {
    let system = System::new_all();
    let root = Pid::from_u32(root_pid);
    let mut descendants: Vec<(usize, Pid)> = system
        .processes()
        .keys()
        .filter_map(|pid| descendant_depth(&system, *pid, root).map(|depth| (depth, *pid)))
        .collect();
    descendants.sort_by_key(|item| std::cmp::Reverse(item.0));

    for (_, pid) in descendants {
        if let Some(process) = system.process(pid) {
            let _ = process.kill();
        }
    }
}

fn descendant_depth(system: &System, pid: Pid, root: Pid) -> Option<usize> {
    let mut current = pid;
    let mut depth = 0;

    while depth < 256 {
        let process = system.process(current)?;
        let parent = process.parent()?;
        depth += 1;
        if parent == root {
            return Some(depth);
        }
        current = parent;
    }

    None
}

fn spawn_pty_blocking(program: &str, args: &[String]) -> Result<PtySpawn, CapabilityError> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| {
            provider_error_message(&format!("failed to open PTY: {error}"), program)
        })?;

    let mut command = CommandBuilder::new(program);
    command.args(args);
    let child = pair.slave.spawn_command(command).map_err(|error| {
        provider_error_message(&format!("failed to spawn PTY process: {error}"), program)
    })?;
    drop(pair.slave);

    let reader = pair.master.try_clone_reader().map_err(|error| {
        provider_error_message(&format!("failed to clone PTY reader: {error}"), program)
    })?;
    let writer = pair.master.take_writer().map_err(|error| {
        provider_error_message(&format!("failed to take PTY writer: {error}"), program)
    })?;
    let pid = child
        .process_id()
        .ok_or_else(|| provider_error_message("spawned PTY process has no pid", program))?;

    Ok(PtySpawn {
        master: pair.master,
        child,
        reader,
        writer,
        pid,
    })
}

const CURSOR_QUERY: &[u8] = b"\x1b[6n";
const CURSOR_REPLY: &[u8] = b"\x1b[1;1R";

fn pump_pty_output(
    mut reader: Box<dyn Read + Send>,
    output: &OutputBuffer,
    writer: &Mutex<Option<Box<dyn Write + Send>>>,
) -> io::Result<()> {
    let mut chunk = [0_u8; 4096];
    let mut pending = Vec::new();

    loop {
        let read = reader.read(&mut chunk)?;
        if read == 0 {
            if !pending.is_empty() {
                output.append(&pending);
            }
            return Ok(());
        }

        pending.extend_from_slice(&chunk[..read]);
        process_pty_bytes(&mut pending, output, writer)?;
    }
}

fn process_pty_bytes(
    pending: &mut Vec<u8>,
    output: &OutputBuffer,
    writer: &Mutex<Option<Box<dyn Write + Send>>>,
) -> io::Result<()> {
    while let Some(index) = find_bytes(pending, CURSOR_QUERY) {
        if index > 0 {
            output.append(&pending[..index]);
        }

        {
            let mut writer = writer
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(writer) = writer.as_mut() {
                writer.write_all(CURSOR_REPLY)?;
                writer.flush()?;
            }
        }

        pending.drain(..index + CURSOR_QUERY.len());
    }

    let keep = CURSOR_QUERY.len().saturating_sub(1).min(pending.len());
    let emit = pending.len().saturating_sub(keep);
    if emit > 0 {
        output.append(&pending[..emit]);
        pending.drain(..emit);
    }

    Ok(())
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn take_stream(output: &OutputBuffer, cursor: &Mutex<u64>) -> (String, bool) {
    let mut cursor = cursor
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (text, next, dropped) = output.text_since(*cursor);
    *cursor = next;
    (text, dropped)
}

async fn pump_output<R>(mut reader: R, output: Arc<OutputBuffer>) -> io::Result<()>
where
    R: AsyncRead + Unpin,
{
    let mut chunk = [0_u8; 4096];
    loop {
        let read = reader.read(&mut chunk).await?;
        if read == 0 {
            return Ok(());
        }
        output.append(&chunk[..read]);
    }
}

fn process_finished() -> CapabilityError {
    CapabilityError {
        code: ErrorCode::ProcessFinished,
        message: "process has already finished".into(),
        recovery_hint: None,
        details: Value::Null,
    }
}

fn provider_error(message: &str, program: &str, error: &io::Error) -> CapabilityError {
    CapabilityError {
        code: ErrorCode::ProviderFailure,
        message: format!("{message}: {error}"),
        recovery_hint: None,
        details: json!({
            "program": program,
            "io_kind": format!("{:?}", error.kind()).to_lowercase(),
        }),
    }
}

fn provider_error_message(message: &str, program: &str) -> CapabilityError {
    CapabilityError {
        code: ErrorCode::ProviderFailure,
        message: message.to_owned(),
        recovery_hint: None,
        details: json!({ "program": program }),
    }
}
