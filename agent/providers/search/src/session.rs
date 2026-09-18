use std::sync::atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, TryRecvError, TrySendError};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde_json::Value;

const RUNNING: u8 = 0;
const COMPLETED: u8 = 1;
const CANCELLED: u8 = 2;

pub(crate) struct SearchSession {
    sender: SyncSender<Value>,
    receiver: Mutex<Receiver<Value>>,
    queue_gate: Mutex<()>,
    queued: AtomicUsize,
    queue_capacity: usize,
    state: AtomicU8,
    cancelled: AtomicBool,
}

impl SearchSession {
    pub(crate) fn new(
        sender: SyncSender<Value>,
        receiver: Receiver<Value>,
        queue_capacity: usize,
    ) -> Self {
        Self {
            sender,
            receiver: Mutex::new(receiver),
            queue_gate: Mutex::new(()),
            queued: AtomicUsize::new(0),
            queue_capacity,
            state: AtomicU8::new(RUNNING),
            cancelled: AtomicBool::new(false),
        }
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }

    pub(crate) fn mark_completed(&self) {
        let _ = self.state.compare_exchange(
            RUNNING,
            COMPLETED,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
    }

    pub(crate) fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        let _ = self.state.compare_exchange(
            RUNNING,
            CANCELLED,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
    }

    pub(crate) fn state_name(&self) -> &'static str {
        match self.state.load(Ordering::Acquire) {
            COMPLETED => "completed",
            CANCELLED => "cancelled",
            _ => "running",
        }
    }

    pub(crate) fn queued(&self) -> usize {
        self.queued.load(Ordering::Acquire)
    }

    pub(crate) const fn queue_capacity(&self) -> usize {
        self.queue_capacity
    }

    pub(crate) fn send_bounded(&self, mut item: Value) -> bool {
        loop {
            if self.is_cancelled() {
                return false;
            }

            {
                let _gate = self
                    .queue_gate
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if self.is_cancelled() {
                    return false;
                }

                match self.sender.try_send(item) {
                    Ok(()) => {
                        self.queued.fetch_add(1, Ordering::AcqRel);
                        return true;
                    }
                    Err(TrySendError::Full(returned)) => {
                        item = returned;
                    }
                    Err(TrySendError::Disconnected(_)) => return false,
                }
            }

            thread::sleep(Duration::from_millis(1));
        }
    }

    pub(crate) fn read_unseen(&self, max_items: usize) -> (Vec<Value>, bool) {
        let _gate = self
            .queue_gate
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let receiver = self
            .receiver
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut items = Vec::with_capacity(max_items);
        let mut exhausted = false;

        for _ in 0..max_items {
            match receiver.try_recv() {
                Ok(item) => {
                    self.queued.fetch_sub(1, Ordering::AcqRel);
                    items.push(item);
                }
                Err(TryRecvError::Empty | TryRecvError::Disconnected) => {
                    exhausted = true;
                    break;
                }
            }
        }

        let terminal = self.state.load(Ordering::Acquire) != RUNNING;
        let done = terminal && exhausted;
        (items, done)
    }
}
