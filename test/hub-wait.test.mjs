// waitForEvents tests: cursor diffing against a real hub in a temp dir (also temp stateDir, so
// cursor files never touch the real one).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "hubwait-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
process.env.ZCODE_MCP_STATE_DIR = join(tmp, "state"); // must be set before config.mjs loads
const emptyCfg = join(tmp, "empty.gitconfig");
writeFileSync(emptyCfg, "");
process.env.GIT_CONFIG_GLOBAL = emptyCfg;
process.env.GIT_CONFIG_SYSTEM = emptyCfg;

const { Hub } = await import("../src/hub/tasks.mjs");
const { waitForEvents, diffEvents, cursorFile } = await import("../src/hub/wait.mjs");

let hub;
const driveTo = async (title, state, patch) => {
  const t = await hub.post({ title, timeoutMin: 30 }, "x");
  if (state !== "queued") await hub.assign(t.id, "w1");
  if (["running", "done", "need-info", "failed", "accepted", "rejected"].includes(state)) {
    await hub.claim(t.id, "w1");
    if (state === "need-info") await hub.ask(t.id, "w1", "why?");
    else if (state === "failed") await hub.fail(t.id, "w1", "boom");
    else if (state !== "running") {
      await hub.report(t.id, "w1", { report: "r", ...(patch ? { patch } : {}) });
      if (state === "accepted") await hub.accept(t.id, { ok: true, log: "ok" });
      if (state === "rejected") await hub.accept(t.id, { ok: false, log: "no" });
    }
  }
  if (state === "cancelled") await hub.cancel(t.id);
  return t.id;
};

test("setup + first wait just establishes the baseline and times out", async () => {
  hub = new Hub({ remote: join(tmp, "hub.git"), workdir: join(tmp, "clone") });
  await hub.init();
  const id = await driveTo("baseline task", "assigned");
  const r = await waitForEvents(hub, { timeoutSec: 1, cursor: "c1", pollMs: 100 });
  assert.equal(r.timedOut, true);
  assert.deepEqual(r.lines, []);
  assert.ok(existsSync(cursorFile("c1")));
  await hub.cancel(id); // keep it non-active for the later idle tests
});

test("change fires on any state change with the documented line format", async () => {
  const id = await driveTo("watch me", "assigned");
  await waitForEvents(hub, { timeoutSec: 1, cursor: "c2", pollMs: 100 }); // baseline
  await hub.claim(id, "w1");
  const r = await waitForEvents(hub, { until: "change", timeoutSec: 5, cursor: "c2", pollMs: 100 });
  assert.equal(r.timedOut, false);
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0], new RegExp(`^${id} running w1 - "watch me"$`));
  await hub.report(id, "w1", { report: "r" });
  await hub.accept(id, { ok: true, log: "ok" }); // leave nothing active behind
});

test("attention fires on failed and carries the note", async () => {
  const id = await driveTo("will fail", "assigned");
  await waitForEvents(hub, { timeoutSec: 1, cursor: "c3", pollMs: 100 }); // baseline
  await hub.claim(id, "w1");
  await hub.fail(id, "w1", "tests exploded");
  const r = await waitForEvents(hub, { timeoutSec: 5, cursor: "c3", pollMs: 100 });
  assert.equal(r.timedOut, false);
  assert.match(r.lines[0], new RegExp(`^${id} failed w1 - "will fail" tests exploded$`));
});

test("idle fires when nothing is active and lists accepted tasks with diffstat", async () => {
  const id = await driveTo("accepted one", "assigned");
  await waitForEvents(hub, { timeoutSec: 1, cursor: "c4", pollMs: 100 }); // baseline (assigned = active)
  await hub.claim(id, "w1");
  await hub.report(id, "w1", { report: "r", patch: "--- a/f\n+++ b/f\n@@\n+hello\n-world\n" });
  await hub.accept(id, { ok: true, log: "ok" });
  const r = await waitForEvents(hub, { timeoutSec: 5, cursor: "c4", pollMs: 100 });
  assert.equal(r.timedOut, false);
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0], new RegExp(`^${id} accepted w1 \\+1/-1 "accepted one"$`));
});

test("until=idle fires when the hub empties of active work", async () => {
  const id = await driveTo("idle only", "running");
  await waitForEvents(hub, { timeoutSec: 1, cursor: "c5", pollMs: 100 }); // baseline (running = active)
  await hub.ask(id, "w1", "hmm?"); // -> need-info: nothing queued/assigned/running any more
  const idle = await waitForEvents(hub, { until: "idle", timeoutSec: 5, cursor: "c5", pollMs: 100 });
  assert.equal(idle.timedOut, false);
  assert.deepEqual(idle.lines, ["IDLE"]); // nothing accepted since the cursor: bare idle marker
});

test("a plain change that is neither attention nor idle does not wake the master", async () => {
  const id = await driveTo("plain change", "queued");
  await waitForEvents(hub, { timeoutSec: 1, cursor: "c6", pollMs: 100 }); // baseline (queued = active)
  await hub.assign(id, "w1"); // queued -> assigned: still active, nothing to report
  const r = await waitForEvents(hub, { timeoutSec: 2, cursor: "c6", pollMs: 100 });
  assert.equal(r.timedOut, true);
  assert.deepEqual(r.lines, []);
});

test("lines are capped at 200 chars", async () => {
  const id = await driveTo("L".repeat(300), "assigned");
  await waitForEvents(hub, { timeoutSec: 1, cursor: "c7", pollMs: 100 });
  await hub.claim(id, "w1");
  const r = await waitForEvents(hub, { until: "change", timeoutSec: 5, cursor: "c7", pollMs: 100 });
  assert.ok(r.lines[0].length <= 200);
});

test("diffEvents unit behavior", () => {
  const t = (id, state) => ({ id, state, spec: { title: id } });
  const ev = diffEvents({ a: "queued", b: "done" }, [t("a", "assigned"), t("b", "done"), t("c", "queued")]);
  assert.deepEqual(ev.changes.map((x) => x.id), ["a", "c"]); // b unchanged, c new
  assert.equal(ev.idle, false);
  const ev2 = diffEvents({ a: "running" }, [t("a", "accepted")]);
  assert.deepEqual(ev2.accepted.map((x) => x.id), ["a"]);
  assert.equal(ev2.idle, true);
  const ev3 = diffEvents({ a: "accepted" }, [t("a", "accepted")]);
  assert.equal(ev3.idle, false); // no change -> did not "become" idle
});

test("invalid until is rejected", async () => {
  await assert.rejects(waitForEvents(hub, { until: "nope", timeoutSec: 1, cursor: "c8" }), /--until/);
});
