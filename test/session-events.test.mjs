import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSessionEvents } from "../src/session-events.mjs";

const line = (event, extra = {}) => JSON.stringify({ event, sessionId: "session_a", turnId: "turn_1", timestamp: "2026-11-05T00:00:00Z", ...extra }) + "\n";
const read = (dir, cursor, limit = 50) => readSessionEvents({ dir, taskId: "session_a", cursor, limit });

test("polls incrementally, filters sessions, retains partial lines and advances on rotation", () => {
  const dir = mkdtempSync(join(tmpdir(), "zcode-events-"));
  try {
    const first = join(dir, "zcode-2026-11-05.jsonl");
    writeFileSync(first, line("turn.started") + "null\n" + line("tool.call.started", { sessionId: "session_b" }) + line("tool.call.started", { toolCallId: "c1", context: { toolName: "Bash", secret: "hidden" } }));
    const a = read(dir, undefined, 1);
    assert.deepEqual(a.events.map((e) => e.type), ["turn.started"]);
    assert.equal(read(dir, undefined, 1).events[0].eventId, a.events[0].eventId);
    assert.ok(a.gaps.includes("history_before_initial_file_not_scanned"));
    const b = read(dir, a.cursor);
    assert.equal(b.events[0].toolName, "Bash");
    assert.equal(JSON.stringify(b).includes("hidden"), false);
    const end = line("tool.call.completed", { toolCallId: "c1" });
    appendFileSync(first, end.slice(0, 20));
    const partial = read(dir, b.cursor);
    assert.equal(partial.events.length, 0);
    appendFileSync(first, end.slice(20));
    const complete = read(dir, partial.cursor);
    assert.equal(complete.events[0].type, "tool.call.completed");
    writeFileSync(join(dir, "zcode-2026-11-06.jsonl"), line("turn.completed"));
    const rotate = read(dir, complete.cursor);
    assert.equal(rotate.hasMore, true);
    assert.equal(read(dir, rotate.cursor).events[0].type, "turn.completed");
    const oldest = readSessionEvents({ dir, taskId: "session_a", start: "oldest" });
    assert.equal(oldest.events[0].type, "turn.started");
    assert.ok(oldest.gaps.includes("history_before_retained_files_unknown"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("reports truncation, replacement, missing files, oversize records and invalid cursors", () => {
  const dir = mkdtempSync(join(tmpdir(), "zcode-events-"));
  try {
    const f = join(dir, "zcode-2026-11-05.jsonl");
    writeFileSync(f, line("turn.started") + line("turn.completed"));
    let c = read(dir).cursor;
    writeFileSync(f, line("turn.started"));
    let out = read(dir, c);
    assert.ok(out.gaps.includes("file_truncated"));
    c = out.cursor;
    renameSync(f, join(dir, "old-file"));
    writeFileSync(f, line("turn.failed"));
    out = read(dir, c);
    assert.ok(out.gaps.includes("file_replaced"));
    c = out.cursor;
    rmSync(f);
    writeFileSync(join(dir, "zcode-2026-11-06.jsonl"), "x".repeat(300000) + "\n" + line("turn.completed"));
    out = read(dir, c);
    assert.ok(out.gaps.includes("cursor_file_missing"));
    assert.ok(out.gaps.includes("oversize_line"));
    out = read(dir, out.cursor);
    assert.equal(out.events[0].type, "turn.completed");
    assert.throws(() => read(dir, "invalid!"), /Invalid event cursor/);
    assert.throws(() => readSessionEvents({ dir, taskId: "session_b", cursor: out.cursor }), /another session/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("reports an incomplete line when advancing to a rotated file", () => {
  const dir = mkdtempSync(join(tmpdir(), "zcode-events-"));
  try {
    const f = join(dir, "zcode-2026-11-05.jsonl");
    writeFileSync(f, line("turn.started"));
    const c = read(dir).cursor;
    appendFileSync(f, "partial");
    writeFileSync(join(dir, "zcode-2026-11-06.jsonl"), line("turn.completed"));
    const out = read(dir, c);
    assert.ok(out.gaps.includes("incomplete_line_at_rotation"));
    assert.equal(read(dir, out.cursor).events[0].type, "turn.completed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
