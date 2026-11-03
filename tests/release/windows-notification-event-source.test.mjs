import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path) => readFileSync(join(root, path), "utf8");

test("developer beta event feed remains opt-in and has no default runtime subscriber", () => {
  const cargo = read("agent/tetherd/Cargo.toml");
  const main = read("agent/tetherd/src/main.rs");
  assert.match(cargo, /default\s*=\s*\[\]/);
  assert.match(cargo, /developer-beta-notification-feed\s*=\s*\["dep:tether-notifications",\s*"tether-notifications\/dev-beta"\]/);
  assert.match(main, /if dev_beta_local_toasts/);
  assert.match(main, /"--dev-beta-local-toasts" => dev_beta_local_toasts = true/);
  assert.match(main, /TransportMode::Stdio/);
});

test("notifications cannot precede the device-authenticated WebSocket upgrade", () => {
  const relay = read("agent/tetherd/src/relay_ws.rs");
  const upgrade = relay.indexOf("let (socket, _) = connect_async(request)");
  const observer = relay.indexOf("let _notification_session =");
  assert.ok(upgrade >= 0 && observer > upgrade, "observer must follow successful upgrade");
  const between = relay.slice(upgrade, observer);
  assert.match(between, /\.await\s*\.map_err\(\|error\|\s*classify_connect_error\(&error\)\)\?/);
  assert.match(between, /let mut socket = connect_device_socket\(config\)\.await\?/);
  assert.match(relay.slice(observer - 100, observer), /#\[cfg\(feature = "developer-beta-notification-feed"\)\]/);
  assert.match(relay, /notification_sink\.as_ref\(\)\.and_then/);
  assert.match(relay, /after_authenticated_upgrade/);
});

test("feed is bounded, text-only and reports unknown instead of fictitious offline", () => {
  const feed = read("agent/tether-notifications/src/session_feed.rs");
  const policy = read("agent/tether-notifications/src/lib.rs");
  assert.match(feed, /SyncSender<Event>/);
  assert.match(feed, /\.try_send\(/);
  assert.match(feed, /EventKind::LocalStatusUnknown/);
  assert.match(feed, /Provenance::LocalAgentTransport/);
  const executableSource = feed.split("#[cfg(test)]")[0].replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(executableSource, /credential|oauth|refresh_token|authorization.*header/i);
  assert.match(policy, /"The local relay connection was interrupted\. Device availability is unverified\."/);
});

test("synthetic 401 handshake denial test must continue to guard against false connected", () => {
  const relay = read("agent/tetherd/src/relay_ws.rs");
  assert.match(relay, /async fn denied_upgrade_never_emits_a_connected_event/);
  assert.match(relay, /HTTP\/1\.1 401 Unauthorized/);
  assert.match(relay, /assert!\(rx\.try_recv\(\)\.is_err\(\)/);
  assert.match(relay, /async fn accepted_upgrade_emits_connected_then_unknown_after_close_without_credentials/);
});

test("legacy private launcher argument-file support is opt-in, bounded and refuses overrides", () => {
  const main = read("agent/tetherd/src/main.rs");
  const loader = read("agent/tetherd/src/beta_arguments_file.rs");
  assert.match(main, /#\[cfg\(all\(windows, feature = "developer-beta-notification-feed"\)\)\]\s*mod beta_arguments_file/);
  assert.match(main, /beta_arguments_file::expand\(argv\)\?/);
  assert.match(loader, /MAX_BYTES: u64 = 16 \* 1024/);
  assert.match(loader, /MAX_ARGS: usize = 96/);
  assert.match(loader, /file_attributes\(\) & REPARSE_POINT/);
  assert.match(loader, /JSON string array/);
  assert.match(loader, /duplicate security-sensitive beta argument/);
  assert.match(loader, /accepts no command-line overrides/);
  assert.match(main, /unknown tetherd argument \(value redacted\)/);
});

test("one-shot real-status notification cannot be confused with automatic presence", () => {
  const script = read("scripts/windows/Test-LenoVerifiedStatusToastCanary.ps1");
  assert.match(script, /STALE_OR_FUTURE_AUTHENTICATED_STATUS_EVIDENCE/);
  assert.match(script, /BETA_KIT_HASH_MISMATCH/);
  assert.match(script, /ValidateSet\('authenticated'\)/);
  assert.match(script, /ValidateSet\('ready'\)/);
  assert.match(script, /One-time check, not continuous monitoring\./);
  assert.match(script, /\.Tag=\$tag/);
  assert.match(script, /\.Group='tetherplane-verified-snapshot'/);
  assert.match(script, /-Operation Unregister/);
  assert.doesNotMatch(script, /Start-ScheduledTask|Stop-ScheduledTask|Register-ScheduledTask|--relay-url|--device-credential-file/i);
});
