// Optional ZCode-owned diagnostic recordings. Read one bounded complete record
// at a time; never expose request headers, request bodies, or reasoning.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.mjs";

const MAX_RECORD = 1024 * 1024;
const encode = (x) => Buffer.from(JSON.stringify(x)).toString("base64url");
function parseCursor(token, taskId) {
  try {
    if (typeof token !== "string" || token.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(token)) throw Error();
    const c = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (c.v !== 1 || c.taskId !== taskId || typeof c.dev !== "string" || typeof c.ino !== "string" ||
        !Number.isSafeInteger(c.offset) || c.offset < 0) throw Error();
    return c;
  } catch { throw new Error("Invalid model IO cursor"); }
}

export function readModelIo({ taskId, cursor, includeContent = false, dir = join(config.zcodeHome, "cli", "rollout") }) {
  if (!/^session_[A-Za-z0-9_-]{1,192}$/.test(taskId)) throw new Error("Invalid ZCode session id");
  let c = cursor ? parseCursor(cursor, taskId) : { v: 1, taskId, offset: 0, dev: "", ino: "" };
  let fd;
  try {
    try { fd = openSync(join(dir, `model-io-${taskId}.jsonl`), "r"); }
    catch (e) {
      if (e.code === "ENOENT") return { taskId, available: false, cursor: cursor ?? null, gaps: ["recording_unavailable"], record: null, hasMore: false };
      throw e;
    }
    const st = fstatSync(fd, { bigint: true });
    const dev = String(st.dev), ino = String(st.ino), gaps = [];
    if (!cursor) gaps.push("recording_start_and_coverage_unknown");
    if ((c.dev && (c.dev !== dev || c.ino !== ino)) || BigInt(c.offset) > st.size) {
      gaps.push(c.dev !== dev || c.ino !== ino ? "file_replaced" : "file_truncated");
      c = { ...c, offset: 0 };
    }
    c.dev = dev; c.ino = ino;
    const remain = st.size - BigInt(c.offset);
    const size = Number(remain > BigInt(MAX_RECORD + 1) ? BigInt(MAX_RECORD + 1) : remain);
    const buf = Buffer.alloc(size);
    const n = size ? readSync(fd, buf, 0, size, c.offset) : 0;
    const nl = buf.subarray(0, n).indexOf(10);
    if (nl < 0) {
      if (n > MAX_RECORD) gaps.push("record_exceeds_1mib");
      return { taskId, available: true, cursor: encode(c), gaps, record: null, hasMore: false };
    }
    if (nl > MAX_RECORD) return { taskId, available: true, cursor: encode(c), gaps: [...gaps, "record_exceeds_1mib"], record: null, hasMore: false };
    let r;
    try { r = JSON.parse(buf.subarray(0, nl).toString("utf8")); }
    catch { return { taskId, available: true, cursor: encode(c), gaps: [...gaps, "malformed_record"], record: null, hasMore: false }; }
    if (!r || r.type !== "model_io" || r.sessionId !== taskId || !r.response || typeof r.response !== "object")
      return { taskId, available: true, cursor: encode(c), gaps: [...gaps, "unexpected_record"], record: null, hasMore: false };
    const id = encode({ v: 1, dev, ino, offset: c.offset });
    c.offset += nl + 1;
    const response = r.response;
    const toolCalls = Array.isArray(response.toolCalls) ? response.toolCalls.filter((x) => x && typeof x === "object").map((t) => ({
      ...(typeof t.id === "string" ? { id: t.id } : {}),
      ...(typeof t.name === "string" ? { name: t.name } : {}),
      ...(includeContent && t.input !== undefined ? { input: t.input } : {}),
    })) : [];
    const safe = (x) => typeof x === "string" && x.length <= 256 ? x : null;
    const record = { id, type: "model_io", startedAt: safe(r.startedAt), completedAt: safe(r.completedAt),
      turnId: safe(r.turnId), requestId: safe(r.requestId), querySource: safe(r.querySource),
      model: { providerId: safe(r.model?.providerId), modelId: safe(r.model?.modelId) }, finishReason: safe(response.finishReason), toolCalls,
      ...(includeContent && typeof response.text === "string" ? { text: response.text } : {}) };
    return { taskId, available: true, cursor: encode(c), gaps, record, hasMore: BigInt(c.offset) < st.size,
      note: "Optional model IO recording; no guarantee of coverage, tool output, or per-token streaming." };
  } finally { if (fd !== undefined) closeSync(fd); }
}
