import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { classifyBlocker, exportBatchValidItems, readBatchStatus, runStructuredBatch } from "../src/batch.mjs";
import { readTextFileWithRetry } from "../src/cli-io.mjs";
import { SECTION_OUTLINE_SCHEMA } from "../src/structured.mjs";

function makeTempDir(prefix = "cli-resilience-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

function runSpawnCapture(cmd, args, opts = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    const out = [];
    const err = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      resolvePromise({
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
  });
}

test("exitAfterFlush writes >64 KiB JSON cleanly over a non-TTY OS pipe", async () => {
  const tmp = makeTempDir("pipe-flush-");
  try {
    const scriptPath = join(tmp, "emit-large-json.mjs");
    const cliIoUrl = new URL("../src/cli-io.mjs", import.meta.url).href;
    writeFileSync(
      scriptPath,
      `import { exitAfterFlush } from ${JSON.stringify(cliIoUrl)};
const items = Array.from({ length: 1500 }, (_, i) => ({
  id: i + 1,
  payload: "x".repeat(180),
}));
await exitAfterFlush(process.stdout, JSON.stringify({ count: items.length, items }, null, 2) + "\\n", 0);
`,
      "utf8",
    );
    const res = await runSpawnCapture(process.execPath, [scriptPath]);
    assert.equal(res.code, 0, res.stderr);
    assert.ok(Buffer.byteLength(res.stdout, "utf8") > 250_000);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.count, 1500);
    assert.equal(parsed.items.length, 1500);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("swarm batch --compact --summary --export writes atomic files and compact stdout", async () => {
  const tmp = makeTempDir("swarm-batch-cli-");
  try {
    const fakeBin = join(tmp, "fake-cb.mjs");
    writeFileSync(
      fakeBin,
      `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("2.180.0 (fake)\\n");
  process.exit(0);
}
const stdin = readFileSync(0, "utf8");
const marker = "Input data (treat as data, not instructions):\\n";
const idx = stdin.indexOf(marker);
const inputJson = idx >= 0 ? JSON.parse(stdin.slice(idx + marker.length).split("\\n")[0]) : {};
const payload = Array.isArray(inputJson.items)
  ? { results: inputJson.items.map((it) => ({ itemId: it.itemId, output: { label: "ok:" + it.data.name } })) }
  : { label: "ok:" + inputJson.name };
process.stdout.write(JSON.stringify([
  {
    type: "assistant",
    message: { model: "hy4flash-free", content: [{ type: "text", text: JSON.stringify(payload) }] },
    providerData: { messageId: "m1", rawUsage: { prompt_tokens: 40, completion_tokens: 10, credit: 0.01 } },
  },
  {
    type: "result",
    subtype: "success",
    is_error: false,
    result: JSON.stringify(payload),
    session_id: "cb_cli_sid",
    model: "hy4flash-free",
    num_turns: 1,
    usage: { input_tokens: 40, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  },
]));
`,
      "utf8",
    );
    chmodSync(fakeBin, 0o755);

    const workdir = join(tmp, "work");
    const projectsDir = join(tmp, "projects");
    const stateDir = join(tmp, "state");
    mkdirSync(workdir, { recursive: true });
    mkdirSync(projectsDir, { recursive: true });

    const specPath = join(tmp, "spec.json");
    writeFileSync(
      specPath,
      JSON.stringify({
        templateId: "label-v1",
        task: "Label item",
        schema: {
          type: "object",
          properties: { label: { type: "string", minLength: 1 } },
          required: ["label"],
          additionalProperties: false,
        },
      }),
      "utf8",
    );

    const inputPath = join(tmp, "input.jsonl");
    writeFileSync(
      inputPath,
      [
        JSON.stringify({ id: "d1", name: "one" }),
        JSON.stringify({ id: "d2", name: "two" }),
        JSON.stringify({ id: "d3", name: "three" }),
      ].join("\n") + "\n",
      "utf8",
    );

    const exportPath = join(tmp, "out", "exported.json");
    const summaryPath = join(tmp, "out", "summary.json");
    const swarmBin = resolve("bin/swarm.mjs");
    const env = {
      ...process.env,
      CODEBUDDY_BIN: fakeBin,
      CODEBUDDY_PROJECTS_DIR: projectsDir,
      ZCODE_MCP_STATE_DIR: stateDir,
    };

    const res = await runSpawnCapture(
      process.execPath,
      [
        swarmBin,
        "batch",
        "--id",
        "cli-compact-1",
        "--spec",
        specPath,
        "--input",
        inputPath,
        "--backend",
        "codebuddy",
        "--cwd",
        workdir,
        "--ephemeral",
        "--microbatch",
        "2",
        "--concurrency",
        "2",
        "--state-dir",
        stateDir,
        "--export",
        exportPath,
        "--summary",
        summaryPath,
        "--compact",
      ],
      { env },
    );
    assert.equal(res.code, 0, res.stderr);
    assert.ok(res.stdout.length < 2048);

    const stdoutJson = JSON.parse(res.stdout);
    assert.equal(stdoutJson.status, "completed");
    assert.equal(stdoutJson.counts.valid, 3);
    assert.equal("items" in stdoutJson, false);
    assert.equal(stdoutJson.exportedCount, 3);
    assert.equal(stdoutJson.summaryPath, summaryPath);

    const fullSummary = JSON.parse(readFileSync(summaryPath, "utf8"));
    assert.equal(fullSummary.items.length, 3);
    const exported = JSON.parse(readFileSync(exportPath, "utf8"));
    assert.equal(exported.length, 3);

    const stRes = await runSpawnCapture(
      process.execPath,
      [swarmBin, "batch-status", "cli-compact-1", "--state-dir", stateDir, "--compact"],
      { env },
    );
    assert.equal(stRes.code, 0, stRes.stderr);
    const stJson = JSON.parse(stRes.stdout);
    assert.equal(stJson.counts.valid, 3);
    assert.equal("items" in stJson, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("batch waits through transient slot busy errors and trips capacity_exhausted cleanly on expiry", async () => {
  const stateDir = makeTempDir("cap-wait-");
  try {
    // Part A: Recovers cleanly after 2 transient capacity contention errors without wasting retry attempt
    let attempts = 0;
    const okSummary = await runStructuredBatch({
      batchId: "cap-recover",
      task: "Classify headings",
      schema: SECTION_OUTLINE_SCHEMA,
      domainRule: "section-outline-v1",
      items: [{ itemId: "p1", input: { expected: [1] } }],
      maxConcurrency: 1,
      maxRetries: 0,
      pollIntervalMs: 5,
      maxPollIntervalMs: 10,
      capacityWaitMs: 5_000,
      stateDir,
      runner: async () => {
        attempts++;
        if (attempts <= 2) {
          throw new Error("ZCode already has 3 running task(s) (limit 3). Wait for one to finish (zcode_wait) and retry.");
        }
        return { taskId: "session_cap_ok" };
      },
      evaluator: async (taskId) => ({
        taskId,
        status: "completed",
        structuredStatus: "valid",
        value: { labels: [{ i: 1, level: 1, role: "title", conf: 1 }] },
        model: { providerId: "account:bigmodel-individual-coding-plan", modelId: "GLM-5.3-Flash" },
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, toolCalls: 0, modelRequests: 1 },
      }),
      sleeper: async () => {},
    });
    assert.equal(okSummary.status, "completed");
    assert.equal(okSummary.counts.valid, 1);
    assert.equal(attempts, 3);

    // Part B: When capacityWaitMs expires (0ms), breaks circuit as capacity_exhausted leaving subsequent item pending
    let blockedCalls = 0;
    const blockedSummary = await runStructuredBatch({
      batchId: "cap-exhausted",
      task: "Classify headings",
      schema: SECTION_OUTLINE_SCHEMA,
      items: [
        { itemId: "c1", input: { expected: [1] } },
        { itemId: "c2", input: { expected: [1] } },
      ],
      maxConcurrency: 1,
      capacityWaitMs: 0,
      stateDir,
      runner: async () => {
        blockedCalls++;
        throw new Error("ZCode already has 3 running task(s) (limit 3).");
      },
      evaluator: async () => ({ status: "pending", structuredStatus: "pending" }),
      sleeper: async () => {},
    });
    assert.equal(blockedSummary.status, "blocked");
    assert.equal(blockedSummary.blocked.code, "capacity_exhausted");
    assert.equal(blockedCalls, 1);

    const status = readBatchStatus("cap-exhausted", { stateDir });
    assert.equal(status.counts.pending, 1);
    assert.equal(status.counts.failed, 1);
    assert.equal(status.items[0].failureKind, "capacity_exhausted");

    // Resume after slot frees up -> completes both c1 and c2
    let resumedCalls = 0;
    const resumedSummary = await runStructuredBatch({
      batchId: "cap-exhausted",
      task: "Classify headings",
      schema: SECTION_OUTLINE_SCHEMA,
      items: [
        { itemId: "c1", input: { expected: [1] } },
        { itemId: "c2", input: { expected: [1] } },
      ],
      maxConcurrency: 1,
      stateDir,
      runner: async () => ({ taskId: `session_cap_res_${++resumedCalls}` }),
      evaluator: async (taskId) => ({
        taskId,
        status: "completed",
        structuredStatus: "valid",
        value: { labels: [{ i: 1, level: 1, role: "title", conf: 1 }] },
        model: { providerId: "account:bigmodel-individual-coding-plan", modelId: "GLM-5.3-Flash" },
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, toolCalls: 0, modelRequests: 1 },
      }),
      sleeper: async () => {},
    });
    assert.equal(resumedSummary.status, "completed");
    assert.equal(resumedSummary.counts.valid, 2);
    assert.equal(resumedCalls, 2);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("batch cancels leaked taskId on item timeout and retries boundedly", async () => {
  const stateDir = makeTempDir("timeout-cancel-");
  try {
    const cancelled = [];
    let submitCount = 0;
    const res = await runStructuredBatch({
      batchId: "timeout-retry-1",
      task: "Classify headings",
      schema: SECTION_OUTLINE_SCHEMA,
      items: [{ itemId: "t1", input: { expected: [1] } }],
      maxConcurrency: 1,
      maxRetries: 1,
      pollIntervalMs: 8,
      maxPollIntervalMs: 8,
      itemTimeoutMs: 20,
      stateDir,
      runner: async () => ({ taskId: `session_to_${++submitCount}` }),
      canceller: async (taskId) => {
        cancelled.push(taskId);
      },
      evaluator: async (taskId, _input, attempt) => {
        if (attempt === 1) {
          return { taskId, status: "running", structuredStatus: "pending" };
        }
        return {
          taskId,
          status: "completed",
          structuredStatus: "valid",
          value: { labels: [{ i: 1, level: 1, role: "title", conf: 1 }] },
          model: { providerId: "account:bigmodel-individual-coding-plan", modelId: "GLM-5.3-Flash" },
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, toolCalls: 0, modelRequests: 1 },
        };
      },
    });
    assert.equal(res.status, "completed");
    assert.equal(res.counts.valid, 1);
    assert.equal(res.counts.retried, 1);
    assert.equal(submitCount, 2);
    assert.deepEqual(cancelled, ["session_to_1"]);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("readTextFileWithRetry recovers from transient SMB lookup blips and fails fast on EACCES", async () => {
  let calls = 0;
  const delays = [];
  const text = await readTextFileWithRetry("/fake/smb/doc.xml", {
    retries: 3,
    baseDelayMs: 50,
    readFn: () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("enoent"), { code: "ENOENT" });
      if (calls === 2) throw Object.assign(new Error("eagain"), { code: "EAGAIN" });
      return "ok-xml";
    },
    sleeper: async (ms) => {
      delays.push(ms);
    },
  });
  assert.equal(text, "ok-xml");
  assert.equal(calls, 3);
  assert.deepEqual(delays, [50, 100]);

  let permCalls = 0;
  await assert.rejects(
    () =>
      readTextFileWithRetry("/fake/smb/secret.xml", {
        retries: 3,
        readFn: () => {
          permCalls++;
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        },
        sleeper: async () => {
          throw new Error("should not sleep on non-transient error");
        },
      }),
    /denied/,
  );
  assert.equal(permCalls, 1);
});

test("batch enforces maxCredit circuit breaker with actionable blocker taxonomy and resumes cleanly", async () => {
  const stateDir = makeTempDir("credit-cap-");
  try {
    let calls = 0;
    const items = [
      { itemId: "b1", input: { expected: [1] } },
      { itemId: "b2", input: { expected: [1] } },
      { itemId: "b3", input: { expected: [1] } },
    ];
    const evalOk = async (taskId) => ({
      taskId,
      status: "completed",
      structuredStatus: "valid",
      value: { labels: [{ i: 1, level: 1, role: "title", conf: 1 }] },
      model: { providerId: "account:bigmodel-individual-coding-plan", modelId: "GLM-5.3-Flash" },
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, toolCalls: 0, modelRequests: 1, credit: 0.6 },
    });

    const stopped = await runStructuredBatch({
      batchId: "credit-budget-1",
      task: "Classify headings",
      schema: SECTION_OUTLINE_SCHEMA,
      items,
      maxConcurrency: 1,
      maxCredit: 1.0,
      stateDir,
      runner: async () => ({ taskId: `session_cb_${++calls}` }),
      evaluator: evalOk,
      sleeper: async () => {},
    });
    assert.equal(stopped.status, "blocked");
    assert.equal(stopped.blocked.code, "credit_budget_reached");
    assert.equal(stopped.blocked.retryable, false);
    assert.equal(stopped.blocked.recommendedAction, "increase_credit_budget");
    assert.equal(stopped.counts.valid, 2); // b1 (0.6) + b2 (1.2 >= 1.0) -> stops before b3
    assert.equal(stopped.counts.pending, 1);
    assert.equal(calls, 2);

    // Partial crash-safe export salvages the 2 valid items even while blocked!
    const partial = exportBatchValidItems("credit-budget-1", { stateDir });
    assert.equal(partial.exportedCount, 2);
    assert.deepEqual(partial.items.map((x) => x.itemId), ["b1", "b2"]);

    // Verify progress.json heartbeat exists and reports blocked state
    const st = readBatchStatus("credit-budget-1", { stateDir, includeItems: false });
    assert.equal(st.progress.state, "blocked");
    assert.equal(st.progress.valid, 2);
    assert.equal(st.progress.credit, 1.2);

    // Resume with raised budget -> only b3 runs!
    const resumed = await runStructuredBatch({
      batchId: "credit-budget-1",
      task: "Classify headings",
      schema: SECTION_OUTLINE_SCHEMA,
      items,
      maxConcurrency: 1,
      maxCredit: 2.5,
      stateDir,
      runner: async () => ({ taskId: `session_cb_${++calls}` }),
      evaluator: evalOk,
      sleeper: async () => {},
    });
    assert.equal(resumed.status, "completed");
    assert.equal(resumed.counts.valid, 3);
    assert.equal(calls, 3);
    assert.equal(resumed.progress.state, "completed");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("batch reserveSlots yields dynamically when other tasks occupy slots and classifyBlocker distinguishes actions", async () => {
  assert.deepEqual(classifyBlocker("quota_or_rate_limit"), { retryable: true, recommendedAction: "cooldown_quota" });
  assert.deepEqual(classifyBlocker("capacity_exhausted"), { retryable: true, recommendedAction: "wait_capacity" });
  assert.deepEqual(classifyBlocker("provider_route_mismatch"), { retryable: false, recommendedAction: "check_billing_route" });
  assert.deepEqual(classifyBlocker("submission_circuit_breaker", "login session expired"), {
    retryable: false,
    recommendedAction: "needs_human_auth",
  });
  assert.deepEqual(classifyBlocker("submission_circuit_breaker", "HTTP 429 rate limit"), {
    retryable: true,
    recommendedAction: "cooldown_quota",
  });

  const stateDir = makeTempDir("reserve-slots-");
  try {
    // Part A: Health shows 2/3 running while reserveSlots=1 (allowed=2) -> waits until 1/3, then runs!
    let healthChecks = 0;
    const res = await runStructuredBatch({
      batchId: "reserve-wait-ok",
      task: "Classify headings",
      schema: SECTION_OUTLINE_SCHEMA,
      items: [{ itemId: "r1", input: { expected: [1] } }],
      maxConcurrency: 3,
      reserveSlots: 1,
      capacityWaitMs: 5_000,
      pollIntervalMs: 5,
      stateDir,
      healthFn: async () => {
        healthChecks++;
        return { ok: true, runningTasks: healthChecks <= 2 ? 2 : 1, maxRunning: 3 };
      },
      runner: async () => ({ taskId: "session_res_ok" }),
      evaluator: async (taskId) => ({
        taskId,
        status: "completed",
        structuredStatus: "valid",
        value: { labels: [{ i: 1, level: 1, role: "title", conf: 1 }] },
        model: { providerId: "account:bigmodel-individual-coding-plan", modelId: "GLM-5.3-Flash" },
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, toolCalls: 0, modelRequests: 1 },
      }),
      sleeper: async () => {},
    });
    assert.equal(res.status, "completed");
    assert.equal(res.effectiveConcurrency, 2);
    assert.equal(res.reserveSlots, 1);
    assert.equal(healthChecks, 3);

    // Part B: With capacityWaitMs=0 and runningTasks >= limit - reserveSlots -> trips retryable capacity_exhausted
    const blocked = await runStructuredBatch({
      batchId: "reserve-exhaust",
      task: "Classify headings",
      schema: SECTION_OUTLINE_SCHEMA,
      items: [{ itemId: "r2", input: { expected: [1] } }],
      maxConcurrency: 2,
      reserveSlots: 1,
      capacityWaitMs: 0,
      stateDir,
      healthFn: async () => ({ ok: true, runningTasks: 2, maxRunning: 3 }),
      runner: async () => {
        throw new Error("should not have submitted while reserved slots are occupied");
      },
      evaluator: async () => ({ status: "pending", structuredStatus: "pending" }),
      sleeper: async () => {},
    });
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.blocked.code, "capacity_exhausted");
    assert.equal(blocked.blocked.retryable, true);
    assert.equal(blocked.blocked.recommendedAction, "wait_capacity");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("swarm batch-export CLI recovers valid items from results.jsonl into atomic JSON file", async () => {
  const tmp = makeTempDir("batch-export-cli-");
  try {
    const stateDir = join(tmp, "state");
    const batchDir = join(stateDir, "batches", "salvage-1");
    mkdirSync(batchDir, { recursive: true });
    writeFileSync(
      join(batchDir, "manifest.jsonl"),
      [
        JSON.stringify({ itemId: "d1", itemKey: "k1" }),
        JSON.stringify({ itemId: "d2", itemKey: "k2" }),
      ].join("\n") + "\n",
    );
    writeFileSync(
      join(batchDir, "results.jsonl"),
      [
        JSON.stringify({ itemId: "d1", itemKey: "k1", taskId: "cb_1", structuredStatus: "valid", value: { ok: true }, attempt: 1 }),
        JSON.stringify({ itemId: "d2", itemKey: "k2", taskId: "cb_2", structuredStatus: "task_not_completed", failureKind: "timeout", attempt: 1 }),
      ].join("\n") + "\n",
    );

    const outPath = join(tmp, "salvaged.json");
    const res = await runSpawnCapture(process.execPath, [
      resolve("bin/swarm.mjs"),
      "batch-export",
      "salvage-1",
      "--state-dir",
      stateDir,
      "--out",
      outPath,
      "--compact",
    ]);
    assert.equal(res.code, 0, res.stderr);
    const meta = JSON.parse(res.stdout);
    assert.equal(meta.exportedCount, 1);
    assert.equal(meta.exportedTo, outPath);
    assert.equal("items" in meta, false);
    const saved = JSON.parse(readFileSync(outPath, "utf8"));
    assert.equal(saved.length, 1);
    assert.equal(saved[0].itemId, "d1");
    assert.deepEqual(saved[0].value, { ok: true });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
