// Lightweight, low-CPU, checkpointed structured batch runner (Stage 4 Plan B + Stage 6 Auto-Microbatching).
// Uses append-only JSONL state (manifest.jsonl, results.jsonl, summary.json, blocked.json)
// instead of heavy per-item Git commits, with adaptive polling, auto-microbatching with
// partial-batch recovery, and strict circuit breakers.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sleep } from './cdp.mjs';
import { writeJsonFileAtomic } from './cli-io.mjs';
import { BACKENDS, selectBackend } from './backends/registry.mjs';
import { config } from './config.mjs';
import { normalizeProviderKey, resolveProvider } from './model-select.mjs';
import {
  runStructured,
  structuredResult,
  validateDomainRule,
  validateSchema,
  validateValue,
} from './structured.mjs';

export function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
}

export function sha256Hex(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

export function computeBatchItemKey({ templateId = 'default', itemId, input, schema, domainRule = null }) {
  if (typeof itemId !== 'string' || !itemId.trim()) throw new Error('itemId must be a non-empty string');
  const ruleKey = typeof domainRule === 'string'
    ? domainRule
    : domainRule && typeof domainRule === 'object'
      ? stableJson(domainRule)
      : null;
  const payload = stableJson({
    templateId,
    itemId: itemId.trim(),
    inputHash: sha256Hex(stableJson(input)),
    schemaHash: sha256Hex(stableJson(schema)),
    domainRule: ruleKey,
  });
  return sha256Hex(payload).slice(0, 32);
}

export function buildMicrobatchSchema(itemSchema, maxBatchSize = 50) {
  validateSchema(itemSchema);
  return validateSchema({
    type: 'object',
    additionalProperties: false,
    required: ['results'],
    properties: {
      results: {
        type: 'array',
        minItems: 1,
        maxItems: Math.max(1, Math.min(100, maxBatchSize)),
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['itemId', 'output'],
          properties: {
            itemId: { type: 'string', minLength: 1, maxLength: 200 },
            output: itemSchema,
          },
        },
      },
    },
  });
}

export function packChunks(items, { microbatchSize = 1, maxBatchInputChars = 30_000 } = {}) {
  if (microbatchSize <= 1) return items.map(it => [it]);
  const chunks = [];
  let current = [];
  let currentChars = 0;
  for (const item of items) {
    const itemChars = JSON.stringify(item.input ?? null).length + item.itemId.length + 32;
    if (
      current.length > 0 &&
      (current.length >= microbatchSize || currentChars + itemChars > maxBatchInputChars)
    ) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(item);
    currentChars += itemChars;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export function isCapacityOrLockBusyError(message) {
  return /already has \d+ running task|capacity limit reached|No healthy backend with available capacity|Timed out waiting for another ZCode UI operation|Reserved \d+ slot\(s\)/i.test(
    String(message ?? ''),
  );
}

export function classifyBlocker(code, message = '') {
  switch (code) {
    case 'quota_or_rate_limit':
      return { retryable: true, recommendedAction: 'cooldown_quota' };
    case 'capacity_exhausted':
      return { retryable: true, recommendedAction: 'wait_capacity' };
    case 'credit_budget_reached':
      return { retryable: false, recommendedAction: 'increase_credit_budget' };
    case 'provider_route_mismatch':
      return { retryable: false, recommendedAction: 'check_billing_route' };
    case 'submission_circuit_breaker':
      if (/quota|rate.limit|429|额度|限流/i.test(String(message ?? ''))) {
        return { retryable: true, recommendedAction: 'cooldown_quota' };
      }
      return { retryable: false, recommendedAction: 'needs_human_auth' };
    default:
      return { retryable: false, recommendedAction: 'inspect_error' };
  }
}

function readJsonlSafe(filePath) {
  if (!existsSync(filePath)) return { records: [], corruptLines: 0 };
  const lines = readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim().length > 0);
  const records = [];
  let corruptLines = 0;
  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch {
      corruptLines++;
    }
  }
  return { records, corruptLines };
}

export function resolveBatchDir(batchId, stateDir = config.stateDir) {
  if (!/^[a-zA-Z0-9._-]{1,120}$/.test(String(batchId ?? ''))) {
    throw new Error('batchId must match /^[a-zA-Z0-9._-]{1,120}$/');
  }
  return resolve(stateDir, 'batches', batchId);
}

export function readBatchStatus(batchId, { stateDir = config.stateDir, includeItems = true } = {}) {
  const dir = resolveBatchDir(batchId, stateDir);
  if (!existsSync(dir)) throw new Error(`Batch "${batchId}" does not exist at ${dir}`);
  const manifest = readJsonlSafe(join(dir, 'manifest.jsonl'));
  const results = readJsonlSafe(join(dir, 'results.jsonl'));
  const blocked = existsSync(join(dir, 'blocked.json'))
    ? JSON.parse(readFileSync(join(dir, 'blocked.json'), 'utf8'))
    : null;
  let progress = null;
  const progressFile = join(dir, 'progress.json');
  if (existsSync(progressFile)) {
    try {
      progress = JSON.parse(readFileSync(progressFile, 'utf8'));
    } catch {
      progress = null;
    }
  }
  const latestByKey = new Map();
  for (const r of results.records) {
    if (r && r.itemKey) latestByKey.set(r.itemKey, r);
  }
  const counts = {
    total: manifest.records.length,
    valid: 0,
    invalid: 0,
    failed: 0,
    pending: 0,
    retried: 0,
  };
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    totalTokens: 0,
    toolCalls: 0,
    modelRequests: 0,
    credit: 0,
  };
  // Deduplicate usage by taskId when multiple items share a microbatch session
  const countedTaskIds = new Set();
  for (const r of latestByKey.values()) {
    if (r?.usage) {
      if (r.taskId) {
        if (countedTaskIds.has(r.taskId)) continue;
        countedTaskIds.add(r.taskId);
      }
      usage.inputTokens += r.usage.inputTokens ?? 0;
      usage.outputTokens += r.usage.outputTokens ?? 0;
      usage.cacheReadInputTokens += r.usage.cacheReadInputTokens ?? 0;
      usage.cacheWriteInputTokens += r.usage.cacheWriteInputTokens ?? 0;
      usage.totalTokens += r.usage.totalTokens ?? 0;
      usage.toolCalls += r.usage.toolCalls ?? 0;
      usage.modelRequests += r.usage.modelRequests ?? 0;
      usage.credit = Math.round((usage.credit + (r.usage.credit ?? 0)) * 10000) / 10000;
    }
  }
  const items = [];
  for (const m of manifest.records) {
    const rec = latestByKey.get(m.itemKey);
    if (!rec) {
      counts.pending++;
      if (includeItems !== false) {
        items.push({ itemId: m.itemId, itemKey: m.itemKey, status: 'pending', attempts: 0 });
      }
    } else {
      if (rec.attempt > 1) counts.retried++;
      if (rec.structuredStatus === 'valid') counts.valid++;
      else if (rec.structuredStatus === 'invalid') counts.invalid++;
      else if (rec.structuredStatus === 'pending') counts.pending++;
      else counts.failed++;
      if (includeItems !== false) {
        items.push({
          itemId: m.itemId,
          itemKey: m.itemKey,
          taskId: rec.taskId ?? null,
          status: rec.structuredStatus,
          failureKind: rec.failureKind ?? null,
          attempt: rec.attempt ?? 1,
          elapsedMs: rec.elapsedMs ?? null,
          errors: rec.errors ?? undefined,
          value: rec.value ?? undefined,
          model: rec.model ?? undefined,
        });
      }
    }
  }
  return {
    batchId,
    dir,
    status: blocked ? 'blocked' : counts.pending === 0 ? 'completed' : 'incomplete',
    blocked,
    counts,
    usage,
    corruptLines: manifest.corruptLines + results.corruptLines,
    ...(progress ? { progress } : {}),
    ...(includeItems !== false ? { items } : {}),
  };
}

/**
 * Crash-safe export of all currently `valid` items from `<stateDir>/batches/<batchId>/results.jsonl`,
 * even if the batch was interrupted mid-wave before writing an export file.
 */
export function exportBatchValidItems(
  batchId,
  { stateDir = config.stateDir, unpackItem = null, rawByItemId = null } = {},
) {
  const report = readBatchStatus(batchId, { stateDir, includeItems: true });
  const validItems = report.items.filter(it => it.status === 'valid');
  const exported = validItems.map(it =>
    typeof unpackItem === 'function'
      ? unpackItem(rawByItemId?.get(it.itemId), it)
      : {
          itemId: it.itemId,
          status: it.status,
          value: it.value ?? null,
          ...(it.taskId ? { taskId: it.taskId } : {}),
          ...(it.model ? { model: it.model } : {}),
        },
  );
  return {
    batchId: report.batchId,
    dir: report.dir,
    status: report.status,
    blocked: report.blocked,
    counts: report.counts,
    usage: report.usage,
    exportedCount: exported.length,
    items: exported,
  };
}

/**
 * Run or resume a checkpointed structured batch.
 * Supports `microbatchSize > 1` with partial-batch recovery (valid items in a microbatch are
 * saved immediately and only invalid/missing items are retried).
 */
export async function runStructuredBatch({
  batchId,
  templateId = 'default',
  task,
  schema,
  domainRule = null,
  items,
  microbatchSize = 1,
  maxBatchInputChars = 30_000,
  backend = 'zcode',
  profile = undefined,
  cwd = undefined,
  ephemeral = false,
  effort = undefined,
  maxTurns = undefined,
  systemPrompt = undefined,
  appendSystemPrompt = undefined,
  addDirs = undefined,
  model,
  provider,
  maxConcurrency = 1,
  reserveSlots = 0,
  maxCredit = null,
  maxRetries = 1,
  pollIntervalMs = undefined,
  maxPollIntervalMs = 5000,
  itemTimeoutMs = 180_000,
  capacityWaitMs = 300_000,
  includeItems = true,
  stateDir = config.stateDir,
  env = process.env,
  backends = BACKENDS,
  runner = runStructured,
  evaluator = null,
  canceller = undefined,
  healthFn = null,
  sleeper = sleep,
}) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 1000) {
    throw new Error('items must be a non-empty array of at most 1000 items');
  }
  validateSchema(schema);
  if (!Number.isSafeInteger(microbatchSize) || microbatchSize < 1 || microbatchSize > 50) {
    throw new Error('microbatchSize must be an integer between 1 and 50');
  }
  if (!Number.isSafeInteger(capacityWaitMs) || capacityWaitMs < 0 || capacityWaitMs > 3_600_000) {
    throw new Error('capacityWaitMs must be an integer between 0 and 3600000');
  }
  if (maxCredit !== null && maxCredit !== undefined && (!Number.isFinite(maxCredit) || maxCredit <= 0)) {
    throw new Error('maxCredit must be a positive number');
  }
  const chosenAdapter = await selectBackend({
    backend,
    model,
    profile,
    cwd,
    ephemeral,
    effort,
    maxTurns,
    systemPrompt,
    appendSystemPrompt,
    addDirs,
    provider,
    env,
    backends,
  });
  const effectiveCanceller = canceller !== undefined
    ? canceller
    : (runner === runStructured ? (taskId) => chosenAdapter.cancel(taskId) : null);
  const resolvedBackend = chosenAdapter.id;
  const effectivePollMs = pollIntervalMs ?? (resolvedBackend === 'zcode' ? 2000 : 500);
  const maxLimit = typeof chosenAdapter.maxRunning === 'function' ? chosenAdapter.maxRunning(env) : config.maxRunning;
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > maxLimit) {
    throw new Error(`maxConcurrency must be an integer between 1 and ${maxLimit}`);
  }
  if (!Number.isSafeInteger(reserveSlots) || reserveSlots < 0 || reserveSlots >= maxLimit) {
    throw new Error(`reserveSlots must be an integer between 0 and ${Math.max(0, maxLimit - 1)}`);
  }
  const effectiveConcurrency = Math.min(maxConcurrency, Math.max(1, maxLimit - reserveSlots));
  const probeHealth = reserveSlots > 0
    ? (healthFn ?? (runner === runStructured && typeof chosenAdapter.health === 'function'
        ? () => chosenAdapter.health({ env })
        : null))
    : null;
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 1) {
    throw new Error('maxRetries must be 0 or 1');
  }
  const route = resolvedBackend === 'zcode'
    ? resolveProvider(provider ?? config.providerKey, config.allowedProviders)
    : null;
  const dir = resolveBatchDir(batchId, stateDir);
  mkdirSync(dir, { recursive: true });

  const manifestPath = join(dir, 'manifest.jsonl');
  const resultsPath = join(dir, 'results.jsonl');
  const blockedPath = join(dir, 'blocked.json');
  const progressPath = join(dir, 'progress.json');
  const summaryPath = join(dir, 'summary.json');

  // Clear previous blocked.json if resuming explicitly
  rmSync(blockedPath, { force: true });
  const existingManifest = readJsonlSafe(manifestPath);
  const manifestByKey = new Map(existingManifest.records.map(r => [r.itemKey, r]));

  const normalizedItems = items.map((item, idx) => {
    const itemId = String(item.itemId ?? item.id ?? `item_${idx + 1}`);
    const input = item.input;
    const itemKey = computeBatchItemKey({ templateId, itemId, input, schema, domainRule });
    const entry = { itemId, itemKey, templateId, createdAt: new Date().toISOString() };
    if (!manifestByKey.has(itemKey)) {
      appendFileSync(manifestPath, JSON.stringify(entry) + '\n', 'utf8');
      manifestByKey.set(itemKey, entry);
    }
    return { itemId, itemKey, input };
  });

  // Load existing results for idempotent resume
  const existingResults = readJsonlSafe(resultsPath);
  const latestByKey = new Map();
  for (const r of existingResults.records) {
    if (r?.itemKey) latestByKey.set(r.itemKey, r);
  }

  const evalFn = evaluator ?? ((taskId, callInput, attempt, callSchema, callDomainRule) => {
    return structuredResult(taskId, {
      domainRule: callDomainRule,
      input: callInput,
      retryPerformed: attempt > 1,
      ...(env !== process.env ? { env } : {}),
    });
  });

  const buildRunPayload = (base) => ({
    ...base,
    model,
    ...(route ? { provider: route.encoded } : {}),
    ...(resolvedBackend !== 'zcode'
      ? {
          backend: resolvedBackend,
          profile: profile ?? 'lite',
          ...(cwd ? { cwd } : {}),
          ...(ephemeral ? { ephemeral: true } : {}),
          ...(effort ? { effort } : {}),
          ...(maxTurns !== undefined ? { maxTurns } : {}),
          ...(systemPrompt !== undefined ? { systemPrompt } : {}),
          ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
          ...(Array.isArray(addDirs) && addDirs.length > 0 ? { addDirs } : {}),
          ...(env !== process.env ? { env } : {}),
        }
      : {}),
  });

  const cpuStart = process.cpuUsage();
  const wallStart = Date.now();
  let blockedReason = null;
  let inFlight = 0;

  // Track cumulative deduplicated credit/tokens across already-recorded and new runs.
  const countedUsageTaskIds = new Set();
  let cumulativeCredit = 0;
  let cumulativeTokens = 0;
  const trackTaskUsage = (taskId, usageObj) => {
    if (!usageObj) return;
    if (taskId) {
      if (countedUsageTaskIds.has(taskId)) return;
      countedUsageTaskIds.add(taskId);
    }
    cumulativeCredit = Math.round((cumulativeCredit + Number(usageObj.credit ?? 0)) * 10000) / 10000;
    cumulativeTokens += Number(usageObj.totalTokens ?? 0);
  };
  for (const prevRec of latestByKey.values()) {
    trackTaskUsage(prevRec?.taskId, prevRec?.usage);
  }

  const writeProgress = (state = 'running') => {
    let valid = 0;
    let invalid = 0;
    let failed = 0;
    let pending = 0;
    for (const m of manifestByKey.values()) {
      const rec = latestByKey.get(m.itemKey);
      if (!rec || rec.structuredStatus === 'pending') pending++;
      else if (rec.structuredStatus === 'valid') valid++;
      else if (rec.structuredStatus === 'invalid') invalid++;
      else failed++;
    }
    writeJsonFileAtomic(progressPath, {
      batchId,
      state,
      backend: resolvedBackend,
      totalItems: manifestByKey.size,
      valid,
      invalid,
      failed,
      pending,
      inFlight,
      credit: cumulativeCredit,
      totalTokens: cumulativeTokens,
      effectiveConcurrency,
      reserveSlots,
      ...(maxCredit != null ? { maxCredit } : {}),
      startedAt: new Date(wallStart).toISOString(),
      updatedAt: new Date().toISOString(),
    });
  };

  const stopWithBlocker = (code, message, detail = {}) => {
    const taxonomy = classifyBlocker(code, message);
    blockedReason = {
      code,
      message,
      ...taxonomy,
      at: new Date().toISOString(),
      ...detail,
    };
    writeJsonFileAtomic(blockedPath, blockedReason);
    writeProgress('blocked');
  };

  const checkCreditBudget = (itemId = null, taskId = null) => {
    if (maxCredit != null && cumulativeCredit >= maxCredit && !blockedReason) {
      stopWithBlocker(
        'credit_budget_reached',
        `Cumulative batch credit ${cumulativeCredit} reached maxCredit budget ${maxCredit}`,
        {
          ...(itemId ? { itemId } : {}),
          ...(taskId ? { taskId } : {}),
          cumulativeCredit,
          maxCredit,
        },
      );
      return true;
    }
    return Boolean(blockedReason);
  };

  function isEligibleItem(normItem) {
    const prev = latestByKey.get(normItem.itemKey);
    if (!prev) return { eligible: true, startAttempt: 1, lastErrors: null };
    if (prev.structuredStatus === 'valid') return { eligible: false };
    if (prev.structuredStatus === 'invalid' && (prev.attempt ?? 1) <= maxRetries) {
      return { eligible: true, startAttempt: (prev.attempt ?? 1) + 1, lastErrors: prev.errors ?? ['previous attempt invalid'] };
    }
    if (['submission_error', 'circuit_breaker', 'quota_or_rate_limit', 'capacity_exhausted'].includes(prev.failureKind)) {
      return { eligible: true, startAttempt: 1, lastErrors: null };
    }
    if (prev.failureKind === 'timeout' && (prev.attempt ?? 1) <= maxRetries) {
      return { eligible: true, startAttempt: (prev.attempt ?? 1) + 1, lastErrors: ['previous attempt timed out'] };
    }
    return { eligible: false };
  }

  async function submitWithCapacityWait(payload) {
    const waitStart = Date.now();
    let waitMs = effectivePollMs;
    for (;;) {
      if (blockedReason) {
        const aborted = new Error('Batch halted by active circuit breaker');
        aborted.abortedByBlocker = true;
        throw aborted;
      }
      if (probeHealth) {
        let h = null;
        try {
          h = await probeHealth();
        } catch {
          h = null;
        }
        if (h && Number.isFinite(h.runningTasks)) {
          const limit = Number.isFinite(h.maxRunning) ? h.maxRunning : maxLimit;
          const allowed = Math.max(1, limit - reserveSlots);
          if (h.runningTasks >= allowed) {
            if (capacityWaitMs > 0 && Date.now() - waitStart < capacityWaitMs && !blockedReason) {
              await sleeper(waitMs);
              waitMs = Math.min(maxPollIntervalMs, Math.round(waitMs * 1.25));
              continue;
            }
            if (blockedReason) {
              const aborted = new Error('Batch halted by active circuit breaker');
              aborted.abortedByBlocker = true;
              throw aborted;
            }
            const capErr = new Error(
              `Reserved ${reserveSlots} slot(s) for other work (${h.runningTasks}/${limit} currently running on ${resolvedBackend})`,
            );
            capErr.capacityExhausted = true;
            throw capErr;
          }
        }
      }
      try {
        return await runner(payload);
      } catch (err) {
        const msg = String(err?.message ?? err);
        if (isCapacityOrLockBusyError(msg)) {
          if (capacityWaitMs > 0 && Date.now() - waitStart < capacityWaitMs && !blockedReason) {
            await sleeper(waitMs);
            waitMs = Math.min(maxPollIntervalMs, Math.round(waitMs * 1.25));
            continue;
          }
          if (blockedReason) {
            const aborted = new Error('Batch halted by active circuit breaker');
            aborted.abortedByBlocker = true;
            throw aborted;
          }
          err.capacityExhausted = true;
        }
        throw err;
      }
    }
  }

  // Filter items that need processing and pack into chunks
  const pendingItems = [];
  for (const it of normalizedItems) {
    const st = isEligibleItem(it);
    if (st.eligible) pendingItems.push({ ...it, startAttempt: st.startAttempt, lastErrors: st.lastErrors });
  }

  const chunks = packChunks(pendingItems, { microbatchSize, maxBatchInputChars });
  let cursor = 0;

  async function processSingleItem(normItem) {
    let startAttempt = normItem.startAttempt ?? 1;
    let lastErrors = normItem.lastErrors ?? null;

    for (let attempt = startAttempt; attempt <= maxRetries + 1; attempt++) {
      if (blockedReason) return;
      const attemptTask = attempt > 1 && lastErrors?.length
        ? `${task}\nIMPORTANT RETRY FIX: Previous output failed validation (${lastErrors.slice(0, 3).join('; ')}). Fix these errors and return strictly valid JSON.`
        : task;

      const t0 = Date.now();
      let started;
      try {
        started = await submitWithCapacityWait(buildRunPayload({
          task: attemptTask,
          input: normItem.input,
          schema,
          domainRule: domainRule ?? undefined,
        }));
      } catch (err) {
        if (err?.abortedByBlocker) return;
        const msg = String(err?.message ?? err);
        const isCapacityExhausted = Boolean(err?.capacityExhausted);
        const isAuthOrBlocker = !isCapacityExhausted && /login|expired|sign in|dialog|switch to model|provider|quota|rate.limit|429|credit|insufficient|额度|限流|auth/i.test(msg);
        const failureKind = isCapacityExhausted ? 'capacity_exhausted' : isAuthOrBlocker ? 'circuit_breaker' : 'submission_error';
        const rec = {
          itemId: normItem.itemId,
          itemKey: normItem.itemKey,
          attempt,
          taskId: null,
          structuredStatus: 'task_not_completed',
          failureKind,
          error: msg,
          elapsedMs: Date.now() - t0,
          at: new Date().toISOString(),
        };
        appendFileSync(resultsPath, JSON.stringify(rec) + '\n', 'utf8');
        latestByKey.set(normItem.itemKey, rec);
        if (isCapacityExhausted) {
          stopWithBlocker('capacity_exhausted', msg, { itemId: normItem.itemId, attempt });
        } else if (isAuthOrBlocker) {
          stopWithBlocker('submission_circuit_breaker', msg, { itemId: normItem.itemId, attempt });
        }
        return;
      }

      if (started.warning && /running this session on provider/i.test(started.warning)) {
        await Promise.resolve(effectiveCanceller?.(started.taskId)).catch(() => {});
        const rec = {
          itemId: normItem.itemId,
          itemKey: normItem.itemKey,
          attempt,
          taskId: started.taskId,
          structuredStatus: 'task_not_completed',
          failureKind: 'provider_route_mismatch',
          error: started.warning,
          elapsedMs: Date.now() - t0,
          at: new Date().toISOString(),
        };
        appendFileSync(resultsPath, JSON.stringify(rec) + '\n', 'utf8');
        latestByKey.set(normItem.itemKey, rec);
        stopWithBlocker('provider_route_mismatch', started.warning, { itemId: normItem.itemId, taskId: started.taskId });
        return;
      }

      let waitMs = effectivePollMs;
      let evalRes = null;
      while (Date.now() - t0 < itemTimeoutMs) {
        await sleeper(waitMs);
        evalRes = await evalFn(started.taskId, normItem.input, attempt, schema, domainRule);
        if (evalRes.structuredStatus !== 'pending') break;
        waitMs = Math.min(maxPollIntervalMs, Math.round(waitMs * 1.25));
      }

      if (!evalRes || evalRes.structuredStatus === 'pending') {
        await Promise.resolve(effectiveCanceller?.(started.taskId)).catch(() => {});
        const rec = {
          itemId: normItem.itemId,
          itemKey: normItem.itemKey,
          attempt,
          taskId: started.taskId,
          structuredStatus: 'task_not_completed',
          failureKind: 'timeout',
          elapsedMs: Date.now() - t0,
          at: new Date().toISOString(),
        };
        appendFileSync(resultsPath, JSON.stringify(rec) + '\n', 'utf8');
        latestByKey.set(normItem.itemKey, rec);
        if (attempt <= maxRetries && !blockedReason) {
          lastErrors = ['previous attempt timed out'];
          continue;
        }
        return;
      }

      if (route && evalRes.model?.providerId && normalizeProviderKey(evalRes.model.providerId).encoded !== route.encoded) {
        const msg = `Session ${started.taskId} recorded providerId "${evalRes.model.providerId}" instead of "${route.decoded}"`;
        const rec = {
          itemId: normItem.itemId,
          itemKey: normItem.itemKey,
          attempt,
          taskId: started.taskId,
          structuredStatus: 'task_not_completed',
          failureKind: 'provider_route_mismatch',
          error: msg,
          model: evalRes.model,
          usage: evalRes.usage ?? null,
          elapsedMs: Date.now() - t0,
          at: new Date().toISOString(),
        };
        appendFileSync(resultsPath, JSON.stringify(rec) + '\n', 'utf8');
        latestByKey.set(normItem.itemKey, rec);
        stopWithBlocker('provider_route_mismatch', msg, { itemId: normItem.itemId, taskId: started.taskId });
        return;
      }

      const rec = {
        itemId: normItem.itemId,
        itemKey: normItem.itemKey,
        attempt,
        taskId: started.taskId,
        structuredStatus: evalRes.structuredStatus,
        failureKind: evalRes.failureKind ?? null,
        errors: evalRes.errors ?? undefined,
        value: evalRes.value ?? undefined,
        model: evalRes.model ?? null,
        usage: evalRes.usage ?? null,
        elapsedMs: Date.now() - t0,
        at: new Date().toISOString(),
      };
      appendFileSync(resultsPath, JSON.stringify(rec) + '\n', 'utf8');
      latestByKey.set(normItem.itemKey, rec);
      trackTaskUsage(started.taskId, evalRes.usage);
      writeProgress('running');

      if (evalRes.failureKind === 'quota_or_rate_limit') {
        stopWithBlocker('quota_or_rate_limit', `Task ${started.taskId} hit quota or rate limit`, {
          itemId: normItem.itemId,
          taskId: started.taskId,
          error: evalRes.error ?? null,
        });
        return;
      }

      if (checkCreditBudget(normItem.itemId, started.taskId)) return;

      if (evalRes.structuredStatus === 'valid') return;
      if (evalRes.structuredStatus === 'invalid' && attempt <= maxRetries) {
        lastErrors = evalRes.errors ?? ['invalid structured output'];
        continue;
      }
      return;
    }
  }

  async function processMicrobatchChunk(chunkItems) {
    if (chunkItems.length === 1) {
      await processSingleItem(chunkItems[0]);
      return;
    }

    let remaining = [...chunkItems];
    let lastBatchErrors = [];

    for (let attempt = 1; attempt <= maxRetries + 1 && remaining.length > 0; attempt++) {
      if (blockedReason) return;
      if (remaining.length === 1 && attempt > 1) {
        // Only 1 item failed in the microbatch -> retry it directly as a single item!
        await processSingleItem({ ...remaining[0], startAttempt: attempt, lastErrors: lastBatchErrors });
        return;
      }

      const mbSchema = buildMicrobatchSchema(schema, remaining.length);
      const mbInput = {
        items: remaining.map(it => ({ itemId: it.itemId, data: it.input })),
      };
      const mbTask = [
        task,
        `MICROBATCH CONTRACT: Process all ${remaining.length} items in input.items.`,
        `Return {"results": [{"itemId": string, "output": <item schema>}]} with exactly one result entry per input itemId in the same order.`,
        ...(attempt > 1 && lastBatchErrors.length
          ? [`IMPORTANT RETRY FIX: Previous attempt had errors (${lastBatchErrors.slice(0, 3).join('; ')}). Fix them strictly.`]
          : []),
      ].join('\n');

      const t0 = Date.now();
      let started;
      try {
        started = await submitWithCapacityWait(buildRunPayload({
          task: mbTask,
          input: mbInput,
          schema: mbSchema,
        }));
      } catch (err) {
        if (err?.abortedByBlocker) return;
        const msg = String(err?.message ?? err);
        const isCapacityExhausted = Boolean(err?.capacityExhausted);
        const isAuthOrBlocker = !isCapacityExhausted && /login|expired|sign in|dialog|switch to model|provider|quota|rate.limit|429|credit|insufficient|额度|限流|auth/i.test(msg);
        const failureKind = isCapacityExhausted ? 'capacity_exhausted' : isAuthOrBlocker ? 'circuit_breaker' : 'submission_error';
        for (const it of remaining) {
          const rec = {
            itemId: it.itemId,
            itemKey: it.itemKey,
            attempt,
            taskId: null,
            structuredStatus: 'task_not_completed',
            failureKind,
            error: msg,
            elapsedMs: Date.now() - t0,
            at: new Date().toISOString(),
          };
          appendFileSync(resultsPath, JSON.stringify(rec) + '\n', 'utf8');
          latestByKey.set(it.itemKey, rec);
        }
        if (isCapacityExhausted) {
          stopWithBlocker('capacity_exhausted', msg, { itemId: remaining[0].itemId, attempt });
        } else if (isAuthOrBlocker) {
          stopWithBlocker('submission_circuit_breaker', msg, { itemId: remaining[0].itemId, attempt });
        }
        return;
      }

      if (started.warning && /running this session on provider/i.test(started.warning)) {
        await Promise.resolve(effectiveCanceller?.(started.taskId)).catch(() => {});
        for (const it of remaining) {
          const rec = {
            itemId: it.itemId,
            itemKey: it.itemKey,
            attempt,
            taskId: started.taskId,
            structuredStatus: 'task_not_completed',
            failureKind: 'provider_route_mismatch',
            error: started.warning,
            elapsedMs: Date.now() - t0,
            at: new Date().toISOString(),
          };
          appendFileSync(resultsPath, JSON.stringify(rec) + '\n', 'utf8');
          latestByKey.set(it.itemKey, rec);
        }
        stopWithBlocker('provider_route_mismatch', started.warning, { itemId: remaining[0].itemId, taskId: started.taskId });
        return;
      }

      let waitMs = effectivePollMs;
      let evalRes = null;
      while (Date.now() - t0 < itemTimeoutMs) {
        await sleeper(waitMs);
        evalRes = await evalFn(started.taskId, mbInput, attempt, mbSchema, null);
        if (evalRes.structuredStatus !== 'pending') break;
        waitMs = Math.min(maxPollIntervalMs, Math.round(waitMs * 1.25));
      }

      const elapsedMs = Date.now() - t0;
      if (!evalRes || evalRes.structuredStatus === 'pending') {
        await Promise.resolve(effectiveCanceller?.(started.taskId)).catch(() => {});
        for (const it of remaining) {
          const rec = {
            itemId: it.itemId,
            itemKey: it.itemKey,
            attempt,
            taskId: started.taskId,
            structuredStatus: 'task_not_completed',
            failureKind: 'timeout',
            elapsedMs,
            at: new Date().toISOString(),
          };
          appendFileSync(resultsPath, JSON.stringify(rec) + '\n', 'utf8');
          latestByKey.set(it.itemKey, rec);
        }
        if (attempt <= maxRetries && !blockedReason) {
          lastBatchErrors = ['previous microbatch attempt timed out'];
          continue;
        }
        return;
      }

      if (route && evalRes.model?.providerId && normalizeProviderKey(evalRes.model.providerId).encoded !== route.encoded) {
        const msg = `Session ${started.taskId} recorded providerId "${evalRes.model.providerId}" instead of "${route.decoded}"`;
        for (const it of remaining) {
          const rec = {
            itemId: it.itemId,
            itemKey: it.itemKey,
            attempt,
            taskId: started.taskId,
            structuredStatus: 'task_not_completed',
            failureKind: 'provider_route_mismatch',
            error: msg,
            model: evalRes.model,
            usage: evalRes.usage ?? null,
            elapsedMs,
            at: new Date().toISOString(),
          };
          appendFileSync(resultsPath, JSON.stringify(rec) + '\n', 'utf8');
          latestByKey.set(it.itemKey, rec);
        }
        stopWithBlocker('provider_route_mismatch', msg, { itemId: remaining[0].itemId, taskId: started.taskId });
        return;
      }

      if (evalRes.failureKind === 'quota_or_rate_limit') {
        for (const it of remaining) {
          const rec = {
            itemId: it.itemId,
            itemKey: it.itemKey,
            attempt,
            taskId: started.taskId,
            structuredStatus: 'task_not_completed',
            failureKind: 'quota_or_rate_limit',
            elapsedMs,
            at: new Date().toISOString(),
          };
          appendFileSync(resultsPath, JSON.stringify(rec) + '\n', 'utf8');
          latestByKey.set(it.itemKey, rec);
        }
        stopWithBlocker('quota_or_rate_limit', `Task ${started.taskId} hit quota or rate limit`, {
          itemId: remaining[0].itemId,
          taskId: started.taskId,
          error: evalRes.error ?? null,
        });
        return;
      }

      // Unpack per-item results and perform per-item schema + domainRule validation (partial-batch recovery!)
      const rawResults = Array.isArray(evalRes.value?.results) ? evalRes.value.results : [];
      const byItemId = new Map();
      for (const entry of rawResults) {
        if (entry && typeof entry.itemId === 'string' && !byItemId.has(entry.itemId)) {
          byItemId.set(entry.itemId, entry.output);
        }
      }

      const nextRemaining = [];
      lastBatchErrors = [];

      for (const it of remaining) {
        const itemOutput = byItemId.get(it.itemId);
        let itemErrors = [];
        if (itemOutput === undefined) {
          itemErrors = evalRes.errors?.length
            ? evalRes.errors
            : [`missing itemId "${it.itemId}" in microbatch results`];
        } else {
          itemErrors = [...validateValue(schema, itemOutput)];
          if (!itemErrors.length && domainRule) {
            itemErrors.push(...validateDomainRule(domainRule, itemOutput, it.input));
          }
        }

        const isValid = itemErrors.length === 0;
        const rec = {
          itemId: it.itemId,
          itemKey: it.itemKey,
          attempt,
          taskId: started.taskId,
          structuredStatus: isValid ? 'valid' : evalRes.structuredStatus === 'task_not_completed' ? 'task_not_completed' : 'invalid',
          failureKind: evalRes.failureKind ?? null,
          ...(isValid ? { value: itemOutput } : { errors: itemErrors }),
          model: evalRes.model ?? null,
          usage: evalRes.usage ?? null,
          elapsedMs,
          at: new Date().toISOString(),
        };
        appendFileSync(resultsPath, JSON.stringify(rec) + '\n', 'utf8');
        latestByKey.set(it.itemKey, rec);

        if (!isValid && rec.structuredStatus === 'invalid') {
          nextRemaining.push(it);
          lastBatchErrors.push(`${it.itemId}: ${itemErrors[0]}`);
        }
      }

      trackTaskUsage(started.taskId, evalRes.usage);
      writeProgress('running');
      if (checkCreditBudget(remaining[0]?.itemId ?? null, started.taskId)) return;

      remaining = nextRemaining;
      if (remaining.length === 0 || attempt > maxRetries) break;
    }
  }

  if (pendingItems.length > 0) {
    checkCreditBudget(pendingItems[0]?.itemId ?? null, null);
  }
  if (!blockedReason) writeProgress('running');

  async function workerLoop() {
    while (!blockedReason) {
      const idx = cursor++;
      if (idx >= chunks.length) break;
      if (checkCreditBudget(chunks[idx]?.[0]?.itemId ?? null, null)) break;
      inFlight++;
      try {
        await processMicrobatchChunk(chunks[idx]);
      } finally {
        inFlight = Math.max(0, inFlight - 1);
      }
    }
  }

  const workers = Array.from({ length: Math.min(effectiveConcurrency, Math.max(1, chunks.length)) }, () => workerLoop());
  await Promise.all(workers);

  const cpuDelta = process.cpuUsage(cpuStart);
  const wallMs = Date.now() - wallStart;
  const mem = process.memoryUsage();
  const finalState = blockedReason ? 'blocked' : 'completed';
  writeProgress(finalState);
  const statusReport = readBatchStatus(batchId, { stateDir, includeItems: true });
  if (!blockedReason && statusReport.counts.pending > 0) {
    writeProgress('incomplete');
  }
  const summary = {
    ...statusReport,
    backend: resolvedBackend,
    microbatchSize,
    effectiveConcurrency,
    reserveSlots,
    ...(maxCredit != null ? { maxCredit } : {}),
    metrics: {
      wallMs,
      cpuUserMs: Number((cpuDelta.user / 1000).toFixed(2)),
      cpuSystemMs: Number((cpuDelta.system / 1000).toFixed(2)),
      cpuTotalMs: Number(((cpuDelta.user + cpuDelta.system) / 1000).toFixed(2)),
      rssMiB: Number((mem.rss / (1024 * 1024)).toFixed(2)),
      heapUsedMiB: Number((mem.heapUsed / (1024 * 1024)).toFixed(2)),
    },
    updatedAt: new Date().toISOString(),
  };
  writeJsonFileAtomic(summaryPath, summary);
  return includeItems === false ? { ...summary, items: undefined } : summary;
}
