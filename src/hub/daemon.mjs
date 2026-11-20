// Daemon: single-instance loop that expires stale leases, heartbeats local workers, runs local
// tasks, accepts results and calls the scheduler. `dispatch daemon` calls runDaemon({ once }).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.mjs";
import { runScheduler } from "./scheduler.mjs";
import { runRunner } from "./runner.mjs";
import { runAccept } from "./accept.mjs";
import { runCleanup } from "./cleanup.mjs";

const LOCAL_KINDS = new Set(["zcode", "cli"]);

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

export function acquireDaemonLock(stateDir = config.stateDir) {
  const dir = join(stateDir, "hub-daemon.lock");
  mkdirSync(stateDir, { recursive: true });
  try {
    mkdirSync(dir); // atomic: fails if it exists
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    let owner = null;
    try {
      owner = JSON.parse(readFileSync(join(dir, "owner.json"), "utf8"));
    } catch {}
    if (owner?.pid && pidAlive(owner.pid)) throw new Error(`another dispatch daemon is running (pid ${owner.pid}): ${dir}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir);
  }
  writeFileSync(join(dir, "owner.json"), JSON.stringify({ pid: process.pid, at: Date.now() }));
  return dir;
}

export function releaseDaemonLock(dir) {
  rmSync(dir, { recursive: true, force: true });
}

export async function tick(hub, { adapters, runnerState = new Map(), schedState = {}, cleanupState = {}, schedulerCmd, stateDir = config.stateDir, dirs, log = () => {}, acceptor } = {}) {
  // Heartbeat first: after a daemon restart local workers' heartbeats are stale, and expiring
  // before refreshing them would requeue tasks whose ZCode sessions are still running.
  for (const w of await hub.workers()) {
    if (!LOCAL_KINDS.has(w.kind) || w.enabled === false) continue;
    const staleSec = Number(w.staleSec ?? process.env.HUB_STALE_SEC ?? 300);
    const onlineSec = Number(process.env.HUB_ONLINE_SEC ?? 180);
    // Each heartbeat makes an unreachable Git commit on the next update. One per minute
    // suffices by default; shorter stale/online windows shorten this interval too (per tick).
    const intervalMs = Math.min(60_000,
      (Number.isFinite(staleSec) && staleSec >= 0 ? staleSec : 300) * 1000 / 3,
      (Number.isFinite(onlineSec) && onlineSec >= 0 ? onlineSec : 180) * 1000 / 3);
    const age = Date.now() - w.lastSeen;
    if (!Number.isFinite(w.lastSeen) || age < 0 || age >= intervalMs) await hub.heartbeat(w.id);
  }
  const expired = await hub.expireStale();
  if (expired?.length) log(`expired: ${expired.join(", ")}`);
  await runRunner(hub, { adapters, state: runnerState, dirs: dirs ?? { stateDir }, log });
  // Acceptance can take many minutes (installs, typecheck): with an acceptor (its own hub clone, since
  // concurrent git work in one clone would clash) it runs in the background so the loop keeps going.
  if (!acceptor) await runAccept(hub, { log });
  else if (!acceptor.running)
    acceptor.running = runAccept(acceptor.hub, { log })
      .catch((e) => log(`accept failed: ${e?.stack ?? e}`))
      .finally(() => (acceptor.running = null));
  await runScheduler(hub, schedState, { cmd: schedulerCmd, stateDir, log });
  // Cleanup errors must not stop scheduling or heartbeats on the next tick.
  try {
    await runCleanup(hub, cleanupState, { adapters, runnerState, dirs: dirs ?? { stateDir }, log });
  } catch (e) {
    log(`cleanup failed: ${e.message}`);
  }
}

export async function runDaemon({
  once = false,
  hub,
  adapters,
  schedulerCmd,
  stateDir = config.stateDir,
  tickSec = Number(process.env.HUB_TICK_SEC ?? 10),
  dirs,
  log = (...a) => console.log("[dispatch-daemon]", ...a),
} = {}) {
  let acceptor = null;
  if (!hub) {
    const { Hub } = await import("./tasks.mjs"); // dynamic: tests inject a fake hub instead
    hub = new Hub({});
    await hub.init();
    acceptor = { hub: new Hub({ workdir: join(stateDir, "hub-accept") }), running: null };
    await acceptor.hub.init();
  }
  const lock = acquireDaemonLock(stateDir);
  const runnerState = new Map();
  const schedState = {};
  const cleanupState = {};
  const ctx = { adapters, runnerState, schedState, cleanupState, schedulerCmd, stateDir, dirs, log, acceptor };
  let ticks = 0;
  let stop = false;
  let wake = () => {};
  const onSig = () => {
    stop = true;
    wake(); // cut the inter-tick sleep short
  };
  process.on("SIGTERM", onSig);
  process.on("SIGINT", onSig);
  try {
    while (!stop) {
      const t0 = Date.now();
      try {
        await tick(hub, ctx);
        ticks++;
      } catch (e) {
        log(`tick failed: ${e?.stack ?? e}`);
      }
      if (once || stop) {
        if (once) await acceptor?.running; // --once means one full tick, acceptance included
        break;
      }
      await new Promise((r) => {
        const timer = setTimeout(r, Math.max(0, tickSec * 1000 - (Date.now() - t0)));
        wake = () => (clearTimeout(timer), r());
      });
    }
  } finally {
    process.off("SIGTERM", onSig);
    process.off("SIGINT", onSig);
    releaseDaemonLock(lock);
  }
  return { ticks };
}
