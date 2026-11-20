// Gemini progress digests: turn a session's part rows into a compact activity log and let a cheap
// model (Gemini Flash via the agy CLI) summarize it, so no paid model has to sit in a wait loop.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "./config.mjs";
import { withDb } from "./store.mjs";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const cut = (s, n) => (s.length > n ? s.slice(0, Math.max(0, n - 3)) + "..." : s);
const hhmm = (ms) => new Date(ms).toTimeString().slice(0, 5);
const partData = (r) => {
  if (typeof r.data === "string") {
    try {
      return JSON.parse(r.data);
    } catch {
      return null;
    }
  }
  return r.data ?? null;
};

// --------------------------------------------------------------- digest text

/** Pure: ordered part rows (+ the task's first user text) -> compact text for the summary model. */
export function buildDigest(rows, { firstUserText = "", maxItems = 60, maxChars = 6000 } = {}) {
  const items = [];
  const edits = new Map(); // file -> edit/write count
  const commands = [];
  for (const r of rows) {
    const d = partData(r);
    if (!d || typeof d !== "object") continue;
    if (d.type === "tool") {
      const input = d.state?.input ?? {};
      const target =
        (input.file_path != null && String(input.file_path)) ||
        (input.command != null ? cut(oneLine(input.command), 160) : "") ||
        (input.pattern != null && String(input.pattern)) ||
        (input.path != null && String(input.path)) ||
        "";
      items.push(`${hhmm(r.time_created)} ${d.tool} ${target} ${d.state?.status ?? "unknown"}`.replace(/ {2,}/g, " ").trimEnd());
      if (EDIT_TOOLS.has(d.tool) && input.file_path) edits.set(input.file_path, (edits.get(input.file_path) ?? 0) + 1);
      if (input.command != null) commands.push(oneLine(input.command));
    } else if (d.type === "text" && r.role !== "user" && d.text) {
      items.push(`${hhmm(r.time_created)} text ${cut(oneLine(d.text), 300)}`);
    }
  }

  const editList = [...edits.entries()].sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f} x${n}`);
  const footer = [
    editList.length ? `FILES EDITED: ${editList.slice(0, 20).join(", ")}${editList.length > 20 ? ` (+${editList.length - 20} more)` : ""}` : "FILES EDITED: none",
    `COMMANDS RUN: ${commands.length}`,
    ...(commands.length ? ["LAST COMMANDS:", ...commands.slice(-5).map((c) => `- ${cut(c, 160)}`)] : []),
  ].join("\n");
  const head = `TASK: ${oneLine(firstUserText) ? cut(oneLine(firstUserText), 2000) : "(no task prompt found)"}`;

  let lines = items.slice(-maxItems);
  let dropped = items.length - lines.length;
  const render = () =>
    [head, "", "ACTIVITY:", ...lines, ...(dropped ? [`(${dropped} older item${dropped > 1 ? "s" : ""} omitted)`] : []), "", footer].join("\n");
  while (render().length > maxChars && lines.length > 1) {
    lines = lines.slice(1);
    dropped++;
  }
  return render();
}

/** All part rows of a session (parsed, with message role) + its first real user text. */
export function sessionActivity(sid) {
  return withDb((db) => {
    const rows = db
      .prepare(
        `select p.id, p.time_created, json_extract(m.data,'$.role') as role, p.data
           from part p join message m on p.message_id = m.id
          where p.session_id = ?
          order by p.time_created, p.sequence, p.id`,
      )
      .all(sid)
      .map((r) => ({ ...r, data: partData(r) }));
    const first = db
      .prepare(
        `select id from message
          where session_id = ? and json_extract(data,'$.role') = 'user'
            and json_extract(data,'$.metadata.visibility') is null
          order by time_created, sequence limit 1`,
      )
      .get(sid);
    const firstUserText = first
      ? db
          .prepare(`select data from part where message_id = ? and json_extract(data,'$.type') = 'text' order by sequence`)
          .all(first.id)
          .map((p) => partData(p)?.text)
          .filter(Boolean)
          .join("\n")
      : "";
    return { rows, firstUserText, lastPartTime: rows.at(-1)?.time_created ?? 0 };
  });
}

// ------------------------------------------------------------ summary output

export const summarySchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "done", "doing", "next", "progressPct", "onTrack", "concerns", "needsAttention"],
  properties: {
    summary: { type: "string", description: "At most 3 sentences, same language as the task prompt." },
    done: { type: "array", items: { type: "string" }, description: "Completed items, taken from the activity log." },
    doing: { type: "string", description: "What the agent is doing most recently." },
    next: { type: "string", description: "The likely next step." },
    progressPct: { type: "integer", minimum: 0, maximum: 100, description: "Estimated completion of the task prompt's requirements." },
    onTrack: { type: "boolean", description: "Whether the activity still matches the task prompt." },
    concerns: { type: "array", items: { type: "string" }, description: "Specific worries; empty if none." },
    needsAttention: { type: "boolean", description: "True only for real problems, not slow progress." },
  },
};

const asIntPct = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null;
};

/** Parse the agy JSON envelope: prefer .structured_output, fall back to JSON in .response. */
export function parseSummaryOutput(stdout) {
  let outer;
  try {
    outer = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!outer || typeof outer !== "object" || (typeof outer.status === "string" && outer.status !== "SUCCESS")) return null;
  let s = outer.structured_output ?? null;
  if (typeof s === "string") {
    try {
      s = JSON.parse(s);
    } catch {
      s = null;
    }
  }
  const hasSummary = (o) => o && typeof o === "object" && typeof o.summary === "string";
  if (!hasSummary(s) && typeof outer.response === "string") {
    try {
      s = JSON.parse(outer.response);
    } catch {
      s = null;
    }
  }
  if (!hasSummary(s)) return null;
  return {
    summary: s.summary,
    done: Array.isArray(s.done) ? s.done.map(String) : [],
    doing: typeof s.doing === "string" ? s.doing : "",
    next: typeof s.next === "string" ? s.next : "",
    progressPct: asIntPct(s.progressPct),
    onTrack: s.onTrack !== false,
    concerns: Array.isArray(s.concerns) ? s.concerns.map(String) : [],
    needsAttention: s.needsAttention === true,
  };
}

// ---------------------------------------------------------------- summarize

const DEFAULT_SUMMARY_CMD =
  "agy -p {prompt} --model gemini-3.8-flash-low --output-format json --json-schema {schema} --disable-slash-commands";

const PROMPT_INTRO =
  "You are monitoring a coding agent (a GLM subagent running inside ZCode) working on the task below. " +
  "Judge ONLY from the activity log; never invent facts that are not in it. " +
  'Write "summary" (at most 3 sentences) in the SAME LANGUAGE as the task prompt. ' +
  "- done / doing / next: short concrete items visible in the log. " +
  "- progressPct: integer 0-100, your estimate of how much of the task prompt's requirements is complete. " +
  "- onTrack: whether the activity still matches the task prompt. " +
  "- concerns: short specific worries, empty list if none. " +
  "- needsAttention: true ONLY for real problems: looping on the same error, editing files outside the task, " +
  "asking a question and waiting for a reply, or clearly off-task work. Slow progress or a missing detail alone is NOT a real problem.\n\n" +
  "TASK AND ACTIVITY LOG:\n";

/** Run the summary command (argv split on spaces; "{prompt}"/"{schema}" are whole-token placeholders,
 *  the prompt goes to stdin when no "{prompt}" token is present) and resolve its stdout. */
function runSummary(cmdStr, prompt, schemaFile, timeoutMs = 90_000) {
  let argv = cmdStr
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => (t === "{prompt}" ? null : t === "{schema}" ? schemaFile : t));
  const hasPromptToken = argv.includes(null);
  argv = argv.map((t) => (t === null ? prompt : t));
  return new Promise((resolve, reject) => {
    const cwd = mkdtempSync(join(tmpdir(), "zcode-summary-")); // agy must not see the caller's files
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rmSync(cwd, { recursive: true, force: true });
      fn();
    };
    const child = spawn(argv[0], argv.slice(1), { cwd });
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error(`Summary command timed out after ${timeoutMs / 1000}s.`)));
    }, timeoutMs);
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", (e) => finish(() => reject(new Error(`Summary command could not start: ${e.message}`))));
    child.on("close", (code) =>
      finish(() => {
        if (code !== 0) reject(new Error(`Summary command exited with ${code}: ${cut(oneLine(stderr || stdout), 200)}`));
        else resolve(stdout);
      }),
    );
    child.stdin.on("error", () => {}); // EPIPE when the command exits without reading stdin
    child.stdin.end(hasPromptToken ? undefined : prompt);
  });
}

/**
 * Gemini digest for one task, cached in <stateDir>/progress/<sid>.json; every real call also appends
 * "- <ISO time> <pct>% <summary>" to <stateDir>/progress/<sid>.md. The cache is returned unless
 * force, or it is older than summaryMinSec AND new parts exist since its lastPartTime.
 */
export async function summarize(sid, { force = false, cmd, now = Date.now(), dir, activity } = {}) {
  const cacheDir = dir ?? join(config.stateDir, "progress");
  const act = activity ?? sessionActivity(sid);
  let cache = null;
  try {
    cache = JSON.parse(readFileSync(join(cacheDir, `${sid}.json`), "utf8"));
  } catch {}
  if (cache?.digest && !force) {
    const ageSec = (now - cache.at) / 1000;
    const hasNewParts = act.lastPartTime > (cache.lastPartTime ?? 0);
    if (!(ageSec >= config.summaryMinSec && hasNewParts)) return { ...cache, cached: true };
  }

  const prompt = PROMPT_INTRO + buildDigest(act.rows, { firstUserText: act.firstUserText });
  mkdirSync(cacheDir, { recursive: true });
  const schemaFile = join(cacheDir, "summary-schema.json");
  writeFileSync(schemaFile, JSON.stringify(summarySchema, null, 2) + "\n");
  const stdout = await runSummary(cmd ?? process.env.ZCODE_MCP_SUMMARY_CMD ?? DEFAULT_SUMMARY_CMD, prompt, schemaFile);
  const digest = parseSummaryOutput(stdout);
  if (!digest) throw new Error(`Summary command returned unparseable output: ${cut(oneLine(stdout), 200)}`);

  const entry = { at: now, lastPartTime: act.lastPartTime, digest };
  writeFileSync(join(cacheDir, `${sid}.json`), JSON.stringify(entry, null, 2) + "\n");
  appendFileSync(join(cacheDir, `${sid}.md`), `- ${new Date(now).toISOString()} ${digest.progressPct ?? "?"}% ${digest.summary}\n`);
  return { ...entry, cached: false };
}
