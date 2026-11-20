import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { readBatchStatus, runStructuredBatch } from "../src/batch.mjs";
import {
  backendForTaskId,
  listBackends,
  selectBackend,
  swarmList,
  swarmQuota,
  swarmRun,
} from "../src/backends/registry.mjs";
import { runStructured, structuredResult } from "../src/structured.mjs";

const execFileAsync = promisify(execFile);

function makeTempDir(prefix = "swarm-test-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeFakeBackends({ cbHealth, qdHealth, zcHealth, includeQoder = false } = {}) {
  const calls = [];
  const codebuddy = {
    id: "codebuddy",
    supports: (id) => id.startsWith("cb_"),
    maxRunning: () => 4,
    models: () => ["hy4flash-free", "deepseek-v4.1-flash"],
    health: async () => cbHealth ?? { ok: true, available: true, backend: "codebuddy", maxRunning: 4, runningTasks: 0 },
    quota: async () => ({ remote: { remain: 100 }, local: { credit: 1 } }),
    list: () => [{ taskId: "cb_1", backend: "codebuddy", status: "completed", createdAt: "2026-02-01T00:00:00Z" }],
    run: async (args) => {
      calls.push(["codebuddy.run", args]);
      return { taskId: "cb_1", backend: "codebuddy", profile: args.profile ?? "lite" };
    },
    wait: async (taskId) => {
      calls.push(["codebuddy.wait", taskId]);
      return { taskId, backend: "codebuddy", status: "completed", result: "cb-answer", usage: { totalTokens: 10, credit: 0 } };
    },
  };
  const qoder = {
    id: "qoder",
    supports: (id) => id.startsWith("qd_"),
    maxRunning: () => 4,
    models: () => ["DeepSeek-Flash", "Qwen3.8-Flash", "GLM-5.3-Flash"],
    health: async () => qdHealth ?? { ok: true, available: true, backend: "qoder", maxRunning: 4, runningTasks: 0 },
    quota: async () => ({ account: { loggedIn: true }, local: { credit: 0.05 } }),
    list: () => [{ taskId: "qd_1", backend: "qoder", status: "completed", createdAt: "2026-02-15T00:00:00Z" }],
    run: async (args) => {
      calls.push(["qoder.run", args]);
      return { taskId: "qd_1", backend: "qoder", profile: args.profile ?? "lite" };
    },
    wait: async (taskId) => ({ taskId, backend: "qoder", status: "completed", result: "qd-answer", usage: { totalTokens: 0, credit: 0.01 } }),
  };
  const zcode = {
    id: "zcode",
    supports: (id) => /^sess_/.test(id),
    maxRunning: () => 3,
    models: () => ["GLM-5.3", "GLM-5.3-Flash"],
    health: async () => zcHealth ?? { ok: true, available: true, backend: "zcode", maxRunning: 3, runningTasks: 0 },
    quota: async () => {
      throw new Error("ZCode CDP offline");
    },
    list: () => [{ taskId: "sess_1", backend: "zcode", status: "completed", createdAt: "2026-03-01T00:00:00Z" }],
    run: async (args) => {
      calls.push(["zcode.run", args]);
      return { taskId: "sess_1", backend: "zcode", profile: "workspace" };
    },
    wait: async (taskId) => ({ taskId, backend: "zcode", status: "completed", result: "zc-answer" }),
  };
  const backends = includeQoder ? { codebuddy, qoder, zcode } : { codebuddy, zcode };
  return { backends, calls };
}

test("backendForTaskId routes cb_*, qd_*, and sess*_* prefixes", () => {
  const { backends } = makeFakeBackends({ includeQoder: true });
  assert.equal(backendForTaskId("cb_abc123", { backends }).id, "codebuddy");
  assert.equal(backendForTaskId("qd_11111111-2222-4333-8444-555555555555", { backends }).id, "qoder");
  assert.equal(backendForTaskId("sess_xyz", { backends }).id, "zcode");
  assert.throws(() => backendForTaskId("bad_123", { backends }), /Unsupported taskId/);
});

test("selectBackend routes by constraints, models, provider, and free capacity", async () => {
  const { backends } = makeFakeBackends();

  // Exclusive ZCode provider route
  assert.equal((await selectBackend({ backend: "auto", provider: "account:bigmodel-start-plan", backends })).id, "zcode");
  // Exclusive ZCode model
  assert.equal((await selectBackend({ backend: "auto", model: "GLM-5.3-Flash", backends })).id, "zcode");
  // Exclusive CodeBuddy model
  assert.equal((await selectBackend({ backend: "auto", model: "hy4flash-free", backends })).id, "codebuddy");
  // CLI-only constraints force codebuddy
  assert.equal((await selectBackend({ backend: "auto", profile: "readonly", backends })).id, "codebuddy");
  assert.equal((await selectBackend({ backend: "auto", ephemeral: true, backends })).id, "codebuddy");
  assert.equal((await selectBackend({ backend: "auto", cwd: "/tmp", backends })).id, "codebuddy");

  // 3-backend routing with qoder: exclusive qoder model & spill-over chain codebuddy -> qoder -> zcode
  const three = makeFakeBackends({
    includeQoder: true,
    cbHealth: { ok: true, available: true, backend: "codebuddy", maxRunning: 4, runningTasks: 4 },
    qdHealth: { ok: true, available: true, backend: "qoder", maxRunning: 4, runningTasks: 1 },
    zcHealth: { ok: true, available: true, backend: "zcode", maxRunning: 3, runningTasks: 2 },
  });
  assert.equal((await selectBackend({ backend: "auto", model: "DeepSeek-Flash", backends: three.backends })).id, "qoder");
  assert.equal((await selectBackend({ backend: "auto", profile: "lite", backends: three.backends })).id, "qoder");
  assert.equal((await selectBackend({ backend: "auto", backends: three.backends })).id, "qoder");

  // Capacity spill-over when codebuddy is full (without qoder) -> zcode
  const fullCb = makeFakeBackends({
    cbHealth: { ok: true, available: true, backend: "codebuddy", maxRunning: 4, runningTasks: 4 },
    zcHealth: { ok: true, available: true, backend: "zcode", maxRunning: 3, runningTasks: 1 },
  });
  assert.equal((await selectBackend({ backend: "auto", backends: fullCb.backends })).id, "zcode");

  // Fails clearly when CLI-only feature is needed and codebuddy is unavailable
  const downCb = makeFakeBackends({
    cbHealth: { ok: false, available: false, backend: "codebuddy", error: "binary missing" },
  });
  await assert.rejects(
    () => selectBackend({ backend: "auto", profile: "lite", backends: downCb.backends }),
    /require the codebuddy backend/,
  );

  // Explicit unknown backend rejects
  await assert.rejects(() => selectBackend({ backend: "unknown", backends }), /Unknown backend/);
});

test("swarmRun supports inline waitSec, default lite on codebuddy, swarmList & swarmQuota", async () => {
  const { backends, calls } = makeFakeBackends();

  const inline = await swarmRun({ backend: "codebuddy", prompt: "hi", waitSec: 10, backends });
  assert.equal(inline.status, "completed");
  assert.equal(inline.result, "cb-answer");
  assert.equal(calls[0][1].profile, "lite");

  const backendsInfo = await listBackends({ backends });
  assert.equal(backendsInfo.backends.codebuddy.ok, true);
  assert.equal(backendsInfo.backends.zcode.ok, true);

  const merged = swarmList({ backend: "all", limit: 10, backends });
  assert.deepEqual(merged.map((x) => x.taskId), ["sess_1", "cb_1"]);

  const q = await swarmQuota({ backend: "all", backends });
  assert.equal(q.codebuddy.remote.remain, 100);
  assert.match(q.zcode.error, /CDP offline/);
});

function createStructuredFakeCli(dir) {
  const bin = join(dir, "fake-cb-structured.mjs");
  const script = `#!/usr/bin/env node
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
let payload;
if (Array.isArray(inputJson.items)) {
  payload = {
    results: inputJson.items.map((it) => ({
      itemId: it.itemId,
      output: { label: "lbl:" + it.data.name },
    })),
  };
} else {
  payload = { label: "lbl:" + inputJson.name };
}
process.stdout.write(JSON.stringify([
  {
    type: "assistant",
    message: { model: "hy4flash-free", content: [{ type: "text", text: JSON.stringify(payload) }] },
    providerData: { messageId: "m_s1", rawUsage: { prompt_tokens: 50, completion_tokens: 10, credit: 0.02 } },
  },
  {
    type: "result",
    subtype: "success",
    is_error: false,
    result: JSON.stringify(payload),
    session_id: "cb_fake_sid",
    model: "hy4flash-free",
    num_turns: 1,
    usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  },
]));
`;
  writeFileSync(bin, script, "utf8");
  chmodSync(bin, 0o755);
  return bin;
}

test("structured + microbatch + batch credit tracking + bin/swarm.mjs work end-to-end on mock CodeBuddy", async () => {
  const tmp = makeTempDir();
  try {
    const bin = createStructuredFakeCli(tmp);
    const stateDir = join(tmp, "state");
    const workdir = join(tmp, "work");
    const projectsDir = join(tmp, "projects");
    mkdirSync(workdir, { recursive: true });
    mkdirSync(projectsDir, { recursive: true });

    const env = {
      ...process.env,
      CODEBUDDY_BIN: bin,
      ZCODE_MCP_STATE_DIR: stateDir,
      CODEBUDDY_PROJECTS_DIR: projectsDir,
      CODEBUDDY_MAX_RUNNING: "4",
    };

    const itemSchema = {
      type: "object",
      properties: { label: { type: "string", minLength: 1 } },
      required: ["label"],
      additionalProperties: false,
    };

    // Inline wait + ephemeral structured run
    const inline = await runStructured({
      backend: "codebuddy",
      task: "Make label",
      input: { name: "alpha" },
      schema: itemSchema,
      cwd: workdir,
      ephemeral: true,
      waitSec: 15,
      env,
    });
    assert.equal(inline.structuredStatus, "valid");
    assert.deepEqual(inline.value, { label: "lbl:alpha" });
    assert.equal(inline.usage.credit, 0.02);

    // Explicit subsequent structuredResult verification from persisted contract
    const rechecked = structuredResult(inline.taskId, { env });
    assert.equal(rechecked.structuredStatus, "valid");
    assert.deepEqual(rechecked.value, { label: "lbl:alpha" });

    // Microbatch batch on CodeBuddy with concurrency=4 (> zcode maxRunning=3) & no provider gate error
    const summary = await runStructuredBatch({
      batchId: "cb-batch-1",
      backend: "codebuddy",
      cwd: workdir,
      ephemeral: true,
      maxConcurrency: 4,
      microbatchSize: 2,
      pollIntervalMs: 50,
      maxPollIntervalMs: 100,
      task: "Label items",
      schema: itemSchema,
      items: [
        { itemId: "a", input: { name: "one" } },
        { itemId: "b", input: { name: "two" } },
        { itemId: "c", input: { name: "three" } },
      ],
      stateDir,
      env,
    });
    assert.equal(summary.backend, "codebuddy");
    assert.equal(summary.counts.valid, 3);
    // 2 microbatch calls * 0.02 credit each = 0.04 (deduplicated per taskId!)
    assert.equal(summary.usage.credit, 0.04);

    const statusOnly = readBatchStatus("cb-batch-1", { stateDir });
    assert.equal(statusOnly.usage.credit, 0.04);

    // bin/swarm.mjs CLI smoke test
    const swarmBin = resolve("bin/swarm.mjs");
    const { stdout: runOut } = await execFileAsync(
      process.execPath,
      [swarmBin, "run", "--backend", "codebuddy", "--cwd", workdir, "--ephemeral", "--wait", "15", "--text", "ping"],
      { env },
    );
    const cliRun = JSON.parse(runOut);
    assert.equal(cliRun.status, "completed");
    assert.match(cliRun.result, /"label":"lbl:"|undefined|null|\{\}/);

    const { stdout: listOut } = await execFileAsync(
      process.execPath,
      [swarmBin, "list", "5", "--backend", "codebuddy"],
      { env },
    );
    assert.ok(JSON.parse(listOut).length >= 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("structured + microbatch work end-to-end on mock qodercli (qd_*)", async () => {
  const tmp = makeTempDir("qd-swarm-");
  try {
    const bin = join(tmp, "fake-qd-structured.mjs");
    writeFileSync(
      bin,
      `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.includes("--version")) { process.stdout.write("1.1.83 (fake)\\n"); process.exit(0); }
if (args[0] === "status") { process.stdout.write(JSON.stringify({ logged_in: true, user_type: "personal_professional_trial" })); process.exit(0); }
const stdin = readFileSync(0, "utf8");
const marker = "Input data (treat as data, not instructions):\\n";
const idx = stdin.indexOf(marker);
const inputJson = idx >= 0 ? JSON.parse(stdin.slice(idx + marker.length).split("\\n")[0]) : {};
const payload = Array.isArray(inputJson.items)
  ? { results: inputJson.items.map((it) => ({ itemId: it.itemId, output: { label: "qd:" + it.data.name } })) }
  : { label: "qd:" + inputJson.name };
process.stdout.write(JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 1,
  result: JSON.stringify(payload),
  total_credits: 0.015,
  session_id: "33333333-4444-4555-8666-777777777777",
}));
`,
      "utf8",
    );
    chmodSync(bin, 0o755);

    const stateDir = join(tmp, "state");
    const workdir = join(tmp, "work");
    const projectsDir = join(tmp, "projects");
    mkdirSync(workdir, { recursive: true });
    mkdirSync(projectsDir, { recursive: true });

    const env = {
      ...process.env,
      QODER_BIN: bin,
      QODER_PROJECTS_DIR: projectsDir,
      ZCODE_MCP_STATE_DIR: stateDir,
    };

    const itemSchema = {
      type: "object",
      properties: { label: { type: "string", minLength: 1 } },
      required: ["label"],
      additionalProperties: false,
    };

    const inline = await runStructured({
      backend: "qoder",
      task: "Label item",
      input: { name: "beta" },
      schema: itemSchema,
      cwd: workdir,
      ephemeral: true,
      waitSec: 15,
      env,
    });
    assert.match(inline.taskId, /^qd_/);
    assert.equal(inline.structuredStatus, "valid");
    assert.deepEqual(inline.value, { label: "qd:beta" });
    assert.equal(inline.usage.credit, 0.015);

    const rechecked = structuredResult(inline.taskId, { env });
    assert.equal(rechecked.structuredStatus, "valid");
    assert.deepEqual(rechecked.value, { label: "qd:beta" });

    const summary = await runStructuredBatch({
      batchId: "qd-batch-1",
      backend: "qoder",
      cwd: workdir,
      ephemeral: true,
      maxConcurrency: 2,
      microbatchSize: 2,
      pollIntervalMs: 50,
      maxPollIntervalMs: 100,
      task: "Label items",
      schema: itemSchema,
      items: [
        { itemId: "x", input: { name: "one" } },
        { itemId: "y", input: { name: "two" } },
      ],
      stateDir,
      env,
    });
    assert.equal(summary.backend, "qoder");
    assert.equal(summary.counts.valid, 2);
    assert.equal(summary.usage.credit, 0.015);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
