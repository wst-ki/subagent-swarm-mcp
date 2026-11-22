// Multi-CLI backend registry and router for subagent-swarm-mcp.
// Keeps zcode, codebuddy, and qoder uniformly addressable via taskId prefixes and routes
// `backend: "auto"` requests by constraints, model match, health, and free capacity.
import { resolve } from "node:path";
import { readCachedExpiringCredit } from "../codebuddy-usage.mjs";
import { config } from "../config.mjs";
import * as codebuddy from "./codebuddy.mjs";
import * as qoder from "./qoder.mjs";
import * as zcode from "./zcode.mjs";

export const BACKENDS = {
  zcode,
  codebuddy,
  qoder,
};

export const SWARM_BACKEND_NAMES = ["auto", "zcode", "codebuddy", "qoder"];
const ROUTING_ORDER = ["codebuddy", "qoder", "zcode"];

export function backendForTaskId(taskId, { backends = BACKENDS } = {}) {
  if (typeof taskId !== "string" || !taskId) {
    throw new Error("taskId is required");
  }
  if (taskId.startsWith("cb_")) {
    return backends.codebuddy;
  }
  if (taskId.startsWith("qd_")) {
    return backends.qoder;
  }
  if (backends.zcode?.supports?.(taskId) ?? /^sess(ion)?_[\w-]+$/.test(taskId)) {
    return backends.zcode;
  }
  throw new Error(`Unsupported taskId "${taskId}": expected cb_*, qd_*, or sess*_*`);
}

function getBackendMaxRunning(backendAdapter, env = process.env) {
  if (!backendAdapter) return 0;
  if (typeof backendAdapter.maxRunning === "function") return backendAdapter.maxRunning(env);
  if (backendAdapter.id === "codebuddy") return codebuddy.cbBackendConfig(env).maxRunning;
  if (backendAdapter.id === "qoder") return qoder.qoderBackendConfig(env).maxRunning;
  return config.maxRunning;
}

function getBackendModels(backendAdapter, env = process.env) {
  if (!backendAdapter) return [];
  if (typeof backendAdapter.models === "function") return backendAdapter.models(env);
  if (backendAdapter.id === "codebuddy") return codebuddy.cbBackendConfig(env).allowedModels;
  if (backendAdapter.id === "qoder") return qoder.qoderBackendConfig(env).allowedModels;
  return config.allowedModels;
}

async function safeHealth(backendAdapter, env) {
  if (!backendAdapter) return { ok: false, available: false, error: "Backend not registered" };
  try {
    return await backendAdapter.health({ env });
  } catch (e) {
    return { ok: false, available: false, backend: backendAdapter.id, error: e?.message ?? String(e) };
  }
}

export async function listBackends({ env = process.env, backends = BACKENDS } = {}) {
  const entries = await Promise.all(
    Object.entries(backends).map(async ([name, adapter]) => [name, await safeHealth(adapter, env)]),
  );
  return {
    backends: Object.fromEntries(entries),
    routingOrder: ROUTING_ORDER.filter((n) => Boolean(backends[n])),
    note: "Future CLIs can register under src/backends/ without changing swarm_* tool contracts.",
  };
}

function pickBestHealthy(names, backends, healthMap, env, { preferCodebuddy = false } = {}) {
  if (preferCodebuddy && names.includes("codebuddy") && backends.codebuddy && healthMap.codebuddy?.ok) {
    const h = healthMap.codebuddy;
    const cbFree = Math.max(0, (h.maxRunning ?? getBackendMaxRunning(backends.codebuddy, env)) - (h.runningTasks ?? 0));
    if (cbFree > 0) return { best: backends.codebuddy, bestFree: cbFree };
  }
  let best = null;
  let bestFree = -1;
  for (const name of names) {
    const adapter = backends[name];
    const h = healthMap[name];
    if (!adapter || !h?.ok) continue;
    const free = Math.max(0, (h.maxRunning ?? getBackendMaxRunning(adapter, env)) - (h.runningTasks ?? 0));
    if (free > bestFree) {
      best = adapter;
      bestFree = free;
    }
  }
  return { best, bestFree };
}

function shouldPreferExpiringCodebuddy(env) {
  if (env?.CODEBUDDY_PREFER_WHEN_EXPIRING === "0" || env?.CODEBUDDY_PREFER_WHEN_EXPIRING === "false") {
    return false;
  }
  const stateDir = env?.ZCODE_MCP_STATE_DIR?.trim() || config.stateDir;
  return readCachedExpiringCredit({ stateDir }).credit > 0;
}

export async function selectBackend({
  backend = "auto",
  model = null,
  profile = null,
  cwd = null,
  ephemeral = false,
  provider = null,
  effort = null,
  maxTurns = null,
  systemPrompt = undefined,
  appendSystemPrompt = null,
  addDirs = null,
  preferExpiringCodebuddy = undefined,
  env = process.env,
  backends = BACKENDS,
} = {}) {
  if (backend && backend !== "auto") {
    const adapter = backends[backend];
    if (!adapter) {
      throw new Error(`Unknown backend "${backend}". Available backends: ${Object.keys(backends).join(", ")}`);
    }
    return adapter;
  }

  // Provider billing routes are exclusive to ZCode.
  if (provider) {
    return backends.zcode;
  }

  // CodeBuddy-specific CLI controls route directly to CodeBuddy when backend="auto".
  const needsCodebuddyFeatures = Boolean(
    effort ||
      maxTurns !== null && maxTurns !== undefined ||
      systemPrompt !== undefined ||
      appendSystemPrompt ||
      (Array.isArray(addDirs) && addDirs.length > 0),
  );
  if (needsCodebuddyFeatures && backends.codebuddy) {
    return backends.codebuddy;
  }

  const preferCb = preferExpiringCodebuddy ?? shouldPreferExpiringCodebuddy(env);
  const hasCustomCwd = Boolean(cwd && resolve(cwd) !== resolve(config.projectDir));
  const needsCliFeatures = profile === "lite" || profile === "readonly" || Boolean(ephemeral) || hasCustomCwd;

  const activeOrder = ROUTING_ORDER.filter((n) => Boolean(backends[n]));
  const eligibleByConstraint = needsCliFeatures ? activeOrder.filter((n) => n !== "zcode") : activeOrder;

  if (model) {
    const modelMatches = eligibleByConstraint.filter((n) => new Set(getBackendModels(backends[n], env)).has(model));
    if (modelMatches.length === 1) {
      return backends[modelMatches[0]];
    }
    if (modelMatches.length > 1) {
      const subsetHealth = Object.fromEntries(
        await Promise.all(modelMatches.map(async (n) => [n, await safeHealth(backends[n], env)])),
      );
      const { best } = pickBestHealthy(modelMatches, backends, subsetHealth, env, { preferCodebuddy: preferCb });
      if (best) return best;
      return backends[modelMatches[0]];
    }
  }

  const healthPairs = await Promise.all(
    activeOrder.map(async (n) => [n, await safeHealth(backends[n], env)]),
  );
  const healthMap = Object.fromEntries(healthPairs);

  if (needsCliFeatures) {
    const { best, bestFree } = pickBestHealthy(eligibleByConstraint, backends, healthMap, env, { preferCodebuddy: preferCb });
    if (best && (bestFree > 0 || eligibleByConstraint.length === 1)) return best;
    if (best) return best;
    const cliReasons = eligibleByConstraint
      .map((n) => `${n}: ${healthMap[n]?.error ?? "unavailable"}`)
      .join("; ");
    throw new Error(
      `Requested options (${[
        profile ? `profile=${profile}` : null,
        ephemeral ? "ephemeral" : null,
        hasCustomCwd ? "custom cwd" : null,
      ]
        .filter(Boolean)
        .join(", ")}) require the ${eligibleByConstraint.join(" or ")} backend, which is not ready (${cliReasons})`,
    );
  }

  // General auto routing: if CodeBuddy has expiring-soon credits and free slots, consume them first;
  // otherwise pick healthy backend with most free capacity (ties: codebuddy -> qoder -> zcode).
  if (preferCb && activeOrder.includes("codebuddy") && healthMap.codebuddy?.ok) {
    const h = healthMap.codebuddy;
    const cbFree = Math.max(0, (h.maxRunning ?? getBackendMaxRunning(backends.codebuddy, env)) - (h.runningTasks ?? 0));
    if (cbFree > 0) return backends.codebuddy;
  }

  let chosen = null;
  let chosenFree = 0;
  for (const n of activeOrder) {
    const h = healthMap[n];
    if (!h?.ok) continue;
    const free = Math.max(0, (h.maxRunning ?? getBackendMaxRunning(backends[n], env)) - (h.runningTasks ?? 0));
    if (free > chosenFree) {
      chosen = backends[n];
      chosenFree = free;
    }
  }
  if (chosen) return chosen;

  const healthyFallback = activeOrder.find((n) => healthMap[n]?.ok);
  if (healthyFallback) {
    // Only return a full backend if others are unavailable, otherwise surface busy/unavailable error.
    const anyOther = activeOrder.filter((n) => n !== healthyFallback);
    if (anyOther.every((n) => !healthMap[n]?.ok)) return backends[healthyFallback];
  }

  const reasons = activeOrder.map((n) => {
    const h = healthMap[n];
    return `${n}: ${h?.ok ? `busy (${h.runningTasks}/${h.maxRunning})` : h?.error ?? "unavailable"}`;
  });
  throw new Error(`No healthy backend with available capacity (${reasons.join("; ")})`);
}

export async function swarmRun({
  backend = "auto",
  prompt,
  model = undefined,
  fallbackModel = undefined,
  profile = undefined,
  cwd = undefined,
  provider = undefined,
  ephemeral = false,
  effort = undefined,
  maxTurns = undefined,
  systemPrompt = undefined,
  appendSystemPrompt = undefined,
  addDirs = undefined,
  waitSec = 0,
  contract = null,
  onProgress = null,
  shouldAbort = null,
  env = process.env,
  backends = BACKENDS,
} = {}) {
  const chosen = await selectBackend({
    backend,
    model,
    profile,
    cwd,
    ephemeral,
    provider,
    effort,
    maxTurns,
    systemPrompt,
    appendSystemPrompt,
    addDirs,
    env,
    backends,
  });

  const effectiveProfile =
    chosen.id === "zcode" ? profile : (profile ?? "lite");

  const started = await chosen.run({
    prompt,
    model,
    fallbackModel,
    profile: effectiveProfile,
    cwd,
    provider,
    ephemeral,
    effort,
    maxTurns,
    systemPrompt,
    appendSystemPrompt,
    addDirs,
    contract,
    shouldAbort,
    env,
  });

  if (waitSec > 0) {
    const waited = await chosen.wait(started.taskId, {
      timeoutSec: waitSec,
      onProgress,
      env,
    });
    return {
      ...started,
      ...waited,
    };
  }

  return started;
}

export function swarmStatus(taskId, { env = process.env, backends = BACKENDS } = {}) {
  const adapter = backendForTaskId(taskId, { backends });
  return adapter.status(taskId, { env });
}

export function swarmResult(taskId, { env = process.env, backends = BACKENDS } = {}) {
  const adapter = backendForTaskId(taskId, { backends });
  return adapter.result(taskId, { env });
}

export async function swarmWait({
  taskId,
  timeoutSec = 45,
  onProgress = null,
  env = process.env,
  backends = BACKENDS,
} = {}) {
  const adapter = backendForTaskId(taskId, { backends });
  return adapter.wait(taskId, { timeoutSec, onProgress, env });
}

export async function swarmFollowUp({
  taskId,
  prompt,
  model = undefined,
  fallbackModel = undefined,
  effort = undefined,
  maxTurns = undefined,
  env = process.env,
  backends = BACKENDS,
} = {}) {
  const adapter = backendForTaskId(taskId, { backends });
  return adapter.followUp({ taskId, prompt, model, fallbackModel, effort, maxTurns, env });
}

export async function swarmCancel(taskId, { env = process.env, backends = BACKENDS } = {}) {
  const adapter = backendForTaskId(taskId, { backends });
  return adapter.cancel(taskId, { env });
}

export function swarmList({ backend = "all", limit = 15, env = process.env, backends = BACKENDS } = {}) {
  const targets = backend === "all" ? Object.values(backends) : [backends[backend]].filter(Boolean);
  if (targets.length === 0) {
    throw new Error(`Unknown backend "${backend}"`);
  }
  const rows = [];
  for (const adapter of targets) {
    try {
      rows.push(...adapter.list({ limit, env }));
    } catch {
      // One backend's local DB may not exist on hosts that only run the other CLI.
    }
  }
  return rows
    .sort((a, b) => Date.parse(b.createdAt ?? 0) - Date.parse(a.createdAt ?? 0))
    .slice(0, limit);
}

export async function swarmQuota({ backend = "all", refresh = false, sinceDays = 7, env = process.env, backends = BACKENDS } = {}) {
  const wanted = backend === "all" ? Object.keys(backends) : [backend];
  const entries = await Promise.all(
    wanted.map(async (name) => {
      const adapter = backends[name];
      if (!adapter) return [name, { error: `Unknown backend "${name}"` }];
      try {
        return [name, await adapter.quota({ refresh, sinceDays, env })];
      } catch (e) {
        return [name, { error: e?.message ?? String(e) }];
      }
    }),
  );
  return Object.fromEntries(entries);
}
