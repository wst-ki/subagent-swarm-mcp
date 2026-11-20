import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHub } from "./helpers/fake-hub.mjs";
import {
  buildSnapshot,
  loadCooldowns,
  parseAgyOutput,
  rulesAssign,
  runScheduler,
  setCooldown,
  validateProposals,
} from "../src/hub/scheduler.mjs";

const WORKERS = [
  { id: "local-zcode", kind: "zcode", host: "local", vendor: "zhipu", model: "GLM-5.3", tier: "high", maxParallel: 2, costRank: 1 },
  { id: "local-codex", kind: "cli", host: "local", vendor: "openai", model: "gpt-6.1", tier: "high", maxParallel: 1, costRank: 2, cmd: ["codex"] },
  { id: "remote-codex", kind: "manual", host: "remote", vendor: "openai", tier: "high", maxParallel: 1, costRank: 2 },
  { id: "local-off", kind: "zcode", host: "local", vendor: "zhipu", tier: "low", maxParallel: 1, costRank: 1, enabled: false },
];

function sh(dir, name, body) {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

function tmp() {
  return mkdtempSync(join(tmpdir(), "hub-sched-"));
}

test("buildSnapshot: queued tasks only, disabled workers dropped, parentVendor resolved", async () => {
  const hub = new FakeHub({ workers: WORKERS });
  const parent = await hub.post({ title: "impl", kind: "code" }, "b");
  await hub.assign(parent.id, "local-zcode", "r");
  const review = await hub.post({ title: "rev", kind: "review", parent: parent.id }, "b");
  await hub.post({ title: "plain", kind: "code" }, "b");

  const snap = buildSnapshot(await hub.list(), await hub.workers());
  assert.deepEqual(snap.workers.map((w) => w.id), ["local-zcode", "local-codex", "remote-codex"]);
  assert.equal(snap.queued.length, 2);
  const rev = snap.queued.find((q) => q.id === review.id);
  assert.equal(rev.parentVendor, "zhipu");
  assert.equal(rev.kind, "review");
  assert.equal(snap.queued.find((q) => q.id === parent.id), undefined);
});

test("parseAgyOutput reads structured_output and falls back to response text", () => {
  const a = parseAgyOutput(JSON.stringify({ status: "SUCCESS", response: "nope", structured_output: { assignments: [{ task: "T1", worker: "w", reason: "x" }] } }));
  assert.equal(a.length, 1);
  assert.equal(a[0].task, "T1");
  const b = parseAgyOutput(JSON.stringify({ status: "SUCCESS", structured_output: null, response: 'Here:\n{"assignments":[{"task":"T2","worker":"w2"}]}' }));
  assert.equal(b[0].task, "T2");
  assert.equal(parseAgyOutput("not json"), null);
  assert.equal(parseAgyOutput(JSON.stringify({ status: "SUCCESS", response: "nothing here" })), null);
  assert.deepEqual(parseAgyOutput(JSON.stringify({ structured_output: { assignments: [{ task: "T3" }, { task: "T4", worker: "w" }] } })), [{ task: "T4", worker: "w" }]);
});

test("validateProposals enforces every hard constraint", async () => {
  const hub = new FakeHub({ workers: WORKERS });
  const t1 = await hub.post({ title: "c", kind: "code", tier: "high" }, "b");
  const t2 = await hub.post({ title: "c2", kind: "code" }, "b");
  await hub.assign(t2.id, "local-codex", "x");
  const t3 = await hub.post({ title: "t", kind: "text" }, "b");
  const t4 = await hub.post({ title: "c3", kind: "code", avoidVendors: ["zhipu"] }, "b");
  const parent = await hub.post({ title: "p", kind: "code" }, "b");
  await hub.assign(parent.id, "local-zcode", "x");
  const rev = await hub.post({ title: "rev", kind: "review", parent: parent.id }, "b");

  const tasks = await hub.list();
  const workers = await hub.workers();
  const { valid, dropped } = validateProposals(
    [
      { task: rev.id, worker: "local-zcode", reason: "r" },
      { task: t1.id, worker: "local-zcode", reason: "r1" },
      { task: t1.id, worker: "local-codex", reason: "dup" },
      { task: t1.id, worker: "local-off", reason: "r" },
      { task: t4.id, worker: "local-zcode", reason: "r" },
      { task: t4.id, worker: "local-codex", reason: "r" },
      { task: t3.id, worker: "remote-codex", reason: "r" },
      { task: t3.id, worker: "ghost", reason: "r" },
      { task: t2.id, worker: "local-zcode", reason: "r" },
    ],
    { tasks, workers },
  );
  assert.deepEqual(valid, [{ task: t1.id, worker: "local-zcode", reason: "r1" }]);
  assert.deepEqual(dropped.map((d) => d.why), [
    "reviewer vendor matches implementer vendor",
    "task already assigned this round",
    "worker disabled",
    "vendor zhipu is avoided for this task",
    "worker has no free slot",
    "manual worker offline",
    "unknown worker",
    "task is not queued",
  ]);

  await hub.heartbeat("remote-codex");
  const online = validateProposals([{ task: t3.id, worker: "remote-codex" }], { tasks: await hub.list(), workers: await hub.workers() });
  assert.equal(online.valid.length, 1);

  const dir = tmp();
  setCooldown(dir, "remote-codex", Date.now() + 60_000);
  const cooling = validateProposals([{ task: t3.id, worker: "remote-codex" }], { tasks, workers: await hub.workers(), cooldowns: loadCooldowns(dir) });
  assert.equal(cooling.valid.length, 0);
  assert.equal(cooling.dropped[0].why, "worker cooling down");
  rmSync(dir, { recursive: true, force: true });
});

test("rulesAssign: preferWorkers, tier sufficiency, fewest busy, lowest costRank", () => {
  const task = (spec) => ({ id: "T1", state: "queued", attempts: 0, spec: { kind: "code", tier: "mid", ...spec } });
  const w = (id, extra) => ({ id, kind: "zcode", vendor: "zhipu", enabled: true, kinds: ["code"], online: true, ...extra });

  const pref = w("w-preferred", { tier: "low", costRank: 9 });
  const cheap = w("w-cheap", { tier: "mid", costRank: 1 });
  const open = w("w-open", { kind: "cli", vendor: "openai", tier: "high", costRank: 2 });
  let r = rulesAssign([task({ preferWorkers: ["w-preferred"], tier: "high" })], [pref, cheap, open]);
  assert.equal(r[0].worker, "w-preferred");

  r = rulesAssign([task({})], [pref, { ...cheap, busy: 1 }, open]);
  assert.equal(r[0].worker, "w-open"); // tier-sufficient and idle beats the busy cheap one

  r = rulesAssign([task({})], [w("w-a", { tier: "mid", costRank: 3 }), w("w-b", { tier: "mid", costRank: 1 })]);
  assert.equal(r[0].worker, "w-b");

  const parentTask = { id: "P1", state: "assigned", assignee: "w-z", spec: {}, attempts: 0 };
  r = rulesAssign([task({ kind: "review", parent: "P1" }), parentTask], [
    w("w-z", { tier: "high", costRank: 1, kinds: ["code", "review"] }),
    w("w-o", { vendor: "openai", tier: "high", costRank: 2, kinds: ["code", "review"] }),
  ]);
  assert.equal(r[0].worker, "w-o");
  assert.deepEqual(rulesAssign([task({})], []), []);
});

test("runScheduler assigns via the scheduler command, prompt delivered on stdin", async () => {
  const dir = tmp();
  try {
    const hub = new FakeHub({ workers: WORKERS.slice(0, 2) });
    const task = await hub.post({ title: "job", kind: "code" }, "do it");
    const stdinFile = join(dir, "prompt.txt");
    const cmd = sh(
      dir,
      "agy.sh",
      `cat > ${stdinFile}\necho '{"status":"SUCCESS","response":"ok","structured_output":{"assignments":[{"task":"${task.id}","worker":"local-zcode","reason":"cheap and idle"}]}}'`,
    );
    const res = await runScheduler(hub, {}, { cmd, stateDir: dir, log: () => {} });
    assert.equal(res.assigned.length, 1);
    const after = await hub.get(task.id);
    assert.equal(after.state, "assigned");
    assert.equal(after.assignee, "local-zcode");
    assert.equal(after.note, "cheap and idle");
    const prompt = readFileSync(stdinFile, "utf8");
    assert.ok(prompt.includes(task.id));
    assert.ok(prompt.includes('"queued"'));
    assert.ok(prompt.includes("Scheduling policy"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runScheduler skips the call when nothing is queued, no worker is eligible, or within the interval", async () => {
  const dir = tmp();
  try {
    const marker = join(dir, "called");
    const cmd = sh(dir, "agy.sh", `touch ${marker}\necho '{"structured_output":{"assignments":[]}}'`);
    const hub = new FakeHub({ workers: WORKERS.slice(0, 1) });

    assert.deepEqual(await runScheduler(hub, {}, { cmd, stateDir: dir, log: () => {} }), { skipped: "nothing queued" });
    assert.ok(!existsSync(marker));

    // cooldown keeps the only worker ineligible
    setCooldown(dir, "local-zcode", Date.now() + 60_000);
    const task = await hub.post({ title: "j", kind: "code" }, "b");
    assert.deepEqual(await runScheduler(hub, {}, { cmd, stateDir: dir, log: () => {} }), { skipped: "no eligible worker with a free slot" });
    assert.ok(!existsSync(marker));

    rmSync(join(dir, "hub-cooldown.json"));
    const state = {};
    const r1 = await runScheduler(hub, state, { cmd, stateDir: dir, log: () => {} });
    assert.equal(r1.assigned.length, 0);
    assert.ok(existsSync(marker));
    rmSync(marker);
    assert.deepEqual(await runScheduler(hub, state, { cmd, stateDir: dir, log: () => {} }), { skipped: "interval" });
    assert.ok(!existsSync(marker));
    assert.equal((await hub.get(task.id)).state, "queued");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two consecutive scheduler failures fall back to rules; HUB_SCHEDULER=rules never calls agy", async () => {
  const dir = tmp();
  try {
    const hub = new FakeHub({ workers: WORKERS.slice(0, 1) });
    const task = await hub.post({ title: "j", kind: "code" }, "b");
    const bad = sh(dir, "bad.sh", "echo oops >&2; exit 3");
    const state = {};
    const r1 = await runScheduler(hub, state, { cmd: bad, minIntervalSec: 0, stateDir: dir, log: () => {} });
    assert.ok(r1.error);
    assert.equal((await hub.get(task.id)).state, "queued");

    const r2 = await runScheduler(hub, state, { cmd: bad, minIntervalSec: 0, stateDir: dir, log: () => {} });
    assert.equal(r2.fallback, true);
    assert.deepEqual(r2.assigned, [{ task: task.id, worker: "local-zcode", reason: "rules: prefer/tier/busy/cost" }]);
    const after = await hub.get(task.id);
    assert.equal(after.state, "assigned");
    assert.equal(after.assignee, "local-zcode");

    const marker = join(dir, "called2");
    const cmd = sh(dir, "agy2.sh", `touch ${marker}\necho '{"structured_output":{"assignments":[]}}'`);
    const hub2 = new FakeHub({ workers: WORKERS.slice(0, 1) });
    const task2 = await hub2.post({ title: "j2", kind: "code" }, "b");
    process.env.HUB_SCHEDULER = "rules";
    try {
      const r3 = await runScheduler(hub2, {}, { cmd, stateDir: dir, log: () => {} });
      assert.equal(r3.fallback, true);
      assert.equal(r3.assigned[0].task, task2.id);
      assert.ok(!existsSync(marker));
    } finally {
      delete process.env.HUB_SCHEDULER;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
