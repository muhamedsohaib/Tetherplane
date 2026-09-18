use std::collections::VecDeque;
use std::sync::Mutex;

#[derive(Debug)]
pub(crate) struct OutputSlice {
    pub(crate) text: String,
    pub(crate) start_cursor: u64,
    pub(crate) next_cursor: u64,
    pub(crate) truncated_before: bool,
}

#[derive(Debug)]
pub(crate) struct BoundedOutput {
    max_bytes: usize,
    inner: Mutex<OutputState>,
}

#[derive(Debug, Default)]
struct OutputState {
    bytes: VecDeque<u8>,
    start_cursor: u64,
    next_cursor: u64,
}

impl BoundedOutput {
    pub(crate) fn new(max_bytes: usize) -> Self {
        Self {
            max_bytes,
            inner: Mutex::new(OutputState::default()),
        }
    }

    pub(crate) fn append(&self, bytes: &[u8]) {
        let mut state = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let appended = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
        state.next_cursor = state.next_cursor.saturating_add(appended);
        state.bytes.extend(bytes);

        while state.bytes.len() > self.max_bytes {
            let _ = state.bytes.pop_front();
            state.start_cursor = state.start_cursor.saturating_add(1);
        }
    }

    pub(crate) fn snapshot(&self) -> OutputSlice {
        let start_cursor = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .start_cursor;
        self.read_from(start_cursor)
    }

    pub(crate) fn next_cursor(&self) -> u64 {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .next_cursor
    }

    pub(crate) fn cursor_for_offset(&self, offset: i64) -> u64 {
        let state = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if offset >= 0 {
            u64::try_from(offset).unwrap_or(u64::MAX)
        } else {
            state.next_cursor.saturating_sub(offset.unsigned_abs())
        }
    }

    pub(crate) fn read_from(&self, cursor: u64) -> OutputSlice {
        let state = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let effective_cursor = cursor.max(state.start_cursor).min(state.next_cursor);
        let skip = usize::try_from(effective_cursor.saturating_sub(state.start_cursor))
            .unwrap_or(state.bytes.len())
            .min(state.bytes.len());
        let bytes: Vec<u8> = state.bytes.iter().skip(skip).copied().collect();
        OutputSlice {
            text: String::from_utf8_lossy(&bytes).into_owned(),
            start_cursor: effective_cursor,
            next_cursor: state.next_cursor,
            truncated_before: cursor < state.start_cursor,
        }
    }
}
