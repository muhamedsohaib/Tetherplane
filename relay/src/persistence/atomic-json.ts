import { randomUUID } from "node:crypto";
import { mkdir, rename as fsRename, unlink as fsUnlink, writeFile as fsWriteFile } from "node:fs/promises";
import path from "node:path";

export type PersistFileOps = {
  mkdir?: (
    dirPath: string,
    options?: { recursive?: boolean },
  ) => Promise<unknown>;
  writeFile?: (
    filePath: string,
    data: string,
    options?: { encoding?: BufferEncoding; mode?: number },
  ) => Promise<void>;
  rename?: (oldPath: string, newPath: string) => Promise<void>;
  unlink?: (filePath: string) => Promise<void>;
};

const TRANSIENT_RENAME_ERROR_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, 120, 160];

export function errorCodeOf(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

export async function renameWithWindowsRetry(
  renameFn: (oldPath: string, newPath: string) => Promise<void>,
  oldPath: string,
  newPath: string,
  delaysMs: readonly number[] = RENAME_RETRY_DELAYS_MS,
): Promise<void> {
  let attempt = 0;
  for (;;) {
    try {
      await renameFn(oldPath, newPath);
      return;
    } catch (error) {
      const code = errorCodeOf(error);
      if (
        !code ||
        !TRANSIENT_RENAME_ERROR_CODES.has(code) ||
        attempt >= delaysMs.length
      ) {
        throw error;
      }
      const delayMs = delaysMs[attempt++]!;
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export async function unlinkWithWindowsRetry(
  unlinkFn: (filePath: string) => Promise<void>,
  filePath: string,
  delaysMs: readonly number[] = RENAME_RETRY_DELAYS_MS,
): Promise<void> {
  let attempt = 0;
  for (;;) {
    try {
      await unlinkFn(filePath);
      return;
    } catch (error) {
      const code = errorCodeOf(error);
      if (
        code === "ENOENT" ||
        !code ||
        !TRANSIENT_RENAME_ERROR_CODES.has(code) ||
        attempt >= delaysMs.length
      ) {
        return;
      }
      const delayMs = delaysMs[attempt++]!;
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export class SerializedJsonFileWriter {
  readonly #filePath: string;
  readonly #mkdirFn: (
    dirPath: string,
    options?: { recursive?: boolean },
  ) => Promise<unknown>;
  readonly #writeFn: (
    filePath: string,
    data: string,
    options?: { encoding?: BufferEncoding; mode?: number },
  ) => Promise<void>;
  readonly #renameFn: (oldPath: string, newPath: string) => Promise<void>;
  readonly #unlinkFn: (filePath: string) => Promise<void>;

  #tail: Promise<void> = Promise.resolve();
  #requestSeq = 0;
  #flushedSeq = 0;
  #latestSerialize: (() => string) | null = null;

  constructor(
    filePath: string,
    ops?: PersistFileOps,
  ) {
    this.#filePath = filePath;
    this.#mkdirFn = ops?.mkdir ?? mkdir;
    this.#writeFn = ops?.writeFile ?? fsWriteFile;
    this.#renameFn = ops?.rename ?? fsRename;
    this.#unlinkFn = ops?.unlink ?? fsUnlink;
  }

  write(serialize: () => string): Promise<void> {
    this.#latestSerialize = serialize;
    const targetSeq = ++this.#requestSeq;
    const run = this.#tail.then(() => this.#flushIfNeeded(targetSeq));
    this.#tail = run.catch(() => {});
    return run;
  }

  async flush(): Promise<void> {
    for (;;) {
      const current = this.#tail;
      await current;
      if (this.#tail === current) return;
    }
  }

  async #flushIfNeeded(targetSeq: number): Promise<void> {
    if (this.#flushedSeq >= targetSeq) return;
    const serialize = this.#latestSerialize;
    if (!serialize) return;
    const capturedSeq = this.#requestSeq;
    const content = serialize();
    const temporary = `${this.#filePath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await this.#mkdirFn(path.dirname(this.#filePath), { recursive: true });
      await this.#writeFn(temporary, content, {
        encoding: "utf8",
        mode: 0o600,
      });
      await renameWithWindowsRetry(
        this.#renameFn,
        temporary,
        this.#filePath,
      );
      this.#flushedSeq = Math.max(this.#flushedSeq, capturedSeq);
    } catch (error) {
      await unlinkWithWindowsRetry(this.#unlinkFn, temporary);
      throw error;
    }
  }
}
