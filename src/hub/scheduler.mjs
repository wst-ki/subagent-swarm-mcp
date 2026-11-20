// Scheduler: asks agy (Gemini Flash) which queued task goes to which worker, validates every
// proposal in code, and falls back to deterministic rules when agy fails twice or is disabled.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../config.mjs";

const TIER = { low: 0, mid: 1, high: 2 };
const COOLDOWN_MS = 60 * 60_000;

const DEFAULT_CMD =
  "agy -p {prompt} --model gemini-3.8-flash-medium --output-format json --json-schema {schema} --disable-slash-commands";

const DEFAULT_SCHEDULER_MD = `# Scheduling policy

You dispatch queued tasks to workers. Hard constraints are enforced in code, but follow them anyway:
- Only assign a task to an enabled, online worker whose "kinds" include the task's kind and that has a free slot (busy < maxParallel).
- Never use a vendor listed in the task's avoidVendors; prefer the task's preferWorkers when set.
- Match the worker tier to the task tier; do not waste a high-tier worker on a low-tier task when a cheaper one fits.
- Prefer a lower costRank (cheaper). Keep every capable worker busy.
- A "review" task must not go to the vendor that implemented its parent task.
- Return at most one assignment per queued task; you may return none.`;

export const ASSIGNMENTS_SCHEMA = {
  type: "object",
  properties: {
    assignments: {
      type: "array",
      items: {
        type: "object",
        properties: { task: { type: "string" }, worker: { type: "string" }, reason: { type: "string" } },
        required: ["task", "worker"],
      },
    },
  },
  required: ["assignments"],
};

// ------------------------------------------------------------- cooldown store

export function loadCooldowns(stateDir = config.stateDir, now = Date.now()) {
  try {
    const raw = JSON.parse(readFileSync(join(stateDir, "hub-cooldown.json"), "utf8"));
    return Object.fromEntries(Object.entries(raw).filter(([, until]) => until > now));
  } catch {
    return {};
  }
}

export function setCooldown(stateDir = config.stateDir, workerId, untilMs = Date.now() + COOLDOWN_MS) {
  const file = join(stateDir, "hub-cooldown.json");
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {}
  raw[workerId] = untilMs;
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(file, JSON.stringify(raw, null, 2));
  return untilMs;
}

// ----------------------------------------------------------------- snapshot

export function buildSnapshot(tasks, workers, cooldowns = {}, now = Date.now()) {
  const wById = new Map(workers.map((w) => [w.id, w]));
  const vendorOf = (t) => wById.get(t.assignee)?.vendor ?? null;
  const queued = tasks
    .filter((t) => t.state === "queued")
    .map((t) => {
      const s = t.spec ?? {};
      const parent = s.parent ? tasks.find((p) => p.id === s.parent) : null;
      return {
        id: t.id,
        title: s.title ?? null,
        kind: s.kind ?? "code",
        tier: s.tier ?? "mid",
        attempts: t.attempts ?? 0,
        note: t.note || null,
        avoidVendors: s.avoidVendors ?? [],
        preferWorkers: s.preferWorkers ?? [],
        parentVendor: parent ? vendorOf(parent) : null,
      };
    });
  const ws = workers
    .filter((w) => w.enabled !== false)
    .map((w) => ({
      id: w.id,
      kind: w.kind,
      vendor: w.vendor ?? null,
      tier: w.tier ?? "mid",
      model: w.model ?? null,
      kinds: w.kinds ?? [],
      costRank: w.costRank ?? 99,
      online: w.kind !== "manual" ? true : Boolean(w.online),
      busy: w.busy ?? 0,
      maxParallel: w.maxParallel ?? 1,
      cooldownUntil: cooldowns[w.id] ?? null,
    }));
  return { queued, workers: ws };
}

// ------------------------------------------------------------ agy invocation

// Split a command string into argv, honoring single/double-quoted segments.
export function splitCmd(str) {
  const out = [];
  let cur = "";
  let q = "";
  for (const ch of String(str).trim()) {
    if (q) {
      if (ch === q) q = "";
      else cur += ch;
    } else if (ch === "'" || ch === '"') q = ch;
    else if (/\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function proposalsFrom(x) {
  const ok = (list) => list.filter((p) => p && typeof p.task === "string" && typeof p.worker === "string");
  if (Array.isArray(x)) return ok(x);
  if (x && Array.isArray(x.assignments)) return ok(x.assignments);
  return null;
}

function proposalsFromText(text) {
  if (typeof text !== "string") return null;
  let j = null;
  try {
    j = JSON.parse(text);
  } catch {
    const m = text.match(/[[{][\s\S]*[\]}]/);
    if (m) {
      try {
        j = JSON.parse(m[0]);
      } catch {}
    }
  }
  return proposalsFrom(j);
}

export function parseAgyOutput(stdout) {
  let out;
  try {
    out = JSON.parse(stdout);
  } catch {
    return null;
  }
  return proposalsFrom(out?.structured_output) ?? proposalsFromText(out?.response);
}

function runCmd(argv, { cwd, timeoutMs, stdin }) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`scheduler command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`scheduler command exited ${code}: ${err.slice(-500)}`));
    });
    if (stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(stdin);
    }
  });
}

export async function callScheduler(prompt, { cmd = DEFAULT_CMD, timeoutMs = 90_000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hub-sched-"));
  try {
    const schemaFile = join(dir, "assignments.schema.json");
    writeFileSync(schemaFile, JSON.stringify(ASSIGNMENTS_SCHEMA));
    const parts = splitCmd(cmd);
    const usesPrompt = parts.some((a) => a.includes("{prompt}"));
    const argv = parts.map((a) => a.replaceAll("{prompt}", prompt).replaceAll("{schema}", schemaFile));
    const stdout = await runCmd(argv, { cwd: dir, timeoutMs, stdin: usesPrompt ? null : prompt });
    const proposals = parseAgyOutput(stdout);
    if (!proposals) throw new Error("scheduler output contained no assignments");
    return proposals;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// -------------------------------------------------------------- validation

function ineligibility(task, w, ctx) {
  const s = task.spec ?? {};
  if (w.enabled === false) return "worker disabled";
  if (!(w.kinds ?? []).includes(s.kind ?? "code")) return `worker does not serve kind ${s.kind}`;
  if (w.kind === "manual" && !w.online) return "manual worker offline";
  if ((ctx.cooldowns[w.id] ?? 0) > ctx.now) return "worker cooling down";
  if ((s.avoidVendors ?? []).includes(w.vendor)) return `vendor ${w.vendor} is avoided for this task`;
  if (s.kind === "review") {
    const parent = s.parent ? ctx.tasksById.get(s.parent) : null;
    const parentVendor = parent ? ctx.workersById.get(parent.assignee)?.vendor : undefined;
    if (parentVendor && w.vendor === parentVendor) return "reviewer vendor matches implementer vendor";
  }
  return null;
}

export function validateProposals(proposals, { tasks, workers, cooldowns = {}, now = Date.now() } = {}) {
  const ctx = {
    cooldowns,
    now,
    tasksById: new Map(tasks.map((t) => [t.id, t])),
    workersById: new Map(workers.map((w) => [w.id, w])),
  };
  const queued = new Map(tasks.filter((t) => t.state === "queued").map((t) => [t.id, t]));
  const slots = new Map(workers.map((w) => [w.id, w.busy ?? 0]));
  const taken = new Set();
  const valid = [];
  const dropped = [];
  for (const p of proposals ?? []) {
    const drop = (why) => dropped.push({ task: p?.task ?? null, worker: p?.worker ?? null, why });
    const t = queued.get(p?.task);
    if (!t) {
      drop("task is not queued");
      continue;
    }
    const w = ctx.workersById.get(p?.worker);
    if (!w) {
      drop("unknown worker");
      continue;
    }
    const why = ineligibility(t, w, ctx);
    if (why) {
      drop(why);
      continue;
    }
    if (taken.has(t.id)) {
      drop("task already assigned this round");
      continue;
    }
    if (slots.get(w.id) >= (w.maxParallel ?? 1)) {
      drop("worker has no free slot");
      continue;
    }
    slots.set(w.id, slots.get(w.id) + 1);
    taken.add(t.id);
    valid.push({ task: t.id, worker: w.id, reason: String(p.reason ?? "scheduled").slice(0, 120) });
  }
  return { valid, dropped };
}

// Deterministic fallback: preferWorkers first, then sufficient tier, fewest busy, lowest costRank.
export function rulesAssign(tasks, workers, cooldowns = {}, now = Date.now()) {
  const ctx = {
    cooldowns,
    now,
    tasksById: new Map(tasks.map((t) => [t.id, t])),
    workersById: new Map(workers.map((w) => [w.id, w])),
  };
  const slots = new Map(workers.map((w) => [w.id, w.busy ?? 0]));
  const out = [];
  const queued = tasks.filter((t) => t.state === "queued").sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const t of queued) {
    const prefer = (t.spec ?? {}).preferWorkers ?? [];
    const tier = TIER[(t.spec ?? {}).tier] ?? 1;
    const cands = workers.filter((w) => {
      if ((slots.get(w.id) ?? 0) >= (w.maxParallel ?? 1)) return false;
      return !ineligibility(t, w, ctx);
    });
    if (!cands.length) continue;
    cands.sort(
      (a, b) =>
        (prefer.includes(a.id) ? 0 : 1) - (prefer.includes(b.id) ? 0 : 1) ||
        ((TIER[b.tier] ?? 1) >= tier ? 1 : 0) - ((TIER[a.tier] ?? 1) >= tier ? 1 : 0) ||
        (slots.get(a.id) ?? 0) - (slots.get(b.id) ?? 0) ||
        (a.costRank ?? 99) - (b.costRank ?? 99) ||
        (TIER[a.tier] ?? 1) - (TIER[b.tier] ?? 1),
    );
    const w = cands[0];
    slots.set(w.id, slots.get(w.id) + 1);
    out.push({ task: t.id, worker: w.id, reason: "rules: prefer/tier/busy/cost" });
  }
  return out;
}

// ------------------------------------------------------------------ driver

function schedulerPrompt(hub, snapshot) {
  let md = "";
  if (hub.workdir) {
    try {
      md = readFileSync(join(hub.workdir, "SCHEDULER.md"), "utf8");
    } catch {}
  }
  // agy is a full agent: without this it sometimes tries to run commands, gets auto-denied in
  // headless mode and returns an empty response.
  return `Do not use any tools, files or commands. Decide only from the policy and the JSON below and answer directly.\n\n${(md || DEFAULT_SCHEDULER_MD).trim()}\n\n## Current state (JSON)\n\n${JSON.stringify(snapshot)}\n\nReturn assignments.`;
}

export async function runScheduler(
  hub,
  state = {},
  { cmd, minIntervalSec, rules, stateDir = config.stateDir, timeoutMs = 90_000, log = () => {}, now = Date.now() } = {},
) {
  cmd ??= process.env.HUB_SCHEDULER_CMD ?? DEFAULT_CMD;
  minIntervalSec ??= Number(process.env.HUB_SCHED_MIN_SEC ?? 30);
  rules ??= process.env.HUB_SCHEDULER === "rules";
  state.lastRunAt ??= 0;
  state.failures ??= 0;

  const tasks = await hub.list();
  const queued = tasks.filter((t) => t.state === "queued");
  if (!queued.length) return { skipped: "nothing queued" };
  if (now - state.lastRunAt < minIntervalSec * 1000) return { skipped: "interval" };

  const workers = await hub.workers();
  const cooldowns = loadCooldowns(stateDir, now);
  const eligible = (t, w) =>
    w.enabled !== false &&
    (w.kind !== "manual" || w.online) &&
    (cooldowns[w.id] ?? 0) <= now &&
    (w.busy ?? 0) < (w.maxParallel ?? 1) &&
    (w.kinds ?? []).includes((t.spec ?? {}).kind ?? "code") &&
    !((t.spec ?? {}).avoidVendors ?? []).includes(w.vendor);
  if (!workers.some((w) => queued.some((t) => eligible(t, w)))) return { skipped: "no eligible worker with a free slot" };
  state.lastRunAt = now;

  let proposals = null;
  let fallback = rules;
  if (!rules) {
    try {
      const prompt = schedulerPrompt(hub, buildSnapshot(tasks, workers, cooldowns, now));
      proposals = await callScheduler(prompt, { cmd, timeoutMs });
      state.failures = 0;
    } catch (e) {
      state.failures += 1;
      log(`scheduler call failed (${state.failures}): ${e.message}`);
      if (state.failures < 2) return { error: e.message, failures: state.failures };
    }
  }
  if (!proposals) {
    proposals = rulesAssign(tasks, workers, cooldowns, now);
    fallback = true;
    log("using rules fallback");
  }
  const { valid, dropped } = validateProposals(proposals, { tasks, workers, cooldowns, now });
  for (const d of dropped) log(`dropped proposal ${d.task} -> ${d.worker}: ${d.why}`);
  const assigned = [];
  for (const p of valid) {
    try {
      await hub.assign(p.task, p.worker, p.reason);
      assigned.push(p);
    } catch (e) {
      log(`assign ${p.task} -> ${p.worker} failed: ${e.message}`);
    }
  }
  return { assigned, dropped, fallback };
}
