import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LogTailer, findSessionByPromptInDb, runningSessions, taskStatus } from "../src/store.mjs";
import { config } from "../src/config.mjs";

const ev = (event, extra = {}) =>
  JSON.stringify({ timestamp: "2026-10-19T10:00:00.000Z", event, sessionId: "s1", turnId: "t1", ...extra });

test("turn lifecycle is tracked by turnId", () => {
  const t = new LogTailer("/nonexistent");
  t.ingestLine(ev("turn.started"));
  assert.equal([...t.sessions.get("s1").turns.values()][0].completedAt, null);
  t.ingestLine(ev("turn.completed", { status: "completed", timestamp: "2026-10-19T10:00:05.000Z" }));
  assert.equal(t.sessions.get("s1").turns.get("t1").status, "completed");
});

test("current tool is set on start and cleared on completion", () => {
  const t = new LogTailer("/nonexistent");
  t.ingestLine(ev("tool.call.started", { toolCallId: "c1", context: { toolName: "Bash" } }));
  assert.equal(t.sessions.get("s1").tool.name, "Bash");
  assert.equal(t.sessions.get("s1").toolCalls, 1);
  t.ingestLine(ev("tool.call.completed", { toolCallId: "c1" }));
  assert.equal(t.sessions.get("s1").tool, null);
});

test("garbage and unrelated lines are ignored", () => {
  const t = new LogTailer("/nonexistent");
  t.ingestLine("not json {{{ sessionId");
  t.ingestLine(JSON.stringify({ event: "mcp.server.connected", sessionId: "s1" }));
  assert.equal(t.sessions.size, 0);
});

test("a failed tool clears the matching current tool", () => {
  const t = new LogTailer("/nonexistent");
  t.ingestLine(ev("tool.call.started", { toolCallId: "c1" }));
  t.ingestLine(ev("tool.call.failed", { toolCallId: "other" }));
  assert.equal(t.sessions.get("s1").tool.id, "c1");
  t.ingestLine(ev("tool.call.failed", { toolCallId: "c1" }));
  assert.equal(t.sessions.get("s1").tool, null);
});

test("zcode_protocol.startup.started interrupts earlier in-flight turns and clears stale tool", () => {
  const t = new LogTailer("/nonexistent");
  t.ingestLine(ev("turn.started", { sessionId: "old", turnId: "t_old", timestamp: "2026-11-14T21:13:00.000Z" }));
  t.ingestLine(ev("tool.call.started", { sessionId: "old", turnId: "t_old", toolCallId: "c1", timestamp: "2026-11-14T21:13:05.000Z" }));
  t.ingestLine(JSON.stringify({ timestamp: "2026-11-14T22:23:22.000Z", event: "zcode_protocol.startup.started" }));
  t.ingestLine(ev("turn.started", { sessionId: "fresh", turnId: "t_new", timestamp: "2026-11-14T22:24:00.000Z" }));

  const oldTurn = t.sessions.get("old").turns.get("t_old");
  assert.equal(oldTurn.status, "interrupted");
  assert.equal(oldTurn.completedAt, Date.parse("2026-11-14T22:23:22.000Z"));
  assert.equal(t.sessions.get("old").tool, null);

  const freshTurn = t.sessions.get("fresh").turns.get("t_new");
  assert.equal(freshTurn.completedAt, null);
  assert.equal(t.lastStartupAt, Date.parse("2026-11-14T22:23:22.000Z"));
});

test("pre-boot and pre-startup orphaned turns and starting sessions fail closed and leave runningSessions", () => {
  const t = new LogTailer("/nonexistent");
  const tOld = Date.parse("2026-11-14T21:13:00.000Z");
  const tBoot = Date.parse("2026-11-14T21:52:00.000Z");
  const tStart = Date.parse("2026-11-14T22:23:22.000Z");
  const tNow = Date.parse("2026-11-14T22:25:00.000Z");

  // Session with turn started before startup/boot (even without seeing startup line yet if bootAt > startedAt)
  t.ingestLine(ev("turn.started", { sessionId: "orphan_turn", turnId: "t1", timestamp: "2026-11-14T21:13:00.000Z" }));
  // Fresh running session started after startup
  t.ingestLine(ev("turn.started", { sessionId: "live_turn", turnId: "t2", timestamp: "2026-11-14T22:24:00.000Z" }));

  const rows = new Map([
    ["orphan_turn", { id: "orphan_turn", title: "Orphan Turn", time_created: tOld - 1000 }],
    ["orphan_starting", { id: "orphan_starting", title: "Orphan Starting", time_created: tOld }],
    ["live_turn", { id: "live_turn", title: "Live Turn", time_created: tStart + 1000 }],
  ]);

  const opts = {
    bootAt: tBoot,
    tailer: t,
    sessionRowFn: (sid) => rows.get(sid) ?? null,
    turnUsageRowsFn: () => [],
  };

  const stOrphanTurn = taskStatus("orphan_turn", tNow, opts);
  assert.equal(stOrphanTurn.status, "failed");
  assert.equal(stOrphanTurn.interrupted, true);
  assert.equal(stOrphanTurn.elapsedSec, Math.round((tBoot - tOld) / 1000));

  const stOrphanStart = taskStatus("orphan_starting", tNow, opts);
  assert.equal(stOrphanStart.status, "failed");
  assert.equal(stOrphanStart.interrupted, true);
  assert.equal(stOrphanStart.elapsedSec, Math.round((tBoot - tOld) / 1000));

  assert.deepEqual(runningSessions(tNow, opts), ["live_turn"]);

  // Now ingest startup line later than tBoot and confirm elapsedSec stays bounded at tStart
  const t2 = new LogTailer("/nonexistent");
  t2.ingestLine(ev("turn.started", { sessionId: "orphan_turn", turnId: "t1", timestamp: "2026-11-14T21:13:00.000Z" }));
  t2.ingestLine(JSON.stringify({ timestamp: "2026-11-14T22:23:22.000Z", event: "zcode_protocol.startup.started" }));
  const opts2 = { ...opts, tailer: t2 };
  assert.equal(taskStatus("orphan_turn", tNow, opts2).status, "failed");
  assert.equal(taskStatus("orphan_starting", tNow, opts2).elapsedSec, Math.round((tStart - tOld) / 1000));
  assert.deepEqual(runningSessions(tNow, opts2), []);
});

test("follow-up turn interrupted after completed turn_usage reports failed instead of stale completed", () => {
  const t = new LogTailer("/nonexistent");
  const t1Start = Date.parse("2026-11-14T21:00:00.000Z");
  const t1End = Date.parse("2026-11-14T21:01:00.000Z");
  const t2Start = Date.parse("2026-11-14T21:10:00.000Z");
  const tRestart = Date.parse("2026-11-14T21:52:00.000Z");
  const tNow = Date.parse("2026-11-14T22:00:00.000Z");

  t.ingestLine(ev("turn.started", { sessionId: "followup_s", turnId: "t1", timestamp: "2026-11-14T21:00:00.000Z" }));
  t.ingestLine(ev("turn.completed", { sessionId: "followup_s", turnId: "t1", status: "completed", timestamp: "2026-11-14T21:01:00.000Z" }));
  t.ingestLine(ev("turn.started", { sessionId: "followup_s", turnId: "t2", timestamp: "2026-11-14T21:10:00.000Z" }));
  t.ingestLine(JSON.stringify({ timestamp: "2026-11-14T21:52:00.000Z", event: "zcode_protocol.startup.started" }));

  const st = taskStatus("followup_s", tNow, {
    bootAt: 0,
    tailer: t,
    sessionRowFn: () => ({ id: "followup_s", title: "Follow-up", time_created: t1Start }),
    turnUsageRowsFn: () => [
      {
        turn_id: "t1",
        status: "completed",
        started_at: t1Start,
        completed_at: t1End,
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 0,
        cache_write_input_tokens: 0,
        computed_total_tokens: 120,
        tool_call_count: 0,
        model_request_count: 1,
      },
    ],
  });

  assert.equal(st.status, "failed");
  assert.equal(st.interrupted, true);
  assert.equal(st.elapsedSec, Math.round((tRestart - t2Start) / 1000));
  assert.equal(st.usage.totalTokens, 120);
});

test("unstarted starting session exceeding startingTimeoutSec transitions to failed", () => {
  const t = new LogTailer("/nonexistent");
  const created = Date.parse("2026-11-14T22:00:00.000Z");
  const boot = Date.parse("2026-11-14T21:50:00.000Z");
  const within = created + (config.startingTimeoutSec - 5) * 1000;
  const expired = created + (config.startingTimeoutSec + 5) * 1000;

  const opts = {
    bootAt: boot,
    tailer: t,
    sessionRowFn: () => ({ id: "s_hang", title: "Hanging start", time_created: created }),
    turnUsageRowsFn: () => [],
  };

  assert.equal(taskStatus("s_hang", within, opts).status, "starting");
  const stExpired = taskStatus("s_hang", expired, opts);
  assert.equal(stExpired.status, "failed");
  assert.equal(stExpired.interrupted, undefined);
  assert.match(stExpired.note, /timed out/i);
  assert.equal(stExpired.elapsedSec, config.startingTimeoutSec);
});

test("LogTailer extracts nested turn.failed 429/3008 concurrency error and ignores background querySource failures", () => {
  const t = new LogTailer("/nonexistent");
  const tStart = Date.parse("2026-11-21T09:15:06.000Z");
  const tFail = Date.parse("2026-11-21T09:15:09.000Z");
  t.ingestLine(ev("turn.started", { sessionId: "s429", turnId: "turn_1", timestamp: "2026-11-21T09:15:06.000Z" }));
  // Background memory/title failure must not pollute main_turn errors
  t.ingestLine(
    ev("model.request.failed", {
      sessionId: "s429",
      turnId: "turn_1",
      timestamp: "2026-11-21T09:15:07.000Z",
      context: { querySource: "session_title", statusCode: 429, statusMessage: "background title fail" },
    }),
  );
  assert.equal(t.sessions.get("s429").lastModelError, undefined);

  // Real turn.failed with nested ZCode ProviderBusinessError 3008
  t.ingestLine(
    ev("turn.failed", {
      sessionId: "s429",
      turnId: "turn_1",
      timestamp: "2026-11-21T09:15:09.000Z",
      error: {
        type: "unknown_error",
        code: "UNKNOWN_ERROR",
        message: "Turn execution failed",
        cause: {
          code: "model_rate_limited",
          message: "user concurrency limit exceeded",
          context: { statusCode: 429, providerCode: "3008", reason: "rate_limited", retryable: false },
        },
      },
    }),
  );

  // Even when SQLite turn_usage only stores UNKNOWN_ERROR, taskStatus enriches error with 429/3008 details
  const st = taskStatus("s429", tFail + 1000, {
    bootAt: 0,
    tailer: t,
    sessionRowFn: () => ({ id: "s429", title: "Concurrency fail", time_created: tStart }),
    turnUsageRowsFn: () => [
      {
        turn_id: "turn_1",
        status: "error",
        error_type: "unknown_error",
        error_code: "UNKNOWN_ERROR",
        started_at: tStart,
        completed_at: tFail,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_write_input_tokens: 0,
        computed_total_tokens: 0,
        tool_call_count: 0,
        model_request_count: 1,
      },
    ],
  });
  assert.equal(st.status, "failed");
  assert.equal(st.error.code, "UNKNOWN_ERROR");
  assert.equal(st.error.causeCode, "model_rate_limited");
  assert.equal(st.error.statusCode, 429);
  assert.equal(st.error.providerCode, "3008");
  assert.equal(st.error.message, "user concurrency limit exceeded");
  assert.deepEqual(runningSessions(tFail + 1000, { bootAt: 0, tailer: t, sessionRowFn: () => ({ id: "s429", time_created: tStart }), turnUsageRowsFn: () => [] }), []);
});

test("LogTailer.refresh reads logs in bounded chunks across multi-byte UTF-8 boundaries and handles truncation", () => {
  const dir = mkdtempSync(join(tmpdir(), "zcode-logtail-chunk-"));
  try {
    const logPath = join(dir, "zcode-2026-11-22.jsonl");
    const line1 = ev("turn.started", { sessionId: "s_utf8", turnId: "t1", note: "中文日志内容测试".repeat(6) });
    const line2 = ev("turn.completed", { sessionId: "s_utf8", turnId: "t1", status: "completed", timestamp: "2026-10-19T10:00:05.000Z" });
    // Write line1 + partial line2 (split mid-UTF-8/JSON), refresh in tiny 48-byte chunks, then append rest.
    const splitAt = Math.floor(line2.length / 2);
    writeFileSync(logPath, line1 + "\n" + line2.slice(0, splitAt), "utf8");

    const t = new LogTailer(dir);
    t.refresh({ chunkBytes: 48 });
    assert.equal(t.sessions.get("s_utf8").turns.get("t1").completedAt, null);

    appendFileSync(logPath, line2.slice(splitAt) + "\n", "utf8");
    t.refresh({ chunkBytes: 48 });
    assert.equal(t.sessions.get("s_utf8").turns.get("t1").status, "completed");

    // Truncate/rotate file -> resets offset AND stale carry buffer cleanly.
    const line3 = ev("turn.started", { sessionId: "s_rot", turnId: "t2" });
    writeFileSync(logPath, line3 + "\n", "utf8");
    t.refresh({ chunkBytes: 32 });
    assert.ok(t.sessions.get("s_rot").turns.has("t2"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findSessionByPromptInDb avoids scanning part table and finds pre-warmed draft sessions", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE session (id text primary key, time_created integer not null, time_updated integer not null);
      CREATE TABLE message (id text primary key, session_id text not null, time_created integer not null, data text not null, sequence integer);
      CREATE TABLE part (id text primary key, message_id text not null, session_id text not null, time_created integer not null, data text not null, sequence integer);
      CREATE INDEX message_session_time_created_id_idx on message(session_id, time_created, id);
      CREATE INDEX part_session_message_sequence_idx on part(session_id, message_id, sequence);
    `);

    const tOld = 1_700_000_000_000;
    const tSend = tOld + 600_000; // 10 minutes after draft pre-warm!
    // Old completed session
    db.prepare("insert into session values (?,?,?)").run("sess_old", tOld - 10_000, tOld - 5_000);
    db.prepare("insert into message values (?,?,?,?,?)").run("m_old", "sess_old", tOld - 9_000, JSON.stringify({ role: "user" }), 0);
    db.prepare("insert into part values (?,?,?,?,?,?)").run("p_old", "m_old", "sess_old", tOld - 9_000, JSON.stringify({ type: "text", text: "old prompt" }), 0);

    // Pre-warmed draft session created 10 minutes earlier whose session.time_updated hasn't bumped yet
    db.prepare("insert into session values (?,?,?)").run("sess_prewarm", tOld, tOld);
    db.prepare("insert into message values (?,?,?,?,?)").run("m_new", "sess_prewarm", tSend, JSON.stringify({ role: "user" }), 0);
    db.prepare("insert into part values (?,?,?,?,?,?)").run("p_new", "m_new", "sess_prewarm", tSend, JSON.stringify({ type: "text", text: "hello prewarmed draft" }), 0);

    // Verify query plan anchors on session and index-seeks message & part (NEVER SCAN part)
    const plan = db
      .prepare(
        `explain query plan
         with recent_sessions as materialized (
           select id from session
            where time_updated >= ? or time_created >= ?
           union
           select id from (select id from session order by time_created desc limit 25)
         )
         select m.session_id as sid, json_extract(p.data,'$.text') as text
           from recent_sessions rs
           cross join message m on m.session_id = rs.id and m.time_created >= ?
           cross join part p on p.session_id = m.session_id and p.message_id = m.id
          where json_extract(m.data,'$.role') = 'user'
            and json_extract(m.data,'$.metadata.visibility') is null
            and json_extract(p.data,'$.type') = 'text'
          order by m.time_created desc limit 20`,
      )
      .all(tSend - 3000, tSend - 3000, tSend - 3000)
      .map((r) => r.detail)
      .join(" | ");
    assert.doesNotMatch(plan, /SCAN p\b/);
    assert.match(plan, /message_session_time_created_id_idx/);
    assert.match(plan, /part_session_message_sequence_idx/);

    assert.equal(findSessionByPromptInDb(db, "hello prewarmed draft", tSend - 3000), "sess_prewarm");
    assert.equal(findSessionByPromptInDb(db, "old prompt", tSend - 3000), null);
  } finally {
    db.close();
  }
});
