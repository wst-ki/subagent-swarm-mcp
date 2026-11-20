// Real-world E2E battle test for subagent-swarm-mcp's Qoder CLI (`qodercli`) backend.
// Exercises four end-to-end scenarios over real MCP stdio using DeepSeek-Flash (override via QD_MODEL):
//   1. `readonly` codebase inspection + `swarm_followup` (`-r` UUID multi-turn session memory)
//   2. `workspace` autonomous bug diagnosis, file edit, and `node --test` verification
//   3. `lite` `swarm_batch_run` auto-microbatching (`microbatchSize: 3`, `maxConcurrency: 2`)
//   4. `swarm_cancel` live `-pgid` termination on a blocking command + `swarm_quota`
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { qoderSessionFile } from "../src/backends/qoder.mjs";
import { withClient, parse } from "./client.mjs";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(THIS_DIR, "..");
const MODEL = process.env.QD_MODEL ?? "DeepSeek-Flash";

const call = async (c, name, args = {}) => {
  const res = parse(await c.callTool({ name, arguments: args }));
  if (res?.error && typeof res.error === "string" && !res.status) {
    throw new Error(`${name} failed: ${res.error}`);
  }
  return res;
};

const sha256File = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

async function pollUntilDone(c, taskId, label, { maxWaitMs = 90_000, intervalMs = 1000 } = {}) {
  const t0 = Date.now();
  const seen = new Set();
  for (;;) {
    const st = await call(c, "swarm_status", { taskId });
    const sig = `${st.status}|${st.currentTool ?? "-"}|${st.toolCalls ?? 0}`;
    if (!seen.has(sig)) {
      seen.add(sig);
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      console.error(`[${label}] +${dt}s status=${st.status} tool=${st.currentTool ?? "-"} calls=${st.toolCalls ?? 0}`);
    }
    if (st.status !== "running" && st.status !== "starting") {
      return await call(c, "swarm_result", { taskId });
    }
    if (Date.now() - t0 > maxWaitMs) {
      throw new Error(`[${label}] timed out waiting for ${taskId}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function setupBuggySandbox(dir) {
  const libFile = join(dir, "lru-ttl.mjs");
  const testFile = join(dir, "lru-ttl.test.mjs");

  writeFileSync(
    libFile,
    `// Deliberately buggy LRU + TTL cache for E2E workspace bugfix test.
export class LruTtlCache {
  constructor(maxSize, ttlMs, nowFn = () => Date.now()) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.nowFn = nowFn;
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    const now = this.nowFn();
    if (now > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value) {
    const now = this.nowFn();
    if (this.map.size >= this.maxSize) {
      const oldestKey = this.map.keys().next().value;
      this.map.delete(oldestKey);
    }
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: now + this.ttlMs });
  }
}
`,
    "utf8",
  );

  writeFileSync(
    testFile,
    `import test from "node:test";
import assert from "node:assert/strict";
import { LruTtlCache } from "./lru-ttl.mjs";

test("basic set/get and missing key", () => {
  const c = new LruTtlCache(2, 100, () => 0);
  c.set("a", 1);
  assert.equal(c.get("a"), 1);
  assert.equal(c.get("missing"), undefined);
});

test("boundary expiry treats now === expiresAt as expired", () => {
  let t = 1000;
  const c = new LruTtlCache(2, 50, () => t);
  c.set("a", 1);
  t = 1049;
  assert.equal(c.get("a"), 1);
  t = 1050;
  assert.equal(c.get("a"), undefined);
});

test("get refreshes LRU recency so recently read key survives eviction", () => {
  const c = new LruTtlCache(2, 1000, () => 0);
  c.set("a", 1);
  c.set("b", 2);
  assert.equal(c.get("a"), 1);
  c.set("c", 3);
  assert.equal(c.get("a"), 1);
  assert.equal(c.get("b"), undefined);
  assert.equal(c.get("c"), 3);
});

test("updating an existing key at full capacity does not evict another live key", () => {
  const c = new LruTtlCache(2, 1000, () => 0);
  c.set("a", 1);
  c.set("b", 2);
  c.set("a", 10);
  assert.equal(c.get("a"), 10);
  assert.equal(c.get("b"), 2);
});

test("purges expired entries before evicting still-valid entries when inserting at capacity", () => {
  let t = 0;
  const c = new LruTtlCache(2, 50, () => t);
  c.set("old", 1);
  t = 30;
  c.set("live", 2);
  t = 60;
  c.set("fresh", 3);
  assert.equal(c.get("live"), 2);
  assert.equal(c.get("fresh"), 3);
  assert.equal(c.get("old"), undefined);
});
`,
    "utf8",
  );

  return { libFile, testFile };
}

const tmpStateDir = mkdtempSync(join(tmpdir(), "qd-battle-state-"));
const sandboxDir = mkdtempSync(join(tmpdir(), "qd-battle-work-"));
process.env.ZCODE_MCP_STATE_DIR = tmpStateDir;

const sessionFilesToClean = [];
const report = { model: MODEL, scenarios: {} };

try {
  const { testFile } = setupBuggySandbox(sandboxDir);
  const testHashBefore = sha256File(testFile);

  let initialFailed = false;
  try {
    execFileSync(process.execPath, ["--test", "lru-ttl.test.mjs"], { cwd: sandboxDir, stdio: "pipe" });
  } catch {
    initialFailed = true;
  }
  assert.equal(initialFailed, true, "Expected buggy LruTtlCache sandbox tests to fail before Qoder fix");

  await withClient(async (c) => {
    const backendsInfo = await call(c, "swarm_backends", {});
    assert.equal(backendsInfo.backends?.qoder?.ok, true, `Qoder backend not healthy: ${JSON.stringify(backendsInfo)}`);
    report.qoderHealth = backendsInfo.backends.qoder;

    // ---------------------------------------------------------
    // Scenario 1: readonly audit + -r multi-turn followUp
    // ---------------------------------------------------------
    const tS1 = Date.now();
    const s1Start = await call(c, "swarm_run", {
      backend: "qoder",
      profile: "readonly",
      model: MODEL,
      cwd: REPO_ROOT,
      ephemeral: false,
      waitSec: 0,
      prompt:
        "Use Read or Grep (no edits) on src/backends/qoder.mjs and src/backends/registry.mjs. " +
        "Report in <= 120 words: (1) how Qoder UUID session IDs map to `qd_*` taskIds, and (2) 1 concrete edge case to watch in multi-backend auto routing.",
    });
    assert.match(s1Start.taskId, /^qd_/);
    sessionFilesToClean.push(qoderSessionFile(s1Start.taskId.slice(3), REPO_ROOT));

    const s1Turn1 = await pollUntilDone(c, s1Start.taskId, "S1-turn1");
    assert.equal(s1Turn1.status, "completed", `Scenario 1 turn 1 failed: ${JSON.stringify(s1Turn1)}`);
    assert.ok(s1Turn1.result?.trim().length > 20);

    const s1FuStart = await call(c, "swarm_followup", {
      taskId: s1Start.taskId,
      model: MODEL,
      prompt:
        "In 2-3 bullet points (no file reads needed), list concrete mitigation steps for the edge case you just described above.",
    });
    assert.equal(s1FuStart.accepted, true);

    const s1Turn2 = await pollUntilDone(c, s1Start.taskId, "S1-turn2");
    assert.equal(s1Turn2.status, "completed", `Scenario 1 turn 2 failed: ${JSON.stringify(s1Turn2)}`);
    assert.equal(s1Turn2.earlierMessages?.length, 1);
    assert.ok((s1Turn2.usage?.modelRequests ?? 0) >= 2);
    report.scenarios.readonlyAndFollowup = {
      taskId: s1Start.taskId,
      elapsedMs: Date.now() - tS1,
      turn1Preview: s1Turn1.result.slice(0, 280),
      turn2Preview: s1Turn2.result.slice(0, 240),
      usage: s1Turn2.usage,
    };

    // ---------------------------------------------------------
    // Scenario 2: workspace autonomous bugfix & verification
    // ---------------------------------------------------------
    const tS2 = Date.now();
    const s2Start = await call(c, "swarm_run", {
      backend: "qoder",
      profile: "workspace",
      model: MODEL,
      cwd: sandboxDir,
      ephemeral: true,
      waitSec: 0,
      prompt:
        "Inspect lru-ttl.mjs and lru-ttl.test.mjs in the current working directory. " +
        "Run `node --test lru-ttl.test.mjs`, fix all bugs inside lru-ttl.mjs WITHOUT modifying lru-ttl.test.mjs, " +
        "and re-run `node --test lru-ttl.test.mjs` until all 5 tests pass. Reply with a 1-sentence summary.",
    });
    const s2Res = await pollUntilDone(c, s2Start.taskId, "S2-workspace");
    assert.equal(s2Res.status, "completed", `Scenario 2 failed: ${JSON.stringify(s2Res)}`);
    assert.equal(sha256File(testFile), testHashBefore, "lru-ttl.test.mjs must not be modified by subagent");

    execFileSync(process.execPath, ["--test", "lru-ttl.test.mjs"], { cwd: sandboxDir, stdio: "pipe" });
    report.scenarios.workspaceBugfix = {
      taskId: s2Start.taskId,
      elapsedMs: Date.now() - tS2,
      testsPassAfterFix: true,
      usage: s2Res.usage,
      summary: s2Res.result?.slice(0, 200),
    };

    // ---------------------------------------------------------
    // Scenario 3: lite structured microbatching
    // ---------------------------------------------------------
    const tS3 = Date.now();
    const batchId = "battle-qd-batch";
    const batchSummary = await call(c, "swarm_batch_run", {
      batchId,
      backend: "qoder",
      profile: "lite",
      model: MODEL,
      ephemeral: true,
      microbatchSize: 3,
      maxConcurrency: 2,
      maxRetries: 1,
      pollIntervalMs: 500,
      task: "Classify each JS module metadata entry into one category, whether it mutates disk/UI state, and a concise 10-120 char summary.",
      schema: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1 },
          category: {
            type: "string",
            enum: ["transport", "concurrency", "storage", "validation", "orchestration", "backend"],
          },
          mutatesState: { type: "boolean" },
          summary: { type: "string", minLength: 10, maxLength: 120 },
        },
        required: ["id", "category", "mutatesState", "summary"],
        additionalProperties: false,
      },
      items: [
        { itemId: "cdp", input: { id: "cdp", file: "src/cdp.mjs", role: "WebSocket CDP client and UI click helpers" } },
        { itemId: "lock", input: { id: "lock", file: "src/lock.mjs", role: "Atomic mkdir mutex on disk with owner PID checks" } },
        { itemId: "store", input: { id: "store", file: "src/store.mjs", role: "Read-only SQLite + JSONL tailer for session status" } },
        { itemId: "structured", input: { id: "structured", file: "src/structured.mjs", role: "Bounded JSON Schema validator and domain rule engine" } },
        { itemId: "batch", input: { id: "batch", file: "src/batch.mjs", role: "Checkpointed JSONL batch scheduler with microbatch recovery" } },
        { itemId: "qoder", input: { id: "qoder", file: "src/backends/qoder.mjs", role: "Detached Qoder CLI adapter and UUID session mapper" } },
      ],
    });
    const batchRead = await call(c, "swarm_batch_status", { batchId });
    assert.equal(batchSummary.status, "completed", `Batch failed: ${JSON.stringify(batchSummary)}`);
    assert.equal(batchSummary.counts?.valid, 6);
    assert.equal(batchSummary.usage?.modelRequests, 2);
    assert.equal(batchRead.counts?.valid, 6);
    report.scenarios.liteMicrobatch = {
      batchId,
      elapsedMs: Date.now() - tS3,
      counts: batchSummary.counts,
      usage: batchSummary.usage,
      categories: batchSummary.items.map((it) => `${it.itemId}:${it.value?.category}(${it.value?.mutatesState})`),
    };

    // ---------------------------------------------------------
    // Scenario 4: live swarm_cancel (-pgid termination) + swarm_quota
    // ---------------------------------------------------------
    const tS4 = Date.now();
    const s4Start = await call(c, "swarm_run", {
      backend: "qoder",
      profile: "workspace",
      model: MODEL,
      cwd: sandboxDir,
      ephemeral: true,
      waitSec: 0,
      prompt: "Immediately run this exact bash command: `sleep 25 && echo SHOULD_NOT_FINISH`",
    });

    let cancelTrigger = "timeout-poll";
    const pollStart = Date.now();
    while (Date.now() - pollStart < 15_000) {
      const st = await call(c, "swarm_status", { taskId: s4Start.taskId });
      if (st.status === "running" && (st.currentTool || Date.now() - pollStart > 3500)) {
        cancelTrigger = `status=${st.status},tool=${st.currentTool ?? "none"}`;
        break;
      }
      if (st.status !== "running" && st.status !== "starting") {
        cancelTrigger = `already-${st.status}`;
        break;
      }
      await new Promise((r) => setTimeout(r, 400));
    }

    const cancelled = await call(c, "swarm_cancel", { taskId: s4Start.taskId });
    assert.equal(cancelled.cancelled, true, `Expected cancelled=true, got ${JSON.stringify(cancelled)}`);
    assert.equal(cancelled.status, "cancelled");
    const afterCancel = await call(c, "swarm_result", { taskId: s4Start.taskId });
    assert.equal(afterCancel.status, "cancelled");
    report.scenarios.liveCancel = {
      taskId: s4Start.taskId,
      trigger: cancelTrigger,
      elapsedMs: Date.now() - tS4,
      status: afterCancel.status,
    };

    report.qoderQuota = (await call(c, "swarm_quota", { backend: "qoder" })).qoder;
  });

  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const f of sessionFilesToClean) {
    rmSync(f, { force: true });
    if (f.endsWith(".jsonl")) rmSync(f.slice(0, -6), { recursive: true, force: true });
  }
  rmSync(tmpStateDir, { recursive: true, force: true });
  rmSync(sandboxDir, { recursive: true, force: true });
}
