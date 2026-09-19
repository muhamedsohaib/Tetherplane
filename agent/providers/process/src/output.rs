use std::sync::Mutex;

const DEFAULT_BUFFER_BYTES: usize = 256 * 1024;

struct OutputState {
    bytes: Vec<u8>,
    base_offset: u64,
}

pub(crate) struct OutputBuffer {
    state: Mutex<OutputState>,
    max_bytes: usize,
}

impl OutputBuffer {
    pub(crate) fn new() -> Self {
        Self {
            state: Mutex::new(OutputState {
                bytes: Vec::new(),
                base_offset: 0,
            }),
            max_bytes: DEFAULT_BUFFER_BYTES,
        }
    }

    pub(crate) fn append(&self, chunk: &[u8]) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);

        state.bytes.extend_from_slice(chunk);
        if state.bytes.len() > self.max_bytes {
            let overflow = state.bytes.len() - self.max_bytes;
            state.bytes.drain(..overflow);
            state.base_offset = state
                .base_offset
                .saturating_add(u64::try_from(overflow).unwrap_or(u64::MAX));
        }
    }

    pub(crate) fn end_offset(&self) -> u64 {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state
            .base_offset
            .saturating_add(u64::try_from(state.bytes.len()).unwrap_or(u64::MAX))
    }

    pub(crate) fn text_since(&self, requested_offset: u64) -> (String, u64, bool) {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let start = requested_offset.max(state.base_offset);
        let relative = usize::try_from(start.saturating_sub(state.base_offset))
            .unwrap_or(state.bytes.len())
            .min(state.bytes.len());
        let end = state
            .base_offset
            .saturating_add(u64::try_from(state.bytes.len()).unwrap_or(u64::MAX));
        (
            String::from_utf8_lossy(&state.bytes[relative..]).into_owned(),
            end,
            requested_offset < state.base_offset,
        )
    }

    pub(crate) fn text_tail(&self, tail_bytes: usize) -> String {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let start = state.bytes.len().saturating_sub(tail_bytes);
        String::from_utf8_lossy(&state.bytes[start..]).into_owned()
    }
}

impl Default for OutputBuffer {
    fn default() -> Self {
        Self::new()
    }
}
