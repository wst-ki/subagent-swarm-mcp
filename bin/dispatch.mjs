#!/usr/bin/env node
// dispatch — master-side CLI for the hub (see docs/HUB-PLAN.md).
import { readFileSync } from "node:fs";
import { Hub } from "../src/hub/tasks.mjs";
import { formatTaskLine, waitForEvents } from "../src/hub/wait.mjs";
import { taskTimeline, watchTasks } from "../src/hub/watch.mjs";
import { git } from "../src/hub/repo.mjs";

const VALUE_FLAGS = new Set(["accept-timeout",
  "title", "file", "repo", "base", "kind", "tier", "accept", "timeout", "prefer", "avoid",
  "until", "cursor", "text", "reason", "from", "quiet-min",
]);

const USAGE = `usage: dispatch <command> [args]
  init                                  create the hub repo (HUB_REMOTE) and the working clone
  post --title T (--file F | stdin) [--repo R] [--base SHA] [--kind code|text|review]
       [--tier low|mid|high] [--accept CMD] [--accept-timeout MIN] [--timeout MIN] [--prefer w1,w2]
       [--avoid vendor1,...] [--review]       post a task; prints its id
  board [--all] [--json]
  show <id>
  wait [--until attention|change|idle] [--timeout SEC] [--cursor NAME]
       (exit 0 + event lines; exit 2 + "timeout" on timeout; default timeout = forever)
  tell <id> (--file F | --text T) [--from NAME]
                                        append a message to the worker's inbox (default master)
  log <id>                              merged timeline: state changes + PROGRESS + INBOX lines
  watch <id...> [--timeout SEC] [--quiet-min MIN] [--cursor NAME]
                                        blocking supervisor watcher; exit 0 when every task is
                                        final (FINAL lines), 3 on ATTENTION, 4 on timeout, 2 usage
  answer <id> (--file F | --text T)
  cancel <id>
  requeue <id>
  assign <id> <worker> [--reason R]
  workers
  daemon [--once]
  cleanup [--apply]                     preview expired task checkouts; --apply deletes them
env: HUB_REMOTE (default ~/dispatch/hub.git), HUB_WORKDIR (default <stateDir>/hub)`;

function parse(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      out._.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (VALUE_FLAGS.has(key)) {
        if (i + 1 >= args.length) throw new Error(`--${key} needs a value`);
        out[key] = args[++i];
      } else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

const readStdin = () =>
  new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve(null);
    let s = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (s += c));
    process.stdin.on("end", () => resolve(s));
  });

const die = (msg, code = 1) => {
  console.error(String(msg));
  process.exit(code);
};

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd) die(USAGE, 2);

try {
  const hub = new Hub();
  await hub.init(); // idempotent: creates the bare repo + clone only when missing

  switch (cmd) {
    case "init": {
      console.log(`hub ready: remote ${hub.repo.remote}, clone ${hub.repo.workdir}`);
      break;
    }
    case "post": {
      const o = parse(rest);
      const body = o.file ? readFileSync(o.file, "utf8") : await readStdin();
      if (body == null) die("post: no task body (--file F or pipe it via stdin)");
      if (o.kind && !["code", "text", "review"].includes(o.kind)) die(`post: invalid --kind ${o.kind}`);
      if (o.tier && !["low", "mid", "high"].includes(o.tier)) die(`post: invalid --tier ${o.tier}`);
      const firstLine = body.match(/^[^\n]{1,80}/)?.[0]?.trim() ?? "";
      const spec = {
        title: o.title ?? (firstLine || "untitled"),
        kind: o.kind,
        tier: o.tier,
        repo: o.repo,
        base: o.base,
        accept: o.accept,
        timeoutMin: o.timeout === undefined ? undefined : Number(o.timeout),
        acceptTimeoutMin: o["accept-timeout"] === undefined ? undefined : Number(o["accept-timeout"]),
        preferWorkers: o.prefer?.split(",").map((s) => s.trim()).filter(Boolean),
        avoidVendors: o.avoid?.split(",").map((s) => s.trim()).filter(Boolean),
        review: o.review ? true : undefined,
      };
      if (spec.timeoutMin !== undefined && !Number.isFinite(spec.timeoutMin)) die("post: --timeout must be a number of minutes");
      if (spec.repo && !spec.base) spec.base = (await git(spec.repo, ["rev-parse", "HEAD"])).trim() || null;
      console.log((await hub.post(spec, body)).id);
      break;
    }
    case "board": {
      const o = parse(rest);
      const tasks = await hub.list();
      const rows = o.all ? tasks : tasks.filter((t) => !["accepted", "rejected", "cancelled"].includes(t.state));
      if (o.json) console.log(JSON.stringify(rows, null, 2));
      else for (const t of rows) console.log(await formatTaskLine(hub, t));
      break;
    }
    case "show": {
      const [id] = rest;
      if (!id) die("show: missing id");
      const t = await hub.get(id);
      if (!t) die(`no such task ${id}`);
      console.log(JSON.stringify(t, null, 2));
      for (const rel of ["answer.md", "result/report.md", "result/accept.log"]) {
        const c = await hub.readTaskFile(id, rel);
        if (c != null) console.log(`\n--- ${rel} ---\n${c.trim()}`);
      }
      break;
    }
    case "wait": {
      const o = parse(rest);
      const r = await waitForEvents(hub, { until: o.until, timeoutSec: Number(o.timeout ?? 0), cursor: o.cursor });
      for (const l of r.lines) console.log(l);
      if (r.timedOut) {
        console.log("timeout");
        process.exit(2);
      }
      break;
    }
    case "tell": {
      const o = parse(rest);
      const [id] = o._;
      if (!id) die("tell: missing id");
      const text = o.file ? readFileSync(o.file, "utf8") : o.text;
      if (text == null) die("tell: need --file F or --text T");
      console.log(await hub.tell(id, o.from ?? "master", text));
      break;
    }
    case "log": {
      const [id] = rest;
      if (!id) die("log: missing id");
      if (!(await hub.get(id))) die(`no such task ${id}`);
      for (const e of await taskTimeline(hub, id)) console.log(e.line);
      break;
    }
    case "watch": {
      const o = parse(rest);
      const ids = o._;
      if (!ids.length) die(`watch: need at least one task id\n${USAGE}`, 2);
      const timeoutSec = o.timeout === undefined ? 0 : Number(o.timeout);
      const quietMin = o["quiet-min"] === undefined ? 15 : Number(o["quiet-min"]);
      if (!Number.isFinite(timeoutSec) || timeoutSec < 0) die("watch: --timeout must be a number of seconds", 2);
      if (!Number.isFinite(quietMin) || quietMin < 0) die("watch: --quiet-min must be a number of minutes", 2);
      for (const id of ids) if (!(await hub.get(id))) die(`no such task ${id}`, 2);
      const r = await watchTasks(hub, { ids, timeoutSec, quietMin, cursor: o.cursor ?? "watch" });
      process.exitCode = r.code;
      break;
    }
    case "answer": {
      const o = parse(rest);
      const [id] = o._;
      if (!id) die("answer: missing id");
      const text = o.file ? readFileSync(o.file, "utf8") : o.text;
      if (text == null) die("answer: need --file F or --text T");
      console.log((await hub.answer(id, text)).state);
      break;
    }
    case "cancel":
    case "requeue": {
      const [id] = rest;
      if (!id) die(`${cmd}: missing id`);
      console.log((await hub[cmd](id)).state);
      break;
    }
    case "assign": {
      const o = parse(rest);
      const [id, worker] = o._;
      if (!id || !worker) die("assign: need <id> <worker>");
      console.log((await hub.assign(id, worker, o.reason ?? "manual override")).state);
      break;
    }
    case "workers": {
      for (const w of await hub.workers())
        console.log(
          `${w.id} ${w.kind} ${w.host} vendor=${w.vendor ?? "-"} tier=${w.tier} model=${w.model ?? "-"} online=${w.online} busy=${w.busy}/${w.maxParallel}` +
            (w.enabled === false ? " DISABLED" : "") +
            (w.note ? `\n    note: ${w.note}` : ""),
        );
      break;
    }
    case "daemon": {
      let runDaemon;
      try {
        ({ runDaemon } = await import("../src/hub/daemon.mjs"));
      } catch {
        die("daemon: src/hub/daemon.mjs not available (part B)");
      }
      await runDaemon({ once: parse(rest).once === true });
      break;
    }
    case "cleanup": {
      if (rest.some((a) => !["--apply", "--dry-run"].includes(a)) || (rest.includes("--apply") && rest.includes("--dry-run"))) {
        die("cleanup: use --dry-run (default) or --apply", 2);
      }
      const { acquireDaemonLock, releaseDaemonLock } = await import("../src/hub/daemon.mjs");
      const { cleanupWorkdirs } = await import("../src/hub/cleanup.mjs");
      const lock = acquireDaemonLock();
      try {
        const result = await cleanupWorkdirs(hub, { dryRun: !rest.includes("--apply") });
        console.log(JSON.stringify(result, null, 2));
        if (result.errors.length) process.exitCode = 1;
      } finally {
        releaseDaemonLock(lock);
      }
      break;
    }
    default:
      die(`unknown command: ${cmd}\n${USAGE}`, 2);
  }
} catch (e) {
  die(e?.message ?? e);
}
