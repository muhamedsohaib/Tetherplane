import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { initializeCredentialDirectory } from "../../packaging/msix-store-runtime/app/state-security.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

// Structural ACL test only: no impersonation, cross-account AccessCheck,
// account creation, privilege changes, installation, relay or owner device use.
test("Windows Store-sealed root protects actual agent idempotency and audit files", {
  skip: process.platform !== "win32",
}, async t => {
  const root = await mkdtemp(join(tmpdir(), "tetherplane-private-agent-state-ci-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const stateRoot = join(root, "store-private-state");
  const agentState = join(stateRoot, "agent-state");
  const allowedRoot = join(root, "synthetic-allowed-root");
  const target = join(allowedRoot, "synthetic-output.txt");
  const profilePath = join(root, "synthetic-principal.json");
  await mkdir(allowedRoot);
  await writeFile(profilePath, JSON.stringify({
    principal_id: "model:ci-synthetic-only",
    authentication: "local_process_binding",
    allowed_devices: ["DisposableCI"],
    allowed_capabilities: ["filesystem.append"],
    allowed_roots: [allowedRoot],
  }));

  // Reuse the actual Store state helper; save no device credential.
  await initializeCredentialDirectory(stateRoot);
  await mkdir(agentState, { recursive: true });

  const binary = join(repoRoot, "target", "debug", "tetherd.exe");
  const request = {
    protocol_version: "1.0",
    request_id: "00000000-0000-4000-8000-000000000461",
    device_id: "DisposableCI",
    principal_id: "model:untrusted-spoofed-input",
    job_id: null,
    capability: "filesystem.append",
    arguments: { path: target, content: "SYNTHETIC_TEST_DATA_ONLY\n" },
    actor: { id: "isolated-msix-state-acl-test", kind: "ai_client" },
    session_id: null,
    response_mode: "compact",
    idempotency_key: "synthetic-acl-test-once",
    preconditions: [],
    expectations: [],
  };
  const agent = spawnSync(binary, [
    "--stdio-rpc", "--principal-profile", profilePath,
    "--allow", allowedRoot, "--state-dir", agentState,
  ], {
    input: JSON.stringify(request) + "\n",
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  assert.ifError(agent.error);
  assert.equal(agent.status, 0, "disposable agent should exit successfully");
  const responses = agent.stdout.trim().split(/\r?\n/);
  assert.equal(responses.length, 1, "one request must produce one response");
  const response = JSON.parse(responses[0]);
  assert.equal(response.status, "success", "synthetic append must succeed");
  assert.equal(await readFile(target, "utf8"), "SYNTHETIC_TEST_DATA_ONLY\n");

  const idempotencyDir = join(agentState, "idempotency");
  const auditDir = join(agentState, "audit");
  const completedFiles = (await readdir(idempotencyDir)).filter(name => name.endsWith(".complete.json"));
  assert.equal(completedFiles.length, 1, "one completed record must be materialized");
  const completed = join(idempotencyDir, completedFiles[0]);
  const audit = join(auditDir, "events.jsonl");
  assert.equal(JSON.parse(await readFile(completed, "utf8")).result.status, "success");
  assert.match(await readFile(audit, "utf8"), /filesystem\.append/);

  // Inspect the Store root and actual agent-created descendants, not just
  // credential files. Never print user SIDs or private paths in CI output.
  const aclCheck = [
    "$ErrorActionPreference = 'Stop'",
    "$owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "$permitted = @($owner, 'S-1-5-18')",
    "$paths = @($env:TP_ACL_ROOT, $env:TP_ACL_AGENT, $env:TP_ACL_IDEMPOTENCY, $env:TP_ACL_COMPLETED, $env:TP_ACL_AUDIT_DIR, $env:TP_ACL_AUDIT_FILE)",
    "foreach ($path in $paths) {",
    "  if (-not (Test-Path -LiteralPath $path)) { throw 'SYNTHETIC_STATE_MISSING' }",
    "  $acl = Get-Acl -LiteralPath $path",
    "  if ($path -eq $paths[0] -and -not $acl.AreAccessRulesProtected) { throw 'STORE_ROOT_INHERITS_UNVERIFIED_ACL' }",
    "  $observed = @()",
    "  foreach ($rule in @($acl.Access)) {",
    "    $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value",
    "    if ($permitted -notcontains $sid) { throw 'UNEXPECTED_AGENT_STATE_ACL_PRINCIPAL' }",
    "    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { throw 'UNEXPECTED_AGENT_STATE_ACL_DENY_RULE' }",
    "    $observed += $sid",
    "  }",
    "  if ($observed -notcontains $owner -or $observed -notcontains 'S-1-5-18') { throw 'OWNER_OR_SYSTEM_ACE_MISSING' }",
    "}",
    "'STORE_AGENT_STATE_ACL_STRUCTURAL_PASS_NO_CROSS_ACCOUNT_CLAIM'",
  ].join("\n");
  const ps = join(process.env.SystemRoot || process.env.WINDIR, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const output = execFileSync(ps, ["-NoProfile", "-NonInteractive", "-Command", aclCheck], {
    cwd: root,
    windowsHide: true,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 16_384,
    env: {
      ...process.env,
      TP_ACL_ROOT: stateRoot,
      TP_ACL_AGENT: agentState,
      TP_ACL_IDEMPOTENCY: idempotencyDir,
      TP_ACL_COMPLETED: completed,
      TP_ACL_AUDIT_DIR: auditDir,
      TP_ACL_AUDIT_FILE: audit,
    },
  });
  assert.match(output, /STORE_AGENT_STATE_ACL_STRUCTURAL_PASS_NO_CROSS_ACCOUNT_CLAIM/);
});
