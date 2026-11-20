import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readModelIo } from "../src/session-model-io.mjs";

const taskId = "session_test";
const record = (text = "answer") => JSON.stringify({ type: "model_io", sessionId: taskId,
  model: { providerId: "plan", modelId: "flash", extra: "hidden" }, request: { headers: { authorization: "secret" }, body: "prompt" },
  response: { text, reasoningText: "private reasoning", toolCalls: [{ id: "call", name: "Bash", input: { command: "echo ok" } }] } }) + "\n";

test("reads optional per-session records with opt-in content and never returns request data", () => {
  const dir = mkdtempSync(join(tmpdir(), "zcode-model-io-"));
  try {
    assert.equal(readModelIo({ taskId, dir }).available, false);
    const f = join(dir, `model-io-${taskId}.jsonl`);
    writeFileSync(f, record());
    const first = readModelIo({ taskId, dir });
    assert.equal(first.record.toolCalls[0].name, "Bash");
    assert.equal(first.record.text, undefined);
    assert.equal(first.record.toolCalls[0].input, undefined);
    assert.equal(JSON.stringify(first).includes("secret"), false);
    const content = readModelIo({ taskId, dir, includeContent: true });
    assert.equal(content.record.text, "answer");
    assert.equal(content.record.toolCalls[0].input.command, "echo ok");
    assert.equal(JSON.stringify(content).includes("private reasoning"), false);
    const tail = record("next");
    appendFileSync(f, tail.slice(0, 20));
    const partial = readModelIo({ taskId, dir, cursor: first.cursor });
    assert.equal(partial.record, null);
    appendFileSync(f, tail.slice(20));
    assert.equal(readModelIo({ taskId, dir, cursor: partial.cursor, includeContent: true }).record.text, "next");
    renameSync(f, join(dir, "old"));
    writeFileSync(f, record());
    assert.ok(readModelIo({ taskId, dir, cursor: first.cursor }).gaps.includes("file_replaced"));
    assert.throws(() => readModelIo({ taskId: "session_../../bad", dir }), /Invalid/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("large or malformed records fail closed without advancing the cursor", () => {
  const dir = mkdtempSync(join(tmpdir(), "zcode-model-io-"));
  try {
    const f = join(dir, `model-io-${taskId}.jsonl`);
    writeFileSync(f, "x".repeat(1024 * 1024 + 1));
    const first = readModelIo({ taskId, dir });
    assert.ok(first.gaps.includes("record_exceeds_1mib"));
    const again = readModelIo({ taskId, dir, cursor: first.cursor });
    assert.equal(again.cursor, first.cursor);
    writeFileSync(f, "bad json\n");
    assert.ok(readModelIo({ taskId, dir }).gaps.includes("malformed_record"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
