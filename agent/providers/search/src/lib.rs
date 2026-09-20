#![forbid(unsafe_code)]

#[cfg(test)]
mod search_tests;

mod session;

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;
use std::sync::mpsc::sync_channel;
use std::sync::{Arc, Mutex};
use std::thread;

use async_trait::async_trait;
use globset::{Glob, GlobSet, GlobSetBuilder};
use ignore::WalkBuilder;
use regex::{Regex, RegexBuilder};
use serde_json::{Value, json};
use tether_core::{
    CapabilityError, CapabilityProvider, ErrorCode, HandleRegistry, InvocationEnvelope,
    ProviderResult, VerificationStatus,
};

use session::SearchSession;

const QUEUE_CAPACITY: usize = 128;
const DEFAULT_MAX_RESULTS: usize = 100;
const DEFAULT_READ_ITEMS: usize = 64;

pub struct SearchProvider {
    sessions: HandleRegistry<Arc<SearchSession>>,
    handles: Mutex<BTreeSet<String>>,
}

impl SearchProvider {
    #[must_use]
    pub fn new() -> Self {
        Self {
            sessions: HandleRegistry::new(),
            handles: Mutex::new(BTreeSet::new()),
        }
    }

    fn start(&self, arguments: &Value) -> Result<Value, CapabilityError> {
        let root = path_argument(arguments, "root")?;
        if !root.is_dir() {
            return Err(invalid_arguments("root must be an existing directory"));
        }

        let scope = string_argument(arguments, "scope")?;
        let query = string_argument(arguments, "query")?;
        let use_regex = bool_argument(arguments, "regex", false)?;
        let case_sensitive = bool_argument(arguments, "case_sensitive", false)?;
        let include_hidden = bool_argument(arguments, "include_hidden", false)?;
        let max_results = usize_argument(arguments, "max_results", DEFAULT_MAX_RESULTS)?;
        if max_results == 0 {
            return Err(invalid_arguments("max_results must be greater than zero"));
        }

        let matcher = TextMatcher::new(query, use_regex, case_sensitive)?;
        let spec = match scope {
            "filename" => SearchWorkerSpec::Filename(FilenameSearchSpec {
                root,
                matcher,
                include_hidden,
                max_results,
            }),
            "content" => SearchWorkerSpec::Content(ContentSearchSpec {
                root,
                matcher,
                include_hidden,
                max_results,
                globs: glob_set_argument(arguments)?,
                context_lines: usize_argument(arguments, "context_lines", 0)?,
            }),
            _ => {
                return Err(CapabilityError {
                    code: ErrorCode::CapabilityUnavailable,
                    message: format!("search scope is unavailable: {scope}"),
                    recovery_hint: None,
                    details: json!({ "scope": scope }),
                });
            }
        };

        let (sender, receiver) = sync_channel(QUEUE_CAPACITY);
        let session = Arc::new(SearchSession::new(sender, receiver, QUEUE_CAPACITY));
        let handle = self.sessions.insert("search", Arc::clone(&session));
        self.handles
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(handle.clone());
        let worker_session = Arc::clone(&session);
        let worker_name = format!("tether-{handle}");

        let spawned = thread::Builder::new().name(worker_name).spawn(move || {
            run_search(&worker_session, spec);
        });

        if let Err(error) = spawned {
            self.sessions.remove(&handle);
            self.handles
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(&handle);
            return Err(CapabilityError {
                code: ErrorCode::ProviderFailure,
                message: format!("failed to start search worker: {error}"),
                recovery_hint: None,
                details: serde_json::json!({}),
            });
        }

        Ok(json!({
            "handle": handle,
            "state": "running",
        }))
    }

    fn read(&self, arguments: &Value) -> Result<Value, CapabilityError> {
        let handle = string_argument(arguments, "handle")?;
        let max_items = usize_argument(arguments, "max_items", DEFAULT_READ_ITEMS)?;
        if max_items == 0 {
            return Err(invalid_arguments("max_items must be greater than zero"));
        }

        let session = self.sessions.with(handle, Arc::clone)?;
        let (matches, done) = session.read_unseen(max_items);

        Ok(json!({
            "handle": handle,
            "matches": matches,
            "state": session.state_name(),
            "done": done,
        }))
    }

    fn stop(&self, arguments: &Value) -> Result<Value, CapabilityError> {
        let handle = string_argument(arguments, "handle")?;
        let session = self.sessions.with(handle, Arc::clone)?;
        session.cancel();
        Ok(session_metadata(handle, &session))
    }

    fn list(&self) -> Result<Value, CapabilityError> {
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
            sessions.push(session_metadata(&handle, &session));
        }

        Ok(json!({ "sessions": sessions }))
    }
}

impl Default for SearchProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl CapabilityProvider for SearchProvider {
    fn namespace(&self) -> &'static str {
        "search"
    }

    async fn execute(
        &self,
        invocation: &InvocationEnvelope,
    ) -> Result<ProviderResult, CapabilityError> {
        let operation = invocation
            .capability
            .strip_prefix("search.")
            .ok_or_else(|| invalid_arguments("capability must use the search namespace"))?;

        let data = match operation {
            "start" => self.start(&invocation.arguments)?,
            "read" => self.read(&invocation.arguments)?,
            "stop" => self.stop(&invocation.arguments)?,
            "list" => self.list()?,
            _ => {
                return Err(CapabilityError {
                    code: ErrorCode::CapabilityUnavailable,
                    message: format!("search operation is unavailable: {operation}"),
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

enum SearchWorkerSpec {
    Filename(FilenameSearchSpec),
    Content(ContentSearchSpec),
}

struct FilenameSearchSpec {
    root: PathBuf,
    matcher: TextMatcher,
    include_hidden: bool,
    max_results: usize,
}

struct ContentSearchSpec {
    root: PathBuf,
    matcher: TextMatcher,
    include_hidden: bool,
    max_results: usize,
    globs: Option<GlobSet>,
    context_lines: usize,
}

enum TextMatcher {
    LiteralSensitive(String),
    LiteralInsensitive(String),
    Regex(Regex),
}

impl TextMatcher {
    fn new(query: &str, use_regex: bool, case_sensitive: bool) -> Result<Self, CapabilityError> {
        if use_regex {
            let regex = RegexBuilder::new(query)
                .case_insensitive(!case_sensitive)
                .build()
                .map_err(|error| CapabilityError {
                    code: ErrorCode::InvalidArguments,
                    message: format!("invalid search regex: {error}"),
                    recovery_hint: None,
                    details: json!({ "query": query }),
                })?;
            return Ok(Self::Regex(regex));
        }

        if case_sensitive {
            Ok(Self::LiteralSensitive(query.to_owned()))
        } else {
            Ok(Self::LiteralInsensitive(query.to_lowercase()))
        }
    }

    fn is_match(&self, text: &str) -> bool {
        match self {
            Self::LiteralSensitive(needle) => text.contains(needle),
            Self::LiteralInsensitive(needle) => text.to_lowercase().contains(needle),
            Self::Regex(regex) => regex.is_match(text),
        }
    }
}

fn run_search(session: &SearchSession, spec: SearchWorkerSpec) {
    match spec {
        SearchWorkerSpec::Filename(spec) => run_filename_search(session, &spec),
        SearchWorkerSpec::Content(spec) => run_content_search(session, &spec),
    }
}

fn run_filename_search(session: &SearchSession, spec: &FilenameSearchSpec) {
    let mut builder = WalkBuilder::new(&spec.root);
    builder.hidden(!spec.include_hidden);

    let mut delivered = 0_usize;
    for entry in builder.build() {
        if session.is_cancelled() {
            session.cancel();
            return;
        }

        let Ok(entry) = entry else {
            continue;
        };
        let Some(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_file() {
            continue;
        }

        let name = entry.file_name().to_string_lossy();
        if !spec.matcher.is_match(&name) {
            continue;
        }

        let Ok(relative) = entry.path().strip_prefix(&spec.root) else {
            continue;
        };
        let item = json!({
            "kind": "filename",
            "path": entry.path().to_string_lossy(),
            "relative_path": normalize_relative(relative),
        });

        if !session.send_bounded(item) {
            session.cancel();
            return;
        }

        delivered = delivered.saturating_add(1);
        if delivered >= spec.max_results {
            break;
        }
    }

    finish_session(session);
}

fn run_content_search(session: &SearchSession, spec: &ContentSearchSpec) {
    let mut builder = WalkBuilder::new(&spec.root);
    builder.hidden(!spec.include_hidden);

    let mut delivered = 0_usize;
    'files: for entry in builder.build() {
        if session.is_cancelled() {
            session.cancel();
            return;
        }

        let Ok(entry) = entry else {
            continue;
        };
        let Some(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_file() {
            continue;
        }

        let Ok(relative) = entry.path().strip_prefix(&spec.root) else {
            continue;
        };
        if spec
            .globs
            .as_ref()
            .is_some_and(|globs| !globs.is_match(relative))
        {
            continue;
        }

        let Ok(bytes) = fs::read(entry.path()) else {
            continue;
        };
        if bytes.contains(&0) {
            continue;
        }
        let Ok(content) = String::from_utf8(bytes) else {
            continue;
        };
        let lines: Vec<&str> = content.lines().collect();

        for (index, line) in lines.iter().enumerate() {
            if session.is_cancelled() {
                session.cancel();
                return;
            }
            if !spec.matcher.is_match(line) {
                continue;
            }

            let before_start = index.saturating_sub(spec.context_lines);
            let after_end = index
                .saturating_add(1)
                .saturating_add(spec.context_lines)
                .min(lines.len());
            let item = json!({
                "kind": "content",
                "path": entry.path().to_string_lossy(),
                "relative_path": normalize_relative(relative),
                "line_number": index.saturating_add(1),
                "line": line,
                "context_before": lines[before_start..index],
                "context_after": lines[index.saturating_add(1)..after_end],
            });

            if !session.send_bounded(item) {
                session.cancel();
                return;
            }

            delivered = delivered.saturating_add(1);
            if delivered >= spec.max_results {
                break 'files;
            }
        }
    }

    finish_session(session);
}

fn finish_session(session: &SearchSession) {
    if session.is_cancelled() {
        session.cancel();
    } else {
        session.mark_completed();
    }
}

fn session_metadata(handle: &str, session: &SearchSession) -> Value {
    json!({
        "handle": handle,
        "state": session.state_name(),
        "queued": session.queued(),
        "queue_capacity": session.queue_capacity(),
    })
}

fn normalize_relative(path: &std::path::Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn path_argument(arguments: &Value, key: &str) -> Result<PathBuf, CapabilityError> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .ok_or_else(|| invalid_arguments(&format!("{key} must be a path string")))
}

fn string_argument<'a>(arguments: &'a Value, key: &str) -> Result<&'a str, CapabilityError> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_arguments(&format!("{key} must be a string")))
}

fn bool_argument(arguments: &Value, key: &str, default: bool) -> Result<bool, CapabilityError> {
    match arguments.get(key) {
        None | Some(Value::Null) => Ok(default),
        Some(Value::Bool(value)) => Ok(*value),
        Some(_) => Err(invalid_arguments(&format!("{key} must be a boolean"))),
    }
}

fn usize_argument(arguments: &Value, key: &str, default: usize) -> Result<usize, CapabilityError> {
    let Some(value) = arguments.get(key) else {
        return Ok(default);
    };
    if value.is_null() {
        return Ok(default);
    }
    let raw = value
        .as_u64()
        .ok_or_else(|| invalid_arguments(&format!("{key} must be a non-negative integer")))?;
    usize::try_from(raw).map_err(|_| invalid_arguments(&format!("{key} is too large")))
}

fn glob_set_argument(arguments: &Value) -> Result<Option<GlobSet>, CapabilityError> {
    let Some(value) = arguments.get("globs") else {
        return Ok(None);
    };
    let Some(patterns) = value.as_array() else {
        return Err(invalid_arguments("globs must be an array of strings"));
    };
    if patterns.is_empty() {
        return Ok(None);
    }

    let mut builder = GlobSetBuilder::new();
    for value in patterns {
        let Some(pattern) = value.as_str() else {
            return Err(invalid_arguments("globs must contain only strings"));
        };
        let glob = Glob::new(pattern).map_err(|error| CapabilityError {
            code: ErrorCode::InvalidArguments,
            message: format!("invalid file glob: {error}"),
            recovery_hint: None,
            details: json!({ "glob": pattern }),
        })?;
        builder.add(glob);
    }

    builder.build().map(Some).map_err(|error| CapabilityError {
        code: ErrorCode::InvalidArguments,
        message: format!("invalid file glob set: {error}"),
        recovery_hint: None,
        details: serde_json::json!({}),
    })
}

fn invalid_arguments(message: &str) -> CapabilityError {
    CapabilityError {
        code: ErrorCode::InvalidArguments,
        message: message.to_owned(),
        recovery_hint: None,
        details: serde_json::json!({}),
    }
}

pub const CRATE_NAME: &str = "tether-search-provider";
