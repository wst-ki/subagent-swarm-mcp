// Worker<->supervisor channel tests: append/read on one stream (two clones racing), bin/hub
// say/inbox round trips through sh, dispatch tell/log/watch exit codes, and the per-worker
// staleSec override. Temp bare repo + real git; nothing touches ~/dispatch or ~/.zcode.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const tmp = mkdtempSync(join(tmpdir(), "hubchan-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const emptyCfg = join(tmp, "empty.gitconfig");
writeFileSync(emptyCfg, "");
process.env.GIT_CONFIG_GLOBAL = emptyCfg;
process.env.GIT_CONFIG_SYSTEM = emptyCfg;
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "test";
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "test@test";

const { Hub } = await import("../src/hub/tasks.mjs");

const root = fileURLToPath(new URL("..", import.meta.url));
const remote = join(tmp, "hub.git");
const stateDir = join(tmp, "state");
const work = join(tmp, "work");
const workerHub = join(tmp, "workerhub");

const run = (cmd, args, env = {}) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
};
const sh = (args, env = {}) => run("sh", [join(workerHub, "bin", "hub"), ...args], { HUB_DIR: workerHub, HUB_WORK: work, ...env });
const cli = (args) =>
  spawnSync("node", [join(root, "bin", "dispatch.mjs"), ...args], {
    encoding: "utf8",
    env: { ...process.env, HUB_REMOTE: remote, HUB_WORKDIR: join(tmp, "cliwork"), ZCODE_MCP_STATE_DIR: stateDir },
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const driveTo = async (title, state) => {
  const t = await hub.post({ title, timeoutMin: 30 }, "x");
  await hub.assign(t.id, "mac-test");
  await hub.claim(t.id, "mac-test");
  if (state === "done") await hub.report(t.id, "mac-test", { report: "r" });
  if (state === "need-info") await hub.ask(t.id, "mac-test", "which db?");
  return t.id;
};

let hub;

test("setup: seeded hub + worker clone", async () => {
  hub = new Hub({ remote, workdir: join(tmp, "mainclone") });
  await hub.init();
  run("git", ["clone", "-q", remote, workerHub]);
});

test("say/tell: oldest first, after=sha, newline collapse, 300-char cap, no such task", async () => {
  const t = await hub.post({ title: "chan basics" }, "x");
  const s1 = await hub.say(t.id, "mac-test", "line one");
  const s2 = await hub.say(t.id, "mac-test", "line\n\n two  with\nnewlines");
  const s3 = await hub.tell(t.id, "master", "use sqlite");
  assert.ok(s1 && s2 && s3);
  const prog = await hub.messages(t.id, "progress");
  assert.deepEqual(prog.map((m) => m.text), ["line one", "line two with newlines"]);
  assert.ok(prog.every((m) => m.from === "mac-test"));
  assert.ok(prog[0].at <= prog[1].at);
  assert.deepEqual((await hub.messages(t.id, "inbox")).map((m) => [m.from, m.text]), [["master", "use sqlite"]]);
  assert.deepEqual((await hub.messages(t.id, "progress", { after: s1 })).map((m) => m.text), ["line two with newlines"]);
  assert.deepEqual(await hub.messages(t.id, "inbox", { after: s3 }), []);
  assert.equal((await hub.messages(t.id, "progress", { after: "unknown" })).length, 2); // unknown after -> all
  await hub.tell(t.id, "master", "x".repeat(400));
  assert.equal((await hub.messages(t.id, "inbox")).at(-1).text.length, 300);
  await assert.rejects(hub.tell("T00000000-000000-zz", "master", "x"), /no such task/);
  await assert.rejects(hub.say(t.id, "mac-test", " \n "), /empty/);
});

test("two clones racing appends on one stream: both land as one linear chain", async () => {
  const t = await hub.post({ title: "race" }, "x");
  const cloneB = new Hub({ remote, workdir: join(tmp, "cloneB") });
  await cloneB.init();
  const [a, b] = await Promise.allSettled([
    hub.tell(t.id, "master", "from A"),
    cloneB.tell(t.id, "supervisor", "from B"),
  ]);
  assert.equal(a.status, "fulfilled");
  assert.equal(b.status, "fulfilled");
  const msgs = await cloneB.messages(t.id, "inbox");
  assert.equal(msgs.length, 2);
  assert.deepEqual(new Set(msgs.map((m) => m.from)), new Set(["master", "supervisor"]));
  assert.equal(run("git", ["-C", remote, "rev-list", "--count", `refs/inbox/${t.id}`]).trim(), "2");
  assert.deepEqual((await hub.messages(t.id, "inbox")).map((m) => m.from), msgs.map((m) => m.from));
});

test("bin/hub say: progress via sh, heartbeat, each inbox message printed exactly once", async () => {
  const t = await hub.post({ title: "sh say" }, "x");
  await hub.tell(t.id, "master", "please use tabs");
  const beatStart = Math.floor(Date.now() / 1000) * 1000;
  const out = sh(["say", "mac-test", t.id, "cloned", "the", "repo"]);
  assert.match(out.trim(), /^INBOX \d{4}-\d{2}-\d{2} \d{2}:\d{2} master: please use tabs$/);
  assert.deepEqual((await hub.messages(t.id, "progress")).map((m) => [m.from, m.text]), [["mac-test", "cloned the repo"]]);
  const beat = await hub.lastSeen("mac-test");
  assert.ok(beat >= beatStart && beat <= Date.now(), "say must heartbeat during the command");
  assert.equal(sh(["say", "mac-test", t.id, "second line"]).trim(), ""); // inbox already seen
  assert.equal((await hub.messages(t.id, "progress")).length, 2);
});

test("bin/hub inbox: tell from Node, read via sh, seen marker advances per task", async () => {
  const t = await hub.post({ title: "sh inbox" }, "x");
  await hub.tell(t.id, "master", "one");
  await hub.tell(t.id, "supervisor", "two");
  const lines = sh(["inbox", "mac-test", t.id]).trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^INBOX \d{4}-\d{2}-\d{2} \d{2}:\d{2} master: one$/);
  assert.match(lines[1], /^INBOX \d{4}-\d{2}-\d{2} \d{2}:\d{2} supervisor: two$/);
  const beatStart = Math.floor(Date.now() / 1000) * 1000;
  assert.equal(sh(["inbox", "mac-test", t.id]).trim(), "");
  const beat = await hub.lastSeen("mac-test");
  assert.ok(beat >= beatStart && beat <= Date.now(), "inbox must heartbeat during the command");
});

test("bin/hub next prints unread INBOX lines right after the TASK line", async () => {
  const t = await hub.post({ title: "next inbox", kind: "text" }, "x");
  await hub.assign(t.id, "mac-test");
  await hub.tell(t.id, "master", "prefer sqlite");
  const out = sh(["next", "mac-test", "--wait", "5"]);
  const lines = out.trim().split("\n");
  assert.match(lines[0], new RegExp(`^TASK ${t.id} `));
  assert.equal(lines.length, 2, `unexpected output: ${out}`);
  assert.match(lines[1], /^INBOX \d{4}-\d{2}-\d{2} \d{2}:\d{2} master: prefer sqlite$/);
  assert.equal((await hub.get(t.id)).state, "running");
  sh(["fail", "mac-test", t.id, "cleanup"]); // stop the background heartbeat loop
});

test("watch: exit 0 with FINAL when every watched task is final", async () => {
  const id = await driveTo("final soon", "done");
  const r = cli(["watch", id, "--timeout", "30", "--cursor", "w7"]);
  assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.ok(r.stdout.includes(`${id} FINAL done`));
});

test("watch: exit 3 on need-info with the question", async () => {
  const id = await driveTo("will ask", "need-info");
  const r = cli(["watch", id, "--timeout", "30", "--cursor", "w8"]);
  assert.equal(r.status, 3, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.ok(r.stdout.includes(`${id} ATTENTION need-info: which db?`));
});

test("watch: exit 4 on timeout, cursor suppresses reprinted progress", async () => {
  const id = await driveTo("slow one", "running");
  await hub.say(id, "mac-test", "halfway there");
  const r1 = cli(["watch", id, "--timeout", "2", "--cursor", "w9"]);
  assert.equal(r1.status, 4, `stdout: ${r1.stdout}\nstderr: ${r1.stderr}`);
  assert.ok(r1.stdout.includes(`${id} PROGRESS`), "first round prints the progress line");
  assert.ok(r1.stdout.includes(`${id} RUNNING running, last progress`));
  const r2 = cli(["watch", id, "--timeout", "2", "--cursor", "w9"]);
  assert.equal(r2.status, 4);
  assert.ok(!r2.stdout.includes("PROGRESS"), `cursor must suppress reprints: ${r2.stdout}`);
  await hub.fail(id, "mac-test", "watch test over");
});

test("watch: exit 2 on usage errors", async () => {
  assert.equal(cli(["watch"]).status, 2);
  assert.equal(cli(["watch", "T00000000-000000-zz"]).status, 2);
});

test("dispatch tell + log round trip", async () => {
  const id = await driveTo("tell me", "running");
  await hub.say(id, "mac-test", "halfway");
  assert.equal(cli(["tell", id, "--text", "nudge: run the tests", "--from", "supervisor"]).status, 0);
  assert.equal(cli(["tell", id, "--text", "master says hi"]).status, 0); // default from master
  assert.deepEqual(
    (await hub.messages(id, "inbox")).map((m) => [m.from, m.text]),
    [
      ["supervisor", "nudge: run the tests"],
      ["master", "master says hi"],
    ],
  );
  const lg = cli(["log", id]);
  assert.equal(lg.status, 0, `stderr: ${lg.stderr}`);
  const lines = lg.stdout.trim().split("\n");
  assert.ok(lines.length >= 6);
  assert.match(lines[0], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} post /);
  assert.ok(lines.some((l) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} claim /.test(l)));
  assert.ok(lines.some((l) => l.endsWith("PROGRESS mac-test: halfway")));
  assert.ok(lines.some((l) => l.endsWith("INBOX supervisor: nudge: run the tests")));
  assert.match(lines.at(-1), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} INBOX master: master says hi$/);
  await hub.fail(id, "mac-test", "tell test over");
});

test("watch: exit 3 when a running worker's heartbeat is older than half its staleSec", async () => {
  await hub.repo.mutate(async () => {
    writeFileSync(
      hub.repo.path("workers.json"),
      JSON.stringify({
        workers: [
          { id: "mac-test", kind: "manual", host: "mac", tier: "high", maxParallel: 1, enabled: true, kinds: ["text"], staleSec: 2 },
          { id: "w-fast", kind: "manual", host: "mac", tier: "mid", maxParallel: 1, enabled: true, kinds: ["text"], staleSec: 5 },
          { id: "w-slow", kind: "manual", host: "mac", tier: "mid", maxParallel: 1, enabled: true, kinds: ["text"] },
        ],
      }),
    );
    return "roster with staleSec";
  });
  const id = await driveTo("quiet worker", "running");
  await hub.heartbeat("mac-test");
  await sleep(1300); // older than half of mac-test's staleSec (2s), younger than the quiet default
  const r = cli(["watch", id, "--timeout", "30", "--cursor", "w12"]);
  assert.equal(r.status, 3, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.ok(r.stdout.includes(`${id} ATTENTION heartbeat stale`));
  await hub.fail(id, "mac-test", "heartbeat test over");
});

test("expireStale: per-worker staleSec overrides HUB_STALE_SEC", async () => {
  await hub.heartbeat("w-fast");
  await hub.heartbeat("w-slow");
  const fast = await hub.post({ title: "override fast", timeoutMin: 30 }, "x");
  await hub.assign(fast.id, "w-fast");
  await hub.claim(fast.id, "w-fast");
  const slow = await hub.post({ title: "default slow", timeoutMin: 30 }, "x");
  await hub.assign(slow.id, "w-slow");
  await hub.claim(slow.id, "w-slow");
  const at6s = await hub.expireStale(Date.now() + 6_000);
  assert.ok(at6s.includes(fast.id), "6s silence beats staleSec 5");
  assert.ok(!at6s.includes(slow.id), "6s silence must not beat the 300s default");
  assert.equal((await hub.get(fast.id)).state, "queued");
  assert.equal((await hub.get(slow.id)).state, "running");
  const at301s = await hub.expireStale(Date.now() + 301_000);
  assert.ok(at301s.includes(slow.id), "301s silence beats the 300s default");
});
