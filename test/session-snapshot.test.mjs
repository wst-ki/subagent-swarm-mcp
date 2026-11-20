import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readSessionPartContent, readSessionParts } from "../src/session-snapshot.mjs";

test("bounded assistant snapshots paginate, isolate sessions, and omit large or unrequested content", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`create table session (id text primary key);
      create table message (id text primary key, session_id text, data text);
      create table part (id text primary key, message_id text, session_id text, sequence integer, time_created integer, time_updated integer, data text);
      insert into session values ('session_a'), ('session_b');
      insert into message values ('m1','session_a','{"role":"assistant"}'), ('m2','session_a','{"role":"user"}'), ('m3','session_b','{"role":"assistant"}');`);
    const insert = db.prepare("insert into part values (?, ?, ?, 0, 1, 2, ?)");
    insert.run("a", "m1", "session_a", JSON.stringify({ type: "text", text: "hello" }));
    insert.run("b", "m1", "session_a", JSON.stringify({ type: "tool", tool: "Bash", callID: "call", state: { status: "completed", input: { cmd: "x" }, output: "x".repeat(9000) } }));
    insert.run("c", "m2", "session_a", JSON.stringify({ type: "text", text: "private prompt" }));
    insert.run("d", "m3", "session_b", JSON.stringify({ type: "text", text: "other session" }));
    const first = readSessionParts(db, { taskId: "session_a", limit: 1 });
    assert.equal(first.parts.length, 1);
    assert.equal(first.parts[0].id, "a");
    assert.equal(first.parts[0].content, undefined);
    assert.equal(first.nextAfter, "a");
    const next = readSessionParts(db, { taskId: "session_a", after: first.nextAfter, includeContent: true });
    assert.equal(next.parts.length, 1);
    assert.equal(next.parts[0].toolStatus, "completed");
    assert.equal(next.parts[0].contentOmitted, "exceeds 8192 bytes");
    assert.equal(next.nextAfter, null);
    assert.equal(readSessionParts(db, { taskId: "session_a", includeContent: true }).parts[0].content.text, "hello");
    const chunks = [];
    let offset = 0, version;
    do {
      const p = readSessionPartContent(db, { taskId: "session_a", partId: "b", offset, limit: 1024, expected: version });
      version = p.version;
      chunks.push(Buffer.from(p.content, "base64"));
      offset = p.nextOffset;
    } while (offset !== null);
    assert.equal(JSON.parse(Buffer.concat(chunks).toString()).state.output.length, 9000);
    assert.throws(() => readSessionPartContent(db, { taskId: "session_a", partId: "b", offset: 1 }), /expected version/);
    db.prepare("update part set time_updated = 3 where id = 'b'").run();
    assert.throws(() => readSessionPartContent(db, { taskId: "session_a", partId: "b", offset: 1, expected: version }), /changed/);
    assert.throws(() => readSessionPartContent(db, { taskId: "session_b", partId: "b" }), /No such/);
    assert.throws(() => readSessionPartContent(db, { taskId: "session_a", partId: "c" }), /No such/);
    assert.throws(() => readSessionParts(db, { taskId: "missing" }), /No such/);
    assert.throws(() => readSessionParts(db, { taskId: "session_a", limit: 51 }), /limit/);
  } finally { db.close(); }
});
