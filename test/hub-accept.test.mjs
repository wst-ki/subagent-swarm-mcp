import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { FakeHub } from "./helpers/fake-hub.mjs";
import { parseVerdict, runAccept } from "../src/hub/accept.mjs";

const exec = promisify(execFile);

const WORKERS = [
  { id: "impl-z", kind: "zcode", host: "local", vendor: "zhipu", model: "GLM-5.3", tier: "high", maxParallel: 1, costRank: 1 },
  { id: "rev-o", kind: "cli", host: "local", vendor: "openai", model: "gpt-6.1", tier: "high", maxParallel: 1, costRank: 2 },
];

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

async function patchAdding(root, repo, base, text) {
  const scratch = join(root, "scratch");
  await exec("git", ["clone", "-q", repo, scratch]);
  writeFileSync(join(scratch, "hello.txt"), `one\n${text}\n`);
  await exec("git", ["add", "-A"], { cwd: scratch });
  const patch = (await exec("git", ["diff", "--cached", "--binary", base], { cwd: scratch })).stdout;
  rmSync(scratch, { recursive: true, force: true });
  return patch;
}

async function doneTask(hub, spec, patch, worker = "impl-z") {
  const t = await hub.post(spec, "instructions");
  await hub.assign(t.id, worker, "test");
  await hub.claim(t.id, worker);
  await hub.report(t.id, worker, { report: "## Result\nok\n", patch });
  return t;
}

test("parseVerdict", () => {
  assert.equal(parseVerdict("## Result\nfine\n\nVERDICT: PASS\n"), "PASS");
  assert.equal(parseVerdict("VERDICT: NEEDS_FIX"), "NEEDS_FIX");
  assert.equal(parseVerdict("verdict: pass"), "PASS");
  assert.equal(parseVerdict("nothing to see"), null);
  assert.equal(parseVerdict("VERDICT: MAYBE"), null);
});

test("accept: patch applies and accept command passes -> accepted, worktree cleaned up", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hub-acc-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { repo, base } = await mkRepo(root);
  const patch = await patchAdding(root, repo, base, "two");
  const hub = new FakeHub({ workers: WORKERS });
  const task = await doneTask(hub, { title: "add two", kind: "code", repo, base, accept: "grep -q two hello.txt && echo checked" }, patch);

  const tmpBase = join(root, "acc");
  mkdirSync(tmpBase);
  const res = await runAccept(hub, { tmpBase, log: () => {} });
  assert.deepEqual(res.accepted, [task.id]);
  const after = await hub.get(task.id);
  assert.equal(after.state, "accepted");
  assert.equal(after.note, "accept command passed");
  assert.match(await hub.readTaskFile(task.id, "result/accept.log"), /checked/);
  assert.equal(readdirSync(tmpBase).length, 0); // temp worktree always removed
  const wt = (await exec("git", ["worktree", "list", "--porcelain"], { cwd: repo })).stdout;
  assert.equal(wt.trim().split("\n").filter((l) => l.startsWith("worktree ")).length, 1);
});

test("accept: broken patch and failing command -> rejected", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hub-acc-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { repo, base } = await mkRepo(root);
  const hub = new FakeHub({ workers: WORKERS });

  const bad = await doneTask(hub, { title: "bad", kind: "code", repo, base, accept: "true" }, "not a real diff\n");
  const r1 = await runAccept(hub, { tmpBase: root, log: () => {} });
  assert.deepEqual(r1.rejected, [bad.id]);
  assert.equal((await hub.get(bad.id)).state, "rejected");
  assert.equal((await hub.get(bad.id)).note, "patch did not apply");
  assert.match(await hub.readTaskFile(bad.id, "result/accept.log"), /git apply/);

  const patch = await patchAdding(root, repo, base, "two");
  const fails = await doneTask(hub, { title: "cmd fails", kind: "code", repo, base, accept: "echo nope >&2; exit 7" }, patch);
  const r2 = await runAccept(hub, { tmpBase: root, log: () => {} });
  assert.deepEqual(r2.rejected, [fails.id]);
  assert.equal((await hub.get(fails.id)).note, "accept command failed");
  assert.match(await hub.readTaskFile(fails.id, "result/accept.log"), /nope/);
});

test("accept: a failure inside a pipeline rejects (pipefail)", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hub-acc-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { repo, base } = await mkRepo(root);
  const hub = new FakeHub({ workers: WORKERS });
  const patch = await patchAdding(root, repo, base, "two");
  const task = await doneTask(hub, { title: "piped", kind: "code", repo, base, accept: "echo typecheck error; false | tail -1" }, patch);
  const r = await runAccept(hub, { tmpBase: root, log: () => {} });
  assert.deepEqual(r.rejected, [task.id]);
  assert.equal((await hub.get(task.id)).note, "accept command failed");
});

test("accept: empty patch -> rejected without running the accept command", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hub-acc-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { repo, base } = await mkRepo(root);
  const tmpBase = join(root, "acc");
  mkdirSync(tmpBase);
  // The accept command would leave a trace outside the throwaway worktree, so a
  // surviving marker means it ran even though there was nothing to check.
  const marker = join(root, "accept-ran");

  for (const patch of ["", null]) {
    const hub = new FakeHub({ workers: WORKERS });
    const task = await doneTask(hub, { title: "no changes", kind: "code", repo, base, accept: `touch ${marker}` }, patch);

    const res = await runAccept(hub, { tmpBase, log: () => {} });

    assert.deepEqual(res.rejected, [task.id]);
    assert.deepEqual(res.accepted, []);
    assert.deepEqual(res.reviews, []); // no review child for a patch worth nothing
    const after = await hub.get(task.id);
    assert.equal(after.state, "rejected");
    assert.equal(after.note, "empty patch: the worker changed nothing");
    assert.equal(existsSync(marker), false); // the accept command was skipped
    assert.equal(await hub.readTaskFile(task.id, "result/accept.log"), "");
    assert.equal(readdirSync(tmpBase).length, 0); // no temp worktree was created
  }
});

test("accept: no accept command, timed-out command, text task", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hub-acc-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { repo, base } = await mkRepo(root);
  const patch = await patchAdding(root, repo, base, "two");
  const hub = new FakeHub({ workers: WORKERS });

  const none = await doneTask(hub, { title: "no cmd", kind: "code", repo, base }, patch);
  const text = await doneTask(hub, { title: "text", kind: "text" }, null);
  const slow = await doneTask(hub, { title: "slow", kind: "code", repo, base, accept: "sleep 5" }, patch);
  const res = await runAccept(hub, { tmpBase: root, acceptTimeoutMs: 200, log: () => {} });
  assert.deepEqual(res.accepted.sort(), [none.id, text.id].sort());
  assert.deepEqual(res.rejected, [slow.id]);
  assert.equal((await hub.get(none.id)).note, "no accept command");
  assert.equal((await hub.get(text.id)).note, "text task");
  assert.equal((await hub.get(slow.id)).note, "accept command timed out");
});

test("review: child task is posted, VERDICT decides the parent", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hub-acc-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { repo, base } = await mkRepo(root);
  const patch = await patchAdding(root, repo, base, "two");
  const hub = new FakeHub({ workers: WORKERS });
  const parent = await doneTask(hub, { title: "impl", kind: "code", repo, base, accept: "true", review: true }, patch);

  const res = await runAccept(hub, { tmpBase: root, log: () => {} });
  assert.equal(res.reviews.length, 1);
  assert.equal(res.accepted.length, 0);
  const childId = res.reviews[0].child;
  const child = await hub.get(childId);
  assert.equal(child.spec.kind, "review");
  assert.equal(child.spec.parent, parent.id);
  assert.equal(child.spec.tier, "mid");
  assert.deepEqual(child.spec.avoidVendors, ["zhipu"]); // the implementer's vendor
  assert.ok((await hub.readTaskFile(childId, "task.md")).includes("VERDICT"));
  const p = await hub.get(parent.id);
  assert.equal(p.state, "done"); // left pending, not accepted yet
  assert.equal(p.note, `awaiting review ${childId}`);
  // not re-posted on the next tick
  assert.deepEqual((await runAccept(hub, { tmpBase: root, log: () => {} })).reviews, []);

  await hub.assign(childId, "rev-o", "s");
  await hub.claim(childId, "rev-o");
  await hub.report(childId, "rev-o", { report: "## Result\nreviewed\n\nVERDICT: PASS\n" });
  const r2 = await runAccept(hub, { tmpBase: root, log: () => {} });
  assert.ok(r2.accepted.includes(parent.id));
  assert.ok(r2.accepted.includes(childId));
  assert.equal((await hub.get(parent.id)).state, "accepted");
  assert.equal((await hub.get(childId)).state, "accepted");
});

test("review: NEEDS_FIX or a missing verdict rejects the parent, child still accepted", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "hub-acc-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { repo, base } = await mkRepo(root);
  const patch = await patchAdding(root, repo, base, "two");

  for (const report of ["## Result\nbad\n\nVERDICT: NEEDS_FIX\n", "## Result\nno verdict line\n"]) {
    const hub = new FakeHub({ workers: WORKERS });
    const parent = await doneTask(hub, { title: "impl", kind: "code", repo, base, accept: "true", review: true }, patch);
    const { reviews } = await runAccept(hub, { tmpBase: root, log: () => {} });
    await hub.assign(reviews[0].child, "rev-o", "s");
    await hub.claim(reviews[0].child, "rev-o");
    await hub.report(reviews[0].child, "rev-o", { report });
    await runAccept(hub, { tmpBase: root, log: () => {} });
    assert.equal((await hub.get(parent.id)).state, "rejected");
    assert.equal((await hub.get(reviews[0].child)).state, "accepted");
  }
});
