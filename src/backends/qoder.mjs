// Qoder CLI (`qodercli`) backend for subagent-swarm-mcp.
// Runs `qodercli -p -o json` in a detached worker process group (`qd_<uuid>`),
// supports lite/readonly/workspace profiles, RFC 4122 UUID `--session-id` / `-r` resumption,
// live JSONL `tool_use` tracking, orphan fail-close, and credit accounting.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.mjs";
import {
  cancelCliRun,
  defaultIsPidAlive,
  execCliText,
  inspectCliSessionJsonl,
  listCliRuns,
  readCliResult,
  readContractFromStateOrJsonl,
  readStateFile,
  reconcileCliRun,
  roundCredit,
  runningCliCount,
  spawnDetachedCliWorker,
  sumUsageList,
  tryParseJsonPayload,
  waitCliRun,
} from "./cli-common.mjs";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const RUNNER_SCRIPT = resolve(THIS_DIR, "../../bin/codebuddy-runner.mjs");
const TASK_FILE_RE = /^qd_[\w-]+\.json$/;

export const id = "qoder";
export const QODER_PROFILES = ["lite", "readonly", "workspace"];
export const profiles = QODER_PROFILES;
export const READONLY_TOOLS = "Read,Glob,Grep,WebSearch,WebFetch";
export const DEFAULT_QODER_MODELS = [
  "Auto",
  "Ultimate",
  "Fast",
  "Efficient",
  "Sonus",
  "Cantus",
  "Qwen4-Max",
  "Qwen4-Max-Preview",
  "Qwen3.8-Max",
  "Qwen3.8-Flash",
  "Kimi-K3.1-Pro",
  "Kimi-K2.8-Preview",
  "GLM-5.3",
  "GLM-5.3-Flash",
  "DeepSeek-V4-Pro",
  "DeepSeek-Flash",
  "MiniMax-M3.1-Flash",
];

const LITE_GUARD =
  "[Mode: pure text, no tools available. Do not emit tool calls; answer directly.]\n\n";

export function supports(taskId) {
  return typeof taskId === "string" && /^qd_[\w-]+$/.test(taskId);
}

export function resolveQoderBin(
  env = process.env,
  { existsFn = existsSync, execPath = process.execPath, homeDir = homedir() } = {},
) {
  const explicit = env.QODER_BIN?.trim();
  if (explicit) return explicit;

  const candidates = [
    join(homeDir, ".local", "bin", "qodercli"),
    join(dirname(execPath), "qodercli"),
    join(homeDir, ".qoder", "bin", "qodercli"),
    ...(env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((dir) => join(dir, "qodercli")),
  ];
  for (const candidate of candidates) {
    try {
      if (existsFn(candidate)) return candidate;
    } catch {
      // Ignore unreadable PATH segments
    }
  }
  return null;
}

export function qoderBackendConfig(env = process.env) {
  const stateDir = env.ZCODE_MCP_STATE_DIR?.trim() || config.stateDir;
  const modelsRaw = env.QODER_MODELS?.trim();
  const allowedModels = modelsRaw
    ? modelsRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : DEFAULT_QODER_MODELS;
  return {
    bin: resolveQoderBin(env),
    stateDir,
    runsDir: join(stateDir, "qd-runs"),
    projectsDir: env.QODER_PROJECTS_DIR?.trim() || join(homedir(), ".qoder", "projects"),
    defaultModel: env.QODER_DEFAULT_MODEL?.trim() || "DeepSeek-Flash",
    allowedModels,
    defaultCwd: env.QODER_DEFAULT_CWD?.trim() || config.projectDir,
    maxRunning: Number(env.QODER_MAX_RUNNING ?? 4),
    stalledAfterSec: Number(env.ZCODE_MCP_STALLED_SEC ?? config.stalledAfterSec),
    startingTimeoutSec: Number(env.ZCODE_MCP_STARTING_TIMEOUT_SEC ?? config.startingTimeoutSec),
  };
}

export function maxRunning(env = process.env) {
  return qoderBackendConfig(env).maxRunning;
}

export function defaultModel(env = process.env) {
  return qoderBackendConfig(env).defaultModel;
}

export function models(env = process.env) {
  return qoderBackendConfig(env).allowedModels;
}

// Empirically observed: /tmp/qd.dot-zErLCI -> -tmp-qd-dot-zErLCI
export function cwdSlug(cwd) {
  return resolve(cwd).replace(/[\\/.:]/g, "-");
}

export function qoderSessionFile(sessionId, cwd, env = process.env) {
  return join(qoderBackendConfig(env).projectsDir, cwdSlug(cwd), `${sessionId}.jsonl`);
}

export function preparePrompt(prompt, { profile = "lite" } = {}) {
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("prompt is empty");
  }
  if (prompt.length > config.maxPromptChars) {
    throw new Error(`prompt exceeds ${config.maxPromptChars} characters`);
  }
  if (profile === "lite" && !prompt.startsWith("ZCODE_STRUCTURED_V1 ")) {
    return `${LITE_GUARD}${prompt}`;
  }
  return prompt;
}

export function buildCliArgs({
  sessionId,
  profile = "lite",
  model = null,
  ephemeral = false,
  resume = false,
} = {}) {
  if (!QODER_PROFILES.includes(profile)) {
    throw new Error(`Unsupported profile "${profile}"; expected one of: ${QODER_PROFILES.join(", ")}`);
  }
  const args = ["-p", "-o", "json"];
  if (resume) {
    if (!sessionId) throw new Error("sessionId is required to resume a Qoder session");
    args.push("-r", sessionId);
  } else if (ephemeral) {
    args.push("--no-session-persistence");
  } else {
    if (!sessionId) throw new Error("sessionId (UUID) is required for persistent Qoder sessions");
    args.push("--session-id", sessionId);
  }

  if (profile === "lite") {
    args.push("--tools", "", "--mcp-config", JSON.stringify({ mcpServers: {} }), "--strict-mcp-config");
  } else if (profile === "readonly") {
    args.push(
      "--tools",
      READONLY_TOOLS,
      "--allowed-tools",
      READONLY_TOOLS,
      "--dangerously-skip-permissions",
      "--mcp-config",
      JSON.stringify({ mcpServers: {} }),
      "--strict-mcp-config",
    );
  } else if (profile === "workspace") {
    args.push("--dangerously-skip-permissions");
  }

  if (model) args.push("-m", model);
  return args;
}

export function parseQoderJsonOutput(stdout) {
  const parsed = tryParseJsonPayload(stdout);
  if (!parsed) {
    return {
      ok: false,
      isError: true,
      subtype: null,
      result: null,
      errors: ["Qoder CLI did not return valid JSON output"],
      sessionId: null,
      model: null,
      numTurns: 0,
      durationMs: null,
      usage: sumUsageList([]),
    };
  }

  const events = Array.isArray(parsed) ? parsed : [parsed];
  let resultEvent = null;
  let lastAssistantText = null;
  let toolCalls = 0;

  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    if (ev.type === "result") {
      resultEvent = ev;
    } else if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
      const texts = [];
      for (const b of ev.message.content) {
        if (b?.type === "text" && typeof b.text === "string") texts.push(b.text);
        if (b?.type === "tool_use") toolCalls++;
      }
      if (texts.length) lastAssistantText = texts.join("\n");
    }
  }
  if (!resultEvent && !Array.isArray(parsed) && typeof parsed === "object") {
    resultEvent = parsed;
  }

  const muValues = Object.values(resultEvent?.modelUsage ?? {}).filter((v) => v && typeof v === "object");
  let muInput = 0;
  let muOutput = 0;
  let muCacheRead = 0;
  let muCacheWrite = 0;
  let muCredits = 0;
  for (const mu of muValues) {
    muInput += Number(mu.inputTokens ?? 0);
    muOutput += Number(mu.outputTokens ?? 0);
    muCacheRead += Number(mu.cacheReadInputTokens ?? 0);
    muCacheWrite += Number(mu.cacheCreationInputTokens ?? 0);
    muCredits += Number(mu.credits ?? 0);
  }

  const u = resultEvent?.usage ?? {};
  const inputTokens = Number(u.input_tokens || muInput || 0);
  const outputTokens = Number(u.output_tokens || muOutput || 0);
  const cacheReadInputTokens = Number(u.cache_read_input_tokens || muCacheRead || 0);
  const cacheWriteInputTokens = Number(u.cache_creation_input_tokens || muCacheWrite || 0);
  const totalTokens = Number(
    u.total_tokens ?? inputTokens + outputTokens + cacheReadInputTokens + cacheWriteInputTokens,
  );
  const credit = roundCredit(resultEvent?.total_credits ?? muCredits);
  const numTurns = Number(resultEvent?.num_turns ?? (resultEvent ? 1 : 0));

  const errors = Array.isArray(resultEvent?.errors) ? resultEvent.errors.map(String) : [];
  const subtype = resultEvent?.subtype ?? null;
  const hasExplicitFailure = Boolean(resultEvent?.is_error) || (subtype !== null && subtype !== "success");
  const resultText =
    typeof resultEvent?.result === "string"
      ? resultEvent.result
      : typeof lastAssistantText === "string"
        ? lastAssistantText
        : null;

  if (hasExplicitFailure && errors.length === 0) {
    errors.push(
      typeof resultEvent?.result === "string" && resultEvent.result.trim()
        ? resultEvent.result.trim()
        : `Qoder failed (${subtype ?? "error"})`,
    );
  }

  const modelKeys = Object.keys(resultEvent?.modelUsage ?? {}).filter((k) => k !== "auto" && (resultEvent.modelUsage[k]?.credits > 0 || resultEvent.modelUsage[k]?.inputTokens > 0));
  return {
    ok: !hasExplicitFailure && (Boolean(resultEvent) || resultText !== null),
    isError: hasExplicitFailure,
    subtype,
    result: resultText,
    errors,
    sessionId: typeof resultEvent?.session_id === "string" ? resultEvent.session_id : null,
    model: modelKeys[0] ?? null,
    numTurns,
    durationMs: Number.isFinite(resultEvent?.duration_ms) ? Number(resultEvent.duration_ms) : null,
    usage: {
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheWriteInputTokens,
      totalTokens,
      toolCalls,
      modelRequests: numTurns || (resultEvent ? 1 : 0),
      credit,
    },
  };
}

export { inspectCliSessionJsonl as inspectSessionJsonl };

export function reconcileRun(taskId, { now = Date.now(), env = process.env, isPidAlive = defaultIsPidAlive } = {}) {
  return reconcileCliRun({
    backend: "qoder",
    label: "Qoder",
    cfg: qoderBackendConfig(env),
    taskId,
    inspectJsonlFn: inspectCliSessionJsonl,
    now,
    isPidAlive,
  });
}

export function status(taskId, { env = process.env, isPidAlive = defaultIsPidAlive } = {}) {
  return reconcileRun(taskId, { env, isPidAlive });
}

export function result(taskId, { env = process.env, isPidAlive = defaultIsPidAlive } = {}) {
  return readCliResult({
    taskId,
    cfg: qoderBackendConfig(env),
    reconcileFn: (idArg, opts) => reconcileRun(idArg, { env, ...opts }),
    isPidAlive,
  });
}

export function list({ limit = 15, env = process.env, isPidAlive = defaultIsPidAlive } = {}) {
  return listCliRuns({
    backend: "qoder",
    fileRegex: TASK_FILE_RE,
    cfg: qoderBackendConfig(env),
    limit,
    reconcileFn: (idArg, opts) => reconcileRun(idArg, { env, ...opts }),
    isPidAlive,
  });
}

export function runningCount({ env = process.env, isPidAlive = defaultIsPidAlive } = {}) {
  return runningCliCount({
    fileRegex: TASK_FILE_RE,
    cfg: qoderBackendConfig(env),
    reconcileFn: (idArg, opts) => reconcileRun(idArg, { env, ...opts }),
    isPidAlive,
  });
}

export async function run({
  prompt,
  model,
  profile = "lite",
  cwd,
  ephemeral = false,
  contract = null,
  env = process.env,
  spawnImpl = spawn,
  isPidAlive = defaultIsPidAlive,
} = {}) {
  const cfg = qoderBackendConfig(env);
  if (!cfg.bin || !existsSync(cfg.bin)) {
    throw new Error("qodercli binary not found. Set QODER_BIN or install qodercli on PATH.");
  }

  const finalPrompt = preparePrompt(prompt, { profile });
  const chosenModel = model ?? cfg.defaultModel;
  const resolvedCwd = resolve(cwd ?? cfg.defaultCwd);
  if (!existsSync(resolvedCwd) || !statSync(resolvedCwd).isDirectory()) {
    throw new Error(`Invalid cwd: "${resolvedCwd}" does not exist or is not a directory.`);
  }

  const active = runningCount({ env, isPidAlive });
  if (active >= cfg.maxRunning) {
    throw new Error(`Qoder capacity limit reached (${active}/${cfg.maxRunning} tasks running). Wait or cancel one first.`);
  }

  const sessionId = randomUUID();
  const taskId = `qd_${sessionId}`;
  const cliArgs = buildCliArgs({
    sessionId,
    profile,
    model: chosenModel,
    ephemeral: Boolean(ephemeral),
    resume: false,
  });

  const stateFile = join(cfg.runsDir, `${taskId}.json`);
  const promptFile = join(cfg.runsDir, `${taskId}.prompt.txt`);
  const specFile = join(cfg.runsDir, `${taskId}.spec.json`);
  const nowMs = Date.now();
  const sessionFile = ephemeral ? null : qoderSessionFile(sessionId, resolvedCwd, env);

  const initialState = {
    taskId,
    backend: "qoder",
    mode: profile,
    status: "starting",
    profile,
    cwd: resolvedCwd,
    model: chosenModel,
    actualModel: null,
    ephemeral: Boolean(ephemeral),
    sessionFile,
    sessionId: ephemeral ? null : sessionId,
    jsonlStartOffset: 0,
    runnerPid: null,
    childPid: null,
    pgid: null,
    createdAt: new Date(nowMs).toISOString(),
    startedAt: nowMs,
    turnStartedAt: nowMs,
    endedAt: null,
    exitCode: null,
    signal: null,
    result: null,
    earlierResults: [],
    subtype: null,
    error: null,
    numTurns: 0,
    turns: [],
    usage: sumUsageList([]),
    contract: contract ?? null,
  };

  spawnDetachedCliWorker({
    runnerScript: RUNNER_SCRIPT,
    spec: { backend: "qoder", taskId, stateFile, promptFile, bin: cfg.bin, args: cliArgs, cwd: resolvedCwd },
    stateFile,
    initialState,
    promptText: finalPrompt,
    promptFile,
    specFile,
    cwd: resolvedCwd,
    env,
    spawnImpl,
  });

  return {
    taskId,
    backend: "qoder",
    model: chosenModel,
    profile,
    cwd: resolvedCwd,
    ephemeral: Boolean(ephemeral),
    mode: profile,
  };
}

export async function followUp({
  taskId,
  prompt,
  model = null,
  env = process.env,
  spawnImpl = spawn,
  isPidAlive = defaultIsPidAlive,
} = {}) {
  if (!prompt?.trim()) throw new Error("prompt is empty");
  const cfg = qoderBackendConfig(env);
  const st = reconcileRun(taskId, { env, isPidAlive });
  if (st.status === "unknown") throw new Error(`Unknown task ${taskId}`);
  if (st.status === "running" || st.status === "starting") {
    throw new Error(`Task ${taskId} is still ${st.status}; wait for it to finish first.`);
  }

  const stateFile = join(cfg.runsDir, `${taskId}.json`);
  const prev = readStateFile(stateFile);
  if (!prev) throw new Error(`Unknown task ${taskId}`);
  if (prev.ephemeral) {
    throw new Error(`Task ${taskId} was created with ephemeral=true and has no persisted session to follow up.`);
  }
  if (!cfg.bin || !existsSync(cfg.bin)) {
    throw new Error("qodercli binary not found. Set QODER_BIN or install qodercli on PATH.");
  }

  const active = runningCount({ env, isPidAlive });
  if (active >= cfg.maxRunning) {
    throw new Error(`Qoder capacity limit reached (${active}/${cfg.maxRunning} tasks running).`);
  }

  const sessionId = prev.sessionId ?? taskId.replace(/^qd_/, "");
  const finalPrompt = preparePrompt(prompt, { profile: prev.profile ?? "lite" });
  const chosenModel = model ?? prev.model ?? cfg.defaultModel;
  const cliArgs = buildCliArgs({
    sessionId,
    profile: prev.profile ?? "lite",
    model: chosenModel,
    ephemeral: false,
    resume: true,
  });

  const jsonlStartOffset = prev.sessionFile && existsSync(prev.sessionFile) ? statSync(prev.sessionFile).size : 0;
  const promptFile = join(cfg.runsDir, `${taskId}.prompt.txt`);
  const specFile = join(cfg.runsDir, `${taskId}.spec.json`);
  const earlierResults = Array.isArray(prev.earlierResults) ? [...prev.earlierResults] : [];
  if (typeof prev.result === "string" && prev.result.length > 0) {
    earlierResults.push(prev.result);
  }

  const updated = {
    ...prev,
    status: "starting",
    model: chosenModel,
    jsonlStartOffset,
    turnStartedAt: Date.now(),
    endedAt: null,
    runnerPid: null,
    childPid: null,
    pgid: null,
    cancelRequested: false,
    error: null,
    note: null,
    earlierResults,
    result: null,
  };

  spawnDetachedCliWorker({
    runnerScript: RUNNER_SCRIPT,
    spec: { backend: "qoder", taskId, stateFile, promptFile, bin: cfg.bin, args: cliArgs, cwd: prev.cwd },
    stateFile,
    initialState: updated,
    promptText: finalPrompt,
    promptFile,
    specFile,
    cwd: prev.cwd,
    env,
    spawnImpl,
    removeStateOnError: false,
  });

  return { taskId, backend: "qoder", accepted: true, model: chosenModel };
}

export async function cancel(
  taskId,
  { env = process.env, isPidAlive = defaultIsPidAlive, killFn = (pid, sig) => process.kill(pid, sig) } = {},
) {
  return cancelCliRun({
    backend: "qoder",
    runsDir: qoderBackendConfig(env).runsDir,
    taskId,
    reconcileFn: (idArg, opts) => reconcileRun(idArg, { env, ...opts }),
    isPidAlive,
    killFn,
  });
}

export async function wait(
  taskId,
  { timeoutSec = 45, onProgress = null, env = process.env, isPidAlive = defaultIsPidAlive, pollIntervalMs = 250 } = {},
) {
  return waitCliRun({
    taskId,
    timeoutSec,
    onProgress,
    pollIntervalMs,
    reconcileFn: (idArg, opts) => reconcileRun(idArg, { env, ...opts }),
    resultFn: (idArg, opts) => result(idArg, { env, ...opts }),
    isPidAlive,
  });
}

export function readContract(taskId, { env = process.env, parseContractText } = {}) {
  return readContractFromStateOrJsonl(taskId, qoderBackendConfig(env).runsDir, parseContractText);
}

async function readSanitizedCliStatus(bin, env) {
  try {
    const raw = await execCliText(bin, ["status", "-o", "json"], env, 6000);
    if (!raw) return null;
    const s = JSON.parse(raw);
    return {
      loggedIn: Boolean(s.logged_in),
      userType: s.user_type ?? null,
      accountType: s.account_type ?? null,
      loginMethod: s.login_method ?? null,
    };
  } catch {
    return null;
  }
}

export async function health({ env = process.env, isPidAlive = defaultIsPidAlive } = {}) {
  const cfg = qoderBackendConfig(env);
  const out = {
    ok: false,
    backend: "qoder",
    available: false,
    bin: cfg.bin,
    version: null,
    defaultModel: cfg.defaultModel,
    models: cfg.allowedModels,
    profiles: QODER_PROFILES,
    defaultCwd: cfg.defaultCwd,
    maxRunning: cfg.maxRunning,
    runningTasks: runningCount({ env, isPidAlive }),
    loggedIn: null,
    userType: null,
    accountType: null,
  };
  if (!cfg.bin || !existsSync(cfg.bin)) {
    out.error = "qodercli binary not found on PATH or QODER_BIN.";
    return out;
  }
  out.available = true;
  try {
    out.version = await execCliText(cfg.bin, ["--version"], env, 3000);
  } catch (e) {
    out.error = `qodercli --version failed: ${e.message}`;
    return out;
  }
  const st = await readSanitizedCliStatus(cfg.bin, env);
  if (st) {
    out.loggedIn = st.loggedIn;
    out.userType = st.userType;
    out.accountType = st.accountType;
    if (!st.loggedIn) {
      out.ok = false;
      out.error = "qodercli is not logged in (run `qodercli login`).";
      return out;
    }
  }
  out.ok = true;
  return out;
}

export async function quota({ sinceDays = 7, env = process.env, now = Date.now() } = {}) {
  const cfg = qoderBackendConfig(env);
  const account = cfg.bin && existsSync(cfg.bin) ? await readSanitizedCliStatus(cfg.bin, env) : null;
  const sinceMs = now - sinceDays * 86_400_000;
  const local = {
    sinceDays,
    credit: 0,
    requests: 0,
    runs: 0,
    tokens: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      totalTokens: 0,
      cacheHitRatePct: 0,
    },
    byDay: {},
    byModel: {},
    byProfile: {},
  };
  if (existsSync(cfg.runsDir)) {
    for (const f of readdirSync(cfg.runsDir)) {
      if (!TASK_FILE_RE.test(f)) continue;
      const runState = readStateFile(join(cfg.runsDir, f));
      const ts = runState?.startedAt ?? 0;
      if (!runState || ts < sinceMs) continue;
      const credit = Number(runState.usage?.credit ?? 0);
      const reqs = Number(runState.usage?.modelRequests ?? 0);
      const inTok = Number(runState.usage?.inputTokens ?? 0);
      const outTok = Number(runState.usage?.outputTokens ?? 0);
      const cacheRead = Number(runState.usage?.cacheReadInputTokens ?? 0);
      const totTok = Number(runState.usage?.totalTokens ?? inTok + outTok);
      local.runs++;
      local.requests += reqs;
      local.credit = roundCredit(local.credit + credit);
      local.tokens.inputTokens += inTok;
      local.tokens.outputTokens += outTok;
      local.tokens.cacheReadInputTokens += cacheRead;
      local.tokens.totalTokens += totTok;
      const d = new Date(ts);
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      local.byDay[day] = roundCredit((local.byDay[day] ?? 0) + credit);

      const m = runState.actualModel || runState.model || "unknown";
      const bm = (local.byModel[m] ??= { credit: 0, runs: 0, requests: 0, totalTokens: 0, avgCreditPerRun: 0 });
      bm.credit = roundCredit(bm.credit + credit);
      bm.runs++;
      bm.requests += reqs;
      bm.totalTokens += totTok;

      const p = runState.profile || "lite";
      const bp = (local.byProfile[p] ??= { credit: 0, runs: 0, requests: 0, totalTokens: 0 });
      bp.credit = roundCredit(bp.credit + credit);
      bp.runs++;
      bp.requests += reqs;
      bp.totalTokens += totTok;
    }
  }
  const denom = Math.max(local.tokens.inputTokens, local.tokens.cacheReadInputTokens);
  local.tokens.cacheHitRatePct =
    denom > 0 ? Math.round(Math.min(100, (100 * local.tokens.cacheReadInputTokens) / denom) * 100) / 100 : 0;
  for (const bm of Object.values(local.byModel)) {
    bm.avgCreditPerRun = bm.runs > 0 ? roundCredit(bm.credit / bm.runs) : 0;
  }
  return {
    account,
    local,
    note: "Qoder CLI exposes remaining Plan/Add-on credit counters interactively via `/usage`; `local` aggregates `total_credits`, tokens, models, and profiles reported by qodercli runs recorded in stateDir.",
  };
}
