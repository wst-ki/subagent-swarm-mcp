import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { checkoutMode, prepareCheckout, removeCheckout } from "../src/hub/checkout.mjs";
import { cleanupWorkdirs } from "../src/hub/cleanup.mjs";
import { readLogTail, WorkerLog, workerLogLimit } from "../src/hub/worker-log.mjs";
import { FakeHub } from "./helpers/fake-hub.mjs";
import { tick } from "../src/hub/daemon.mjs";

const exec = promisify(execFile);
const git = async (cwd, ...args) => (await exec("git", args, { cwd })).stdout.trim();
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "hub-space-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
async function repoAt(root) {
  const repo = join(root, "repo");
  await exec("git", ["init", "-q", "-b", "main", repo]);
  await git(repo, "config", "user.email", "test@hub");
  await git(repo, "config", "user.name", "test");
  writeFileSync(join(repo, "source.txt"), "original\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "base");
  return { repo, base: await git(repo, "rev-parse", "HEAD") };
}

test("worktrees share Git objects but isolate files, index, source dirty changes and follow-ups", async (t) => {
  const root = fixture(t);
  const { repo, base } = await repoAt(root);
  writeFileSync(join(repo, "source.txt"), "source dirty\n");
  const task = { spec: { kind: "code", repo, base } };
  const a = join(root, "a");
  const b = join(root, "b");
  await prepareCheckout(task, a, { fresh: true, mode: "worktree" });
  await prepareCheckout(task, b, { fresh: true, mode: "worktree" });
  assert.ok(lstatSync(join(a, ".git")).isFile());
  assert.equal(await git(a, "rev-parse", "--path-format=absolute", "--git-common-dir"), join(repo, ".git"));
  assert.equal(readFileSync(join(a, "source.txt"), "utf8"), "original\n");
  writeFileSync(join(a, "source.txt"), "a edit\n");
  await git(a, "add", ".");
  assert.match(await git(a, "diff", "--cached", base), /a edit/);
  assert.equal(await git(b, "diff", "--cached", base), "");
  assert.equal(readFileSync(join(b, "source.txt"), "utf8"), "original\n");
  assert.equal(readFileSync(join(repo, "source.txt"), "utf8"), "source dirty\n");
  await prepareCheckout(task, a, { fresh: false });
  assert.equal(readFileSync(join(a, "source.txt"), "utf8"), "a edit\n");
  await prepareCheckout(task, a, { fresh: true, mode: "worktree" });
  assert.equal(readFileSync(join(a, "source.txt"), "utf8"), "original\n");
  await removeCheckout(a);
  await removeCheckout(b);
  assert.equal((await git(repo, "worktree", "list", "--porcelain")).split("\n").filter((s) => s.startsWith("worktree ")).length, 1);
});

test("reviews get source, omitted base uses HEAD, and clone opt-out remains independent", async (t) => {
  const root = fixture(t);
  const { repo } = await repoAt(root);
  const review = join(root, "review");
  await prepareCheckout({ spec: { kind: "review", repo } }, review, { fresh: true, mode: "worktree" });
  assert.equal(readFileSync(join(review, "source.txt"), "utf8"), "original\n");
  const clone = join(root, "clone");
  await prepareCheckout({ spec: { kind: "code", repo } }, clone, { fresh: true, mode: "clone" });
  assert.ok(lstatSync(join(clone, ".git")).isDirectory());
  await removeCheckout(clone);
  await removeCheckout(review);
  assert.ok(!existsSync(clone));
  assert.equal(checkoutMode({}), "worktree");
  assert.throws(() => checkoutMode({ HUB_CHECKOUT_MODE: "typo" }));
});

test("cleanup removes successful worktrees after one hour and unregisters them; failures keep three days", async (t) => {
  const root = fixture(t);
  const { repo, base } = await repoAt(root);
  const hub = new FakeHub();
  const now = Date.now();
  const dirs = { stateDir: join(root, "state"), zcodeProjectDir: join(root, "project") };
  const tasks = [];
  for (const state of ["accepted", "failed"]) {
    const task = await hub.post({ kind: "code", repo, base }, "task");
    await hub.transition(task.id, { to: state });
    hub.tasks.get(task.id).updatedAt = now - 90 * 60_000;
    const workdir = join(dirs.stateDir, "work", task.id);
    await prepareCheckout(task, workdir, { fresh: true, mode: "worktree" });
    tasks.push(workdir);
  }
  const preview = await cleanupWorkdirs(hub, { dirs, now, successHours: 1, days: 3 });
  assert.deepEqual(preview.candidates, [tasks[0]]);
  assert.ok(existsSync(tasks[0]));
  const result = await cleanupWorkdirs(hub, { dirs, now, successHours: 1, days: 3, dryRun: false });
  assert.deepEqual(result.removed, [tasks[0]]);
  assert.deepEqual(result.errors, []);
  assert.ok(existsSync(tasks[1]));
  const listed = await git(repo, "worktree", "list", "--porcelain");
  assert.ok(!listed.includes(tasks[0]));
  assert.ok(listed.includes(tasks[1]));
});

test("worker log caps huge chunks and repeated writes, resumes existing logs, and reads bounded tails", (t) => {
  const root = fixture(t);
  const path = join(root, "worker.log");
  const log = new WorkerLog(path, 4096);
  log.append(Buffer.alloc(9000, 65));
  assert.equal(statSync(path).size, 4096);
  for (let i = 0; i < 500; i++) log.append(`line ${i} ${"x".repeat(50)}\n`);
  log.append("last marker\n");
  log.close();
  assert.ok(statSync(path).size <= 4096);
  assert.match(readLogTail(path, 128), /last marker/);
  assert.ok(Buffer.byteLength(readLogTail(path, 128)) <= 128);
  writeFileSync(path, "y".repeat(10_000));
  const resumed = new WorkerLog(path, 4096);
  resumed.append("resumed\n");
  resumed.close();
  assert.ok(statSync(path).size <= 4096);
  assert.match(readLogTail(path), /resumed/);
  assert.equal(readLogTail(join(root, "missing")), "");
  assert.equal(workerLogLimit({}), 10 * 1024 * 1024);
  for (const v of ["0", "NaN", "Infinity", "-1"]) assert.throws(() => workerLogLimit({ HUB_WORKER_LOG_MAX_MB: v }));
});

test("detached wrapper forwards stdin, drains stdout/stderr beyond the log cap and preserves failure exit", async (t) => {
  const root = fixture(t);
  const script = join(root, "worker.mjs");
  writeFileSync(script, `
let input = "";
for await (const chunk of process.stdin) input += chunk;
await new Promise((r) => process.stdout.write("o".repeat(2000000), r));
await new Promise((r) => process.stderr.write("e".repeat(2000000), r));
process.stdout.write("\\nINPUT=" + input + "\\n");
process.stderr.write("\\nSTDERR_END\\n");
process.exitCode = 7;
`);
  const path = join(root, ".hub-out.log");
  const wrapper = fileURLToPath(new URL("../bin/hub-worker.mjs", import.meta.url));
  const child = spawn(process.execPath, [wrapper, path, "1048576", process.execPath, script], { cwd: root, stdio: ["pipe", "ignore", "pipe"] });
  child.stdin.end("hello stdin");
  const [code] = await once(child, "close");
  assert.equal(code, 7);
  assert.ok(statSync(path).size <= 1048576);
  assert.match(readFileSync(path, "utf8"), /INPUT=hello stdin/);
  assert.match(readFileSync(path, "utf8"), /STDERR_END/);
  const capped = new WorkerLog(path, 4096);
  capped.close();
  assert.ok(statSync(path).size <= 4096);
});

test("daemon throttles Git heartbeats while respecting shorter worker stale windows", async (t) => {
  const root = fixture(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const hub = new FakeHub({ workers: [{ id: "normal", kind: "cli" }, { id: "short", kind: "cli", staleSec: 30 }] });
  const beats = [];
  const heartbeat = hub.heartbeat.bind(hub);
  hub.heartbeat = async (id) => { beats.push(id); await heartbeat(id); };
  const ctx = {
    stateDir: root, dirs: { stateDir: root, zcodeProjectDir: join(root, "proj") },
    cleanupState: { lastRun: now }, schedulerCmd: "unused", adapters: {},
  };
  await tick(hub, ctx);
  assert.deepEqual(beats, ["normal", "short"]);
  now += 5000;
  await tick(hub, ctx);
  assert.equal(beats.length, 2);
  now += 6000;
  await tick(hub, ctx);
  assert.deepEqual(beats, ["normal", "short", "short"]);
  now += 50_000;
  await tick(hub, ctx);
  assert.deepEqual(beats, ["normal", "short", "short", "normal", "short"]);
});
