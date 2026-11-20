import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { cleanupPolicy, cleanupWorkdirs, runCleanup } from "../src/hub/cleanup.mjs";
import { FakeHub } from "./helpers/fake-hub.mjs";

const DAY = 86_400_000;
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "hub-cleanup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dirs = { stateDir: join(root, "state"), zcodeProjectDir: join(root, "project") };
  const roots = [join(dirs.stateDir, "work"), join(dirs.zcodeProjectDir, "hub")];
  for (const dir of roots) mkdirSync(dir, { recursive: true });
  const hub = new FakeHub();
  const now = Date.now();
  async function task(state, age = 4 * DAY) {
    const t = await hub.post({ kind: "text" }, "instructions");
    await hub.transition(t.id, { to: state });
    hub.tasks.get(t.id).updatedAt = now - age;
    for (const dir of roots) {
      mkdirSync(join(dir, t.id));
      writeFileSync(join(dir, t.id, "REPORT.md"), "local report");
    }
    return t.id;
  }
  return { root, dirs, roots, hub, now, task };
}

test("cleanup previews and removes only expired terminal task checkouts; records survive", async (t) => {
  const { hub, dirs, roots, now, task } = fixture(t);
  const expired = [];
  const kept = [];
  for (const state of ["accepted", "rejected", "failed", "cancelled"]) expired.push(await task(state));
  for (const state of ["queued", "assigned", "running", "done", "need-info"]) kept.push(await task(state));
  kept.push(await task("accepted", 30 * 60_000));
  const id = expired[0];
  await hub.transition(id, { files: { "result/report.md": "saved report", "result/patch.diff": "saved patch" } });
  hub.tasks.get(id).updatedAt = now - 4 * DAY;
  const preview = await cleanupWorkdirs(hub, { dirs, now });
  assert.equal(preview.candidates.length, expired.length * 2);
  assert.deepEqual(preview.removed, []);
  for (const root of roots) for (const id of [...expired, ...kept]) assert.ok(existsSync(join(root, id)));
  const result = await cleanupWorkdirs(hub, { dirs, now, dryRun: false });
  assert.equal(result.removed.length, expired.length * 2);
  assert.deepEqual(result.errors, []);
  for (const root of roots) {
    for (const id of expired) assert.ok(!existsSync(join(root, id)));
    for (const id of kept) assert.ok(existsSync(join(root, id)));
  }
  assert.equal(await hub.readTaskFile(id, "result/report.md"), "saved report");
  assert.equal(await hub.readTaskFile(id, "result/patch.diff"), "saved patch");
  assert.equal((await hub.get(id)).state, "accepted");
});

test("cleanup preserves orphans, symlinks, tracked runs and uncertain/live workers", async (t) => {
  const { hub, dirs, roots, now, task, root } = fixture(t);
  const tracked = await task("cancelled");
  const cli = await task("cancelled");
  const zcode = await task("accepted");
  const unknown = await task("failed");
  const linked = await task("accepted");
  const invalidTime = await task("accepted");
  hub.tasks.get(invalidTime).updatedAt = NaN;
  await hub.transition(cli, { files: { run: `pid:${process.pid}` } });
  await hub.transition(zcode, { files: { run: "zcode:live" } });
  await hub.transition(unknown, { files: { run: "zcode:missing" } });
  for (const id of [cli, zcode, unknown]) hub.tasks.get(id).updatedAt = now - 4 * DAY;
  const outside = join(root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep"), "important");
  for (const dir of roots) {
    mkdirSync(join(dir, "orphan"));
    rmSync(join(dir, linked), { recursive: true });
    symlinkSync(outside, join(dir, linked));
  }
  const result = await cleanupWorkdirs(hub, {
    dirs, now, dryRun: false, runnerState: new Map([[tracked, {}]]),
    adapters: { zcode: { taskStatus: async (sid) => ({ status: sid === "live" ? "running" : "unknown" }) } },
  });
  assert.deepEqual(result.removed, []);
  assert.equal(readFileSync(join(outside, "keep"), "utf8"), "important");
  for (const dir of roots) for (const id of [tracked, cli, zcode, unknown, linked, invalidTime, "orphan"]) assert.ok(existsSync(join(dir, id)));
});

test("cleanup refreshes state, handles worker errors and deletes a completed ZCode checkout", async (t) => {
  const { hub, dirs, roots, now, task } = fixture(t);
  const requeued = await task("accepted");
  const broken = await task("accepted");
  const finished = await task("accepted");
  for (const id of [broken, finished]) {
    await hub.transition(id, { files: { run: `zcode:${id}` } });
    hub.tasks.get(id).updatedAt = now - 4 * DAY;
  }
  const get = hub.get.bind(hub);
  hub.get = async (id) => {
    if (id === requeued) hub.tasks.get(id).state = "queued";
    return get(id);
  };
  const result = await cleanupWorkdirs(hub, {
    dirs, now, dryRun: false,
    adapters: { zcode: { taskStatus: async (sid) => {
      if (sid === broken) throw new Error("store unavailable");
      return { status: "completed" };
    } } },
  });
  assert.equal(result.errors.length, 2);
  assert.equal(result.removed.length, 2);
  for (const root of roots) {
    assert.ok(existsSync(join(root, requeued)));
    assert.ok(existsSync(join(root, broken)));
    assert.ok(!existsSync(join(root, finished)));
  }
});

test("cleanup refuses a symlink root", async (t) => {
  const { hub, dirs, roots, now, task, root } = fixture(t);
  const id = await task("accepted");
  const moved = join(root, "moved");
  const { renameSync } = await import("node:fs");
  renameSync(roots[0], moved);
  symlinkSync(moved, roots[0]);
  await cleanupWorkdirs(hub, { dirs, now, dryRun: false });
  assert.ok(existsSync(join(moved, id)));
});

test("cleanup policy validates values, disables deletion and throttles periodic runs", async (t) => {
  assert.deepEqual(cleanupPolicy({}), { days: 3, intervalSec: 3600, successHours: 1 });
  for (const value of ["NaN", "-1", "Infinity"]) assert.throws(() => cleanupPolicy({ HUB_WORK_RETENTION_DAYS: value }));
  for (const value of ["0", "-1", "NaN"]) assert.throws(() => cleanupPolicy({ HUB_CLEANUP_INTERVAL_SEC: value }));
  for (const value of ["-1", "NaN", "Infinity"]) assert.throws(() => cleanupPolicy({ HUB_SUCCESS_RETENTION_HOURS: value }));
  const keys = ["HUB_WORK_RETENTION_DAYS", "HUB_CLEANUP_INTERVAL_SEC"];
  const previous = keys.map((key) => process.env[key]);
  t.after(() => keys.forEach((key, i) => {
    if (previous[i] === undefined) delete process.env[key];
    else process.env[key] = previous[i];
  }));
  process.env.HUB_WORK_RETENTION_DAYS = "3";
  process.env.HUB_CLEANUP_INTERVAL_SEC = "3600";
  const { hub, dirs, now, task, roots } = fixture(t);
  const id = await task("accepted");
  assert.deepEqual((await cleanupWorkdirs(hub, { dirs, now, days: 0, dryRun: false })).removed, []);
  const state = {};
  assert.equal((await runCleanup(hub, state, { dirs, now })).removed.length, 2);
  const next = await task("accepted");
  assert.equal(await runCleanup(hub, state, { dirs, now: now + 1000 }), null);
  assert.ok(existsSync(join(roots[0], next)));
  assert.equal((await runCleanup(hub, state, { dirs, now: now + 3_600_000 })).removed.length, 2);
  assert.ok(!existsSync(join(roots[0], id)));
  process.env.HUB_WORK_RETENTION_DAYS = "0";
  assert.equal(await runCleanup(hub, {}, { dirs, now }), null);
});

test("dispatch cleanup uses the real hub, previews by default and shares the daemon lock", async (t) => {
  const { Hub } = await import("../src/hub/tasks.mjs");
  const { acquireDaemonLock, releaseDaemonLock } = await import("../src/hub/daemon.mjs");
  const { root, dirs, roots } = fixture(t);
  const hub = new Hub({ remote: join(root, "hub.git"), workdir: join(root, "hub") });
  await hub.init();
  const task = await hub.post({ kind: "text" }, "instructions");
  await hub.transition(task.id, { to: "accepted", files: { "result/report.md": "saved result" }, message: "accept test task" });
  for (const dir of roots) mkdirSync(join(dir, task.id));
  const env = {
    ...process.env, HUB_REMOTE: hub.repo.remote, HUB_WORKDIR: hub.workdir,
    ZCODE_MCP_STATE_DIR: dirs.stateDir, ZCODE_MCP_PROJECT_DIR: dirs.zcodeProjectDir,
    HUB_WORK_RETENTION_DAYS: "0.00000001",
  };
  const cli = fileURLToPath(new URL("../bin/dispatch.mjs", import.meta.url));
  const exec = promisify(execFile);
  const preview = JSON.parse((await exec(process.execPath, [cli, "cleanup"], { env })).stdout);
  assert.equal(preview.dryRun, true);
  assert.equal(preview.candidates.length, 2);
  for (const dir of roots) assert.ok(existsSync(join(dir, task.id)));
  const lock = acquireDaemonLock(dirs.stateDir);
  try {
    await assert.rejects(exec(process.execPath, [cli, "cleanup", "--apply"], { env }), /another dispatch daemon is running/);
  } finally {
    releaseDaemonLock(lock);
  }
  const result = JSON.parse((await exec(process.execPath, [cli, "cleanup", "--apply"], { env })).stdout);
  assert.equal(result.removed.length, 2);
  assert.deepEqual(result.errors, []);
  for (const dir of roots) assert.ok(!existsSync(join(dir, task.id)));
  assert.equal(await hub.readTaskFile(task.id, "result/report.md"), "saved result");
});
