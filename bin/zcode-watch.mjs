#!/usr/bin/env node
// Blocking watcher for master agents: plain code polls taskStatus and a cheap Gemini digest runs on
// an interval, so no paid model has to sit in a zcode_wait loop. Meant to run as a BACKGROUND
// command; stays silent except short status lines. Exit 0 = all tasks finished (DONE lines),
// 3 = a digest set needsAttention or a task stalled (ATTENTION line), 2 = usage error,
// 4 = --timeout elapsed while tasks are still running (RUNNING lines; just run it again).
import "../src/silence.mjs";
import { summarize } from "../src/progress.mjs";
import { taskStatus } from "../src/store.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2);
const ids = [];
let everySec = 300;
let quiet = false;
let timeoutSec = Infinity;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--every") everySec = Number(args[++i]);
  else if (args[i] === "--timeout") timeoutSec = Number(args[++i]);
  else if (args[i] === "--quiet") quiet = true;
  else ids.push(args[i]);
}
if (!ids.length || !Number.isFinite(everySec) || everySec <= 0 || !(timeoutSec > 0)) {
  console.error("usage: zcode-watch <taskId...> [--every SEC] [--timeout SEC] [--quiet]");
  process.exit(2);
}

const PENDING = new Set(["running", "starting"]);
const lastSummaryAt = new Map(); // sid -> ms of the last real summarize call
let exitCode = null;
const deadline = Date.now() + timeoutSec * 1000;

while (exitCode === null) {
  const statuses = new Map(ids.map((id) => [id, taskStatus(id)]));
  for (const [id, st] of statuses) {
    if (PENDING.has(st.status) && st.stalled) {
      console.log(`ATTENTION ${id}: stalled, ${st.idleSec}s without activity`);
      exitCode = 3;
    }
  }
  if (exitCode === null && [...statuses.values()].every((st) => !PENDING.has(st.status))) {
    for (const id of ids) console.log(`DONE ${id} ${statuses.get(id).status}`);
    exitCode = 0;
  }
  if (exitCode === null) {
    const now = Date.now();
    for (const id of ids) {
      if (!PENDING.has(statuses.get(id).status) || now - (lastSummaryAt.get(id) ?? -Infinity) < everySec * 1000) continue;
      lastSummaryAt.set(id, now);
      try {
        const d = (await summarize(id)).digest;
        if (d.needsAttention) {
          console.log(`ATTENTION ${id}: ${d.concerns.length ? d.concerns.join("; ") : d.summary}`);
          exitCode = 3;
          break;
        }
        if (!quiet) console.log(`${id} ${d.progressPct ?? "?"}% ${d.onTrack ? "ok" : "OFF-TRACK"} ${d.summary}`);
      } catch (e) {
        console.log(`WARN ${id} summary failed: ${cut(e?.message ?? e)}`); // never stop watching over Gemini
      }
    }
  }
  if (exitCode === null && Date.now() >= deadline) {
    for (const [id, st] of statuses) if (PENDING.has(st.status)) console.log(`RUNNING ${id} ${st.elapsedSec ?? "?"}s, ${st.toolCalls ?? "?"} tool calls`);
    exitCode = 4;
  }
  if (exitCode === null) await sleep(10_000);
}
process.exitCode = exitCode;

function cut(s) {
  s = String(s).replace(/\s+/g, " ").trim();
  return s.length > 200 ? s.slice(0, 197) + "..." : s;
}
