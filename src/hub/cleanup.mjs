// Reclaim disposable local task checkouts; hub records and result/* remain untouched.
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.mjs";
import { removeCheckout } from "./checkout.mjs";

const TERMINAL = new Set(["accepted", "rejected", "failed", "cancelled"]);
const ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const DAY_MS = 86_400_000;

export function cleanupPolicy(env = process.env) {
  const days = Number(env.HUB_WORK_RETENTION_DAYS ?? 3);
  const intervalSec = Number(env.HUB_CLEANUP_INTERVAL_SEC ?? 3600);
  const successHours = Number(env.HUB_SUCCESS_RETENTION_HOURS ?? 1);
  if (!Number.isFinite(days) || days < 0) throw new Error("HUB_WORK_RETENTION_DAYS must be a non-negative number (0 disables cleanup)");
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) throw new Error("HUB_CLEANUP_INTERVAL_SEC must be a positive number");
  if (!Number.isFinite(successHours) || successHours < 0) throw new Error("HUB_SUCCESS_RETENTION_HOURS must be a non-negative number");
  return { days, intervalSec, successHours };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== "ESRCH"; // uncertainty must preserve the checkout
  }
}

async function idle(hub, id, adapters) {
  const run = (await hub.readTaskFile(id, "run"))?.trim();
  if (!run) return true; // task never launched
  if (/^pid:[1-9]\d*$/.test(run)) {
    const pid = Number(run.slice(4));
    return Number.isSafeInteger(pid) && !alive(pid) && !alive(-pid);
  }
  if (run.startsWith("zcode:")) {
    const status = adapters?.zcode?.taskStatus
      ? await adapters.zcode.taskStatus(run.slice(6).trim())
      : await import("../store.mjs").then((m) => m.taskStatus(run.slice(6).trim()));
    return ["completed", "failed", "cancelled"].includes(status?.status);
  }
  return false;
}

// Call under the daemon lock (the CLI uses the same lock). No recursive search, no orphan
// deletion: only direct, non-symlink directories belonging to known terminal hub tasks.
export async function cleanupWorkdirs(hub, {
  dirs = {}, runnerState = new Map(), adapters, days = cleanupPolicy().days,
  successHours = cleanupPolicy().successHours, now = Date.now(), dryRun = true, log = () => {},
} = {}) {
  if (!Number.isFinite(days) || days < 0) throw new Error("retention days must be non-negative");
  if (!Number.isFinite(successHours) || successHours < 0) throw new Error("success retention hours must be non-negative");
  const out = { dryRun, candidates: [], removed: [], errors: [] };
  if (days === 0) return out;
  const d = { stateDir: config.stateDir, zcodeProjectDir: config.projectDir, ...dirs };
  const tasks = new Map((await hub.list()).map((t) => [t.id, t]));
  const retentionMs = (t) => t.state === "accepted" ? Math.min(days * DAY_MS, successHours * 3_600_000) : days * DAY_MS;
  const eligible = (t) => t && TERMINAL.has(t.state) && Number.isFinite(t.updatedAt) && t.updatedAt > 0 && now - t.updatedAt >= retentionMs(t);
  for (const root of new Set([join(d.stateDir, "work"), join(d.zcodeProjectDir, "hub")])) {
    let entries;
    try {
      const st = await lstat(root);
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      entries = await readdir(root, { withFileTypes: true });
    } catch (e) {
      if (e.code === "ENOENT") continue;
      out.errors.push({ path: root, error: e.message });
      continue;
    }
    for (const entry of entries) {
      const id = entry.name;
      if (!entry.isDirectory() || !ID_RE.test(id) || runnerState.has(id) || !eligible(tasks.get(id))) continue;
      const path = join(root, id);
      try {
        if (!(await idle(hub, id, adapters))) continue;
        // Refresh after the worker check: it may take time, and the master can requeue tasks.
        const current = await hub.get(id);
        if (!eligible(current)) continue;
        const st = await lstat(path);
        if (!st.isDirectory() || st.isSymbolicLink()) continue;
        out.candidates.push(path);
        if (dryRun) continue;
        await removeCheckout(path);
        out.removed.push(path);
        log(`cleanup removed ${path} (${current.state}, retention ${retentionMs(current) / 3_600_000} hours)`);
      } catch (e) {
        out.errors.push({ path, error: e.message });
      }
    }
  }
  for (const e of out.errors) log(`cleanup ${e.path}: ${e.error}`);
  return out;
}

export async function runCleanup(hub, state, options = {}) {
  const { days, intervalSec } = cleanupPolicy();
  const now = options.now ?? Date.now();
  if (days === 0 || (state.lastRun != null && now - state.lastRun < intervalSec * 1000)) return null;
  state.lastRun = now;
  return cleanupWorkdirs(hub, { ...options, days, now, dryRun: false });
}
