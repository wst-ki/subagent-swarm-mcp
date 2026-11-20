import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { FakeHub } from "./helpers/fake-hub.mjs";
import { renderPrompt, runRunner } from "../src/hub/runner.mjs";
import { runDaemon } from "../src/hub/daemon.mjs";
import { loadCooldowns, runScheduler } from "../src/hub/scheduler.mjs";

const exec = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ZWORKER = { id: "z1", kind: "zcode", host: "local", vendor: "zhipu", model: "GLM-5.3", tier: "high", maxParallel: 1, costRank: 1 };

async function mkRepo(root) {
  const repo = join(root, "repo");
  mkdirSync(repo);
  await exec("git", ["init", "-q", "-b", "main", repo]);
  await exec("git", ["config", "user.email", "t@t"], { cwd: repo });
  await exec("git", ["config", "user.name", "t"], { cwd: repo });
  writeFileSync(join(repo, "hello.txt"), "one\n");
  await exec("git", ["add", "-A"], { cwd: repo });
  await exec("git", ["commit", "-q", "-m", "base"], { cwd: repo });
  const base = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  return { repo, base };
}

function workdirOf(prompt) {
  return /## Working directory\n\n(\S+)/.exec(prompt)[1];
}

const REPORT = "## Result\nok\n## Changes\nnone\n## Checks run\nnone\n## Open questions\nnone\n";
// same, but with an empty Open questions section (nothing to ask the master)
const REPORT_CLOSED = "## Result\nok\n## Changes\nnone\n## Checks run\nnone\n## Open questions\n\n";

test("zcode runner: code task is cloned at base, then reported with patch (REPORT.md excluded)", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hub-run-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { repo, base } = await mkRepo(root);
  const dirs = { zcodeProjectDir: join(root, "proj"), stateDir: join(root, "state") };
  const hub = new FakeHub({ workers: [ZWORKER] });
  const task = await hub.post({ title: "add two", kind: "code", repo, base }, "Add a line saying two.");
  await hub.assign(task.id, "z1", "test");

  const seen = [];
  const adapters = {
    zcode: {
      runTask: async ({ prompt, model }) => {
        seen.push({ prompt, model });
        const wd = workdirOf(prompt);
        writeFileSync(join(wd, "REPORT.md"), REPORT);
        writeFileSync(join(wd, ".hub-out.log"), "diagnostic output excluded before staging\n");
        appendFileSync(join(wd, "hello.txt"), "two\n");
        return { taskId: "sess_1" };
      },
      followUp: async () => {
        throw new Error("unexpected followUp");
      },
      taskStatus: async () => ({ status: "running" }),
      getResult: async () => ({ status: "completed", result: "final answer text" }),
    },
  };
  const state = new Map();
  await runRunner(hub, { adapters, state, dirs, log: () => {} });

  let cur = await hub.get(task.id);
  assert.equal(cur.state, "running");
  assert.equal(cur.assignee, "z1");
  assert.equal(await hub.readTaskFile(task.id, "run"), "zcode:sess_1");
  const wd = join(dirs.zcodeProjectDir, "hub", task.id);
  assert.equal((await exec("git", ["rev-parse", "HEAD"], { cwd: wd })).stdout.trim(), base); // detached at base
  assert.equal(readFileSync(join(wd, "hello.txt"), "utf8"), "one\ntwo\n"); // the fake worker edited the clone
  assert.equal(seen[0].model, "GLM-5.3");
  assert.equal(seen[0].provider, undefined); // no worker.provider → ZCode default route
  assert.ok(seen[0].prompt.includes("Add a line saying two."));
  assert.ok(seen[0].prompt.includes("## Rules"));

  adapters.zcode.taskStatus = async () => ({ status: "completed" });
  await runRunner(hub, { adapters, state, dirs, log: () => {} });
  cur = await hub.get(task.id);
  assert.equal(cur.state, "done");
  assert.equal(cur.attempts, 1);
  assert.ok((await hub.readTaskFile(task.id, "result/report.md")).startsWith("## Result"));
  const patch = await hub.readTaskFile(task.id, "result/patch.diff");
  assert.match(patch, /\+two/);
  assert.ok(!patch.includes("REPORT.md"));
  const staged = (await exec("git", ["diff", "--cached", "--name-only"], { cwd: wd })).stdout;
  assert.ok(!staged.includes("REPORT.md"));
  assert.ok(!staged.includes(".hub-out.log"));
  const logHash = (await exec("git", ["hash-object", ".hub-out.log"], { cwd: wd })).stdout.trim();
  await assert.rejects(exec("git", ["cat-file", "-e", logHash], { cwd: wd }));
});

test("zcode runner: worker.provider (billing route) is passed through to runTask", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hub-run-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dirs = { zcodeProjectDir: join(root, "proj"), stateDir: join(root, "state") };
  const provider = "account%3Abigmodel-start-plan";
  const hub = new FakeHub({ workers: [{ ...ZWORKER, id: "zp", provider }] });
  const task = await hub.post({ title: "start plan", kind: "text" }, "Say hi.");
  await hub.assign(task.id, "zp", "test");

  const seen = [];
  const adapters = {
    zcode: {
      runTask: async ({ prompt, model, provider: p }) => {
        seen.push({ model, provider: p });
        writeFileSync(join(workdirOf(prompt), "REPORT.md"), REPORT_CLOSED);
        return { taskId: "sess_p", provider: "account:bigmodel-start-plan" };
      },
      followUp: async () => ({}),
      taskStatus: async () => ({ status: "completed" }),
      getResult: async () => ({ status: "completed", result: "ok" }),
    },
  };
  const state = new Map();
  await runRunner(hub, { adapters, state, dirs, log: () => {} });
  assert.deepEqual(seen, [{ model: "GLM-5.3", provider }]);
  await runRunner(hub, { adapters, state, dirs, log: () => {} });
  assert.equal((await hub.get(task.id)).state, "done");
});

test("zcode runner: open questions without a patch ask the master", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hub-run-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dirs = { zcodeProjectDir: join(root, "proj"), stateDir: join(root, "state") };
  const hub = new FakeHub({ workers: [ZWORKER] });
  const task = await hub.post({ title: "color", kind: "text" }, "Pick a color.");
  await hub.assign(task.id, "z1", "test");
  const adapters = {
    zcode: {
      runTask: async ({ prompt }) => {
        writeFileSync(join(workdirOf(prompt), "REPORT.md"), "## Open questions\nshould it be blue or green?\n");
        return { taskId: "sess_2" };
      },
      followUp: async () => ({}),
      taskStatus: async () => ({ status: "completed" }),
      getResult: async () => ({ status: "completed", result: "I have a question" }),
    },
  };
  const state = new Map();
  await runRunner(hub, { adapters, state, dirs, log: () => {} });
  await runRunner(hub, { adapters, state, dirs, log: () => {} });
  const cur = await hub.get(task.id);
  assert.equal(cur.state, "need-info");
  assert.equal(cur.note, "should it be blue or green?");
});

test("zcode runner: failed session fails the task; quota output requeues + cools the worker down", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hub-run-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dirs = { zcodeProjectDir: join(root, "proj"), stateDir: join(root, "state") };

  const hub = new FakeHub({ workers: [ZWORKER] });
  const failed = await hub.post({ title: "f", kind: "text" }, "b");
  await hub.assign(failed.id, "z1", "test");
  const failAdapters = {
    zcode: {
      runTask: async () => ({ taskId: "sess_3" }),
      followUp: async () => ({}),
      taskStatus: async () => ({ status: "failed" }),
      getResult: async () => ({ status: "failed", result: "boom" }),
    },
  };
  const st1 = new Map();
  await runRunner(hub, { adapters: failAdapters, state: st1, dirs, log: () => {} });
  await runRunner(hub, { adapters: failAdapters, state: st1, dirs, log: () => {} });
  const f = await hub.get(failed.id);
  assert.equal(f.state, "failed");
  assert.match(f.note, /failed: boom/);

  const quota = await hub.post({ title: "q", kind: "text" }, "b");
  await hub.assign(quota.id, "z1", "test");
  const quotaAdapters = {
    zcode: {
      runTask: async () => ({ taskId: "sess_4" }),
      followUp: async () => ({}),
      taskStatus: async () => ({ status: "completed" }),
      getResult: async () => ({ status: "completed", result: "APIError: 429 rate limit hit" }),
    },
  };
  const st2 = new Map();
  await runRunner(hub, { adapters: quotaAdapters, state: st2, dirs, log: () => {} });
  await runRunner(hub, { adapters: quotaAdapters, state: st2, dirs, log: () => {} });
  const q = await hub.get(quota.id);
  assert.equal(q.state, "queued");
  assert.equal(q.assignee, "");
  assert.match(q.note, /cooling down/);
  const cooldowns = loadCooldowns(dirs.stateDir);
  assert.ok(cooldowns.z1 > Date.now());

  // the cooldown keeps the scheduler from calling agy at all
  const marker = join(root, "called");
  const script = join(root, "agy.sh");
  writeFileSync(script, `#!/bin/sh\ntouch ${marker}\necho '{}'\n`);
  chmodSync(script, 0o755);
  const res = await runScheduler(hub, {}, { cmd: script, stateDir: dirs.stateDir, log: () => {} });
  assert.deepEqual(res, { skipped: "no eligible worker with a free slot" });
  assert.ok(!existsSync(marker));
});

test("zcode runner: after an answer the same session gets a followUp in the kept workdir", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hub-run-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dirs = { zcodeProjectDir: join(root, "proj"), stateDir: join(root, "state") };
  const hub = new FakeHub({ workers: [ZWORKER] });
  const task = await hub.post({ title: "color", kind: "text" }, "Pick a color.");
  await hub.assign(task.id, "z1", "test");
  await hub.claim(task.id, "z1");
  await hub.transition(task.id, { from: ["running"], to: "running", files: { run: "zcode:sess_9" } });
  await hub.ask(task.id, "z1", "blue or green?");
  await hub.answer(task.id, "make it blue");
  assert.equal((await hub.get(task.id)).state, "assigned");

  const wd = join(dirs.zcodeProjectDir, "hub", task.id);
  mkdirSync(wd, { recursive: true });
  writeFileSync(join(wd, "keep.txt"), "kept");

  const followUps = [];
  const adapters = {
    zcode: {
      runTask: async () => {
        throw new Error("unexpected runTask");
      },
      followUp: async ({ taskId, prompt }) => {
        followUps.push({ taskId, prompt });
        writeFileSync(join(workdirOf(prompt), "REPORT.md"), REPORT_CLOSED);
        return { taskId, accepted: true };
      },
      taskStatus: async () => ({ status: "completed" }),
      getResult: async () => ({ status: "completed", result: "done boss" }),
    },
  };
  const state = new Map();
  await runRunner(hub, { adapters, state, dirs, log: () => {} });
  assert.equal(followUps.length, 1);
  assert.equal(followUps[0].taskId, "sess_9");
  assert.ok(followUps[0].prompt.includes("make it blue"));
  assert.ok(followUps[0].prompt.includes("Pick a color."));
  assert.ok(existsSync(join(wd, "keep.txt"))); // workdir not recloned
  assert.equal(await hub.readTaskFile(task.id, "run"), "zcode:sess_9");
  assert.equal((await hub.get(task.id)).state, "running");

  await runRunner(hub, { adapters, state, dirs, log: () => {} });
  const cur = await hub.get(task.id);
  assert.equal(cur.state, "done");
  assert.equal(cur.attempts, 2);
});

test("cli runner: detached worker runs in the workdir, {prompt} replaced, output logged", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hub-run-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dirs = { zcodeProjectDir: join(root, "proj"), stateDir: join(root, "state") };
  const script = join(root, "worker.mjs");
  writeFileSync(
    script,
    `import { writeFileSync } from "node:fs";
console.log("plen:" + (process.argv[2]?.length ?? -1));
writeFileSync("REPORT.md", ${JSON.stringify(REPORT_CLOSED)});
console.log("worker output");
`,
  );
  const worker = { id: "c1", kind: "cli", host: "local", vendor: "openai", tier: "high", maxParallel: 1, costRank: 2, cmd: [process.execPath, script, "{prompt}"] };
  const hub = new FakeHub({ workers: [worker] });
  const task = await hub.post({ title: "say hi", kind: "text" }, "Say hi.");
  await hub.assign(task.id, "c1", "test");

  const state = new Map();
  for (let i = 0; i < 100 && (await hub.get(task.id)).state !== "done"; i++) {
    await runRunner(hub, { adapters: {}, state, dirs, log: () => {} });
    await sleep(100);
  }
  const cur = await hub.get(task.id);
  assert.equal(cur.state, "done");
  const wd = join(dirs.stateDir, "work", task.id);
  const out = readFileSync(join(wd, ".hub-out.log"), "utf8");
  assert.match(out, /worker output/);
  const expected = renderPrompt({ taskMd: "Say hi.", answerMd: null, workdir: wd });
  assert.equal(Number(/plen:(-?\d+)/.exec(out)[1]), expected.length);
  assert.ok((await hub.readTaskFile(task.id, "result/report.md")).startsWith("## Result"));
  assert.equal(await hub.readTaskFile(task.id, "result/patch.diff"), null); // text task: no patch
  assert.match(await hub.readTaskFile(task.id, "run"), /^pid:\d+$/);
});

test("cli runner: a cli worker that exits non-zero without a REPORT.md fails the task", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hub-run-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dirs = { zcodeProjectDir: join(root, "proj"), stateDir: join(root, "state") };
  const script = join(root, "worker.mjs");
  writeFileSync(
    script,
    `console.log("Authentication required");
process.exit(1);
`,
  );
  const worker = { id: "c1", kind: "cli", host: "local", vendor: "openai", tier: "high", maxParallel: 1, costRank: 2, cmd: [process.execPath, script, "{prompt}"] };
  const hub = new FakeHub({ workers: [worker] });
  const task = await hub.post({ title: "say hi", kind: "text" }, "Say hi.");
  await hub.assign(task.id, "c1", "test");

  const state = new Map();
  for (let i = 0; i < 100 && (await hub.get(task.id)).state !== "failed"; i++) {
    await runRunner(hub, { adapters: {}, state, dirs, log: () => {} });
    await sleep(100);
  }
  const cur = await hub.get(task.id);
  assert.equal(cur.state, "failed");
  assert.match(cur.note, /Authentication required/);
  assert.equal(await hub.readTaskFile(task.id, "result/report.md"), null);
});

test("cli runner: a cli worker that wrote a REPORT.md but exited non-zero is still done", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hub-run-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dirs = { zcodeProjectDir: join(root, "proj"), stateDir: join(root, "state") };
  const script = join(root, "worker.mjs");
  writeFileSync(
    script,
    `import { writeFileSync } from "node:fs";
writeFileSync("REPORT.md", ${JSON.stringify(REPORT_CLOSED)});
console.log("done but grumpy");
process.exit(1);
`,
  );
  const worker = { id: "c1", kind: "cli", host: "local", vendor: "openai", tier: "high", maxParallel: 1, costRank: 2, cmd: [process.execPath, script, "{prompt}"] };
  const hub = new FakeHub({ workers: [worker] });
  const task = await hub.post({ title: "say hi", kind: "text" }, "Say hi.");
  await hub.assign(task.id, "c1", "test");

  const state = new Map();
  for (let i = 0; i < 100 && (await hub.get(task.id)).state !== "done"; i++) {
    await runRunner(hub, { adapters: {}, state, dirs, log: () => {} });
    await sleep(100);
  }
  const cur = await hub.get(task.id);
  assert.equal(cur.state, "done");
  assert.ok((await hub.readTaskFile(task.id, "result/report.md")).startsWith("## Result"));
});

test("daemon: runDaemon once ticks (assign, heartbeat) and releases the lock; live lock refuses", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hub-run-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "sd");

  const script = join(root, "agy.sh");
  const hub = new FakeHub({ workers: [{ ...ZWORKER, id: "dz" }] });
  const task = await hub.post({ title: "j", kind: "text" }, "b");
  writeFileSync(script, `#!/bin/sh\ncat >/dev/null\necho '{"structured_output":{"assignments":[{"task":"${task.id}","worker":"dz","reason":"only one"}]}}'\n`);
  chmodSync(script, 0o755);
  const noop = {
    zcode: {
      runTask: async () => ({ taskId: "x" }),
      followUp: async () => ({}),
      taskStatus: async () => ({ status: "completed" }),
      getResult: async () => ({ result: "" }),
    },
  };
  const res = await runDaemon({ once: true, hub, adapters: noop, schedulerCmd: script, stateDir, tickSec: 1, log: () => {} });
  assert.equal(res.ticks, 1);
  const after = await hub.get(task.id);
  assert.equal(after.state, "assigned"); // scheduler ran after runner+accept
  assert.equal(after.note, "only one");
  assert.ok(await hub.lastSeen("dz")); // local worker heartbeated
  assert.ok(!existsSync(join(stateDir, "hub-daemon.lock")));

  // a live owner refuses; a dead one is taken over
  const lock = join(stateDir, "hub-daemon.lock");
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, at: Date.now() }));
  await assert.rejects(() => runDaemon({ once: true, hub, adapters: noop, stateDir, log: () => {} }), /another dispatch daemon is running/);
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: 999_999, at: Date.now() }));
  const res2 = await runDaemon({ once: true, hub: new FakeHub({ workers: [] }), adapters: noop, schedulerCmd: script, stateDir, log: () => {} });
  assert.equal(res2.ticks, 1);
});
