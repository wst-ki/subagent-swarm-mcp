// Git plumbing for the dispatch hub: the bare repo is the only shared state; every writer keeps a
// working clone and mutates via fetch -> reset --hard -> edit -> commit -> push, retrying races.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Thrown when a mutation's precondition no longer holds after re-syncing (someone won the race),
// or when another writer pushed a byte-identical mutation first.
export class HubConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "HubConflictError";
  }
}

// git in `cwd` (null = process cwd); `ok` lists exit codes treated as "empty output, not an error";
// `date` forces the author date (ms); `capture` returns { stdout, stderr } instead of just stdout.
export async function git(cwd, args, { ok = [], actor, date, capture } = {}) {
  const env = { ...process.env };
  if (actor) {
    env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = actor;
    env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = `${actor}@hub`;
  }
  if (date !== undefined) env.GIT_AUTHOR_DATE = `@${Math.floor(date / 1000)}`;
  try {
    const { stdout, stderr } = await run("git", args, { cwd: cwd ?? undefined, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return capture ? { stdout, stderr } : stdout;
  } catch (e) {
    if (ok.includes(e.code)) return capture ? { stdout: "", stderr: "" } : "";
    throw new Error(`git ${args.join(" ")}: ${String(e.stderr || e.message).trim().slice(0, 500)}`);
  }
}

const isLocalPath = (remote) => remote.startsWith("/") || remote.startsWith("./") || remote.startsWith("../");

export class Repo {
  constructor({ remote, workdir, actor = "dispatch" }) {
    this.remote = remote;
    this.workdir = workdir;
    this.actor = actor;
  }

  path(...parts) {
    return join(this.workdir, ...parts);
  }

  #git(args, opts = {}) {
    return git(this.workdir, args, { actor: this.actor, ...opts });
  }

  // Create the bare repo (local paths only) and seed it from the kit dir if it has no commits,
  // then make sure the working clone exists on branch main.
  async init({ kit } = {}) {
    if (isLocalPath(this.remote) && !existsSync(this.remote)) {
      mkdirSync(dirname(this.remote), { recursive: true });
      await git(null, ["-c", "init.defaultBranch=main", "init", "--bare", "--quiet", this.remote]);
    }
    if (isLocalPath(this.remote) && kit) {
      const seeded = await git(this.remote, ["for-each-ref", "--format=%(refname)", "refs/heads/main"]);
      if (!seeded.trim()) await this.#seed(kit);
    }
    if (!existsSync(join(this.workdir, ".git"))) {
      mkdirSync(dirname(this.workdir), { recursive: true });
      await git(dirname(this.workdir), ["clone", "--quiet", this.remote, basename(this.workdir)]);
    }
    // Every heartbeat and lost CAS race leaves an unreachable commit behind (~15k loose objects a
    // day); with git's default 2-week expiry auto-gc can't drop them and warns on every command.
    // Not "now": the CLI and the daemon share this clone, so objects being written must survive.
    await this.#git(["config", "gc.pruneExpire", "1.hour.ago"]);
  }

  async #seed(kit) {
    const tmp = mkdtempSync(join(tmpdir(), "hub-seed-"));
    try {
      const seed = join(tmp, "seed");
      await git(tmp, ["clone", "--quiet", this.remote, "seed"]);
      cpSync(join(kit, "PROTOCOL.md"), join(seed, "PROTOCOL.md"));
      cpSync(join(kit, "SCHEDULER.md"), join(seed, "SCHEDULER.md"));
      cpSync(join(kit, "workers.example.json"), join(seed, "workers.json"));
      cpSync(join(kit, "bin"), join(seed, "bin"), { recursive: true });
      chmodSync(join(seed, "bin", "hub"), 0o755);
      await git(seed, ["add", "-A"]);
      await git(seed, ["commit", "--quiet", "-m", "hub: init (protocol, scheduler, roster, bin/hub)"], { actor: this.actor });
      await git(seed, ["push", "--quiet", "origin", "HEAD:main"]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  async sync() {
    await this.#git(["fetch", "--quiet", "origin"]);
    await this.#git(["reset", "--quiet", "--hard", "origin/main"]);
    await this.#git(["clean", "--quiet", "-fd"]);
  }

  // Compare-and-swap mutation: fn must re-check its preconditions against the freshly reset tree,
  // write files and return a commit message (or { message }); throwing aborts without pushing.
  // A lost push race is retried after re-syncing (8 times, small backoff).
  async mutate(fn, { retries = 8 } = {}) {
    for (let i = 0; ; i++) {
      await this.sync();
      let message;
      try {
        message = await fn(this.workdir);
        if (message && typeof message === "object") message = message.message;
      } catch (e) {
        await this.sync().catch(() => {}); // discard partial writes
        throw e;
      }
      await this.#git(["add", "-A"]);
      if ((await this.#git(["status", "--porcelain"])).trim()) {
        await this.#git(["commit", "--quiet", "-m", message ?? "hub update"]);
        let pushed;
        try {
          pushed = await this.#git(["push", "origin", "HEAD:main"], { capture: true });
        } catch (e) {
          if (i >= retries) throw e;
          await sleep(200 + Math.floor(Math.random() * 500));
          continue;
        }
        // We only ever push fresh commits; "up to date" means another writer pushed a
        // byte-identical mutation first (same tree/message/second) and we did not win.
        if (/up-to-date/.test(`${pushed.stdout}${pushed.stderr}`))
          throw new HubConflictError("lost a concurrent identical mutation race");
      }
      return;
    }
  }

  // Heartbeats never touch main: force-push an empty-tree commit below refs/hb/<workerId>
  // whose message is the unix time in seconds. Retried: the same worker heartbeating from two
  // places races on the remote ref lock.
  async heartbeat(workerId) {
    const tree = (await this.#git(["hash-object", "-w", "-t", "tree", "/dev/null"])).trim();
    const sha = (await this.#git(["commit-tree", tree, "-m", String(Math.floor(Date.now() / 1000))])).trim();
    for (let i = 0; ; i++) {
      try {
        await this.#git(["push", "--quiet", "--force", "origin", `${sha}:refs/hb/${workerId}`]);
        return;
      } catch (e) {
        if (i >= 2) throw e;
        await sleep(1000);
      }
    }
  }

  // Map workerId -> heartbeat time in ms. Fetches all hb refs first; empty when none exist.
  async heartbeatTimes() {
    await this.#git(["fetch", "--quiet", "--force", "origin", "+refs/hb/*:refs/hb/*"]);
    const out = await this.#git(["for-each-ref", "--format=%(refname) %(contents:subject)", "refs/hb/"]);
    const times = new Map();
    for (const line of out.split("\n")) {
      const m = line.match(/^refs\/hb\/(\S+) (\d+)$/);
      if (m) times.set(m[1], Number(m[2]) * 1000);
    }
    return times;
  }

  // Last commit time (ms) touching a path, from the currently checked-out history.
  async lastCommitMs(path) {
    const out = await this.#git(["log", "-1", "--format=%ct", "--", path]);
    return Number(out) * 1000 || 0;
  }
}
