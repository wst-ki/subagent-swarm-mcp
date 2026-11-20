import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeBatchItemKey, readBatchStatus, runStructuredBatch } from '../src/batch.mjs';
import { SECTION_OUTLINE_SCHEMA } from '../src/structured.mjs';
import { isStale } from '../src/lock.mjs';

test('isStale keeps lock alive when owner PID is alive even after 120s', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'zcode-lock-test-'));
  try {
    const lockDir = join(tmp, 'ui.lock');
    mkdirSync(lockDir);
    // Live PID (process.pid) held for 300s -> must NOT be stale
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, at: Date.now() - 300_000 }));
    assert.equal(isStale(lockDir), false);

    // Dead PID -> must be stale immediately
    writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: 99999999, at: Date.now() }));
    assert.equal(isStale(lockDir), true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('computeBatchItemKey is deterministic across key ordering', () => {
  const k1 = computeBatchItemKey({
    templateId: 't1',
    itemId: 'doc-1',
    input: { b: 2, a: 1 },
    schema: SECTION_OUTLINE_SCHEMA,
    domainRule: 'section-outline-v1',
  });
  const k2 = computeBatchItemKey({
    templateId: 't1',
    itemId: 'doc-1',
    input: { a: 1, b: 2 },
    schema: SECTION_OUTLINE_SCHEMA,
    domainRule: 'section-outline-v1',
  });
  assert.equal(k1, k2);
});

test('batch runner supports bounded retry on invalid output, idempotent resume, and circuit breaker on quota/route error', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'zcode-batch-test-'));
  try {
    let calls = [];
    const runner = async ({ task, input }) => {
      const n = calls.length + 1;
      calls.push({ task, input });
      return { taskId: `session_mock_${n}` };
    };
    const evaluator = async (taskId, input, attempt) => {
      if (input.doc === 'p1' && attempt === 1) {
        return {
          taskId,
          status: 'completed',
          structuredStatus: 'invalid',
          errors: ['$.labels: missing expected heading id 1'],
          usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, toolCalls: 0, modelRequests: 1 },
        };
      }
      return {
        taskId,
        status: 'completed',
        structuredStatus: 'valid',
        value: { labels: [{ i: 1, level: 1, role: 'title', conf: 1 }] },
        model: { providerId: 'account:bigmodel-individual-coding-plan', modelId: 'GLM-5.3-Flash' },
        usage: { inputTokens: 100, outputTokens: 30, cacheReadInputTokens: 50, totalTokens: 130, toolCalls: 0, modelRequests: 1 },
      };
    };

    const items = [
      { itemId: 'p1', input: { doc: 'p1', expected: [1] } },
      { itemId: 'p2', input: { doc: 'p2', expected: [1] } },
    ];

    const res1 = await runStructuredBatch({
      batchId: 'batch-unit-1',
      task: 'Classify headings',
      schema: SECTION_OUTLINE_SCHEMA,
      domainRule: 'section-outline-v1',
      items,
      maxRetries: 1,
      stateDir,
      runner,
      evaluator,
      sleeper: async () => {},
    });

    assert.equal(res1.status, 'completed');
    assert.equal(res1.counts.valid, 2);
    assert.equal(res1.counts.retried, 1);
    assert.equal(calls.length, 3); // p1 (attempt 1 + retry 2) + p2 (attempt 1)

    // Re-running the same batch must be a no-op (idempotent resume skips valid items)
    const res2 = await runStructuredBatch({
      batchId: 'batch-unit-1',
      task: 'Classify headings',
      schema: SECTION_OUTLINE_SCHEMA,
      domainRule: 'section-outline-v1',
      items,
      maxRetries: 1,
      stateDir,
      runner,
      evaluator,
      sleeper: async () => {},
    });
    assert.equal(res2.counts.valid, 2);
    assert.equal(calls.length, 3); // no new calls!

    // Circuit breaker test on quota_or_rate_limit
    let quotaCalls = 0;
    const resBlocked = await runStructuredBatch({
      batchId: 'batch-quota-stop',
      task: 'Classify headings',
      schema: SECTION_OUTLINE_SCHEMA,
      items: [
        { itemId: 'q1', input: { expected: [1] } },
        { itemId: 'q2', input: { expected: [1] } },
      ],
      maxConcurrency: 1,
      stateDir,
      runner: async () => ({ taskId: `session_q_${++quotaCalls}` }),
      evaluator: async (taskId) => ({
        taskId,
        status: 'failed',
        structuredStatus: 'task_not_completed',
        failureKind: 'quota_or_rate_limit',
        error: { code: '429' },
      }),
      sleeper: async () => {},
    });
    assert.equal(resBlocked.status, 'blocked');
    assert.equal(resBlocked.blocked.code, 'quota_or_rate_limit');
    assert.equal(quotaCalls, 1); // Stopped immediately before q2!

    const statusCheck = readBatchStatus('batch-quota-stop', { stateDir });
    assert.equal(statusCheck.status, 'blocked');
    assert.equal(statusCheck.counts.pending, 1);

    // Resuming after quota recovery must re-run both the quota_or_rate_limit item (q1) and pending item (q2)
    let resumeCalls = 0;
    const resResumed = await runStructuredBatch({
      batchId: 'batch-quota-stop',
      task: 'Classify headings',
      schema: SECTION_OUTLINE_SCHEMA,
      items: [
        { itemId: 'q1', input: { expected: [1] } },
        { itemId: 'q2', input: { expected: [1] } },
      ],
      maxConcurrency: 1,
      stateDir,
      runner: async () => ({ taskId: `session_q_resumed_${++resumeCalls}` }),
      evaluator: async (taskId) => ({
        taskId,
        status: 'completed',
        structuredStatus: 'valid',
        value: { labels: [{ i: 1, level: 1, role: 'title', conf: 1 }] },
        model: { providerId: 'account:bigmodel-individual-coding-plan', modelId: 'GLM-5.3-Flash' },
        usage: { inputTokens: 100, outputTokens: 30, totalTokens: 130, toolCalls: 0, modelRequests: 1 },
      }),
      sleeper: async () => {},
    });
    assert.equal(resResumed.status, 'completed');
    assert.equal(resResumed.counts.valid, 2);
    assert.equal(resumeCalls, 2);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('auto-microbatching packs items, deduplicates task usage, and performs partial-batch recovery on retry', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'zcode-microbatch-test-'));
  try {
    const calls = [];
    const runner = async ({ task, input, schema }) => {
      const n = calls.length + 1;
      calls.push({ task, input, schema });
      return { taskId: `session_mb_${n}` };
    };

    const declarativeRule = {
      arrayField: 'labels',
      matchInputIds: { inputField: 'expected', outputKey: 'i' },
      noLevelJump: 'level',
      fieldConstraints: [{ ifField: 'role', ifEquals: 'title', thenField: 'level', thenEquals: 1 }],
    };

    // First call is a 3-item microbatch: p1 and p2 succeed, p3 has a level jump (1 -> 3).
    // Second call (retry) must ONLY contain p3 (as a single item!) and succeed.
    const evaluator = async (taskId, callInput, attempt) => {
      if (attempt === 1) {
        return {
          taskId,
          status: 'completed',
          structuredStatus: 'valid',
          value: {
            results: [
              { itemId: 'p1', output: { labels: [{ i: 1, level: 1, role: 'title', conf: 1 }] } },
              { itemId: 'p2', output: { labels: [{ i: 1, level: 1, role: 'title', conf: 1 }, { i: 2, level: 1, role: 'references', conf: 0.9 }] } },
              { itemId: 'p3', output: { labels: [{ i: 1, level: 1, role: 'title', conf: 1 }, { i: 2, level: 3, role: 'methods', conf: 0.9 }] } },
            ],
          },
          model: { providerId: 'account:bigmodel-individual-coding-plan', modelId: 'GLM-5.3-Flash' },
          usage: { inputTokens: 32000, outputTokens: 1500, cacheReadInputTokens: 18000, totalTokens: 33500, toolCalls: 0, modelRequests: 1 },
        };
      }
      // Retry of p3 alone (single item schema!)
      return {
        taskId,
        status: 'completed',
        structuredStatus: 'valid',
        value: {
          labels: [{ i: 1, level: 1, role: 'title', conf: 1 }, { i: 2, level: 2, role: 'methods', conf: 0.95 }],
        },
        model: { providerId: 'account:bigmodel-individual-coding-plan', modelId: 'GLM-5.3-Flash' },
        usage: { inputTokens: 30000, outputTokens: 500, cacheReadInputTokens: 18000, totalTokens: 30500, toolCalls: 0, modelRequests: 1 },
      };
    };

    const items = [
      { itemId: 'p1', input: { expected: [1] } },
      { itemId: 'p2', input: { expected: [1, 2] } },
      { itemId: 'p3', input: { expected: [1, 2] } },
    ];

    const summary = await runStructuredBatch({
      batchId: 'mb-partial-recovery',
      templateId: 'declarative-test',
      task: 'Classify headings',
      schema: SECTION_OUTLINE_SCHEMA,
      domainRule: declarativeRule,
      items,
      microbatchSize: 3,
      maxRetries: 1,
      stateDir,
      runner,
      evaluator,
      sleeper: async () => {},
    });

    assert.equal(summary.status, 'completed');
    assert.equal(summary.counts.total, 3);
    assert.equal(summary.counts.valid, 3);
    assert.equal(summary.counts.retried, 1);
    assert.equal(calls.length, 2);
    // Call 1 was microbatch of 3 items
    assert.equal(calls[0].input.items.length, 3);
    // Call 2 was single-item retry of p3 only
    assert.deepEqual(calls[1].input, { expected: [1, 2] });
    // Usage deduplicated across p1 & p2 (shared session_mb_1) + p3 retry (session_mb_2)
    assert.equal(summary.usage.inputTokens, 32000 + 30000);
    assert.equal(summary.usage.modelRequests, 2);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
