// `dispatch watch` / taskTimeline: the supervisor-side reader of the channel. watchTasks blocks,
// printing only what is new since a cursor file, and exits with a code the caller loops on:
// 0 = every task final (FINAL lines), 3 = something needs attention, 4 = --timeout (RUNNING lines).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../config.mjs";
import { git } from "./repo.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FINAL = new Set(["done", "accepted", "rejected", "failed", "cancelled"]);
const p2 = (n) => String(n).padStart(2, "0");

export function watchCursorFile(name = "watch") {
  return join(config.stateDir, `hub-watch-${String(name).replace(/[^\w.-]/g, "_")}.json`);
}

export function fmtTime(ms, withDate = false) {
  const d = new Date(ms);
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  return withDate ? `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${hm}` : hm;
}

function readCursor(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8")).tasks;
  } catch {
    return null;
  }
}

function writeCursor(file, tasks) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), tasks }, null, 2) + "\n");
}

// Merged, time-sorted timeline for `dispatch log` / hub_log: state changes from main's git history
// plus both channel streams. One compact line per event.
export async function taskTimeline(hub, id) {
  const entries = [];
  const out = await git(hub.repo.workdir, ["log", "--reverse", "--format=%ct%x01%s", "--", `tasks/${id}`], { ok: [128] });
  for (const line of out.split("\n").filter(Boolean)) {
    const i = line.indexOf("\x01");
    const ms = Number(line.slice(0, i)) * 1000;
    entries.push({ ms, line: `${fmtTime(ms, true)} ${line.slice(i + 1)}` });
  }
  for (const [stream, tag] of [["progress", "PROGRESS"], ["inbox", "INBOX"]])
    for (const m of await hub.messages(id, stream))
      entries.push({ ms: m.at, line: `${fmtTime(m.at, true)} ${tag} ${m.from}: ${m.text}` });
  entries.sort((a, b) => a.ms - b.ms);
  return entries;
}

export async function watchTasks(hub, { ids, timeoutSec = 0, quietMin = 15, cursor = "watch", pollMs = 5000 } = {}) {
  const file = watchCursorFile(cursor);
  const quietMs = quietMin * 60_000;
  const end = timeoutSec > 0 ? Date.now() + timeoutSec * 1000 : Infinity;
  let prev = readCursor(file);
  const allLines = [];
  for (;;) {
    const lines = [];
    let exit = null;
    const tasks = new Map((await hub.list()).filter((t) => ids.includes(t.id)).map((t) => [t.id, t]));
    const times = await hub.repo.heartbeatTimes();
    const cur = {};
    for (const id of ids) {
      const t = tasks.get(id);
      const p = prev?.[id] ?? {};
      const msgs = await hub.messages(id, "progress", { after: p.progress });
      for (const m of msgs) lines.push(`${id} PROGRESS ${fmtTime(m.at)} ${m.text}`);
      if (p.state !== undefined && (p.state !== t.state || p.note !== t.note))
        lines.push(`${id} STATE ${t.state}${t.note ? " " + t.note : ""}`);
      cur[id] = {
        progress: msgs.length ? msgs.at(-1).sha : p.progress ?? null,
        lastProgress: msgs.length ? msgs.at(-1).at : p.lastProgress ?? null,
        state: t.state,
        note: t.note,
      };
    }
    const now = Date.now();
    for (const id of ids) {
      const t = tasks.get(id);
      if (t.state === "need-info") {
        lines.push(`${id} ATTENTION need-info: ${t.note}`);
        exit = 3;
        continue;
      }
      if (t.state !== "running") continue;
      const seen = times.get(t.assignee);
      const staleSec = await hub.staleSecOf(t.assignee);
      if (seen === undefined || (now - seen) / 1000 > staleSec / 2) {
        const silent = seen === undefined ? "never heartbeated" : `silent ${Math.round((now - seen) / 1000)}s`;
        lines.push(`${id} ATTENTION heartbeat stale: ${t.assignee} ${silent} (staleSec ${staleSec}s)`);
        exit = 3;
      }
      const since = cur[id].lastProgress ?? t.updatedAt;
      if (now - since > quietMs) {
        lines.push(`${id} ATTENTION no progress for ${Math.round((now - since) / 60000)}m while running`);
        exit = 3;
      }
    }
    if (exit === null && ids.every((id) => FINAL.has(tasks.get(id).state))) {
      for (const id of ids) {
        const t = tasks.get(id);
        lines.push(`${id} FINAL ${t.state}${t.note ? " " + t.note : ""}`);
      }
      exit = 0;
    }
    if (exit === null && now >= end) {
      for (const id of ids) {
        const t = tasks.get(id);
        if (FINAL.has(t.state)) continue;
        const lp = cur[id].lastProgress;
        lines.push(`${id} RUNNING ${t.state}, ${lp == null ? "no progress yet" : `last progress ${Math.round((now - lp) / 60000)}m ago`}`);
      }
      exit = 4;
    }
    prev = cur;
    writeCursor(file, cur);
    for (const l of lines) console.log(l);
    allLines.push(...lines);
    if (exit !== null) return { code: exit, lines: allLines };
    await sleep(Math.max(50, Math.min(pollMs, end - Date.now())));
  }
}
