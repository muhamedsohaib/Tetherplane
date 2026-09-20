use crate::{CapabilityError, ErrorCode, ResponseMode};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContinuationCursor {
    pub offset: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BudgetedText {
    pub content: String,
    pub continuation: Option<ContinuationCursor>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BudgetedItems<T> {
    pub items: Vec<T>,
    pub continuation: Option<ContinuationCursor>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResponseBudget {
    pub mode: ResponseMode,
    pub max_bytes: usize,
    pub max_items: usize,
}

impl ResponseBudget {
    #[must_use]
    pub fn for_mode(mode: ResponseMode) -> Self {
        let (max_bytes, max_items) = match mode {
            ResponseMode::Compact => (16 * 1024, 100),
            ResponseMode::Normal => (64 * 1024, 500),
            ResponseMode::Debug => (256 * 1024, 2_000),
        };
        Self {
            mode,
            max_bytes,
            max_items,
        }
    }

    /// Applies the byte budget starting at `start_byte`.
    ///
    /// # Errors
    ///
    /// Returns a capability error when `start_byte` is beyond the input or is not a
    /// UTF-8 character boundary.
    pub fn apply_text(
        &self,
        input: &str,
        start_byte: usize,
    ) -> Result<BudgetedText, CapabilityError> {
        if start_byte > input.len() || !input.is_char_boundary(start_byte) {
            return Err(invalid_offset("text continuation offset is invalid"));
        }

        let remaining_len = input.len() - start_byte;
        if remaining_len <= self.max_bytes {
            return Ok(BudgetedText {
                content: input[start_byte..].to_owned(),
                continuation: None,
            });
        }

        let mut end = start_byte + self.max_bytes;
        while end > start_byte && !input.is_char_boundary(end) {
            end -= 1;
        }

        Ok(BudgetedText {
            content: input[start_byte..end].to_owned(),
            continuation: Some(ContinuationCursor { offset: end }),
        })
    }

    /// Applies the item budget starting at `start_item`.
    ///
    /// # Errors
    ///
    /// Returns a capability error when `start_item` is beyond the end of `items`.
    pub fn apply_items<T: Clone>(
        &self,
        items: &[T],
        start_item: usize,
    ) -> Result<BudgetedItems<T>, CapabilityError> {
        if start_item > items.len() {
            return Err(invalid_offset("item continuation offset is invalid"));
        }

        let end = start_item.saturating_add(self.max_items).min(items.len());
        let continuation = (end < items.len()).then_some(ContinuationCursor { offset: end });

        Ok(BudgetedItems {
            items: items[start_item..end].to_vec(),
            continuation,
        })
    }
}

fn invalid_offset(message: &str) -> CapabilityError {
    CapabilityError {
        code: ErrorCode::InvalidArguments,
        message: message.to_owned(),
        recovery_hint: None,
        details: serde_json::json!({}),
    }
}
