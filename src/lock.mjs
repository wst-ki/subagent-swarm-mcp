// Cross-process mutex for UI automation. Several MCP servers (Claude Code, Codex, ...) may run
// at once but ZCode has a single window, so submissions / cancellations must be serialized.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sleep } from "./cdp.mjs";
import { paths } from "./config.mjs";

const STALE_MS = 120_000;
const INIT_GRACE_MS = 5_000;

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

export async function withUiLock(fn, { timeout = 180_000 } = {}) {
  const dir = paths.uiLock;
  mkdirSync(dirname(dir), { recursive: true });
  const end = Date.now() + timeout;
  for (;;) {
    try {
      mkdirSync(dir); // atomic: fails if it exists
      writeFileSync(dir + "/owner.json", JSON.stringify({ pid: process.pid, at: Date.now() }));
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (isStale(dir)) {
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > end) throw new Error("Timed out waiting for another ZCode UI operation to finish.");
      await sleep(250);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
