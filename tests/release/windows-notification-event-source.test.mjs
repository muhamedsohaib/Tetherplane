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
