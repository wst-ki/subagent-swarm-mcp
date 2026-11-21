// Read-only view of ZCode's own state: the CLI sqlite db (sessions, messages, per-turn usage)
// and the structured JSONL log (live turn / tool events). Nothing here touches the UI.
import { DatabaseSync } from "node:sqlite";
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";
import { config, paths } from "./config.mjs";

export const SYSTEM_BOOT_AT = Math.floor(Date.now() - uptime() * 1000);

export function withDb(fn) {
  const db = new DatabaseSync(paths.cliDb, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 3000");
    return fn(db);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------- log tailer

const TRACKED = new Set([
  "turn.started",
  "turn.completed",
  "turn.failed",
  "tool.call.started",
  "tool.call.completed",
  "tool.call.failed",
  "model.request.started",
  "model.request.completed",
  "model.request.failed",
]);

/** Extract compact, PII-free upstream error details from ZCode JSONL `turn.failed` or `model.request.failed`. */
export function extractLogError(r) {
  if (!r || typeof r !== "object") return null;
  let out = {};
  if (r.event === "turn.failed" && r.error && typeof r.error === "object") {
    const err = r.error;
    const cause = err.cause && typeof err.cause === "object" ? err.cause : null;
    const cctx = cause?.context && typeof cause.context === "object" ? cause.context : null;
    const bodyErr = cctx?.responseBodySummary?.error && typeof cctx.responseBodySummary.error === "object"
      ? cctx.responseBodySummary.error
      : null;
    const innerCause = cause?.cause && typeof cause.cause === "object" ? cause.cause : null;
    const rawMsg = cause?.message || bodyErr?.providerMessage || innerCause?.message || err.message || "";
    out = {
      type: err.type ?? null,
      code: err.code ?? null,
      causeCode: cause?.code ?? bodyErr?.code ?? innerCause?.code ?? null,
      statusCode: cctx?.statusCode ?? cctx?.responseStatus ?? bodyErr?.responseStatus ?? null,
      providerCode: cctx?.providerCode != null ? String(cctx.providerCode) : bodyErr?.providerCode != null ? String(bodyErr.providerCode) : null,
      reason: cctx?.reason ?? null,
      message: String(rawMsg).trim().slice(0, 300) || null,
      retryable: typeof cctx?.retryable === "boolean" ? cctx.retryable : null,
    };
  } else if (r.event === "model.request.failed" && r.context && typeof r.context === "object") {
    const ctx = r.context;
    const rawMsg = ctx.statusMessage || ctx.errorMessage || ctx.error || "";
    out = {
      statusCode: ctx.statusCode ?? null,
      providerCode: ctx.providerCode != null ? String(ctx.providerCode) : null,
      reason: ctx.reason ?? null,
      message: String(rawMsg).trim().slice(0, 300) || null,
      retryable: typeof ctx.retryable === "boolean" ? ctx.retryable : null,
    };
  } else {
    return null;
  }
  const compact = {};
  for (const [k, v] of Object.entries(out)) {
    if (v !== null && v !== undefined && v !== "") compact[k] = v;
  }
  return Object.keys(compact).length ? compact : null;
}

export class LogTailer {
  #dir;
  #files = new Map(); // path -> { offset, carry }
  sessions = new Map(); // sessionId -> state
  lastStartupAt = 0;

  constructor(dir = paths.cliLogDir) {
    this.#dir = dir;
  }

  #state(sid) {
    let s = this.sessions.get(sid);
    if (!s) {
      if (this.sessions.size >= 500) {
        for (const [oldId, oldState] of this.sessions) {
          if (![...oldState.turns.values()].some((t) => !t.completedAt)) {
            this.sessions.delete(oldId);
            break;
          }
        }
      }
      this.sessions.set(sid, (s = { turns: new Map(), lastEventAt: 0, tool: null, toolCalls: 0 }));
    }
    return s;
  }

  ingestLine(line) {
    // ZCode protocol daemon startup resets all earlier in-flight turns (no sessionId on this line).
    if (line.includes('"zcode_protocol.startup.started"')) {
      try {
        const r = JSON.parse(line);
        if (r.event === "zcode_protocol.startup.started") {
          const ts = Date.parse(r.timestamp);
          if (Number.isFinite(ts)) {
            this.lastStartupAt = Math.max(this.lastStartupAt, ts);
            for (const s of this.sessions.values()) {
              if (s.tool && s.tool.since < ts) s.tool = null;
              for (const [turnId, t] of s.turns) {
                if (!t.completedAt && t.startedAt < ts) {
                  s.turns.set(turnId, { ...t, completedAt: ts, status: "interrupted" });
                }
              }
            }
          }
        }
      } catch {}
      return;
    }
    if (!line.includes('"sessionId"')) return;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      return;
    }
    if (!r.sessionId || !TRACKED.has(r.event)) return;
    const ts = Date.parse(r.timestamp);
    const s = this.#state(r.sessionId);
    s.lastEventAt = Math.max(s.lastEventAt, ts);
    switch (r.event) {
      case "turn.started":
        s.turns.set(r.turnId, { startedAt: ts, completedAt: null, status: null });
        break;
      case "turn.completed": {
        const t = s.turns.get(r.turnId) ?? { startedAt: ts };
        s.turns.set(r.turnId, { ...t, completedAt: ts, status: r.status ?? "completed" });
        break;
      }
      case "turn.failed": {
        const t = s.turns.get(r.turnId) ?? { startedAt: ts };
        const err = extractLogError(r);
        s.turns.set(r.turnId, { ...t, completedAt: ts, status: "failed", ...(err ? { error: err } : {}) });
        s.tool = null;
        if (err) s.lastTurnError = { turnId: r.turnId ?? null, at: ts, ...err };
        break;
      }
      case "model.request.failed": {
        if (!r.context?.querySource || r.context.querySource === "main_turn") {
          const err = extractLogError(r);
          if (err) s.lastModelError = { turnId: r.turnId ?? null, at: ts, ...err };
        }
        break;
      }
      case "tool.call.started":
        s.toolCalls++;
        s.tool = { id: r.toolCallId, name: r.context?.toolName ?? r.context?.tool ?? r.toolName ?? "tool", since: ts };
        break;
      case "tool.call.completed":
      case "tool.call.failed":
        if (s.tool?.id === r.toolCallId) s.tool = null;
        break;
    }
  }

  // Reads whatever was appended to the recent log files since the last call.
  refresh() {
    if (!existsSync(this.#dir)) return;
    const files = readdirSync(this.#dir)
      .filter((f) => /^zcode-.*\.jsonl$/.test(f))
      .sort()
      .slice(-2);
    for (const f of files) {
      const path = join(this.#dir, f);
      let f_ = this.#files.get(path);
      if (!f_) this.#files.set(path, (f_ = { offset: 0, carry: Buffer.alloc(0) }));
      const size = statSync(path).size;
      if (size < f_.offset) f_.offset = 0; // truncated / rotated
      if (size === f_.offset) continue;
      const fd = openSync(path, "r");
      try {
        const buf = Buffer.alloc(size - f_.offset);
        readSync(fd, buf, 0, buf.length, f_.offset);
        f_.offset = size;
        let data = Buffer.concat([f_.carry, buf]);
        let nl;
        while ((nl = data.indexOf(0x0a)) !== -1) {
          this.ingestLine(data.subarray(0, nl).toString("utf8"));
          data = data.subarray(nl + 1);
        }
        f_.carry = Buffer.from(data);
      } finally {
        closeSync(fd);
      }
    }
  }
}

export const tailer = new LogTailer();

// ------------------------------------------------------------------ queries

export function findSessionByPrompt(prompt, sinceMs) {
  const want = prompt.trim();
  return withDb((db) => {
    const rows = db
      .prepare(
        `select m.session_id as sid, json_extract(p.data,'$.text') as text
           from message m join part p on p.message_id = m.id
          where json_extract(m.data,'$.role') = 'user'
            and json_extract(m.data,'$.metadata.visibility') is null
            and json_extract(p.data,'$.type') = 'text'
            and m.time_created >= ?
          order by m.time_created desc limit 20`,
      )
      .all(sinceMs);
    return rows.find((r) => String(r.text).trim() === want)?.sid ?? null;
  });
}

export function sessionRow(sid) {
  return withDb((db) => db.prepare("select id, title, directory, time_created, time_updated from session where id = ?").get(sid) ?? null);
}

export function turnUsageRows(sid) {
  return withDb((db) => db.prepare("select * from turn_usage where session_id = ? order by started_at").all(sid));
}

/** providerId ZCode recorded on the session's newest message (e.g. "account:bigmodel-start-plan"), or null. */
export function sessionProviderId(sid) {
  return withDb((db) => {
    const row = db
      .prepare(
        `select data from message
          where session_id = ? and json_extract(data,'$.providerId') is not null
          order by time_created desc, sequence desc limit 1`,
      )
      .get(sid);
    if (!row) return null;
    try {
      return JSON.parse(row.data).providerId ?? null;
    } catch {
      return null;
    }
  });
}

export function listSessions(directory, limit) {
  return withDb((db) =>
    db
      .prepare(
        `select s.id, s.title, s.time_created, s.time_updated,
                (select status from turn_usage u where u.session_id = s.id order by started_at desc limit 1) as last_status
           from session s
          where s.directory = ? and s.time_deleted is null and s.time_archived is null
          order by s.time_created desc limit ?`,
      )
      .all(directory, limit),
  );
}

export function finalAnswer(sid) {
  return withDb((db) => {
    const lastUser = db
      .prepare(
        `select max(time_created) as t from message
          where session_id = ? and json_extract(data,'$.role') = 'user' and json_extract(data,'$.metadata.visibility') is null`,
      )
      .get(sid)?.t ?? 0;
    const msgs = db
      .prepare(
        `select id, data from message where session_id = ? and json_extract(data,'$.role') = 'assistant' and time_created >= ?
          order by time_created, sequence`,
      )
      .all(sid, lastUser);
    const textOf = (mid) =>
      db
        .prepare(`select data from part where message_id = ? and json_extract(data,'$.type') = 'text' order by sequence, time_created`)
        .all(mid)
        .map((p) => JSON.parse(p.data).text)
        .filter(Boolean)
        .join("\n");
    const texts = msgs.map((m) => ({ id: m.id, model: JSON.parse(m.data), text: textOf(m.id) })).filter((m) => m.text);
    const last = texts.at(-1);
    return {
      text: last?.text ?? "",
      allText: texts.map((t) => t.text),
      model: last ? { providerId: last.model.providerId, modelId: last.model.modelId } : null,
    };
  });
}

// ------------------------------------------------------------- task status

/**
 * Derive a task's state from ZCode's own records.
 * running   : a turn started and has neither a turn.completed event nor a turn_usage row
 * completed / failed / cancelled : taken from the latest turn
 * starting  : session exists but no turn has started yet
 */
export function taskStatus(
  sid,
  now = Date.now(),
  { bootAt = SYSTEM_BOOT_AT, tailer: activeTailer = tailer, sessionRowFn = sessionRow, turnUsageRowsFn = turnUsageRows } = {},
) {
  activeTailer.refresh();
  const row = sessionRowFn(sid);
  if (!row) return { taskId: sid, status: "unknown", note: "No such ZCode session." };
  const usage = turnUsageRowsFn(sid);
  const doneIds = new Set(usage.map((u) => u.turn_id));
  const live = activeTailer.sessions.get(sid);
  const restartCutoff = Math.max(activeTailer.lastStartupAt ?? 0, bootAt ?? 0);
  let inFlight = null;
  let completedViaLog = null;
  for (const [turnId, t] of live?.turns ?? []) {
    if (doneIds.has(turnId)) continue;
    if (t.completedAt) completedViaLog = { turnId, ...t };
    else if (restartCutoff > 0 && t.startedAt < restartCutoff) {
      completedViaLog = { turnId, ...t, completedAt: restartCutoff, status: "interrupted" };
    } else inFlight = { turnId, ...t };
  }
  const last = usage.at(-1);
  const logNewerThanDb = Boolean(completedViaLog && (!last || completedViaLog.startedAt >= (last.started_at ?? 0)));
  const interruptedByLog = Boolean(!inFlight && logNewerThanDb && completedViaLog.status === "interrupted");
  const interruptedBeforeStart = Boolean(!inFlight && !logNewerThanDb && !last && restartCutoff > 0 && row.time_created < restartCutoff);
  const startingTimedOut = Boolean(!inFlight && !logNewerThanDb && !last && !interruptedBeforeStart && now - row.time_created > config.startingTimeoutSec * 1000);

  let status;
  if (inFlight) status = "running";
  else if (logNewerThanDb) {
    status = completedViaLog.status === "error" || completedViaLog.status === "interrupted" ? "failed" : completedViaLog.status;
  } else if (last) status = last.status === "error" ? "failed" : last.status;
  else if (interruptedBeforeStart || startingTimedOut) status = "failed";
  else status = "starting";

  const startedAt =
    inFlight?.startedAt ??
    (logNewerThanDb ? completedViaLog.startedAt : last?.started_at) ??
    live?.turns?.values().next().value?.startedAt ??
    row.time_created;
  let endedAt;
  if (status === "running" || status === "starting") endedAt = now;
  else if (logNewerThanDb) endedAt = completedViaLog.completedAt ?? live?.lastEventAt ?? now;
  else if (last) endedAt = last.completed_at ?? live?.lastEventAt ?? now;
  else if (interruptedBeforeStart) endedAt = restartCutoff;
  else if (startingTimedOut) endedAt = row.time_created + config.startingTimeoutSec * 1000;
  else endedAt = live?.lastEventAt ?? now;

  const out = {
    taskId: sid,
    status,
    title: row.title || null,
    elapsedSec: Math.round((endedAt - startedAt) / 1000),
  };
  if (interruptedByLog || interruptedBeforeStart) {
    out.interrupted = true;
    out.note = "Interrupted by ZCode or host restart.";
  } else if (startingTimedOut) {
    out.note = "Session timed out before starting a turn.";
  }
  if (status === "running") {
    out.currentTool = live?.tool?.name ?? null;
    out.toolCalls = live?.toolCalls ?? 0;
    const idle = Math.round((now - (live?.lastEventAt || startedAt)) / 1000);
    out.idleSec = idle;
    if (idle > config.stalledAfterSec && !live?.tool) out.stalled = true;
  }
  if (last) {
    out.usage = usage.reduce(
      (a, u) => ({
        inputTokens: a.inputTokens + (u.input_tokens ?? 0),
        outputTokens: a.outputTokens + (u.output_tokens ?? 0),
        cacheReadInputTokens: a.cacheReadInputTokens + (u.cache_read_input_tokens ?? 0),
        cacheWriteInputTokens: a.cacheWriteInputTokens + (u.cache_write_input_tokens ?? 0),
        totalTokens: a.totalTokens + (u.computed_total_tokens ?? 0),
        toolCalls: a.toolCalls + (u.tool_call_count ?? 0),
        modelRequests: a.modelRequests + (u.model_request_count ?? 0),
      }),
      { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, totalTokens: 0, toolCalls: 0, modelRequests: 0 },
    );
    if (last.status === "error") out.error = { type: last.error_type, code: last.error_code };
  }
  if (status === "failed" || last?.status === "error") {
    const pickErr = (e) => {
      if (!e || typeof e !== "object") return null;
      const { turnId: _tid, at: _at, ...rest } = e;
      return Object.keys(rest).length ? rest : null;
    };
    const logErr =
      (logNewerThanDb ? pickErr(completedViaLog?.error) : null) ??
      (last?.turn_id ? pickErr(live?.turns?.get(last.turn_id)?.error) : null) ??
      (last?.turn_id && live?.lastTurnError?.turnId === last.turn_id ? pickErr(live.lastTurnError) : null) ??
      (last?.turn_id && live?.lastModelError?.turnId === last.turn_id ? pickErr(live.lastModelError) : null) ??
      (live?.lastTurnError && live.lastTurnError.at >= startedAt - 5000 ? pickErr(live.lastTurnError) : null) ??
      (live?.lastModelError && live.lastModelError.at >= startedAt - 5000 ? pickErr(live.lastModelError) : null);
    if (logErr) {
      out.error = {
        ...logErr,
        ...(out.error ?? {}),
        ...(logErr.causeCode ? { causeCode: logErr.causeCode } : {}),
        ...(logErr.statusCode != null ? { statusCode: logErr.statusCode } : {}),
        ...(logErr.providerCode != null ? { providerCode: logErr.providerCode } : {}),
        ...(logErr.reason ? { reason: logErr.reason } : {}),
        ...(logErr.message ? { message: logErr.message } : {}),
      };
    }
  }
  return out;
}

/** Sessions with a turn currently in flight (any project). */
export function runningSessions(now = Date.now(), opts = {}) {
  const activeTailer = opts.tailer ?? tailer;
  activeTailer.refresh();
  const restartCutoff = Math.max(activeTailer.lastStartupAt ?? 0, opts.bootAt ?? SYSTEM_BOOT_AT);
  const out = [];
  for (const [sid, s] of activeTailer.sessions) {
    if (![...s.turns.values()].some((t) => !t.completedAt && !(restartCutoff > 0 && t.startedAt < restartCutoff))) continue;
    if (now - s.lastEventAt > 6 * 3600_000) continue; // long-dead leftovers
    if (taskStatus(sid, now, opts).status === "running") out.push(sid);
  }
  return out;
}
