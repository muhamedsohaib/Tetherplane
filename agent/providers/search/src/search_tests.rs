use std::fs;
use std::path::Path;
use std::time::Duration;

use serde_json::{Value, json};
use tempfile::TempDir;
use tether_core::{Actor, ActorKind, CapabilityProvider, InvocationEnvelope, ResponseMode};

use super::SearchProvider;

fn invocation(capability: &str, arguments: Value) -> InvocationEnvelope {
    InvocationEnvelope {
        protocol_version: "1.0".into(),
        request_id: "00000000-0000-4000-8000-000000000007".parse().unwrap(),
        device_id: Some("Leno".into()),
        capability: capability.into(),
        arguments,
        actor: Actor {
            id: "search-test".into(),
            kind: ActorKind::AiClient,
        },
        session_id: None,
        response_mode: ResponseMode::Compact,
        idempotency_key: None,
        preconditions: vec![],
        expectations: vec![],
    }
}

fn fixture() -> TempDir {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    fs::create_dir_all(root.join("nested").join("deep")).unwrap();
    fs::create_dir_all(root.join(".hidden-dir")).unwrap();
    fs::write(root.join("Alpha.TXT"), "a").unwrap();
    fs::write(root.join("alpha.log"), "a").unwrap();
    fs::write(root.join("report[1].txt"), "a").unwrap();
    fs::write(root.join("report1.txt"), "a").unwrap();
    fs::write(root.join(".hidden.txt"), "hidden").unwrap();
    fs::write(root.join("nested").join("Beta.txt"), "b").unwrap();
    fs::write(root.join("nested").join("deep").join("gamma.TXT"), "g").unwrap();
    fs::write(root.join(".hidden-dir").join("Secret.txt"), "s").unwrap();
    temp
}

async fn start_filename(
    provider: &SearchProvider,
    root: &Path,
    query: &str,
    regex: bool,
    case_sensitive: bool,
    include_hidden: bool,
    max_results: usize,
) -> String {
    let result = provider
        .execute(&invocation(
            "search.start",
            json!({
                "root": root,
                "scope": "filename",
                "query": query,
                "regex": regex,
                "case_sensitive": case_sensitive,
                "include_hidden": include_hidden,
                "max_results": max_results,
            }),
        ))
        .await
        .unwrap();

    let handle = result.data["handle"].as_str().unwrap().to_owned();
    assert!(handle.starts_with("search_"));
    handle
}

async fn collect_matches(provider: &SearchProvider, handle: &str) -> Vec<Value> {
    let mut matches = Vec::new();
    for _ in 0..200 {
        let result = provider
            .execute(&invocation(
                "search.read",
                json!({ "handle": handle, "max_items": 64 }),
            ))
            .await
            .unwrap();

        matches.extend(result.data["matches"].as_array().unwrap().iter().cloned());
        if result.data["done"].as_bool() == Some(true) {
            return matches;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("search did not reach a terminal state");
}

async fn collect_relative_paths(provider: &SearchProvider, handle: &str) -> Vec<String> {
    let mut paths: Vec<String> = collect_matches(provider, handle)
        .await
        .into_iter()
        .map(|item| item["relative_path"].as_str().unwrap().to_owned())
        .collect();
    paths.sort();
    paths
}

struct ContentSearchOptions<'a> {
    query: &'a str,
    regex: bool,
    case_sensitive: bool,
    globs: &'a [&'a str],
    context_lines: usize,
    max_results: usize,
}

async fn start_content(
    provider: &SearchProvider,
    root: &Path,
    options: ContentSearchOptions<'_>,
) -> String {
    let result = provider
        .execute(&invocation(
            "search.start",
            json!({
                "root": root,
                "scope": "content",
                "query": options.query,
                "regex": options.regex,
                "case_sensitive": options.case_sensitive,
                "include_hidden": false,
                "globs": options.globs,
                "context_lines": options.context_lines,
                "max_results": options.max_results,
            }),
        ))
        .await
        .unwrap();

    let handle = result.data["handle"].as_str().unwrap().to_owned();
    assert!(handle.starts_with("search_"));
    handle
}

#[tokio::test]
async fn literal_filename_search_is_case_insensitive_and_nested() {
    let temp = fixture();
    let provider = SearchProvider::new();

    let handle = start_filename(&provider, temp.path(), "alpha", false, false, false, 100).await;
    let paths = collect_relative_paths(&provider, &handle).await;

    assert_eq!(paths, vec!["Alpha.TXT", "alpha.log"]);
}

#[tokio::test]
async fn case_sensitive_filename_search_distinguishes_case() {
    let temp = fixture();
    let provider = SearchProvider::new();

    let handle = start_filename(&provider, temp.path(), "Alpha", false, true, false, 100).await;
    let paths = collect_relative_paths(&provider, &handle).await;

    assert_eq!(paths, vec!["Alpha.TXT"]);
}

#[tokio::test]
async fn regex_filename_search_matches_nested_names() {
    let temp = fixture();
    let provider = SearchProvider::new();

    let handle = start_filename(
        &provider,
        temp.path(),
        "^(Alpha|Beta)\\.",
        true,
        true,
        false,
        100,
    )
    .await;
    let paths = collect_relative_paths(&provider, &handle).await;

    assert_eq!(paths, vec!["Alpha.TXT", "nested/Beta.txt"]);
}

#[tokio::test]
async fn literal_search_does_not_treat_regex_metacharacters_as_patterns() {
    let temp = fixture();
    let provider = SearchProvider::new();

    let handle = start_filename(&provider, temp.path(), "report[1]", false, true, false, 100).await;
    let paths = collect_relative_paths(&provider, &handle).await;

    assert_eq!(paths, vec!["report[1].txt"]);
}

#[tokio::test]
async fn hidden_files_and_hidden_directories_are_opt_in() {
    let temp = fixture();
    let provider = SearchProvider::new();

    let visible_handle = start_filename(
        &provider,
        temp.path(),
        "hidden|Secret",
        true,
        false,
        false,
        100,
    )
    .await;
    let visible = collect_relative_paths(&provider, &visible_handle).await;
    assert!(visible.is_empty());

    let hidden_handle = start_filename(
        &provider,
        temp.path(),
        "hidden|Secret",
        true,
        false,
        true,
        100,
    )
    .await;
    let hidden = collect_relative_paths(&provider, &hidden_handle).await;

    assert_eq!(hidden, vec![".hidden-dir/Secret.txt", ".hidden.txt"]);
}

#[tokio::test]
async fn filename_search_respects_max_results() {
    let temp = fixture();
    let provider = SearchProvider::new();

    let handle = start_filename(&provider, temp.path(), ".", true, false, true, 2).await;
    let paths = collect_relative_paths(&provider, &handle).await;

    assert_eq!(paths.len(), 2);
}

#[tokio::test]
async fn literal_content_search_returns_bounded_context() {
    let temp = TempDir::new().unwrap();
    let file = temp.path().join("notes.txt");
    fs::write(&file, "zero\nbefore\nNeedle target\nafter\nlast\n").unwrap();
    let provider = SearchProvider::new();

    let handle = start_content(
        &provider,
        temp.path(),
        ContentSearchOptions {
            query: "needle",
            regex: false,
            case_sensitive: false,
            globs: &[],
            context_lines: 1,
            max_results: 100,
        },
    )
    .await;
    let matches = collect_matches(&provider, &handle).await;

    assert_eq!(matches.len(), 1);
    let item = &matches[0];
    assert_eq!(item["relative_path"].as_str(), Some("notes.txt"));
    assert_eq!(item["line_number"].as_u64(), Some(3));
    assert_eq!(item["line"].as_str(), Some("Needle target"));
    assert_eq!(item["context_before"], json!(["before"]));
    assert_eq!(item["context_after"], json!(["after"]));
}

#[tokio::test]
async fn regex_content_search_matches_only_matching_lines() {
    let temp = TempDir::new().unwrap();
    let file = temp.path().join("codes.txt");
    fs::write(&file, "alpha\nid 123-45 end\nid 12-3\n").unwrap();
    let provider = SearchProvider::new();

    let handle = start_content(
        &provider,
        temp.path(),
        ContentSearchOptions {
            query: r"\b\d{3}-\d{2}\b",
            regex: true,
            case_sensitive: true,
            globs: &[],
            context_lines: 0,
            max_results: 100,
        },
    )
    .await;
    let matches = collect_matches(&provider, &handle).await;

    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0]["line_number"].as_u64(), Some(2));
    assert_eq!(matches[0]["line"].as_str(), Some("id 123-45 end"));
}

#[tokio::test]
async fn content_search_respects_file_glob_filters() {
    let temp = TempDir::new().unwrap();
    fs::write(temp.path().join("hit.txt"), "needle\n").unwrap();
    fs::write(temp.path().join("skip.md"), "needle\n").unwrap();
    let provider = SearchProvider::new();

    let handle = start_content(
        &provider,
        temp.path(),
        ContentSearchOptions {
            query: "needle",
            regex: false,
            case_sensitive: true,
            globs: &["*.txt"],
            context_lines: 0,
            max_results: 100,
        },
    )
    .await;
    let matches = collect_matches(&provider, &handle).await;
    let paths: Vec<_> = matches
        .iter()
        .map(|item| item["relative_path"].as_str().unwrap())
        .collect();

    assert_eq!(paths, vec!["hit.txt"]);
}

#[tokio::test]
async fn content_search_skips_binary_and_invalid_utf8_without_aborting() {
    let temp = TempDir::new().unwrap();
    fs::write(temp.path().join("valid.txt"), "needle\n").unwrap();
    fs::write(temp.path().join("binary.bin"), b"needle\0binary").unwrap();
    fs::write(
        temp.path().join("invalid.txt"),
        [b'n', b'e', b'e', b'd', b'l', b'e', 0xff],
    )
    .unwrap();
    let provider = SearchProvider::new();

    let handle = start_content(
        &provider,
        temp.path(),
        ContentSearchOptions {
            query: "needle",
            regex: false,
            case_sensitive: true,
            globs: &[],
            context_lines: 0,
            max_results: 100,
        },
    )
    .await;
    let matches = collect_matches(&provider, &handle).await;
    let mut paths: Vec<_> = matches
        .iter()
        .map(|item| item["relative_path"].as_str().unwrap().to_owned())
        .collect();
    paths.sort();

    assert_eq!(paths, vec!["valid.txt"]);
}

fn large_filename_fixture(count: usize) -> TempDir {
    let temp = TempDir::new().unwrap();
    for index in 0..count {
        fs::write(temp.path().join(format!("match-{index:04}.txt")), "content").unwrap();
    }
    temp
}

#[tokio::test]
async fn progressive_reads_only_return_unseen_matches() {
    let temp = large_filename_fixture(8);
    let provider = SearchProvider::new();
    let handle = start_filename(&provider, temp.path(), "match-", false, true, false, 8).await;

    tokio::time::sleep(Duration::from_millis(20)).await;

    let first = provider
        .execute(&invocation(
            "search.read",
            json!({ "handle": handle, "max_items": 2 }),
        ))
        .await
        .unwrap();
    let second = provider
        .execute(&invocation(
            "search.read",
            json!({ "handle": handle, "max_items": 2 }),
        ))
        .await
        .unwrap();

    let first_paths: Vec<_> = first.data["matches"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["relative_path"].as_str().unwrap())
        .collect();
    let second_paths: Vec<_> = second.data["matches"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["relative_path"].as_str().unwrap())
        .collect();

    assert_eq!(first_paths.len(), 2);
    assert_eq!(second_paths.len(), 2);
    assert!(first_paths.iter().all(|path| !second_paths.contains(path)));
}

#[tokio::test]
async fn search_list_reports_session_state_and_bounded_queue_metadata() {
    let temp = large_filename_fixture(300);
    let provider = SearchProvider::new();
    let handle = start_filename(&provider, temp.path(), "match-", false, true, false, 300).await;

    tokio::time::sleep(Duration::from_millis(30)).await;

    let result = provider
        .execute(&invocation("search.list", json!({})))
        .await
        .unwrap();
    let sessions = result.data["sessions"].as_array().unwrap();
    let session = sessions
        .iter()
        .find(|item| item["handle"].as_str() == Some(handle.as_str()))
        .expect("started search must appear in search.list");

    let queued = session["queued"].as_u64().unwrap();
    let capacity = session["queue_capacity"].as_u64().unwrap();
    assert!(capacity > 0);
    assert!(queued <= capacity);
    assert_eq!(session["state"].as_str(), Some("running"));
}

#[tokio::test]
async fn bounded_queue_never_exceeds_reported_capacity() {
    let temp = large_filename_fixture(512);
    let provider = SearchProvider::new();
    let handle = start_filename(&provider, temp.path(), "match-", false, true, false, 512).await;

    tokio::time::sleep(Duration::from_millis(50)).await;

    let result = provider
        .execute(&invocation("search.list", json!({})))
        .await
        .unwrap();
    let session = result.data["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["handle"].as_str() == Some(handle.as_str()))
        .unwrap();

    assert!(session["queued"].as_u64().unwrap() <= session["queue_capacity"].as_u64().unwrap());
}

#[tokio::test]
async fn search_stop_cancels_an_active_search_and_reaches_terminal_state() {
    let temp = large_filename_fixture(512);
    let provider = SearchProvider::new();
    let handle = start_filename(&provider, temp.path(), "match-", false, true, false, 512).await;

    tokio::time::sleep(Duration::from_millis(30)).await;

    let stopped = provider
        .execute(&invocation("search.stop", json!({ "handle": handle })))
        .await
        .unwrap();
    assert_eq!(stopped.data["state"].as_str(), Some("cancelled"));

    for _ in 0..100 {
        let listed = provider
            .execute(&invocation("search.list", json!({})))
            .await
            .unwrap();
        let session = listed.data["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["handle"].as_str() == Some(handle.as_str()))
            .cloned()
            .unwrap();

        if session["state"].as_str() == Some("cancelled") {
            assert!(
                session["queued"].as_u64().unwrap() <= session["queue_capacity"].as_u64().unwrap()
            );
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }

    panic!("cancelled search did not reach a terminal state");
}
