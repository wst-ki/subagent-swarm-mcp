// Shared CLI pipe-flush, atomic JSON output, and transient filesystem read retry helpers.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sleep } from "./cdp.mjs";

const TRANSIENT_READ_CODES = new Set(["ENOENT", "EAGAIN", "EBUSY", "ESTALE", "EIO", "EMFILE"]);

/**
 * Write text to a Node stream (stdout/stderr) and resolve only after both the write
 * callback and any backpressure 'drain' event complete. Prevents >64 KiB pipe truncation
 * when callers immediately exit under piped (non-TTY) stdio.
 */
export function writeStreamAndDrain(stream, text) {
  const payload = String(text ?? "");
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let drained = false;
    let cbDone = false;

    const cleanup = () => {
      stream.off("error", onError);
      stream.off("drain", onDrain);
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise();
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err?.code === "EPIPE") resolvePromise();
      else rejectPromise(err);
    };

    const tryFinish = () => {
      if (drained && cbDone) finish();
    };

    const onError = (err) => fail(err);
    const onDrain = () => {
      drained = true;
      tryFinish();
    };

    stream.on("error", onError);

    let ok;
    try {
      ok = stream.write(payload, "utf8", (err) => {
        if (err) return fail(err);
        cbDone = true;
        tryFinish();
      });
    } catch (err) {
      return fail(err);
    }

    if (ok) {
      drained = true;
      tryFinish();
    } else {
      stream.once("drain", onDrain);
    }
  });
}

/** Flush a stream completely before exiting the process. */
export async function exitAfterFlush(stream, text, code = 0) {
  try {
    await writeStreamAndDrain(stream, text);
  } catch {
    // Ignore broken pipe errors when downstream reader closes early
  }
  process.exit(code);
}

/** Atomically write formatted JSON to filePath via a PID-scoped temp file + rename. */
export function writeJsonFileAtomic(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  renameSync(tmp, filePath);
}

/**
 * Read a UTF-8 file with exponential backoff retry on transient SMB/NAS lookup or lock errors
 * (`ENOENT`, `EAGAIN`, `EBUSY`, `ESTALE`, `EIO`, `EMFILE`).
 */
export async function readTextFileWithRetry(
  filePath,
  { retries = 3, baseDelayMs = 150, readFn = (p) => readFileSync(p, "utf8"), sleeper = sleep } = {},
) {
  for (let attempt = 1; ; attempt++) {
    try {
      return readFn(filePath);
    } catch (err) {
      if (!TRANSIENT_READ_CODES.has(err?.code) || attempt > retries) throw err;
      await sleeper(baseDelayMs * 2 ** (attempt - 1));
    }
  }
}
