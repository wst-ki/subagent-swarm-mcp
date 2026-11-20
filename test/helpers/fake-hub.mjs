// In-memory Hub implementing the src/hub/tasks.mjs contract closely enough for Part-B tests.
// Semantics mirror docs/HUB-PLAN.md: CAS transitions, lease on claim, expireStale, heartbeats.
export class HubConflictError extends Error {
  constructor(msg) {
    super(msg);
    this.name = "HubConflictError";
  }
}

export const STATES = ["queued", "assigned", "running", "done", "need-info", "failed", "accepted", "rejected", "cancelled"];

const pad = (n, w = 2) => String(n).padStart(w, "0");
let idSeq = 0;

export class FakeHub {
  constructor({ workers = [] } = {}) {
    this.workersRoster = workers.map((w) => ({ enabled: true, maxParallel: 1, kinds: ["code", "text", "review"], tier: "mid", ...w }));
    this.tasks = new Map();
    this.files = new Map(); // taskId -> Map(rel -> string)
    this.lastSeenMap = new Map();
    this.transitions = [];
    this.workdir = null; // set by tests that exercise SCHEDULER.md reading
  }

  newId() {
    const d = new Date();
    idSeq = (idSeq + 1) % 1296;
    return `T${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${idSeq.toString(36).padStart(2, "0")}`;
  }

  async init() {}
  async sync() {}

  async list() {
    return [...this.tasks.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).map((t) => ({ ...t, spec: { ...t.spec } }));
  }

  async get(id) {
    const t = this.tasks.get(id);
    return t ? { ...t, spec: { ...t.spec } } : null;
  }

  async workers() {
    const now = Date.now();
    return this.workersRoster.map((w) => {
      const lastSeen = this.lastSeenMap.get(w.id) ?? null;
      const busy = [...this.tasks.values()].filter((t) => t.assignee === w.id && (t.state === "assigned" || t.state === "running")).length;
      return { ...w, lastSeen, online: w.kind !== "manual" ? true : lastSeen !== null && now - lastSeen < 180_000, busy };
    });
  }

  #files(id) {
    let f = this.files.get(id);
    if (!f) this.files.set(id, (f = new Map()));
    return f;
  }

  async post(spec, body) {
    const id = this.newId();
    const s = {
      title: "task",
      kind: "code",
      tier: "mid",
      repo: null,
      base: null,
      accept: null,
      timeoutMin: 45,
      avoidVendors: [],
      preferWorkers: [],
      review: false,
      parent: null,
      ...spec,
      id,
      createdAt: new Date().toISOString(),
      createdBy: "test",
    };
    this.tasks.set(id, { id, state: "queued", assignee: "", lease: null, attempts: 0, note: "", spec: s, updatedAt: Date.now() });
    this.#files(id).set("task.md", String(body));
    return this.get(id);
  }

  async transition(id, { from, to, set = {}, files = {}, remove = [], message } = {}) {
    const t = this.tasks.get(id);
    if (!t) throw new Error(`no task ${id}`);
    const want = from ? (Array.isArray(from) ? from : [from]) : null;
    if (want && !want.includes(t.state)) throw new HubConflictError(`${id} is ${t.state}, expected ${want.join("|")}`);
    const prev = t.state;
    if (to) t.state = to;
    Object.assign(t, set);
    const f = this.#files(id);
    for (const [rel, content] of Object.entries(files)) f.set(rel, String(content));
    for (const rel of remove) f.delete(rel);
    t.updatedAt = Date.now();
    this.transitions.push({ id, from: prev, to: t.state, set: { ...set }, message });
    return this.get(id);
  }

  async assign(id, worker, reason = "") {
    return this.transition(id, { from: ["queued", "assigned"], to: "assigned", set: { assignee: worker, note: String(reason ?? "").slice(0, 120) } });
  }

  async claim(id, worker) {
    const t = this.tasks.get(id);
    if (!t) throw new Error(`no task ${id}`);
    if (t.state !== "assigned" || t.assignee !== worker) throw new HubConflictError(`${id} is ${t.state}/${t.assignee}, not assigned to ${worker}`);
    return this.transition(id, { from: "assigned", to: "running", set: { lease: Date.now() + (t.spec.timeoutMin ?? 45) * 60_000, attempts: t.attempts + 1 } });
  }

  async report(id, worker, { report, patch } = {}) {
    const files = { "result/report.md": String(report ?? "") };
    if (patch != null) files["result/patch.diff"] = String(patch);
    return this.transition(id, { from: "running", to: "done", files, message: `report ${id}` });
  }

  async ask(id, worker, question) {
    return this.transition(id, { from: "running", to: "need-info", set: { note: String(question ?? "").slice(0, 300) } });
  }

  async fail(id, worker, reason) {
    return this.transition(id, { from: "running", to: "failed", set: { note: String(reason ?? "").slice(0, 300) } });
  }

  async answer(id, text) {
    return this.transition(id, { from: "need-info", to: "assigned", files: { "answer.md": String(text) } });
  }

  async accept(id, { ok, log = "", note = "" } = {}) {
    return this.transition(id, { from: "done", to: ok ? "accepted" : "rejected", files: { "result/accept.log": String(log) }, set: { note } });
  }

  async cancel(id) {
    const t = this.tasks.get(id);
    if (!t) throw new Error(`no task ${id}`);
    if (t.state === "accepted" || t.state === "cancelled") return this.get(id);
    return this.transition(id, { to: "cancelled" });
  }

  async requeue(id) {
    return this.transition(id, { from: ["failed", "rejected", "cancelled"], to: "queued", set: { assignee: "", lease: null } });
  }

  async expireStale(now = Date.now()) {
    const ids = [];
    for (const t of this.tasks.values()) {
      if (t.state !== "running") continue;
      const hb = t.assignee ? (this.lastSeenMap.get(t.assignee) ?? 0) : 0;
      if (!(t.lease < now || now - hb > 300_000)) continue;
      ids.push(t.id);
      if (t.attempts >= 3) {
        t.state = "failed";
        t.note = "lease expired after 3 attempts";
      } else {
        t.state = "queued";
        t.assignee = "";
        t.lease = null;
        t.note = "lease expired";
      }
    }
    return ids;
  }

  async heartbeat(workerId) {
    this.lastSeenMap.set(workerId, Date.now());
  }

  async lastSeen(workerId) {
    return this.lastSeenMap.get(workerId) ?? null;
  }

  async readTaskFile(id, rel) {
    return this.files.get(id)?.get(rel) ?? null;
  }

  taskDir(id) {
    return `/fake-hub/${id}`;
  }
}
