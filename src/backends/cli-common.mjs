// Shared helpers for detached CLI backends (CodeBuddy, Qoder, and future CLIs).
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { sleep } from "../cdp.mjs";

export function writeJsonAtomic(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, filePath);
}

export function readStateFile(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function roundCredit(n) {
  return Math.round((Number(n) || 0) * 10000) / 10000;
}

export function sumUsageList(list) {
  const total = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    totalTokens: 0,
    toolCalls: 0,
    modelRequests: 0,
    credit: 0,
  };
  let reasoningTokens = 0;
  for (const u of list) {
    if (!u) continue;
    total.inputTokens += Number(u.inputTokens ?? 0);
    total.outputTokens += Number(u.outputTokens ?? 0);
    total.cacheReadInputTokens += Number(u.cacheReadInputTokens ?? 0);
    total.cacheWriteInputTokens += Number(u.cacheWriteInputTokens ?? 0);
    total.totalTokens += Number(u.totalTokens ?? 0);
    total.toolCalls += Number(u.toolCalls ?? 0);
    total.modelRequests += Number(u.modelRequests ?? 0);
    total.credit = roundCredit(total.credit + Number(u.credit ?? 0));
    reasoningTokens += Number(u.reasoningTokens ?? 0);
  }
  if (reasoningTokens > 0) total.reasoningTokens = reasoningTokens;
  return total;
}

export function classifyCliError(message = "") {
  if (/empty zero-token response|empty response/i.test(message)) {
    return "empty_response";
  }
  if (/quota|rate.limit|429|credit|insufficient|balance|额度|限流|不足/i.test(message)) {
    return "quota_or_rate_limit";
  }
  if (/auth|login|unauthorized|401|expired|sign in|token/i.test(message)) {
    return "auth_required";
  }
  return "cli_error";
}

export function defaultIsPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

export async function execCliText(bin, args, env = process.env, timeoutMs = 3000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      rejectPromise(new Error(`timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise(stdout.trim() || null);
      else rejectPromise(new Error(stderr.trim() || `exit code ${code}`));
    });
  });
}

export function tryParseJsonPayload(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if ((line.startsWith("[") && line.endsWith("]")) || (line.startsWith("{") && line.endsWith("}"))) {
        try {
          return JSON.parse(line);
        } catch {
          // keep searching
        }
      }
    }
    const bracketStart = trimmed.indexOf("[");
    const bracketEnd = trimmed.lastIndexOf("]");
    if (bracketStart >= 0 && bracketEnd > bracketStart) {
      try {
        return JSON.parse(trimmed.slice(bracketStart, bracketEnd + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function readFileSliceFromOffset(file, fromOffset = 0, maxSliceBytes = 4 * 1024 * 1024) {
  if (!file || !existsSync(file)) return "";
  try {
    const size = statSync(file).size;
    const start = Math.max(0, Math.min(fromOffset, size));
    const len = size - start;
    if (len <= 0) return "";
    const sliceStart = len > maxSliceBytes ? size - maxSliceBytes : start;
    const fd = openSync(file, "r");
    try {
      const b = Buffer.alloc(size - sliceStart);
      readSync(fd, b, 0, b.length, sliceStart);
      return b.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

export function formatCliStatusView(state, live = null) {
  const startedAt = state.turnStartedAt ?? state.startedAt ?? Date.now();
  const isActive = state.status === "starting" || state.status === "running";
  const endedAt = isActive ? Date.now() : (state.endedAt ?? Date.now());
  const out = {
    taskId: state.taskId,
    backend: state.backend,
    status: state.status,
    profile: state.profile,
    cwd: state.cwd,
    ephemeral: Boolean(state.ephemeral),
    model: state.actualModel ? { id: state.actualModel, requested: state.model } : (state.model ?? null),
    elapsedSec: Math.max(0, Math.round((endedAt - startedAt) / 1000)),
  };
  if (state.interrupted) out.interrupted = true;
  if (state.note) out.note = state.note;
  if (isActive && live) {
    out.currentTool = live.currentTool;
    out.toolCalls = live.toolCalls;
    out.idleSec = live.idleSec ?? out.elapsedSec;
    if (live.stalled) out.stalled = true;
  }
  if (!isActive && state.usage) {
    out.usage = state.usage;
  }
  if (state.status === "failed" && state.error) {
    out.error = state.error;
  }
  return out;
}

export function reconcileCliRun({
  backend,
  label,
  cfg,
  taskId,
  inspectJsonlFn,
  now = Date.now(),
  isPidAlive = defaultIsPidAlive,
}) {
  const file = join(cfg.runsDir, `${taskId}.json`);
  let state = readStateFile(file);
  if (!state) {
    return { taskId, backend, status: "unknown", note: `No such ${label} task: ${taskId}` };
  }

  let live = null;
  if (state.status === "starting" || state.status === "running") {
    const runnerAlive = state.runnerPid ? isPidAlive(state.runnerPid) : false;
    const childAlive = state.childPid ? isPidAlive(state.childPid) : false;

    if (!runnerAlive && !childAlive) {
      // Re-read after PID check to avoid losing a terminal write that landed right before kill(0).
      const fresh = readStateFile(file);
      if (fresh && fresh.status !== "starting" && fresh.status !== "running") {
        state = fresh;
      } else {
        const refTime = state.turnStartedAt ?? state.startedAt ?? now;
        const timedOutStarting = state.status === "starting" && now - refTime > cfg.startingTimeoutSec * 1000;
        const next = {
          ...(fresh ?? state),
          status: "failed",
          endedAt: now,
          interrupted: true,
          note: timedOutStarting
            ? `${label} worker timed out before starting.`
            : `Interrupted: ${label} worker process exited without writing a final result.`,
          error: {
            type: "orphan_process",
            message: `${label} worker process died unexpectedly; state reconciled to failed.`,
          },
        };
        writeJsonAtomic(file, next);
        state = next;
      }
    } else {
      if (state.sessionFile && typeof inspectJsonlFn === "function") {
        live = inspectJsonlFn(state.sessionFile, {
          fromOffset: state.jsonlStartOffset ?? 0,
          now,
          stalledAfterSec: cfg.stalledAfterSec,
        });
      }
      if (
        state.status === "starting" &&
        now - (state.turnStartedAt ?? state.startedAt ?? now) > cfg.startingTimeoutSec * 1000
      ) {
        live = live ?? { currentTool: null, toolCalls: 0, lastEventAt: null, idleSec: null, stalled: true };
        live.stalled = true;
      }
    }
  }

  return formatCliStatusView({ ...state, backend: state.backend ?? backend }, live);
}

export function readCliResult({ taskId, cfg, reconcileFn, isPidAlive = defaultIsPidAlive }) {
  const st = reconcileFn(taskId, { isPidAlive });
  if (st.status === "running" || st.status === "starting" || st.status === "unknown") {
    return st;
  }
  const state = readStateFile(join(cfg.runsDir, `${taskId}.json`));
  const out = { ...st };
  if (state) {
    out.result = state.result ?? null;
    if (Array.isArray(state.earlierResults) && state.earlierResults.length > 0) {
      out.earlierMessages = state.earlierResults;
    }
    if (state.subtype) out.subtype = state.subtype;
    if (state.sessionId) out.sessionId = state.sessionId;
    if (state.numTurns) out.numTurns = state.numTurns;
  }
  return out;
}

export function listCliRuns({ backend, fileRegex, cfg, limit = 15, reconcileFn, isPidAlive = defaultIsPidAlive }) {
  if (!existsSync(cfg.runsDir)) return [];
  const files = readdirSync(cfg.runsDir)
    .filter((f) => fileRegex.test(f))
    .map((f) => {
      const taskId = f.slice(0, -5);
      const raw = readStateFile(join(cfg.runsDir, f));
      return raw ? { taskId, raw } : null;
    })
    .filter(Boolean)
    .sort((a, b) => (b.raw.startedAt ?? 0) - (a.raw.startedAt ?? 0))
    .slice(0, limit);

  return files.map(({ taskId, raw }) => {
    const st = reconcileFn(taskId, { isPidAlive });
    return {
      taskId,
      backend,
      status: st.status,
      profile: raw.profile,
      model: raw.model ?? null,
      cwd: raw.cwd,
      ephemeral: Boolean(raw.ephemeral),
      createdAt: raw.createdAt ?? new Date(raw.startedAt ?? 0).toISOString(),
    };
  });
}

export function runningCliCount({ fileRegex, cfg, reconcileFn, isPidAlive = defaultIsPidAlive }) {
  if (!existsSync(cfg.runsDir)) return 0;
  let count = 0;
  for (const f of readdirSync(cfg.runsDir)) {
    if (!fileRegex.test(f)) continue;
    const raw = readStateFile(join(cfg.runsDir, f));
    if (raw && (raw.status === "starting" || raw.status === "running")) {
      const st = reconcileFn(raw.taskId, { isPidAlive });
      if (st.status === "starting" || st.status === "running") count++;
    }
  }
  return count;
}

export async function cancelCliRun({
  backend,
  runsDir,
  taskId,
  reconcileFn,
  isPidAlive = defaultIsPidAlive,
  killFn = (pid, sig) => process.kill(pid, sig),
}) {
  const st = reconcileFn(taskId, { isPidAlive });
  if (st.status !== "running" && st.status !== "starting") {
    return { ...st, cancelled: false, note: `Task is ${st.status}; nothing to cancel.` };
  }

  const file = join(runsDir, `${taskId}.json`);
  const prev = readStateFile(file);
  if (!prev) return { taskId, backend, status: "unknown", cancelled: false };

  writeJsonAtomic(file, {
    ...prev,
    cancelRequested: true,
    status: "cancelled",
    endedAt: Date.now(),
    note: "Cancelled by caller.",
  });

  const targetGroup = prev.pgid && prev.pgid > 0 ? -prev.pgid : null;
  const targets = [targetGroup, prev.childPid, prev.runnerPid].filter((p) => Number.isInteger(p) && p !== 0);

  for (const t of targets) {
    try {
      killFn(t, "SIGTERM");
    } catch {
      // ESRCH if already exited
    }
  }

  const waitEnd = Date.now() + 2000;
  while (Date.now() < waitEnd) {
    const alive = (prev.childPid && isPidAlive(prev.childPid)) || (prev.runnerPid && isPidAlive(prev.runnerPid));
    if (!alive) break;
    await sleep(100);
  }

  if ((prev.childPid && isPidAlive(prev.childPid)) || (prev.runnerPid && isPidAlive(prev.runnerPid))) {
    for (const t of targets) {
      try {
        killFn(t, "SIGKILL");
      } catch {
        // Ignore already-dead process
      }
    }
  }

  return { ...reconcileFn(taskId, { isPidAlive }), cancelled: true };
}

export async function waitCliRun({
  taskId,
  timeoutSec = 45,
  onProgress = null,
  pollIntervalMs = 250,
  reconcileFn,
  resultFn,
  isPidAlive = defaultIsPidAlive,
}) {
  const end = Date.now() + timeoutSec * 1000;
  let tick = 0;
  for (;;) {
    const st = reconcileFn(taskId, { isPidAlive });
    if (st.status !== "running" && st.status !== "starting") {
      return resultFn(taskId, { isPidAlive });
    }
    if (Date.now() >= end) return st;
    if (onProgress && ++tick % Math.max(1, Math.round(5000 / pollIntervalMs)) === 0) {
      await onProgress({
        tick,
        elapsedSec: st.elapsedSec,
        currentTool: st.currentTool ?? null,
      });
    }
    await sleep(pollIntervalMs);
  }
}

export function spawnDetachedCliWorker({
  runnerScript,
  spec,
  stateFile,
  initialState,
  promptText,
  promptFile,
  specFile,
  cwd,
  env = process.env,
  spawnImpl = spawn,
  removeStateOnError = true,
}) {
  writeJsonAtomic(stateFile, initialState);
  writeFileSync(promptFile, promptText, { encoding: "utf8", mode: 0o600 });
  writeFileSync(specFile, JSON.stringify(spec), { encoding: "utf8", mode: 0o600 });

  let runner;
  try {
    runner = spawnImpl(process.execPath, [runnerScript, "--spec", specFile], {
      cwd,
      detached: true,
      stdio: "ignore",
      env,
    });
  } catch (err) {
    rmSync(promptFile, { force: true });
    rmSync(specFile, { force: true });
    if (removeStateOnError) rmSync(stateFile, { force: true });
    throw new Error(`Failed to spawn CLI runner: ${err.message}`);
  }

  if (!runner?.pid) {
    rmSync(promptFile, { force: true });
    rmSync(specFile, { force: true });
    if (removeStateOnError) rmSync(stateFile, { force: true });
    throw new Error("Failed to obtain CLI runner PID");
  }

  const latest = readStateFile(stateFile) ?? initialState;
  writeJsonAtomic(stateFile, { ...latest, runnerPid: runner.pid });
  runner.unref?.();
  return runner;
}

export function readContractFromStateOrJsonl(taskId, runsDir, parseContractText) {
  const state = readStateFile(join(runsDir, `${taskId}.json`));
  if (!state) throw new Error(`Unknown task: ${taskId}`);
  if (state.contract) return state.contract;

  if (state.sessionFile && existsSync(state.sessionFile) && typeof parseContractText === "function") {
    const lines = readFileSync(state.sessionFile, "utf8").split("\n");
    for (const line of lines) {
      if (!line.includes("ZCODE_STRUCTURED_V1 ")) continue;
      try {
        const row = JSON.parse(line);
        const content = row?.message?.content ?? row?.content;
        const text =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content.find((c) => typeof c?.text === "string")?.text
              : null;
        if (text) return parseContractText(text);
      } catch {
        // ignore malformed lines
      }
    }
  }
  throw new Error(`Session ${taskId} does not contain a structured contract`);
}

export function inspectCliSessionJsonl(sessionFile, { fromOffset = 0, now = Date.now(), stalledAfterSec = 600 } = {}) {
  const buf = readFileSliceFromOffset(sessionFile, fromOffset);
  if (!buf) {
    return { currentTool: null, toolCalls: 0, lastEventAt: null, idleSec: null, stalled: false };
  }

  let toolCalls = 0;
  let lastEventAt = null;
  const openTools = new Map();
  let anonSeq = 0;

  for (const line of buf.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const ts = typeof ev.timestamp === "number" ? ev.timestamp : Date.parse(ev.timestamp);
    if (Number.isFinite(ts) && ts > 0) {
      lastEventAt = lastEventAt ? Math.max(lastEventAt, ts) : ts;
    }

    if (ev.type === "function_call") {
      toolCalls++;
      const id = ev.callId ?? ev.id ?? `anon_${++anonSeq}`;
      openTools.set(id, ev.name ?? "tool");
    } else if (ev.type === "function_call_result") {
      const id = ev.callId ?? ev.id;
      if (id && openTools.has(id)) {
        openTools.delete(id);
      } else if (ev.name) {
        for (const [k, v] of openTools) {
          if (v === ev.name) {
            openTools.delete(k);
            break;
          }
        }
      }
    } else if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
      for (const block of ev.message.content) {
        if (block?.type === "tool_use") {
          toolCalls++;
          const id = block.id ?? `anon_${++anonSeq}`;
          openTools.set(id, block.name ?? "tool");
        }
      }
    } else if (ev.type === "user" && Array.isArray(ev.message?.content)) {
      for (const block of ev.message.content) {
        if (block?.type === "tool_result" && block.tool_use_id) {
          openTools.delete(block.tool_use_id);
        }
      }
    }
  }

  let currentTool = null;
  for (const name of openTools.values()) currentTool = name;
  const idleSec = lastEventAt ? Math.max(0, Math.round((now - lastEventAt) / 1000)) : null;
  const stalled = Boolean(idleSec !== null && idleSec > stalledAfterSec && !currentTool);
  return { currentTool, toolCalls, lastEventAt, idleSec, stalled };
}
