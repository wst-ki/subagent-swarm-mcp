// `dispatch wait` / hub_wait: diff current hub states against a cursor file and wake the master
// only when something needs it. Semantics in docs/HUB-PLAN.md §Notification.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../config.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ACTIVE = new Set(["queued", "assigned", "running", "done"]); // done = awaiting acceptance or review
const ATTENTION = new Set(["need-info", "failed", "rejected"]);

export function cursorFile(name = "master") {
  return join(config.stateDir, `hub-cursor-${String(name).replace(/[^\w.-]/g, "_")}.json`);
}

function readStates(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8")).tasks;
  } catch {
    return null;
  }
}

function writeStates(file, tasks) {
  mkdirSync(dirname(file), { recursive: true });
  const byId = {};
  for (const t of tasks) byId[t.id] = t.state;
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), tasks: byId }, null, 2) + "\n");
}

// Diff current tasks against remembered states: what changed, what needs attention, and whether
// the hub went idle (no queued/assigned/running/done) after some change.
export function diffEvents(prev, tasks) {
  const changes = tasks.filter((t) => prev[t.id] !== t.state);
  return {
    changes,
    attention: changes.filter((t) => ATTENTION.has(t.state)),
    accepted: changes.filter((t) => t.state === "accepted"),
    idle: changes.length > 0 && !tasks.some((t) => ACTIVE.has(t.state)),
  };
}

// `<id> <state> <assignee|-> <+adds/-dels|-> "<title>" <note>` capped at 200 chars.
export async function formatTaskLine(hub, t) {
  let stat = "-";
  if (["done", "accepted", "rejected"].includes(t.state)) {
    const patch = await hub.readTaskFile(t.id, "result/patch.diff");
    if (patch) {
      let add = 0;
      let del = 0;
      for (const line of patch.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) add++;
        else if (line.startsWith("-") && !line.startsWith("---")) del++;
      }
      stat = `+${add}/-${del}`;
    }
  }
  return `${t.id} ${t.state} ${t.assignee || "-"} ${stat} "${t.spec?.title ?? ""}"${t.note ? " " + t.note : ""}`.slice(0, 200);
}

export async function waitForEvents(hub, { until = "attention", timeoutSec = 0, cursor = "master", pollMs = 2000 } = {}) {
  if (!["attention", "change", "idle"].includes(until)) throw new Error(`invalid --until ${until}`);
  const file = cursorFile(cursor);
  const end = timeoutSec > 0 ? Date.now() + timeoutSec * 1000 : Infinity;
  for (;;) {
    const tasks = await hub.list();
    const prev = readStates(file);
    if (prev) {
      const ev = diffEvents(prev, tasks);
      let fire = [];
      if (until === "change") fire = ev.changes;
      else if (until === "idle") fire = ev.idle ? ev.accepted : [];
      else fire = [...ev.attention, ...(ev.idle ? ev.accepted : [])];
      if (!fire.length && until !== "change" && ev.idle) {
        writeStates(file, tasks);
        return { timedOut: false, lines: ["IDLE"] }; // idle with nothing to list still wakes the master
      }
      if (fire.length) {
        writeStates(file, tasks);
        const seen = new Set();
        const lines = [];
        for (const t of fire.toSorted((a, b) => (a.id < b.id ? -1 : 1)))
          if (!seen.has(t.id)) {
            seen.add(t.id);
            lines.push(await formatTaskLine(hub, t));
          }
        return { timedOut: false, lines };
      }
    }
    writeStates(file, tasks); // first run establishes the baseline; later runs advance it
    if (Date.now() + 50 >= end) return { timedOut: true, lines: [] };
    await sleep(Math.max(50, Math.min(pollMs, end - Date.now())));
  }
}
