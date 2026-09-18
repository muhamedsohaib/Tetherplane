use std::io::{self, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use serde_json::{Value, json};
use tether_core::{CapabilityError, ErrorCode, ResourceOrigin};

use crate::output::{BoundedOutput, OutputSlice};

const OUTPUT_BUFFER_BYTES: usize = 256 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ProcessStatus {
    pub(crate) running: bool,
    pub(crate) exit_code: Option<i32>,
}

enum ProcessChild {
    Pipe(Child),
    Pty(Box<dyn portable_pty::Child + Send + Sync>),
}

impl ProcessChild {
    fn try_wait(&mut self) -> io::Result<Option<i32>> {
        match self {
            Self::Pipe(child) => child.try_wait().map(|status| {
                status.map(|status| {
                    status
                        .code()
                        .unwrap_or_else(|| i32::from(!status.success()))
                })
            }),
            Self::Pty(child) => child.try_wait().map(|status| {
                status.map(|status| i32::try_from(status.exit_code()).unwrap_or(i32::MAX))
            }),
        }
    }
}

pub(crate) struct ProcessSession {
    child: Mutex<ProcessChild>,
    stdin: Mutex<Option<Box<dyn Write + Send>>>,
    stdout: Arc<BoundedOutput>,
    stderr: Arc<BoundedOutput>,
    stdout_done: Arc<AtomicBool>,
    stderr_done: Arc<AtomicBool>,
    pid: Option<u32>,
    origin: ResourceOrigin,
    pty: bool,
    exit_code: Mutex<Option<i32>>,
    read_cursors: Mutex<ReadCursors>,
}

#[derive(Clone, Copy, Debug, Default)]
struct ReadCursors {
    stdout: u64,
    stderr: u64,
}

impl ProcessSession {
    pub(crate) fn spawn(
        program: &str,
        args: &[String],
        pty: bool,
    ) -> Result<Arc<Self>, CapabilityError> {
        if pty {
            Self::spawn_pty(program, args)
        } else {
            Self::spawn_piped(program, args)
        }
    }

    fn spawn_piped(program: &str, args: &[String]) -> Result<Arc<Self>, CapabilityError> {
        let mut command = Command::new(program);
        command
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = command
            .spawn()
            .map_err(|error| spawn_error(program, &error))?;
        let pid = child.id();
        let stdin = child
            .stdin
            .take()
            .map(|writer| Box::new(writer) as Box<dyn Write + Send>);
        let stdout_pipe = child
            .stdout
            .take()
            .ok_or_else(|| provider_failure("spawned process has no stdout pipe"))?;
        let stderr_pipe = child
            .stderr
            .take()
            .ok_or_else(|| provider_failure("spawned process has no stderr pipe"))?;

        let stdout = Arc::new(BoundedOutput::new(OUTPUT_BUFFER_BYTES));
        let stderr = Arc::new(BoundedOutput::new(OUTPUT_BUFFER_BYTES));
        let stdout_done = Arc::new(AtomicBool::new(false));
        let stderr_done = Arc::new(AtomicBool::new(false));

        if let Err(error) = spawn_reader(
            format!("tether-proc-{pid}-stdout"),
            stdout_pipe,
            Arc::clone(&stdout),
            Arc::clone(&stdout_done),
        ) {
            let _ = child.kill();
            return Err(provider_failure(&format!(
                "failed to start stdout reader: {error}"
            )));
        }
        if let Err(error) = spawn_reader(
            format!("tether-proc-{pid}-stderr"),
            stderr_pipe,
            Arc::clone(&stderr),
            Arc::clone(&stderr_done),
        ) {
            let _ = child.kill();
            return Err(provider_failure(&format!(
                "failed to start stderr reader: {error}"
            )));
        }

        Ok(Arc::new(Self {
            child: Mutex::new(ProcessChild::Pipe(child)),
            stdin: Mutex::new(stdin),
            stdout,
            stderr,
            stdout_done,
            stderr_done,
            pid: Some(pid),
            origin: ResourceOrigin::Tetherplane,
            pty: false,
            exit_code: Mutex::new(None),
            read_cursors: Mutex::new(ReadCursors::default()),
        }))
    }

    fn spawn_pty(program: &str, args: &[String]) -> Result<Arc<Self>, CapabilityError> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize::default())
            .map_err(|error| provider_failure(&format!("failed to open PTY: {error}")))?;

        let mut command = CommandBuilder::new(program);
        command.args(args);
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| provider_failure(&format!("failed to start PTY process: {error}")))?;
        let pid = child.process_id();

        drop(pair.slave);

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| provider_failure(&format!("failed to clone PTY reader: {error}")))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| provider_failure(&format!("failed to take PTY writer: {error}")))?;

        let stdout = Arc::new(BoundedOutput::new(OUTPUT_BUFFER_BYTES));
        let stderr = Arc::new(BoundedOutput::new(OUTPUT_BUFFER_BYTES));
        let stdout_done = Arc::new(AtomicBool::new(false));
        let stderr_done = Arc::new(AtomicBool::new(true));
        let reader_name = pid.map_or_else(
            || "tether-proc-pty-stdout".to_owned(),
            |pid| format!("tether-proc-{pid}-stdout"),
        );

        if let Err(error) = spawn_reader(
            reader_name,
            reader,
            Arc::clone(&stdout),
            Arc::clone(&stdout_done),
        ) {
            let _ = child.kill();
            return Err(provider_failure(&format!(
                "failed to start PTY reader: {error}"
            )));
        }

        Ok(Arc::new(Self {
            child: Mutex::new(ProcessChild::Pty(child)),
            stdin: Mutex::new(Some(writer)),
            stdout,
            stderr,
            stdout_done,
            stderr_done,
            pid,
            origin: ResourceOrigin::Tetherplane,
            pty: true,
            exit_code: Mutex::new(None),
            read_cursors: Mutex::new(ReadCursors::default()),
        }))
    }

    pub(crate) fn status(&self) -> Result<ProcessStatus, CapabilityError> {
        if let Some(exit_code) = *self
            .exit_code
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
        {
            return Ok(ProcessStatus {
                running: false,
                exit_code: Some(exit_code),
            });
        }

        let exit_code = self
            .child
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .try_wait()
            .map_err(|error| provider_failure(&format!("failed to poll process: {error}")))?;

        match exit_code {
            Some(exit_code) => {
                *self
                    .exit_code
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(exit_code);
                Ok(ProcessStatus {
                    running: false,
                    exit_code: Some(exit_code),
                })
            }
            None => Ok(ProcessStatus {
                running: true,
                exit_code: None,
            }),
        }
    }

    pub(crate) fn write_input(&self, data: &[u8]) -> Result<usize, CapabilityError> {
        let mut stdin = self
            .stdin
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let writer = stdin
            .as_mut()
            .ok_or_else(|| process_finished("process input is no longer available"))?;
        writer
            .write_all(data)
            .and_then(|()| writer.flush())
            .map_err(|error| {
                provider_failure(&format!("failed to write process input: {error}"))
            })?;
        Ok(data.len())
    }

    pub(crate) fn outputs_drained(&self) -> bool {
        self.stdout_done.load(Ordering::Acquire) && self.stderr_done.load(Ordering::Acquire)
    }

    pub(crate) fn stdout_snapshot(&self) -> OutputSlice {
        self.stdout.snapshot()
    }

    pub(crate) fn stderr_snapshot(&self) -> OutputSlice {
        self.stderr.snapshot()
    }

    pub(crate) fn has_unseen_output(&self) -> bool {
        let cursors = self
            .read_cursors
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.stdout.next_cursor() > cursors.stdout || self.stderr.next_cursor() > cursors.stderr
    }

    pub(crate) fn incremental_snapshot(&self) -> (OutputSlice, OutputSlice) {
        let cursors = self
            .read_cursors
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        (
            self.stdout.read_from(cursors.stdout),
            self.stderr.read_from(cursors.stderr),
        )
    }

    pub(crate) fn advance_read_cursors(&self, stdout_cursor: u64, stderr_cursor: u64) {
        let mut cursors = self
            .read_cursors
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        cursors.stdout = cursors.stdout.max(stdout_cursor);
        cursors.stderr = cursors.stderr.max(stderr_cursor);
    }

    pub(crate) fn explicit_snapshot(&self, offset: i64) -> (OutputSlice, OutputSlice) {
        let stdout_cursor = self.stdout.cursor_for_offset(offset);
        let stderr_cursor = self.stderr.cursor_for_offset(offset);
        (
            self.stdout.read_from(stdout_cursor),
            self.stderr.read_from(stderr_cursor),
        )
    }

    #[allow(dead_code)]
    pub(crate) const fn pid(&self) -> Option<u32> {
        self.pid
    }

    #[allow(dead_code)]
    pub(crate) const fn origin(&self) -> ResourceOrigin {
        self.origin
    }

    pub(crate) const fn is_pty(&self) -> bool {
        self.pty
    }
}

fn spawn_reader<R>(
    name: String,
    mut reader: R,
    output: Arc<BoundedOutput>,
    done: Arc<AtomicBool>,
) -> io::Result<thread::JoinHandle<()>>
where
    R: Read + Send + 'static,
{
    thread::Builder::new().name(name).spawn(move || {
        let mut buffer = [0_u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(count) if count > 0 => output.append(&buffer[..count]),
                Ok(_) | Err(_) => break,
            }
        }
        done.store(true, Ordering::Release);
    })
}

fn spawn_error(program: &str, error: &io::Error) -> CapabilityError {
    CapabilityError {
        code: ErrorCode::ProviderFailure,
        message: format!("failed to start process: {error}"),
        recovery_hint: None,
        details: json!({
            "program": program,
            "io_kind": format!("{:?}", error.kind()),
        }),
    }
}

fn process_finished(message: &str) -> CapabilityError {
    CapabilityError {
        code: ErrorCode::ProcessFinished,
        message: message.to_owned(),
        recovery_hint: None,
        details: Value::Null,
    }
}

fn provider_failure(message: &str) -> CapabilityError {
    CapabilityError {
        code: ErrorCode::ProviderFailure,
        message: message.to_owned(),
        recovery_hint: None,
        details: Value::Null,
    }
}
