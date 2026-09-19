use std::fs;

use serde_json::{Value, json};
use tempfile::TempDir;
use tether_core::{
    Actor, ActorKind, CapabilityProvider, ErrorCode, InvocationEnvelope, ResponseMode,
    VerificationStatus,
};

use super::FilesystemProvider;

fn invocation(capability: &str, arguments: Value) -> InvocationEnvelope {
    InvocationEnvelope {
        protocol_version: "1.0".into(),
        request_id: "00000000-0000-4000-8000-000000000001".parse().unwrap(),
        device_id: Some("Leno".into()),
        principal_id: None,
        job_id: None,
        capability: capability.into(),
        arguments,
        actor: Actor {
            id: "filesystem-test".into(),
            kind: ActorKind::AiClient,
        },
        session_id: None,
        response_mode: ResponseMode::Compact,
        idempotency_key: None,
        preconditions: vec![],
        expectations: vec![],
    }
}

#[tokio::test]
async fn read_respects_line_bounds_and_utf8() {
    let temp = TempDir::new().unwrap();
    let file = temp.path().join("utf8.txt");
    fs::write(&file, "α\nβ\nγ\nδ\n").unwrap();
    let provider = FilesystemProvider::new();

    let result = provider
        .execute(&invocation(
            "filesystem.read",
            json!({ "path": file, "offset": 1, "length": 2 }),
        ))
        .await
        .unwrap();

    assert_eq!(result.verification, VerificationStatus::NotApplicable);
    assert_eq!(result.data["content"].as_str(), Some("β\nγ\n"));
    assert_eq!(result.data["start_line"].as_u64(), Some(1));
    assert_eq!(result.data["lines_returned"].as_u64(), Some(2));
    assert_eq!(result.data["total_lines"].as_u64(), Some(4));
}

#[tokio::test]
async fn negative_offset_reads_from_the_tail() {
    let temp = TempDir::new().unwrap();
    let file = temp.path().join("tail.txt");
    fs::write(&file, "one\ntwo\nthree\nfour\n").unwrap();
    let provider = FilesystemProvider::new();

    let result = provider
        .execute(&invocation(
            "filesystem.read",
            json!({ "path": file, "offset": -2 }),
        ))
        .await
        .unwrap();

    assert_eq!(result.data["content"].as_str(), Some("three\nfour\n"));
    assert_eq!(result.data["start_line"].as_u64(), Some(2));
    assert_eq!(result.data["total_lines"].as_u64(), Some(4));
}

#[tokio::test]
async fn read_many_preserves_successes_when_one_file_fails() {
    let temp = TempDir::new().unwrap();
    let good = temp.path().join("good.txt");
    let missing = temp.path().join("missing.txt");
    fs::write(&good, "good\n").unwrap();
    let provider = FilesystemProvider::new();

    let result = provider
        .execute(&invocation(
            "filesystem.read_many",
            json!({ "paths": [good, missing] }),
        ))
        .await
        .unwrap();

    let entries = result.data["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0]["status"].as_str(), Some("success"));
    assert_eq!(entries[0]["content"].as_str(), Some("good\n"));
    assert_eq!(entries[1]["status"].as_str(), Some("error"));
    assert!(entries[1]["error"]["code"].is_string());
}

#[tokio::test]
async fn list_is_depth_bounded() {
    let temp = TempDir::new().unwrap();
    let root = temp.path().join("root");
    fs::create_dir_all(root.join("sub").join("deep")).unwrap();
    fs::write(root.join("a.txt"), "a").unwrap();
    fs::write(root.join("sub").join("b.txt"), "b").unwrap();
    fs::write(root.join("sub").join("deep").join("c.txt"), "c").unwrap();
    let provider = FilesystemProvider::new();

    let depth_one = provider
        .execute(&invocation(
            "filesystem.list",
            json!({ "path": root, "depth": 1 }),
        ))
        .await
        .unwrap();
    let one: Vec<_> = depth_one.data["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["relative_path"].as_str().unwrap().to_owned())
        .collect();

    assert!(one.contains(&"a.txt".to_owned()));
    assert!(one.contains(&"sub".to_owned()));
    assert!(!one.contains(&"sub/b.txt".to_owned()));

    let root = temp.path().join("root");
    let depth_two = provider
        .execute(&invocation(
            "filesystem.list",
            json!({ "path": root, "depth": 2 }),
        ))
        .await
        .unwrap();
    let two: Vec<_> = depth_two.data["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["relative_path"].as_str().unwrap().to_owned())
        .collect();

    assert!(two.contains(&"sub/b.txt".to_owned()));
    assert!(two.contains(&"sub/deep".to_owned()));
    assert!(!two.contains(&"sub/deep/c.txt".to_owned()));
}

#[tokio::test]
async fn info_reports_size_modified_type_and_text_line_count() {
    let temp = TempDir::new().unwrap();
    let file = temp.path().join("info.txt");
    let contents = "one\ntwo\nthree\n";
    fs::write(&file, contents).unwrap();
    let provider = FilesystemProvider::new();

    let result = provider
        .execute(&invocation("filesystem.info", json!({ "path": file })))
        .await
        .unwrap();

    assert_eq!(result.data["type"].as_str(), Some("file"));
    assert_eq!(
        result.data["size"].as_u64(),
        Some(u64::try_from(contents.len()).unwrap())
    );
    assert!(result.data["modified_time"].is_string());
    assert_eq!(result.data["line_count"].as_u64(), Some(3));
}

#[tokio::test]
async fn write_parent_missing_is_machine_readable() {
    let temp = TempDir::new().unwrap();
    let target = temp.path().join("missing").join("file.txt");
    let provider = FilesystemProvider::new();

    let error = provider
        .execute(&invocation(
            "filesystem.write",
            json!({ "path": target, "content": "hello" }),
        ))
        .await
        .unwrap_err();

    assert_eq!(error.code, ErrorCode::InvalidArguments);
    assert_eq!(error.details["reason"].as_str(), Some("parent_missing"));
}

#[tokio::test]
async fn write_is_atomic_and_append_extends_the_file() {
    let temp = TempDir::new().unwrap();
    let target = temp.path().join("file.txt");
    let provider = FilesystemProvider::new();

    provider
        .execute(&invocation(
            "filesystem.write",
            json!({ "path": target, "content": "alpha" }),
        ))
        .await
        .unwrap();
    provider
        .execute(&invocation(
            "filesystem.append",
            json!({ "path": target, "content": "\nbeta" }),
        ))
        .await
        .unwrap();

    assert_eq!(fs::read_to_string(target).unwrap(), "alpha\nbeta");
}

#[tokio::test]
async fn mkdir_creates_the_requested_directory() {
    let temp = TempDir::new().unwrap();
    let target = temp.path().join("created");
    let provider = FilesystemProvider::new();

    provider
        .execute(&invocation("filesystem.mkdir", json!({ "path": target })))
        .await
        .unwrap();

    assert!(target.is_dir());
}

#[tokio::test]
async fn move_rejects_existing_destination_unless_replace_is_explicit() {
    let temp = TempDir::new().unwrap();
    let source = temp.path().join("source.txt");
    let destination = temp.path().join("destination.txt");
    fs::write(&source, "source").unwrap();
    fs::write(&destination, "destination").unwrap();
    let provider = FilesystemProvider::new();

    let error = provider
        .execute(&invocation(
            "filesystem.move",
            json!({ "source": source, "destination": destination }),
        ))
        .await
        .unwrap_err();

    assert_eq!(error.code, ErrorCode::PreconditionFailed);
    assert_eq!(fs::read_to_string(&source).unwrap(), "source");
    assert_eq!(fs::read_to_string(&destination).unwrap(), "destination");

    provider
        .execute(&invocation(
            "filesystem.move",
            json!({ "source": source, "destination": destination, "replace": true }),
        ))
        .await
        .unwrap();

    assert!(!source.exists());
    assert_eq!(fs::read_to_string(destination).unwrap(), "source");
}

#[tokio::test]
async fn patch_one_exact_match_succeeds_and_returns_changed_range() {
    let temp = TempDir::new().unwrap();
    let file = temp.path().join("patch.txt");
    fs::write(&file, "alpha\nbeta\ngamma\n").unwrap();
    let provider = FilesystemProvider::new();

    let result = provider
        .execute(&invocation(
            "filesystem.patch",
            json!({
                "path": file,
                "old": "beta",
                "new": "BETA",
                "expected_replacements": 1
            }),
        ))
        .await
        .unwrap();

    assert_eq!(fs::read_to_string(&file).unwrap(), "alpha\nBETA\ngamma\n");
    assert_eq!(result.data["replacements"].as_u64(), Some(1));
    assert_eq!(result.data["changes"].as_array().unwrap().len(), 1);
    assert!(result.data.get("content").is_none());
}

#[tokio::test]
async fn patch_zero_matches_fails_before_writing() {
    let temp = TempDir::new().unwrap();
    let file = temp.path().join("patch.txt");
    fs::write(&file, "alpha\nbeta\n").unwrap();
    let provider = FilesystemProvider::new();

    let error = provider
        .execute(&invocation(
            "filesystem.patch",
            json!({
                "path": file,
                "old": "missing",
                "new": "replacement",
                "expected_replacements": 1
            }),
        ))
        .await
        .unwrap_err();

    assert_eq!(error.code, ErrorCode::PreconditionFailed);
    assert_eq!(fs::read_to_string(file).unwrap(), "alpha\nbeta\n");
}

#[tokio::test]
async fn patch_multiple_matches_fails_when_expected_is_one() {
    let temp = TempDir::new().unwrap();
    let file = temp.path().join("patch.txt");
    fs::write(&file, "same\nsame\n").unwrap();
    let provider = FilesystemProvider::new();

    let error = provider
        .execute(&invocation(
            "filesystem.patch",
            json!({
                "path": file,
                "old": "same",
                "new": "changed",
                "expected_replacements": 1
            }),
        ))
        .await
        .unwrap_err();

    assert_eq!(error.code, ErrorCode::PreconditionFailed);
    assert_eq!(fs::read_to_string(file).unwrap(), "same\nsame\n");
}

#[tokio::test]
async fn patch_exactly_two_matches_succeeds_when_two_are_expected() {
    let temp = TempDir::new().unwrap();
    let file = temp.path().join("patch.txt");
    fs::write(&file, "same\nmiddle\nsame\n").unwrap();
    let provider = FilesystemProvider::new();

    let result = provider
        .execute(&invocation(
            "filesystem.patch",
            json!({
                "path": file,
                "old": "same",
                "new": "changed",
                "expected_replacements": 2
            }),
        ))
        .await
        .unwrap();

    assert_eq!(
        fs::read_to_string(&file).unwrap(),
        "changed\nmiddle\nchanged\n"
    );
    assert_eq!(result.data["replacements"].as_u64(), Some(2));
    assert_eq!(result.data["changes"].as_array().unwrap().len(), 2);
}
