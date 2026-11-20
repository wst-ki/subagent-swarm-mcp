import { test } from "node:test";
import assert from "node:assert/strict";
import { LogTailer, runningSessions, taskStatus } from "../src/store.mjs";
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
