import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const OWNER_FILE = ".tetherplane-acceptance-owner.json";
const OWNER_KIND = "tetherplane-live-acceptance-v1";

export function acceptanceRootPath(localAppData, release) {
  if (typeof localAppData !== "string" || localAppData.trim() === "") {
    throw new Error("LOCALAPPDATA is required for the acceptance root");
  }
  if (typeof release !== "string" || !/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9][A-Za-z0-9.-]*)?$/.test(release)) {
    throw new Error("invalid live-acceptance release identifier");
  }
  return path.join(path.resolve(localAppData), "Tetherplane", "live-acceptance", release);
}

function assertNoRedirectedParents(localAppData, release) {
  const root = acceptanceRootPath(localAppData, release);
  const base = path.resolve(localAppData);
  for (const directory of [
    path.join(base, "Tetherplane"),
    path.join(base, "Tetherplane", "live-acceptance"),
  ]) {
    const info = lstatSync(directory, { throwIfNoEntry: false });
    if (info?.isSymbolicLink()) {
      throw new Error("acceptance parent is a symbolic link or reparse point");
    }
    if (info && !info.isDirectory()) {
      throw new Error("acceptance parent is not a normal directory");
    }
  }
  const current = lstatSync(root, { throwIfNoEntry: false });
  if (current?.isSymbolicLink()) {
    throw new Error("acceptance root is a symbolic link or reparse point");
  }
  return root;
}

export function assertFreshAcceptanceRoot(localAppData, release) {
  const root = assertNoRedirectedParents(localAppData, release);
  if (lstatSync(root, { throwIfNoEntry: false })) {
    throw new Error("acceptance root already exists; inspect it and use explicit guarded cleanup, never overwrite");
  }
  return root;
}

export function writeAcceptanceOwnership(root, release) {
  const info = lstatSync(root, { throwIfNoEntry: false });
  if (!info || !info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("cannot record ownership of a missing or redirected acceptance directory");
  }
  writeFileSync(
    path.join(root, OWNER_FILE),
    JSON.stringify({ kind: OWNER_KIND, release, root: path.resolve(root) }) + "\n",
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
}

export function assertOwnedAcceptanceRoot(localAppData, release) {
  const root = assertNoRedirectedParents(localAppData, release);
  const info = lstatSync(root, { throwIfNoEntry: false });
  if (!info || !info.isDirectory()) {
    throw new Error("acceptance ownership receipt unavailable: root is not a directory");
  }
  for (const name of ["package", "install", "state", "allowed"]) {
    const nested = lstatSync(path.join(root, name), { throwIfNoEntry: false });
    if (nested?.isSymbolicLink()) {
      throw new Error("acceptance content is a symbolic link or reparse point: " + name);
    }
    if (nested && !nested.isDirectory()) {
      throw new Error("acceptance content is not a normal directory: " + name);
    }
  }
  const receiptPath = path.join(root, OWNER_FILE);
  const receiptInfo = lstatSync(receiptPath, { throwIfNoEntry: false });
  if (!receiptInfo || !receiptInfo.isFile() || receiptInfo.isSymbolicLink()) {
    throw new Error("acceptance ownership receipt missing or redirected");
  }
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  } catch {
    throw new Error("acceptance ownership receipt invalid");
  }
  if (
    receipt?.kind !== OWNER_KIND ||
    receipt?.release !== release ||
    receipt?.root !== path.resolve(root)
  ) {
    throw new Error("acceptance ownership receipt does not match this release and root");
  }
  return root;
}
