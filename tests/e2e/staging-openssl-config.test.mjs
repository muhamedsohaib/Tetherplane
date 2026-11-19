import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createStagingPki } from "../../scripts/staging-acceptance.mjs";

test("G4 disposable relay PKI is independent of machine OpenSSL configuration", (t) => {
  const openssl = process.platform === "win32" ? "openssl.exe" : "openssl";
  const version = spawnSync(openssl, ["version"], { encoding: "utf8", timeout: 5_000 });
  if (version.error || version.status !== 0) {
    t.skip("OpenSSL runtime unavailable on this CI worker");
    return;
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), "g4-ephemeral-pki-test-"));
  const oldConfig = process.env.OPENSSL_CONF;
  process.env.OPENSSL_CONF = path.join(dir, "nonexistent-host-openssl.cnf");
  try {
    const pki = createStagingPki(openssl, dir, "127.0.0.1");
    assert.ok(existsSync(path.join(dir, "openssl.cnf")));
    assert.match(readFileSync(path.join(dir, "openssl.cnf"), "utf8"), /distinguished_name/);
    assert.match(pki.caPem, /BEGIN CERTIFICATE/);
    assert.match(pki.spkiPin, /^[A-Za-z0-9+/]+={0,2}$/);
    const certificate = new X509Certificate(readFileSync(pki.srvCrt));
    assert.match(certificate.subjectAltName ?? "", /127[.]0[.]0[.]1/);
  } finally {
    if (oldConfig === undefined) delete process.env.OPENSSL_CONF;
    else process.env.OPENSSL_CONF = oldConfig;
    rmSync(dir, { recursive: true, force: true });
  }
});
