// Stateless, bounded polling of ZCode's existing lifecycle log. This is not the
// desktop's v4 stream: logs do not provide assistant text or tool input/output.
import { closeSync, fstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./config.mjs";

const FILE = /^zcode-[A-Za-z0-9_-]+\.jsonl$/;
const MAX_READ = 256 * 1024;
const MAX_LINE = 64 * 1024;
const EVENTS = new Set(["turn.started", "turn.completed", "turn.failed", "model.request.started", "model.request.completed", "model.request.failed", "tool.call.started", "tool.call.completed", "tool.call.failed"]);

function encode(c) { return Buffer.from(JSON.stringify(c)).toString("base64url"); }
function decode(token) {
  try {
    if (typeof token !== "string" || token.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(token)) throw Error();
    const c = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (c.v !== 1 || !FILE.test(c.file) || !Number.isSafeInteger(c.offset) || c.offset < 0 ||
        typeof c.dev !== "string" || typeof c.ino !== "string" || typeof c.discard !== "boolean" ||
        typeof c.taskId !== "string") throw Error();
    return c;
  } catch { throw new Error("Invalid event cursor"); }
}

function filesIn(dir) {
  try { return readdirSync(dir).filter((f) => FILE.test(f)).sort(); }
  catch (e) { if (e.code === "ENOENT") return []; throw e; }
}

function eventOf(r, taskId) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return null;
  if (r.sessionId !== taskId || !EVENTS.has(r.event)) return null;
  const out = { source: "zcode.jsonl", type: r.event, timestamp: typeof r.timestamp === "string" && r.timestamp.length <= 64 ? r.timestamp : null, taskId };
  for (const [key, value] of Object.entries({ turnId: r.turnId, toolCallId: r.toolCallId,
    toolName: r.context?.toolName, status: r.status, durationMs: r.durationMs })) {
    if ((typeof value === "string" && value.length <= 256) || (typeof value === "number" && Number.isFinite(value))) out[key] = value;
  }
  return out;
}

/** Cursor marks consumed bytes, not a guarantee that upstream emitted every event. */
export function readSessionEvents({ taskId, cursor, limit = 50, start = "latest", dir = paths.cliLogDir }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be between 1 and 100");
  if (start !== "latest" && start !== "oldest") throw new Error("start must be latest or oldest");
  const files = filesIn(dir);
  const gaps = [];
  let c = cursor ? decode(cursor) : null;
  if (c && c.taskId !== taskId) throw new Error("Event cursor belongs to another session");
  if (!files.length) return { taskId, source: "zcode.jsonl", events: [], cursor: cursor ?? null, gaps: ["log_unavailable"], hasMore: false };
  if (!c) {
    c = { v: 1, taskId, file: start === "oldest" ? files[0] : files.at(-1), offset: 0, dev: "", ino: "", discard: false };
    gaps.push(start === "oldest" ? "history_before_retained_files_unknown" : "history_before_initial_file_not_scanned");
  } else if (!files.includes(c.file)) {
    // Old files can disappear during retention. Do not claim continuity.
    c = { ...c, file: files[0], offset: 0, dev: "", ino: "", discard: false };
    gaps.push("cursor_file_missing");
  }
  let fd;
  try {
    fd = openSync(join(dir, c.file), "r");
    const st = fstatSync(fd, { bigint: true });
    const dev = String(st.dev), ino = String(st.ino);
    if ((c.dev && (c.dev !== dev || c.ino !== ino)) || BigInt(c.offset) > st.size) {
      gaps.push(c.dev !== dev || c.ino !== ino ? "file_replaced" : "file_truncated");
      c.offset = 0;
      c.discard = false;
    }
    c.dev = dev; c.ino = ino;
    const remaining = st.size - BigInt(c.offset);
    const readSize = Number(remaining > BigInt(MAX_READ) ? BigInt(MAX_READ) : remaining);
    const buf = Buffer.alloc(readSize);
    const count = readSize ? readSync(fd, buf, 0, readSize, c.offset) : 0;
    const events = [];
    let start = 0;
    while (start < count) {
      const nl = buf.indexOf(10, start);
      if (nl === -1) {
        if (c.discard || count - start > MAX_LINE) {
          if (!c.discard) gaps.push("oversize_line");
          c.discard = true;
          c.offset += count - start;
          start = count;
        }
        break; // incomplete normal line: leave offset at its beginning
      }
      const length = nl - start;
      if (c.discard) c.discard = false;
      else if (length > MAX_LINE) gaps.push("oversize_line");
      else {
        const line = buf.subarray(start, nl).toString("utf8");
        // A malformed record may have belonged to this session.
        try {
          const ev = eventOf(JSON.parse(line), taskId);
          if (ev) {
            // Identity is the physical record location, stable across replay of
            // the same file and independent of the consumer's page size.
            ev.eventId = encode({ v: 1, file: c.file, dev, ino, offset: c.offset });
            events.push(ev);
          }
        } catch { gaps.push("malformed_line"); }
      }
      c.offset += length + 1;
      start = nl + 1;
      if (events.length >= limit) break;
    }
    let hasMore = BigInt(c.offset) < st.size && (start < count && buf.indexOf(10, start) !== -1 || count === MAX_READ);
    const next = files[files.indexOf(c.file) + 1];
    if (next && !hasMore) {
      if (BigInt(c.offset) !== st.size || c.discard) gaps.push("incomplete_line_at_rotation");
      if (BigInt(c.offset) === st.size || count < MAX_READ) {
        c = { ...c, file: next, offset: 0, dev: "", ino: "", discard: false };
        hasMore = true;
      }
    }
    return { taskId, source: "zcode.jsonl", events, cursor: encode(c), gaps: [...new Set(gaps)], hasMore,
      note: "Lifecycle log only; no text stream or tool arguments. A cursor is bounded by retained files." };
  } finally { if (fd !== undefined) closeSync(fd); }
}
