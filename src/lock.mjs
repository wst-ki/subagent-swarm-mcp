// Cross-process mutex for UI automation. Several MCP servers (Claude Code, Codex, ...) may run
// at once but ZCode has a single window, so submissions / cancellations must be serialized.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sleep } from "./cdp.mjs";
import { paths } from "./config.mjs";

const STALE_MS = 120_000;
const INIT_GRACE_MS = 5_000;

export class UiLockAbortedError extends Error {
  constructor(message = "Aborted while waiting for ZCode UI lock.") {
    super(message);
    this.name = "UiLockAbortedError";
    this.abortedByBlocker = true;
  }
}

export function isStale(dir, now = Date.now()) {
  try {
    const { pid, at } = JSON.parse(readFileSync(dir + "/owner.json", "utf8"));
    if (!Number.isInteger(pid) || pid <= 0) return true;
    try {
      process.kill(pid, 0);
      return false; // owner PID is still alive (even if >120s)
    } catch (e) {
      if (e.code === "EPERM") return false; // process exists, owned by another user
      if (e.code === "ESRCH") return true; // process is dead
      return now - (Number(at) || 0) > STALE_MS;
    }
  } catch {
    try {
      const mtimeMs = statSync(dir).mtimeMs;
      return now - mtimeMs > INIT_GRACE_MS; // allow brief grace period while owner.json is being written
    } catch {
      return true;
    }
  }
}

export async function withUiLock(fn, { timeout = 180_000, shouldAbort = null, lockDir = paths.uiLock, pollMs = 250 } = {}) {
  const dir = lockDir;
  const token = randomBytes(8).toString("hex");
  mkdirSync(dirname(dir), { recursive: true });
  const end = Date.now() + timeout;
  for (;;) {
    if (typeof shouldAbort === "function" && shouldAbort()) {
      throw new UiLockAbortedError();
    }
    try {
      mkdirSync(dir); // atomic: fails if it exists
      try {
        writeFileSync(dir + "/owner.json", JSON.stringify({ pid: process.pid, token, at: Date.now() }));
      } catch (writeErr) {
        rmSync(dir, { recursive: true, force: true });
        throw writeErr;
      }
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (isStale(dir)) {
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > end) throw new Error("Timed out waiting for another ZCode UI operation to finish.");
      await sleep(pollMs);
    }
  }
  try {
    if (typeof shouldAbort === "function" && shouldAbort()) {
      throw new UiLockAbortedError();
    }
    return await fn();
  } finally {
    try {
      const owner = JSON.parse(readFileSync(dir + "/owner.json", "utf8"));
      if (owner?.token === token && owner?.pid === process.pid) {
        rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // Lock directory already removed or superseded by another owner.
    }
  }
}
