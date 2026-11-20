// Hub core tests: real git, temp bare repo, two working clones racing for one claim.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hermetic: empty global/system git config, committed identity comes from repo.mjs's actor env.
const tmp = mkdtempSync(join(tmpdir(), "hubtasks-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const emptyCfg = join(tmp, "empty.gitconfig");
writeFileSync(emptyCfg, "");
process.env.GIT_CONFIG_GLOBAL = emptyCfg;
process.env.GIT_CONFIG_SYSTEM = emptyCfg;

const { Hub, HubConflictError, STATES, newTaskId } = await import("../src/hub/tasks.mjs");

const remote = join(tmp, "hub.git");
let n = 0;
const newHub = async () => {
  const hub = new Hub({ remote, workdir: join(tmp, `clone${++n}`) });
  await hub.init();
  return hub;
};
let hub;
let hubB; // second working clone against the same bare repo

test("init creates a seeded bare repo and a working clone", async () => {
  hub = await newHub();
  hubB = await newHub();
  assert.ok(existsSync(join(hub.repo.workdir, "workers.json")));
  assert.ok(existsSync(join(hub.repo.workdir, "PROTOCOL.md")));
  assert.ok(existsSync(join(hub.repo.workdir, "SCHEDULER.md")));
  assert.ok(existsSync(join(hub.repo.workdir, "bin", "hub")));
  assert.deepEqual(STATES, [
    "queued", "assigned", "running", "done", "need-info", "failed", "accepted", "rejected", "cancelled",
  ]);
});

test("post/list/get/readTaskFile/taskDir", async () => {
  const t = await hub.post(
    { title: "fix the thing", kind: "code", repo: "/tmp/x", base: "abc", timeoutMin: 5, preferWorkers: ["w1"], avoidVendors: ["v"] },
    "body text",
  );
  assert.match(t.id, /^T\d{8}-\d{6}-[a-z0-9]{2}$/);
  assert.equal(newTaskId().length, t.id.length);
  assert.equal(t.state, "queued");
  assert.equal(t.attempts, 0);
  assert.equal(t.spec.title, "fix the thing");
  assert.equal(t.spec.timeoutMin, 5);
  assert.deepEqual(t.spec.preferWorkers, ["w1"]);
  assert.ok(t.updatedAt > 0);
  assert.equal(existsSync(join(hub.taskDir(t.id), "spec.json")), true);
  assert.equal(await hub.readTaskFile(t.id, "task.md"), "body text");
  assert.equal(await hub.readTaskFile(t.id, "nope.md"), null);
  const list = await hub.list();
  assert.ok(list.some((x) => x.id === t.id));
  assert.deepEqual(list.map((x) => x.id), [...list.map((x) => x.id)].sort());
  assert.equal((await hub.get(t.id)).id, t.id);
  assert.equal(await hub.get("T00000000-000000-zz"), null);
});

test("assign -> claim -> report -> accept lifecycle", async () => {
  const t = await hub.post({ title: "lifecycle", timeoutMin: 10 }, "go");
  const a = await hub.assign(t.id, "w1", "cheapest");
  assert.equal(a.state, "assigned");
  assert.equal(a.assignee, "w1");
  assert.equal(a.note, "cheapest");
  const before = Math.floor(Date.now() / 1000);
  const r = await hub.claim(t.id, "w1");
  assert.equal(r.state, "running");
  assert.equal(r.attempts, 1);
  assert.ok(r.lease >= before + 9 * 60 && r.lease <= before + 11 * 60);
  const d = await hub.report(t.id, "w1", { report: "## Result\nok", patch: "diff --git a/f b/f\n+hello\n" });
  assert.equal(d.state, "done");
  assert.equal(await hub.readTaskFile(t.id, "result/report.md"), "## Result\nok");
  assert.equal(await hub.readTaskFile(t.id, "result/patch.diff"), "diff --git a/f b/f\n+hello\n");
  const acc = await hub.accept(t.id, { ok: true, log: "npm test: 3 pass" });
  assert.equal(acc.state, "accepted");
  assert.equal(await hub.readTaskFile(t.id, "result/accept.log"), "npm test: 3 pass");
});

test("transition rejects a wrong from-state with HubConflictError", async () => {
  const t = await hub.post({ title: "conflict" }, "x");
  await assert.rejects(hub.transition(t.id, { from: ["running"], to: "done" }), HubConflictError);
  await assert.rejects(hub.claim(t.id, "w1"), HubConflictError); // still queued, not assigned
});

test("claim by the wrong worker is rejected", async () => {
  const t = await hub.post({ title: "ownership" }, "x");
  await hub.assign(t.id, "w1");
  await assert.rejects(hub.claim(t.id, "w2"), HubConflictError);
  assert.equal((await hub.get(t.id)).state, "assigned");
});

test("two working clones race to claim: exactly one wins", async () => {
  const cloneA = await newHub();
  const cloneB = await newHub();
  const t = await cloneA.post({ title: "race" }, "x");
  await cloneA.assign(t.id, "w1");
  const [a, b] = await Promise.allSettled([cloneA.claim(t.id, "w1"), cloneB.claim(t.id, "w1")]);
  const wins = [a, b].filter((r) => r.status === "fulfilled");
  const losses = [a, b].filter((r) => r.status === "rejected");
  assert.equal(wins.length, 1);
  assert.equal(losses.length, 1);
  assert.ok(losses[0].reason instanceof HubConflictError);
  const after = await cloneA.get(t.id);
  assert.equal(after.state, "running");
  assert.equal(after.attempts, 1); // the loser's write never landed
});

test("ask -> answer round trip returns the task to the assignee", async () => {
  const t = await hub.post({ title: "question" }, "x");
  await hub.assign(t.id, "w1");
  await hub.claim(t.id, "w1");
  const q = await hub.ask(t.id, "w1", "which color?");
  assert.equal(q.state, "need-info");
  assert.equal(q.note, "which color?");
  const ans = await hub.answer(t.id, "the sea");
  assert.equal(ans.state, "assigned");
  assert.equal(ans.assignee, "w1"); // same assignee
  assert.equal(await hub.readTaskFile(t.id, "answer.md"), "the sea");
  const again = await hub.claim(t.id, "w1");
  assert.equal(again.attempts, 2);
});

test("fail and requeue; cancel works from active and done states only", async () => {
  const t = await hub.post({ title: "fail path" }, "x");
  await hub.assign(t.id, "w1");
  await hub.claim(t.id, "w1");
  const f = await hub.fail(t.id, "w1", "too hard");
  assert.equal(f.state, "failed");
  assert.equal(f.note, "too hard");
  await assert.rejects(hub.cancel(t.id), HubConflictError); // failed is terminal until requeued
  const rq = await hub.requeue(t.id);
  assert.equal(rq.state, "queued");
  assert.equal(rq.assignee, "");

  const t2 = await hub.post({ title: "cancel me" }, "x");
  assert.equal((await hub.cancel(t2.id)).state, "cancelled");
  await assert.rejects(hub.cancel(t2.id), HubConflictError); // already terminal
  assert.equal((await hub.requeue(t2.id)).state, "queued");

  const t3 = await hub.post({ title: "cancel while done" }, "x");
  await hub.assign(t3.id, "w1");
  await hub.claim(t3.id, "w1");
  await hub.report(t3.id, "w1", { report: "r" });
  assert.equal((await hub.cancel(t3.id)).state, "cancelled");
});

test("accept can reject, with the log attached", async () => {
  const t = await hub.post({ title: "rejected" }, "x");
  await hub.assign(t.id, "w1");
  await hub.claim(t.id, "w1");
  await hub.report(t.id, "w1", { report: "r" });
  const r = await hub.accept(t.id, { ok: false, log: "1 failing test" });
  assert.equal(r.state, "rejected");
  assert.equal(await hub.readTaskFile(t.id, "result/accept.log"), "1 failing test");
});

test("expireStale requeues on lease passage and fails at 3 attempts", async () => {
  const drain = async (hub_, title) => {
    const t = await hub_.post({ title, timeoutMin: 10 }, "x");
    for (let i = 0; i < 3; i++) {
      await hub_.assign(t.id, "w1");
      await hub_.claim(t.id, "w1");
      const expired = await hub_.expireStale(Date.now() + 11 * 60 * 1000);
      assert.ok(expired.includes(t.id));
      const cur = await hub_.get(t.id);
      if (i < 2) assert.equal(cur.state, "queued");
      else assert.equal(cur.state, "failed"); // attempts hit 3
    }
    return t.id;
  };
  await drain(hub, "expire loop");
});

test("expireStale: fresh lease + live heartbeat keeps the task running", async () => {
  await hub.heartbeat("w-alice");
  const t = await hub.post({ title: "alive", timeoutMin: 60 }, "x");
  await hub.assign(t.id, "w-alice");
  await hub.claim(t.id, "w-alice");
  const expired = await hub.expireStale(Date.now() + 30 * 1000); // lease 60 min away, hb fresh
  assert.deepEqual(expired.filter((id) => id === t.id), []);
  assert.equal((await hub.get(t.id)).state, "running");
});

test("expireStale: silent assignee loses the lease even when it is long", async () => {
  const t = await hub.post({ title: "ghost", timeoutMin: 600 }, "x");
  await hub.assign(t.id, "w-ghost"); // never heartbeats
  await hub.claim(t.id, "w-ghost");
  const expired = await hub.expireStale(Date.now() + 301 * 1000); // past HUB_STALE_SEC default 300
  assert.ok(expired.includes(t.id));
  assert.equal((await hub.get(t.id)).state, "queued");
});

test("heartbeat/lastSeen/workers: roster enriched with online, lastSeen, busy", async () => {
  await hub.repo.mutate(async () => {
    writeFileSync(
      hub.repo.path("workers.json"),
      JSON.stringify({
        workers: [
          { id: "w-alice", kind: "manual", host: "mac", tier: "high", maxParallel: 1, enabled: true, kinds: ["text"] },
          { id: "w-bob", kind: "manual", host: "mac", tier: "low", maxParallel: 1, enabled: true, kinds: ["text"] },
        ],
      }),
    );
    return "test roster";
  });
  await hub.heartbeat("w-alice");
  const seen = await hub.lastSeen("w-alice");
  assert.ok(Math.abs(Date.now() - seen) < 10_000);
  assert.equal(await hub.lastSeen("w-nobody"), null);

  const t = await hub.post({ title: "busy count" }, "x");
  await hub.assign(t.id, "w-alice");
  const ws = await hub.workers();
  const alice = ws.find((w) => w.id === "w-alice");
  const bob = ws.find((w) => w.id === "w-bob");
  assert.equal(alice.online, true);
  assert.equal(alice.busy, 1);
  assert.equal(alice.kind, "manual");
  assert.equal(bob.online, false);
  assert.equal(bob.lastSeen, null);
  assert.equal(bob.busy, 0);
});
