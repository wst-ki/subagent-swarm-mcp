// CodeBuddy CLI backend for subagent-swarm-mcp.
// Runs `codebuddy -p --output-format json` in a detached worker process group,
// tracks live tool calls and state on disk, supports session resumption, and
// safely disables tool loops / memory hallucinations in zero-tool `lite` mode.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cbConfig, codebuddyUsage, readToken } from "../codebuddy-usage.mjs";
import { config } from "../config.mjs";
import {
  cancelCliRun,
  classifyCliError,
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
  writeJsonAtomic,
} from "./cli-common.mjs";

export { classifyCliError, defaultIsPidAlive, inspectCliSessionJsonl as inspectSessionJsonl, sumUsageList, writeJsonAtomic };

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const RUNNER_SCRIPT = resolve(THIS_DIR, "../../bin/codebuddy-runner.mjs");
const TASK_FILE_RE = /^cb_[\w-]+\.json$/;

export const id = "codebuddy";
export const CODEBUDDY_PROFILES = ["lite", "readonly", "workspace"];
export const profiles = CODEBUDDY_PROFILES;
export const READONLY_TOOLS = "Read,ViewImage,Glob,Grep,WebSearch,WebFetch";
export const DEFAULT_CODEBUDDY_MODELS = [
  "hy4flash-free",
  "hy4flash",
  "hy4std",
  "deepseek-v4.1-flash",
  "glm-5.3",
  "glm-5.3-flash",
  "glm-5.2",
  "space-bunny",
  "minimax-m3.1-flash",
  "minimax-m2.7",
  "kimi-k3.1-pro",
  "kimi-k3-1",
  "kimi-k2.8-preview",
  "deepseek-v4-pro",
  "step-5-preview",
  "mimo-v2.6-pro",
];

const LITE_MEMORY_GUARD =
  "[Mode: pure text, no tools available. Do not emit tool calls or write memory files; answer directly.]\n\n";

export function supports(taskId) {
  return typeof taskId === "string" && /^cb_[\w-]+$/.test(taskId);
}

export function resolveCodebuddyBin(
  env = process.env,
  { existsFn = existsSync, execPath = process.execPath, homeDir = homedir() } = {},
) {
  const explicit = env.CODEBUDDY_BIN?.trim();
  if (explicit) return explicit;

  const candidates = [
    join(dirname(execPath), "codebuddy"),
    join(homeDir, ".local", "bin", "codebuddy"),
    ...(env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((dir) => join(dir, "codebuddy")),
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

export function cbBackendConfig(env = process.env) {
  const stateDir = env.ZCODE_MCP_STATE_DIR?.trim() || config.stateDir;
  const modelsRaw = env.CODEBUDDY_MODELS?.trim();
  const allowedModels = modelsRaw
    ? modelsRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : DEFAULT_CODEBUDDY_MODELS;
  return {
    bin: resolveCodebuddyBin(env),
    stateDir,
    runsDir: join(stateDir, "cb-runs"),
    projectsDir: env.CODEBUDDY_PROJECTS_DIR?.trim() || cbConfig.projectsDir,
    defaultModel: env.CODEBUDDY_DEFAULT_MODEL?.trim() || "hy4flash-free",
    allowedModels,
    defaultCwd: env.CODEBUDDY_DEFAULT_CWD?.trim() || config.projectDir,
    maxRunning: Number(env.CODEBUDDY_MAX_RUNNING ?? 4),
    stalledAfterSec: Number(env.ZCODE_MCP_STALLED_SEC ?? config.stalledAfterSec),
    startingTimeoutSec: Number(env.ZCODE_MCP_STARTING_TIMEOUT_SEC ?? config.startingTimeoutSec),
  };
}

export function maxRunning(env = process.env) {
  return cbBackendConfig(env).maxRunning;
}

export function defaultModel(env = process.env) {
  return cbBackendConfig(env).defaultModel;
}

export function models(env = process.env) {
  return cbBackendConfig(env).allowedModels;
}

export function cwdSlug(cwd) {
  return resolve(cwd).replace(/^[\\/]+/, "").replace(/[\\/:]/g, "-");
}

export function codebuddySessionFile(taskId, cwd, env = process.env) {
  return join(cbBackendConfig(env).projectsDir, cwdSlug(cwd), `${taskId}.jsonl`);
}

export function preparePrompt(prompt, { profile = "lite" } = {}) {
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("prompt is empty");
  }
  if (prompt.length > config.maxPromptChars) {
    throw new Error(`prompt exceeds ${config.maxPromptChars} characters`);
  }
  // Keep line 0 intact for ZCODE_STRUCTURED_V1 contracts so contract recovery and
  // structured schema prompts are never prefixed with prose instructions.
  if (profile === "lite" && !prompt.startsWith("ZCODE_STRUCTURED_V1 ")) {
    return `${LITE_MEMORY_GUARD}${prompt}`;
  }
  return prompt;
}

export function buildCliArgs({
  taskId,
  profile = "lite",
  model = null,
  fallbackModel = null,
  ephemeral = false,
  resume = false,
} = {}) {
  if (!CODEBUDDY_PROFILES.includes(profile)) {
    throw new Error(`Unsupported profile "${profile}"; expected one of: ${CODEBUDDY_PROFILES.join(", ")}`);
  }
  const args = ["-p", "--output-format", "json"];
  if (resume) {
    if (!taskId) throw new Error("taskId is required to resume a session");
    args.push("-r", taskId);
  } else if (ephemeral) {
    args.push("--no-session-persistence");
  } else {
    if (!taskId) throw new Error("taskId is required for persistent sessions");
    args.push("--session-id", taskId);
  }

  if (profile === "lite") {
    args.push("--tools", "", "--mcp-config", JSON.stringify({ mcpServers: {} }), "--strict-mcp-config");
  } else if (profile === "readonly") {
    args.push(
      "--tools",
      READONLY_TOOLS,
      "--allowedTools",
      READONLY_TOOLS,
      "--mcp-config",
      JSON.stringify({ mcpServers: {} }),
      "--strict-mcp-config",
      "-y",
    );
  } else if (profile === "workspace") {
    args.push("-y");
  }

  if (model) args.push("--model", model);
  if (fallbackModel) args.push("--fallback-model", fallbackModel);
  return args;
}

function extractTextFromAssistantEvent(ev) {
  const msg = ev?.message ?? ev;
  const content = msg?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const texts = [];
  for (const part of content) {
    if (part?.type === "text" && typeof part.text === "string") {
      texts.push(part.text);
    }
  }
  return texts.length ? texts.join("\n") : null;
}

export function parseCodebuddyJsonOutput(stdout) {
  const parsed = tryParseJsonPayload(stdout);
  if (!parsed) {
    return {
      ok: false,
      isError: true,
      subtype: null,
      result: null,
      errors: ["CodeBuddy CLI did not return valid JSON output"],
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
  let detectedModel = null;
  let detectedSessionId = null;
  let toolCalls = 0;

  const seenMsgIds = new Set();
  let rawPrompt = 0;
  let rawCompletion = 0;
  let rawCacheRead = 0;
  let rawCacheWrite = 0;
  let credit = 0;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev || typeof ev !== "object") continue;
    if (typeof ev.session_id === "string" && ev.session_id) detectedSessionId = ev.session_id;
    if (typeof ev.model === "string" && ev.model) detectedModel = ev.model;
    if (typeof ev.message?.model === "string" && ev.message.model) detectedModel = ev.message.model;

    if (ev.type === "function_call") {
      toolCalls++;
    } else if (ev.type === "assistant") {
      const text = extractTextFromAssistantEvent(ev);
      if (text !== null) lastAssistantText = text;
      const content = ev.message?.content ?? ev.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === "tool_use") toolCalls++;
        }
      }
    } else if (ev.type === "result") {
      resultEvent = ev;
    }

    const p = ev.providerData;
    if (p?.rawUsage) {
      const key = p.messageId ? `id:${p.messageId}` : `idx:${i}`;
      if (!seenMsgIds.has(key)) {
        seenMsgIds.add(key);
        const ru = p.rawUsage;
        rawPrompt += Number(ru.prompt_tokens ?? ru.input_tokens ?? 0);
        rawCompletion += Number(ru.completion_tokens ?? ru.output_tokens ?? 0);
        rawCacheRead += Number(ru.prompt_cache_hit_tokens ?? ru.cache_read_input_tokens ?? 0);
        rawCacheWrite += Number(ru.cache_creation_input_tokens ?? ru.cache_write_input_tokens ?? 0);
        credit = roundCredit(credit + Number(ru.credit ?? 0));
      }
    }
  }

  const u = resultEvent?.usage ?? null;
  const inputTokens = Number(u?.input_tokens ?? u?.prompt_tokens ?? rawPrompt);
  const outputTokens = Number(u?.output_tokens ?? u?.completion_tokens ?? rawCompletion);
  const cacheReadInputTokens = Number(u?.cache_read_input_tokens ?? u?.prompt_cache_hit_tokens ?? rawCacheRead);
  const cacheWriteInputTokens = Number(u?.cache_creation_input_tokens ?? u?.cache_write_input_tokens ?? rawCacheWrite);
  const totalTokens = Number(
    u?.total_tokens ?? inputTokens + outputTokens + cacheReadInputTokens + cacheWriteInputTokens,
  );
  const modelRequests = seenMsgIds.size || Number(resultEvent?.num_turns ?? 0) || (resultEvent ? 1 : 0);

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
        : `CodeBuddy failed (${subtype ?? "error"})`,
    );
  }

  return {
    ok: !hasExplicitFailure && (Boolean(resultEvent) || resultText !== null),
    isError: hasExplicitFailure,
    subtype,
    result: resultText,
    errors,
    sessionId: detectedSessionId,
    model: detectedModel,
    numTurns: Number(resultEvent?.num_turns ?? (modelRequests > 0 ? 1 : 0)),
    durationMs: Number.isFinite(resultEvent?.duration_ms) ? Number(resultEvent.duration_ms) : null,
    usage: {
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheWriteInputTokens,
      totalTokens,
      toolCalls,
      modelRequests,
      credit,
    },
  };
}

export function reconcileRun(taskId, { now = Date.now(), env = process.env, isPidAlive = defaultIsPidAlive } = {}) {
  return reconcileCliRun({
    backend: "codebuddy",
    label: "CodeBuddy",
    cfg: cbBackendConfig(env),
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
    cfg: cbBackendConfig(env),
    reconcileFn: (idArg, opts) => reconcileRun(idArg, { env, ...opts }),
    isPidAlive,
  });
}

export function list({ limit = 15, env = process.env, isPidAlive = defaultIsPidAlive } = {}) {
  return listCliRuns({
    backend: "codebuddy",
    fileRegex: TASK_FILE_RE,
    cfg: cbBackendConfig(env),
    limit,
    reconcileFn: (idArg, opts) => reconcileRun(idArg, { env, ...opts }),
    isPidAlive,
  });
}

export function runningCount({ env = process.env, isPidAlive = defaultIsPidAlive } = {}) {
  return runningCliCount({
    fileRegex: TASK_FILE_RE,
    cfg: cbBackendConfig(env),
    reconcileFn: (idArg, opts) => reconcileRun(idArg, { env, ...opts }),
    isPidAlive,
  });
}

export async function run({
  prompt,
  model,
  fallbackModel = null,
  profile = "lite",
  cwd,
  ephemeral = false,
  contract = null,
  env = process.env,
  spawnImpl = spawn,
  isPidAlive = defaultIsPidAlive,
} = {}) {
  const cfg = cbBackendConfig(env);
  if (!cfg.bin || !existsSync(cfg.bin)) {
    throw new Error("codebuddy CLI binary not found. Set CODEBUDDY_BIN or install codebuddy on PATH.");
  }

  const finalPrompt = preparePrompt(prompt, { profile });
  const chosenModel = model ?? cfg.defaultModel;
  const resolvedCwd = resolve(cwd ?? cfg.defaultCwd);
  if (!existsSync(resolvedCwd) || !statSync(resolvedCwd).isDirectory()) {
    throw new Error(`Invalid cwd: "${resolvedCwd}" does not exist or is not a directory.`);
  }

  const active = runningCount({ env, isPidAlive });
  if (active >= cfg.maxRunning) {
    throw new Error(`CodeBuddy capacity limit reached (${active}/${cfg.maxRunning} tasks running). Wait or cancel one first.`);
  }

  const taskId = `cb_${randomBytes(12).toString("hex")}`;
  const cliArgs = buildCliArgs({
    taskId,
    profile,
    model: chosenModel,
    fallbackModel,
    ephemeral: Boolean(ephemeral),
    resume: false,
  });

  const stateFile = join(cfg.runsDir, `${taskId}.json`);
  const promptFile = join(cfg.runsDir, `${taskId}.prompt.txt`);
  const specFile = join(cfg.runsDir, `${taskId}.spec.json`);
  const nowMs = Date.now();
  const sessionFile = ephemeral ? null : codebuddySessionFile(taskId, resolvedCwd, env);

  const initialState = {
    taskId,
    backend: "codebuddy",
    mode: profile,
    status: "starting",
    profile,
    cwd: resolvedCwd,
    model: chosenModel,
    fallbackModel: fallbackModel ?? null,
    actualModel: null,
    ephemeral: Boolean(ephemeral),
    sessionFile,
    sessionId: ephemeral ? null : taskId,
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
    spec: { backend: "codebuddy", taskId, stateFile, promptFile, bin: cfg.bin, args: cliArgs, cwd: resolvedCwd },
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
    backend: "codebuddy",
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
  fallbackModel = null,
  env = process.env,
  spawnImpl = spawn,
  isPidAlive = defaultIsPidAlive,
} = {}) {
  if (!prompt?.trim()) throw new Error("prompt is empty");
  const cfg = cbBackendConfig(env);
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
    throw new Error("codebuddy CLI binary not found. Set CODEBUDDY_BIN or install codebuddy on PATH.");
  }

  const active = runningCount({ env, isPidAlive });
  if (active >= cfg.maxRunning) {
    throw new Error(`CodeBuddy capacity limit reached (${active}/${cfg.maxRunning} tasks running).`);
  }

  const finalPrompt = preparePrompt(prompt, { profile: prev.profile ?? "lite" });
  const chosenModel = model ?? prev.model ?? cfg.defaultModel;
  const cliArgs = buildCliArgs({
    taskId: prev.sessionId ?? taskId,
    profile: prev.profile ?? "lite",
    model: chosenModel,
    fallbackModel: fallbackModel ?? prev.fallbackModel ?? null,
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
    spec: { backend: "codebuddy", taskId, stateFile, promptFile, bin: cfg.bin, args: cliArgs, cwd: prev.cwd },
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

  return { taskId, backend: "codebuddy", accepted: true, model: chosenModel };
}

export async function cancel(
  taskId,
  { env = process.env, isPidAlive = defaultIsPidAlive, killFn = (pid, sig) => process.kill(pid, sig) } = {},
) {
  return cancelCliRun({
    backend: "codebuddy",
    runsDir: cbBackendConfig(env).runsDir,
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
  return readContractFromStateOrJsonl(taskId, cbBackendConfig(env).runsDir, parseContractText);
}

export async function health({ env = process.env, isPidAlive = defaultIsPidAlive } = {}) {
  const cfg = cbBackendConfig(env);
  let authAvailable = false;
  try {
    authAvailable = Boolean(readToken());
  } catch {
    authAvailable = false;
  }
  const out = {
    ok: false,
    backend: "codebuddy",
    available: false,
    bin: cfg.bin,
    version: null,
    defaultModel: cfg.defaultModel,
    models: cfg.allowedModels,
    profiles: CODEBUDDY_PROFILES,
    defaultCwd: cfg.defaultCwd,
    maxRunning: cfg.maxRunning,
    runningTasks: runningCount({ env, isPidAlive }),
    authAvailable,
  };
  if (!cfg.bin || !existsSync(cfg.bin)) {
    out.error = "codebuddy binary not found on PATH or CODEBUDDY_BIN.";
    return out;
  }
  out.available = true;
  try {
    out.version = await execCliText(cfg.bin, ["--version"], env, 3000);
    out.ok = true;
  } catch (e) {
    out.error = `codebuddy --version failed: ${e.message}`;
  }
  return out;
}

export async function quota({ refresh = false, sinceDays = 7 } = {}) {
  return codebuddyUsage({ refresh, sinceDays });
}
