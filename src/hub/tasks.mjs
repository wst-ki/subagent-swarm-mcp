// The Hub task queue: queue/roster/results as plain files in a bare git repo, mutated through
// Repo's fetch/reset/commit/push CAS loop. Contract in docs/HUB-PLAN.md — Part B codes against it.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { config } from "../config.mjs";
import { HubConflictError, Repo } from "./repo.mjs";
import { appendMessage, readMessages } from "./channel.mjs";

export { HubConflictError };

export const STATES = ["queued", "assigned", "running", "done", "need-info", "failed", "accepted", "rejected", "cancelled"];

const KIT = fileURLToPath(new URL("../../hub-kit/", import.meta.url));
const ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const CANCELLABLE = ["queued", "assigned", "running", "done", "need-info"];

const envSec = (name, dflt) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};

// Per-worker staleSec in the roster overrides HUB_STALE_SEC (a GUI agent whose shell may not keep
// the background heartbeat loop alive leans on `say` instead, so it needs a wider margin).
const workerStaleSec = (roster, workerId, dflt) => {
  const s = Number(roster.find((w) => w.id === workerId)?.staleSec);
  return Number.isFinite(s) && s >= 0 ? s : dflt;
};

// T<yyyymmdd>-<HHMMSS>-<2 random base36>, sortable (UTC).
export function newTaskId(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const d = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}`;
  const t = `${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  return `T${d}-${t}-${randomBytes(4).readUInt32BE(0).toString(36).slice(-2)}`;
}

export class Hub {
  constructor({ remote, workdir, actor } = {}) {
    this.repo = new Repo({
      remote: remote ?? process.env.HUB_REMOTE ?? join(homedir(), "dispatch", "hub.git"),
      workdir: workdir ?? process.env.HUB_WORKDIR ?? join(config.stateDir, "hub"),
      actor: actor ?? "dispatch",
    });
  }

  get workdir() {
    return this.repo.workdir;
  }

  taskDir(id) {
    return this.repo.path("tasks", id);
  }

  async init() {
    await this.repo.init({ kit: KIT });
  }

  sync() {
    return this.repo.sync();
  }

  async list({ sync = true } = {}) {
    if (sync) await this.sync();
    const dir = this.repo.path("tasks");
    if (!existsSync(dir)) return [];
    const ids = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    const tasks = await Promise.all(ids.map((id) => this.#read(id)));
    return tasks.filter(Boolean);
  }

  async get(id) {
    await this.sync();
    return this.#read(id);
  }

  #roster() {
    try {
      return JSON.parse(readFileSync(this.repo.path("workers.json"), "utf8")).workers ?? [];
    } catch {
      return [];
    }
  }

  async workers() {
    const tasks = await this.list();
    const roster = this.#roster();
    const times = await this.repo.heartbeatTimes();
    const now = Date.now();
    return roster.map((w) => {
      const lastSeen = times.get(w.id) ?? null;
      return {
        ...w,
        lastSeen,
        online: lastSeen !== null && now - lastSeen < envSec("HUB_ONLINE_SEC", 180) * 1000,
        busy: tasks.filter((t) => t.assignee === w.id && (t.state === "running" || t.state === "assigned")).length,
      };
    });
  }

  async post(spec, body) {
    const id = spec.id ?? newTaskId();
    if (!ID_RE.test(id)) throw new Error(`invalid task id ${id}`);
    const full = {
      id,
      title: spec.title ?? "untitled",
      kind: spec.kind ?? "code",
      repo: spec.repo ?? null,
      base: spec.base ?? null,
      tier: spec.tier ?? "mid",
      accept: spec.accept ?? null,
      timeoutMin: spec.timeoutMin ?? 45,
      acceptTimeoutMin: spec.acceptTimeoutMin ?? null,
      avoidVendors: spec.avoidVendors ?? [],
      preferWorkers: spec.preferWorkers ?? [],
      review: spec.review ?? false,
      parent: spec.parent ?? null,
      createdAt: new Date().toISOString(),
      createdBy: spec.createdBy ?? "master",
    };
    await this.repo.mutate(async () => {
      if (await this.#read(id)) throw new HubConflictError(`task ${id} already exists`);
      const dir = this.taskDir(id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "task.md"), body ?? "");
      writeFileSync(join(dir, "spec.json"), JSON.stringify(full) + "\n");
      writeFileSync(join(dir, "state"), "queued\n");
      writeFileSync(join(dir, "attempts"), "0\n");
      return `post ${id} ${full.title}`;
    });
    return this.#read(id);
  }

  // Generic atomic CAS. `from` gates on the current state; `guard(task)` may return an error
  // message; `set` values may be plain values (null clears) or functions of the current task.
  async transition(id, opts) {
    return this.#transition(id, opts);
  }

  async #transition(id, { from, to, set = {}, files = {}, remove = [], message, guard } = {}) {
    if (!STATES.includes(to)) throw new Error(`invalid target state ${to}`);
    await this.repo.mutate(async () => {
      const t = await this.#read(id);
      if (!t) throw new HubConflictError(`no such task ${id}`);
      if (from && !from.includes(t.state))
        throw new HubConflictError(`${id} is ${t.state}, expected ${Array.isArray(from) ? from.join("|") : from}`);
      const bad = guard?.(t);
      if (bad) throw new HubConflictError(`${id}: ${bad}`);
      const dir = this.taskDir(id);
      writeFileSync(join(dir, "state"), to + "\n");
      for (const [key, val] of Object.entries(set)) {
        const v = typeof val === "function" ? val(t) : val;
        writeFileSync(join(dir, key), v === null || v === undefined ? "" : `${v}\n`);
      }
      for (const [rel, content] of Object.entries(files)) {
        const p = join(dir, rel);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, content ?? "");
      }
      for (const rel of remove) rmSync(join(dir, rel), { force: true });
      return message ?? `${t.state}->${to} ${id}`;
    });
    return this.#read(id);
  }

  #ownedBy(worker) {
    return (t) => (t.assignee === worker ? null : `assigned to ${t.assignee || "-"}, not ${worker}`);
  }

  async assign(id, worker, reason = "") {
    return this.#transition(id, {
      from: ["queued", "assigned"],
      to: "assigned",
      set: { assignee: worker, note: reason },
      message: `assign ${id} ${worker}`,
    });
  }

  async claim(id, worker) {
    return this.#transition(id, {
      from: ["assigned"],
      to: "running",
      guard: this.#ownedBy(worker),
      set: {
        assignee: worker,
        lease: (t) => Math.floor(Date.now() / 1000) + (t.spec.timeoutMin ?? 45) * 60,
        attempts: (t) => t.attempts + 1,
      },
      message: `claim ${id} ${worker}`,
    });
  }

  async report(id, worker, { report, patch } = {}) {
    const files = { "result/report.md": report ?? "" };
    if (patch != null) files["result/patch.diff"] = patch;
    return this.#transition(id, {
      from: ["running"],
      to: "done",
      guard: this.#ownedBy(worker),
      set: { lease: null },
      files,
      message: `report ${id} ${worker}`,
    });
  }

  async ask(id, worker, question) {
    return this.#transition(id, {
      from: ["running"],
      to: "need-info",
      guard: this.#ownedBy(worker),
      set: { note: question ?? "", lease: null },
      message: `ask ${id} ${worker}`,
    });
  }

  async fail(id, worker, reason = "") {
    return this.#transition(id, {
      from: ["running"],
      to: "failed",
      guard: this.#ownedBy(worker),
      set: { note: reason, lease: null },
      message: `fail ${id} ${worker}`,
    });
  }

  async answer(id, text) {
    return this.#transition(id, {
      from: ["need-info"],
      to: "assigned",
      set: { note: "", lease: null },
      files: { "answer.md": text ?? "" },
      message: `answer ${id}`,
    });
  }

  async accept(id, { ok, log, note } = {}) {
    return this.#transition(id, {
      from: ["done"],
      to: ok ? "accepted" : "rejected",
      set: note === undefined ? {} : { note },
      files: log == null ? {} : { "result/accept.log": log },
      message: `accept ${id} ${ok ? "accepted" : "rejected"}`,
    });
  }

  async cancel(id) {
    return this.#transition(id, { from: CANCELLABLE, to: "cancelled", set: { lease: null }, message: `cancel ${id}` });
  }

  async requeue(id) {
    return this.#transition(id, {
      from: ["failed", "rejected", "cancelled"],
      to: "queued",
      set: { assignee: "", lease: null, note: "" },
      message: `requeue ${id}`,
    });
  }

  // running tasks whose lease passed or whose assignee went silent -> queued
  // (or failed once attempts >= 3). Returns the ids acted on.
  async expireStale(now = Date.now()) {
    const tasks = await this.list();
    const times = await this.repo.heartbeatTimes();
    const roster = this.#roster();
    const dflt = envSec("HUB_STALE_SEC", 300);
    const out = [];
    for (const t of tasks.filter((t) => t.state === "running")) {
      const leasePassed = !t.lease || t.lease * 1000 <= now;
      const seen = t.assignee ? times.get(t.assignee) : undefined;
      const hbStale = seen === undefined || now - seen > workerStaleSec(roster, t.assignee, dflt) * 1000;
      if (!leasePassed && !hbStale) continue;
      const failed = t.attempts >= 3;
      try {
        await this.#transition(t.id, {
          from: ["running"],
          to: failed ? "failed" : "queued",
          set: { assignee: "", lease: null, note: failed ? `expired after ${t.attempts} attempts` : "lease expired" },
          message: `expire ${t.id}`,
        });
        out.push(t.id);
      } catch (e) {
        if (!(e instanceof HubConflictError)) throw e; // someone else acted first
      }
    }
    return out;
  }

  async heartbeat(workerId) {
    return this.repo.heartbeat(workerId);
  }

  async lastSeen(workerId) {
    return (await this.repo.heartbeatTimes()).get(workerId) ?? null;
  }

  // Effective lease-staleness for a worker, in seconds: its roster staleSec or HUB_STALE_SEC.
  async staleSecOf(workerId) {
    return workerStaleSec(this.#roster(), workerId, envSec("HUB_STALE_SEC", 300));
  }

  // Worker -> supervisor/master progress line (refs/progress/<id>); returns the new message sha.
  async say(id, from, text) {
    await this.sync();
    if (!(await this.#read(id))) throw new Error(`no such task ${id}`);
    return appendMessage(this.repo, "progress", id, from, text);
  }

  // Supervisor/master -> worker message (refs/inbox/<id>); returns the new message sha.
  async tell(id, from, text) {
    await this.sync();
    if (!(await this.#read(id))) throw new Error(`no such task ${id}`);
    return appendMessage(this.repo, "inbox", id, from, text);
  }

  // One channel stream of a task: [{ sha, at, from, text }] oldest first (see channel.mjs).
  async messages(id, stream, opts = {}) {
    return readMessages(this.repo, stream, id, opts);
  }

  async readTaskFile(id, rel) {
    try {
      return readFileSync(join(this.taskDir(id), rel), "utf8");
    } catch {
      return null;
    }
  }

  async #read(id) {
    if (!ID_RE.test(id)) return null;
    const dir = this.taskDir(id);
    let spec;
    try {
      spec = JSON.parse(readFileSync(join(dir, "spec.json"), "utf8"));
    } catch {
      return null;
    }
    const field = (f) => {
      try {
        return readFileSync(join(dir, f), "utf8").trim();
      } catch {
        return "";
      }
    };
    return {
      id,
      spec,
      state: field("state") || "queued",
      assignee: field("assignee"),
      lease: Number(field("lease")) || null,
      attempts: Number(field("attempts")) || 0,
      note: field("note"),
      updatedAt: await this.repo.lastCommitMs(`tasks/${id}`),
    };
  }
}
