// bin/hub end-to-end against a temp hub: real git, a temp bare repo, a worker clone, and a work
// repo for the code task. Also a bin/dispatch.mjs smoke test. Nothing touches ~/dispatch or ~/.zcode.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const tmp = mkdtempSync(join(tmpdir(), "hubsh-"));
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

let hub;
let proj;
let base;

test("setup: seeded hub, worker clone, work repo", async () => {
  hub = new Hub({ remote, workdir: join(tmp, "mainclone") });
  await hub.init();
  run("git", ["clone", "-q", remote, workerHub]);
  assert.ok(existsSync(join(workerHub, "bin", "hub")));

  proj = join(tmp, "proj");
  mkdirSync(proj);
  run("git", ["-C", proj, "init", "-q"]);
  writeFileSync(join(proj, "a.txt"), "v1\n");
  run("git", ["-C", proj, "add", "-A"]);
  run("git", ["-C", proj, "commit", "-q", "-m", "init"]);
  base = run("git", ["-C", proj, "rev-parse", "HEAD"]).trim();
});

test("next claims the assigned task, clones the repo at base, prints TASK", async () => {
  const t = await hub.post({ title: "fix a", kind: "code", repo: proj, base, timeoutMin: 10 }, "make a better");
  await hub.assign(t.id, "mac-test", "test assign");
  const out = sh(["next", "mac-test", "--wait", "5"]);
  const m = out.trim().match(/^TASK (\S+) (\S+) (\S+)$/);
  assert.ok(m, `unexpected output: ${out}`);
  assert.equal(m[1], t.id);
  assert.equal(m[2], join(work, t.id));
  assert.equal(m[3], join(workerHub, "tasks", t.id, "task.md"));
  assert.equal(readFileSync(m[3], "utf8"), "make a better");
  const cur = await hub.get(t.id);
  assert.equal(cur.state, "running");
  assert.equal(cur.assignee, "mac-test");
  assert.equal(cur.attempts, 1);
  const nowSec = Math.floor(Date.now() / 1000);
  assert.ok(cur.lease > nowSec + 9 * 60, `lease ${cur.lease}`);
  assert.equal(readFileSync(join(work, t.id, "a.txt"), "utf8"), "v1\n"); // detached checkout at base
  assert.equal(run("git", ["-C", join(work, t.id), "rev-parse", "HEAD"]).trim(), base);
});

test("done packages REPORT.md + patch (excluding REPORT.md) and the patch applies at base", async () => {
  const id = (await hub.list()).find((t) => t.state === "running").id;
  const wd = join(work, id);
  writeFileSync(join(wd, "REPORT.md"), "## Result\nok\n## Changes\nfixed a\n");
  writeFileSync(join(wd, "a.txt"), "v2\n");
  writeFileSync(join(wd, "b.txt"), "brand new\n");
  const out = sh(["done", "mac-test", id]);
  assert.match(out, new RegExp(`^done ${id}`));
  const cur = await hub.get(id);
  assert.equal(cur.state, "done");
  assert.equal(await hub.readTaskFile(id, "result/report.md"), "## Result\nok\n## Changes\nfixed a\n");
  const patch = await hub.readTaskFile(id, "result/patch.diff");
  assert.ok(patch.includes("b.txt"));
  assert.ok(patch.includes("-v1"));
  assert.ok(patch.includes("+v2"));
  assert.ok(!patch.includes("REPORT.md"), "REPORT.md must not be in the patch");
  const verify = mkdtempSync(join(tmp, "hubpatch-"));
  run("git", ["-C", verify, "init", "-q"]);
  run("git", ["-C", verify, "fetch", "-q", proj, base]);
  run("git", ["-C", verify, "checkout", "-q", "--detach", "FETCH_HEAD"]);
  const applied = spawnSync("git", ["-C", verify, "apply", "-"], { input: patch, encoding: "utf8" });
  assert.equal(applied.status, 0, `patch did not apply: ${applied.stderr}`);
  assert.equal(readFileSync(join(verify, "b.txt"), "utf8"), "brand new\n");
});

test("hb pushes a heartbeat ref visible via lastSeen", async () => {
  sh(["hb", "mac-test"]);
  const seen = await hub.lastSeen("mac-test");
  assert.ok(Math.abs(Date.now() - seen) < 10_000);
});

test("ask -> answer -> reclaim (attempts grows) -> fail -> requeue", async () => {
  const t = await hub.post({ title: "haiku", kind: "text" }, "write a haiku");
  await hub.assign(t.id, "mac-test");
  let out = sh(["next", "mac-test", "--wait", "5"]);
  assert.match(out, new RegExp(`^TASK ${t.id} `));
  assert.ok(existsSync(join(work, t.id)), "text task workdir created");

  sh(["ask", "mac-test", t.id, "what topic?"]);
  let cur = await hub.get(t.id);
  assert.equal(cur.state, "need-info");
  assert.equal(cur.note, "what topic?");
  assert.equal(cur.lease, null);

  await hub.answer(t.id, "the sea");
  cur = await hub.get(t.id);
  assert.equal(cur.state, "assigned");
  assert.equal(await hub.readTaskFile(t.id, "answer.md"), "the sea");

  out = sh(["next", "mac-test", "--wait", "5"]); // comes back to the same worker
  assert.match(out, new RegExp(`^TASK ${t.id} `));
  assert.equal((await hub.get(t.id)).attempts, 2);

  sh(["fail", "mac-test", t.id, "muse left me"]);
  cur = await hub.get(t.id);
  assert.equal(cur.state, "failed");
  assert.equal(cur.note, "muse left me");
  await hub.requeue(t.id);
  assert.equal((await hub.get(t.id)).state, "queued");
});

test("next prints NONE when nothing is assigned to me", () => {
  assert.equal(sh(["next", "mac-test", "--wait", "0"]).trim(), "NONE");
});

test("a second worker clone cannot claim what the first took; state change is visible", async () => {
  const t = await hub.post({ title: "race in sh", kind: "text" }, "x");
  await hub.assign(t.id, "mac-test");
  const workerHub2 = join(tmp, "workerhub2");
  run("git", ["clone", "-q", remote, workerHub2]);
  const first = run("sh", [join(workerHub2, "bin", "hub"), "next", "mac-test", "--wait", "5"], {
    HUB_DIR: workerHub2,
    HUB_WORK: join(tmp, "work2"),
  });
  assert.match(first, new RegExp(`^TASK ${t.id} `), `first clone should win: ${first}`);
  const second = sh(["next", "mac-test", "--wait", "0"]); // same worker, other clone: already running
  assert.equal(second.trim(), "NONE");
  // release the lease from the clone that owns it (also stops its background hb loop)
  run("sh", [join(workerHub2, "bin", "hub"), "fail", "mac-test", t.id, "cleanup"], {
    HUB_DIR: workerHub2,
    HUB_WORK: join(tmp, "work2"),
  });
});

test("dispatch CLI: init/post/board/assign/wait/answer/cancel against the temp hub", async () => {
  const cli = join(root, "bin", "dispatch.mjs");
  const env = { HUB_REMOTE: remote, HUB_WORKDIR: join(tmp, "cliwork"), ZCODE_MCP_STATE_DIR: stateDir };
  run("node", [cli, "init"], env);
  const bodyFile = join(tmp, "body.md");
  writeFileSync(bodyFile, "# Task body\n\nDetails here.\n");
  const id = run("node", [cli, "post", "--title", "cli task", "--kind", "text", "--file", bodyFile], env).trim();
  assert.match(id, /^T\d{8}-\d{6}-[a-z0-9]{2}$/);

  const board = JSON.parse(run("node", [cli, "board", "--all", "--json"], env));
  const posted = board.find((t) => t.id === id);
  assert.equal(posted.spec.title, "cli task");
  assert.equal(posted.state, "queued");

  assert.equal(run("node", [cli, "assign", id, "mac-test", "--reason", "smoke"], env).trim(), "assigned");
  assert.ok(run("node", [cli, "workers"], env).includes("local-zcode-glm53"));

  const waited = spawnSync("node", [cli, "wait", "--timeout", "1", "--cursor", "smoke"], { encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(waited.status, 2, `wait should exit 2 on timeout (stdout: ${waited.stdout})`);
  assert.match(waited.stdout, /timeout/);

  await hub.claim(id, "mac-test"); // drive to need-info via the node Hub, answer through the CLI
  await hub.ask(id, "mac-test", "cli question?");
  assert.equal(run("node", [cli, "answer", id, "--text", "42"], env).trim(), "assigned");
  assert.equal(run("node", [cli, "cancel", id], env).trim(), "cancelled");

  const show = run("node", [cli, "show", id], env);
  assert.ok(show.includes('"state": "cancelled"'));
});
