// Local hub runner: claims tasks assigned to local workers (zcode / cli), prepares a working dir,
// launches the worker, and turns its outcome into report / ask / fail (plus quota cooldown).
import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { config } from "../config.mjs";
import { localExtension } from "../local-loader.mjs";
import { setCooldown } from "./scheduler.mjs";
import { prepareCheckout } from "./checkout.mjs";
import { readLogTail, workerLogLimit } from "./worker-log.mjs";

const exec = promisify(execFile);
const git = (cwd, ...args) => exec("git", args, { cwd, maxBuffer: 100 * 1024 * 1024 });
const QUOTA_RE = /usage limit|rate limit|429|quota/i;
const LOCAL_KINDS = new Set(["zcode", "cli"]);
const WORKER_WRAPPER = fileURLToPath(new URL("../../bin/hub-worker.mjs", import.meta.url));

export function workdirFor(task, worker, dirs) {
  return worker.kind === "zcode" ? join(dirs.zcodeProjectDir, "hub", task.id) : join(dirs.stateDir, "work", task.id);
}

export function renderPrompt({ taskMd, answerMd, workdir, kind, env = process.env }) {
  let p = `${String(taskMd ?? "").trim()}\n\n`;
  if (answerMd && String(answerMd).trim()) p += `## Master's answer\n\n${String(answerMd).trim()}\n\n`;
  p += `## Working directory\n\n${workdir}\n\n`;
  const workdirRule =
    (env.HUB_WORKDIR_RULE ?? localExtension.LOCAL_WORKDIR_RULE ?? "").trim() ||
    "Work only inside the working directory above.";
  const hostPolicy = (env.HUB_HOST_POLICY ?? localExtension.LOCAL_HOST_POLICY ?? "").trim();
  p += `## Rules\n\n` +
    `- ${workdirRule}\n` +
    `- Do not commit, do not push; leave your changes as plain files.\n` +
    (hostPolicy ? `- Host policy: ${hostPolicy}\n` : "") +
    `- If this directory contains .git, use the prepared checkout; do not clone another copy of the repo.\n` +
    `- Run only checks relevant to the task. Install dependencies only when required for those checks; prefer the repo's package manager and shared download store, and filtered installs for the affected workspace when supported.\n` +
    `- Reuse the configured global package cache/store. Do not create a separate package store under /tmp or a second dependency tree just for this task.\n` +
    (kind === "review" ? `- This is a read-only review. Source is prepared at the base commit; inspect the supplied patch without modifying source or installing dependencies unless the task explicitly requests checks.\n` : "") +
    `- Finish by writing REPORT.md in the working directory root with exactly these headings:\n` +
    `  ## Result\n  ## Changes\n  ## Checks run\n  ## Open questions\n` +
    `- Be concise: facts, paths, check outcomes and blockers only. Keep all details needed to verify the result.\n` +
    `- If you must ask the master a question, write only the "## Open questions" heading (with your questions) in REPORT.md and stop.\n`;
  return p;
}

// Real adapters, loaded lazily so tests can import this module without ZCode side effects.
function defaultAdapters() {
  const z = () => import("../zcode.mjs");
  const store = () => import("../store.mjs");
  return {
    zcode: {
      runTask: (args) => z().then((m) => m.runTask(args)),
      followUp: (args) => z().then((m) => m.followUp(args)),
      taskStatus: (sid) => store().then((m) => m.taskStatus(sid)),
      getResult: (sid) => z().then((m) => m.getResult(sid)),
      cancelTask: (sid) => z().then((m) => m.cancelTask(sid)),
    },
  };
}

function section(text, name) {
  const re = new RegExp(`^##\\s+${name}\\s*\\r?\\n([\\s\\S]*?)(?=\\r?\\n#{1,6}\\s|$)`, "im");
  return (String(text ?? "").match(re)?.[1] ?? "").trim();
}

const tail = (s, n = 80) => String(s ?? "").split("\n").slice(-n).join("\n").trim();
const firstLine = (s, n = 200) =>
  String(s ?? "").split("\n").map((l) => l.trim()).find(Boolean)?.slice(0, n) ?? "";

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

async function buildPatch(workdir, base, log) {
  try {
    // Exclude before staging: otherwise large worker logs become Git blobs even though the
    // subsequent diff excludes them. This matters especially with a shared object database.
    await git(workdir, "add", "-A", "--", ".", ":(exclude)REPORT.md", ":(exclude).hub-out.log");
    const { stdout } = await git(workdir, "diff", "--cached", "--binary", base, "--", ":(exclude)REPORT.md", ":(exclude).hub-out.log");
    return stdout.trim() ? stdout : null;
  } catch (e) {
    log(`patch for ${workdir}: ${e.message}`);
    return null;
  }
}

async function requeue(hub, task, note, message) {
  try {
    await hub.transition(task.id, {
      from: ["running"],
      to: "queued",
      set: { assignee: "", lease: null, note: note.slice(0, 200) },
      message,
    });
  } catch (e) {
    // lost a race (task moved on) — nothing to do
  }
}

async function finishRun(hub, task, run, { status, text, dirs, log }) {
  const spec = task.spec ?? {};
  const workdir = run.workdir;
  const reportFile = existsSync(join(workdir, "REPORT.md")) ? readFileSync(join(workdir, "REPORT.md"), "utf8") : null;
  const logText = readLogTail(join(workdir, ".hub-out.log"));
  const patch = spec.kind === "code" && spec.repo ? await buildPatch(workdir, spec.base, log) : null;
  const report = reportFile ?? (text?.trim() ? text : tail(logText) || `(worker ${status})`);

  // Only failed runs or runs that left no REPORT.md can be quota hits; a finished report that
  // merely mentions "quota" or "429" must not requeue the task forever.
  if ((status !== "completed" || !reportFile) && QUOTA_RE.test(`${text ?? ""}\n${tail(logText, 20)}`)) {
    setCooldown(dirs.stateDir, run.workerId);
    await requeue(hub, task, "worker hit a usage/rate limit; cooling down 60 min", `requeue ${task.id}: quota`);
    return;
  }
  if (status === "failed" || status === "cancelled" || status === "unknown") {
    await hub.fail(task.id, run.workerId, `${status}: ${firstLine(text || report) || status}`);
    return;
  }
  // Workers fill the heading with "None." etc. when they have nothing to ask; reviews never ask.
  const questions = reportFile ? section(reportFile, "Open questions") : "";
  const asks = questions && !/^[\s\-*_]*(none|n\/?a|no(ne)?\s+questions?|nothing|无|没有)?[\s.。!]*$/i.test(questions);
  if (asks && !patch && spec.kind !== "review") {
    await hub.ask(task.id, run.workerId, questions.replace(/\s+/g, " ").slice(0, 300));
    return;
  }
  await hub.report(task.id, run.workerId, { report, patch });
}

async function startTask(hub, task, worker, { adapters, state, dirs, log }) {
  try {
    await hub.claim(task.id, worker.id);
  } catch (e) {
    log(`claim ${task.id}: ${e.message}`);
    return;
  }
  const workdir = workdirFor(task, worker, dirs);
  try {
    // A zcode task that already has a live session (e.g. after answer) continues it.
    const prevRun = await hub.readTaskFile(task.id, "run");
    let followSid = null;
    if (worker.kind === "zcode" && prevRun?.startsWith("zcode:")) {
      const sid = prevRun.slice("zcode:".length).trim();
      const st = await adapters.zcode.taskStatus(sid).catch(() => null);
      if (st && st.status !== "unknown") followSid = sid;
    }
    await prepareCheckout(task, workdir, { fresh: !followSid });
    const prompt = renderPrompt({
      taskMd: (await hub.readTaskFile(task.id, "task.md")) ?? "",
      answerMd: await hub.readTaskFile(task.id, "answer.md"),
      workdir,
      kind: task.spec?.kind,
    });

    if (worker.kind === "zcode") {
      let sid;
      if (followSid) {
        await adapters.zcode.followUp({ taskId: followSid, prompt });
        sid = followSid;
      } else {
        // worker.provider is the billing route (optional; defaults to ZCODE_MCP_PROVIDER).
        const res = await adapters.zcode.runTask({ prompt, model: worker.model, provider: worker.provider });
        if (res?.warning) log(`${task.id}: ${res.warning}`);
        sid = res.taskId;
      }
      await hub.transition(task.id, {
        from: ["running"],
        to: "running",
        files: { run: `zcode:${sid}` },
        message: `run ${task.id} in zcode session ${sid}`,
      });
      state.set(task.id, { taskId: task.id, workerId: worker.id, kind: "zcode", sid, workdir });
    } else {
      let promptPassed = false;
      const argv = [];
      for (const a of worker.cmd ?? []) {
        if (a.includes("{prompt}")) promptPassed = true;
        argv.push(a.replaceAll("{prompt}", prompt).replaceAll("{workdir}", workdir));
      }
      if (!argv.length) throw new Error("cli worker has no cmd");
      mkdirSync(workdir, { recursive: true });
      // The detached wrapper owns log capping, so logging survives a daemon restart.
      const child = spawn(process.execPath, [WORKER_WRAPPER, join(workdir, ".hub-out.log"), String(workerLogLimit()), ...argv], {
        cwd: workdir, detached: true, stdio: [promptPassed ? "ignore" : "pipe", "ignore", "ignore"],
      });
      child.unref();
      if (!promptPassed) {
        child.stdin.on("error", () => {});
        child.stdin.end(prompt);
      }
      const rec = { taskId: task.id, workerId: worker.id, kind: "cli", pid: child.pid, workdir, exited: false, exitCode: null, signal: null };
      child.on("exit", (code, signal) => {
        rec.exited = true;
        rec.exitCode = code;
        rec.signal = signal;
      });
      await hub.transition(task.id, {
        from: ["running"],
        to: "running",
        files: { run: `pid:${child.pid}` },
        message: `run ${task.id} as pid ${child.pid}`,
      });
      state.set(task.id, rec);
    }
  } catch (e) {
    const msg = `start failed: ${e.message}`;
    log(`${task.id}: ${msg}`);
    if (QUOTA_RE.test(msg)) setCooldown(dirs.stateDir, worker.id);
    await requeue(hub, task, msg, `requeue ${task.id}: start failed`);
  }
}

export async function runRunner(hub, { adapters = defaultAdapters(), state = new Map(), dirs = {}, log = () => {} } = {}) {
  const d = { zcodeProjectDir: config.projectDir, stateDir: config.stateDir, ...dirs };
  const tasks = await hub.list();
  const wById = new Map((await hub.workers()).map((w) => [w.id, w]));
  const byId = new Map(tasks.map((t) => [t.id, t]));

  // Adopt running local tasks this process is not tracking yet (e.g. after a daemon restart).
  for (const t of tasks) {
    if (t.state !== "running" || state.has(t.id)) continue;
    const w = wById.get(t.assignee);
    if (!w || !LOCAL_KINDS.has(w.kind)) continue;
    const run = await hub.readTaskFile(t.id, "run");
    if (run?.startsWith("zcode:"))
      state.set(t.id, { taskId: t.id, workerId: w.id, kind: "zcode", sid: run.slice(6).trim(), workdir: workdirFor(t, w, d) });
    else if (run?.startsWith("pid:"))
      state.set(t.id, { taskId: t.id, workerId: w.id, kind: "cli", pid: Number(run.slice(4)), workdir: workdirFor(t, w, d) });
  }

  // Poll in-flight runs and finish the ones that are done.
  for (const run of [...state.values()]) {
    const t = byId.get(run.taskId);
    if (!t || t.state !== "running" || t.assignee !== run.workerId) {
      // Expired, cancelled or reassigned elsewhere: stop our copy so it can't keep working.
      if (run.kind === "zcode" && adapters.zcode.cancelTask) {
        const st = await adapters.zcode.taskStatus(run.sid).catch(() => null);
        if (st?.status === "running" || st?.status === "starting") await adapters.zcode.cancelTask(run.sid).catch((e) => log(`cancel ${run.sid}: ${e.message}`));
      }
      if (run.kind === "cli" && run.pid) {
        try {
          process.kill(-run.pid, "SIGTERM");
        } catch {}
        try {
          process.kill(run.pid, "SIGTERM");
        } catch {}
      }
      state.delete(run.taskId);
      continue;
    }
    try {
      if (run.kind === "zcode") {
        const st = await adapters.zcode.taskStatus(run.sid);
        if (st.status === "running" || st.status === "starting") continue;
        const res = await adapters.zcode.getResult(run.sid).catch(() => null);
        await finishRun(hub, t, run, { status: st.status, text: res?.result ?? "", dirs: d, log });
      } else {
        // Detached children we spawned turn into zombies until their exit event fires, so
        // trust the flag; adopted pids from a previous daemon are checked with kill(0).
        const exited = "exited" in run ? run.exited : !alive(run.pid);
        if (!exited) continue;
        const logText = readLogTail(join(run.workdir, ".hub-out.log"));
        // A child that died (non-zero exit or signal) without leaving a REPORT.md did not finish the
        // task — e.g. it stopped on "Authentication required" — so fail it instead of reporting the
        // log tail as a result. Adopted pids carry no exit code and keep the old "completed" path.
        const crashed = (run.exitCode ?? 0) !== 0 || Boolean(run.signal);
        const status = crashed && !existsSync(join(run.workdir, "REPORT.md")) ? "failed" : "completed";
        await finishRun(hub, t, run, { status, text: tail(logText), dirs: d, log });
      }
      state.delete(run.taskId);
    } catch (e) {
      log(`finish ${run.taskId} failed: ${e.message}`);
    }
  }

  // Start newly assigned tasks while the worker has free slots. Only running tasks count as
  // in-flight here — an assigned task that cannot start yet just stays assigned for the next tick.
  const running = new Map([...wById.values()].filter((w) => LOCAL_KINDS.has(w.kind)).map((w) => [w.id, 0]));
  for (const t of tasks) if (t.state === "running" && running.has(t.assignee)) running.set(t.assignee, running.get(t.assignee) + 1);
  const started = new Map();
  for (const t of tasks) {
    if (t.state !== "assigned") continue;
    const w = wById.get(t.assignee);
    if (!w || !LOCAL_KINDS.has(w.kind) || w.enabled === false) continue;
    if ((running.get(w.id) ?? 0) + (started.get(w.id) ?? 0) >= (w.maxParallel ?? 1)) continue;
    started.set(w.id, (started.get(w.id) ?? 0) + 1);
    await startTask(hub, t, w, { adapters, state, dirs: d, log }).catch((e) => log(`start ${t.id}: ${e.message}`));
  }
}
