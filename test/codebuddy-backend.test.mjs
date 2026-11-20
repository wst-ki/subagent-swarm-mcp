import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import {
  buildCliArgs,
  cancel,
  classifyCliError,
  codebuddySessionFile,
  cwdSlug,
  DEFAULT_LITE_SYSTEM_PROMPT,
  followUp,
  health,
  inspectSessionJsonl,
  list,
  parseCodebuddyJsonOutput,
  preparePrompt,
  reconcileRun,
  resolveCodebuddyBin,
  result,
  run,
  runningCount,
  status,
  wait,
  writeJsonAtomic,
} from "../src/backends/codebuddy.mjs";

function makeTempDir(prefix = "cb-test-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

function createFakeCodebuddy(dir) {
  const binPath = join(dir, "fake-codebuddy.mjs");
  const script = `#!/usr/bin/env node
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("2.180.0 (fake)\\n");
  process.exit(0);
}
const flagVal = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const stdin = readFileSync(0, "utf8");
const sessionId = flagVal("--session-id") || flagVal("-r") || "cb_ephemeral_tmp";
const model = flagVal("--model") || "hy4flash-free";
const logFile = process.env.FAKE_CB_LOG;
if (logFile) {
  appendFileSync(logFile, JSON.stringify({ args, stdin, sessionId, model }) + "\\n", "utf8");
}

const projectsDir = process.env.CODEBUDDY_PROJECTS_DIR;
const slug = resolve(process.cwd()).replace(/^[\\\\/]+/, "").replace(/[\\\\/:]/g, "-");
const sessionFile = projectsDir ? join(projectsDir, slug, sessionId + ".jsonl") : null;
const persistent = !args.includes("--no-session-persistence") && Boolean(sessionFile);

if (stdin.includes("__SLOW_TOOL__")) {
  if (persistent) {
    mkdirSync(dirname(sessionFile), { recursive: true });
    appendFileSync(sessionFile, JSON.stringify({
      type: "function_call",
      callId: "call_1",
      name: "Grep",
      timestamp: Date.now(),
    }) + "\\n", "utf8");
  }
  const timer = setTimeout(() => {
    process.stdout.write(JSON.stringify([{ type: "result", subtype: "success", is_error: false, result: "done slow", session_id: sessionId }]));
  }, 15000);
  process.on("SIGTERM", () => {
    clearTimeout(timer);
    process.exit(143);
  });
} else if (stdin.includes("__FAIL_QUOTA__")) {
  process.stdout.write(JSON.stringify([
    {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: "HTTP 429 quota exceeded",
      errors: ["quota exceeded"],
      session_id: sessionId,
      num_turns: 1,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  ]));
  process.exit(1);
} else {
  const isFollowUp = args.includes("-r");
  const isStructured = stdin.startsWith("ZCODE_STRUCTURED_V1 ");
  const replyText = isStructured
    ? JSON.stringify({ ok: true, echo: isFollowUp ? "followup" : "initial", length: stdin.length })
    : (isFollowUp ? "followup-ok:" : "ok:") + stdin.slice(0, 200);

  if (persistent) {
    mkdirSync(dirname(sessionFile), { recursive: true });
    const firstLine = stdin.split("\\n")[0];
    appendFileSync(sessionFile, JSON.stringify({
      type: "user",
      message: { role: "user", content: firstLine },
      timestamp: Date.now(),
    }) + "\\n", "utf8");
  }

  const events = [
    {
      type: "assistant",
      message: { model, content: [{ type: "text", text: replyText }] },
      providerData: {
        messageId: "msg_" + (isFollowUp ? "2" : "1"),
        rawUsage: { prompt_tokens: 120, completion_tokens: 15, prompt_cache_hit_tokens: 30, credit: 0.0125 },
      },
    },
    {
      type: "assistant",
      message: { model, content: [{ type: "text", text: replyText }] },
      providerData: {
        messageId: "msg_" + (isFollowUp ? "2" : "1"),
        rawUsage: { prompt_tokens: 120, completion_tokens: 15, prompt_cache_hit_tokens: 30, credit: 0.0125 },
      },
    },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result: replyText,
      session_id: sessionId,
      model,
      num_turns: 1,
      duration_ms: 42,
      usage: { input_tokens: 120, output_tokens: 15, cache_read_input_tokens: 30, cache_creation_input_tokens: 0 },
    },
  ];
  process.stdout.write(JSON.stringify(events));
}
`;
  writeFileSync(binPath, script, "utf8");
  chmodSync(binPath, 0o755);
  return binPath;
}

test("resolveCodebuddyBin respects precedence without hardcoding paths", () => {
  const tmp = makeTempDir();
  try {
    const execDir = join(tmp, "nodebin");
    const home = join(tmp, "home");
    const pathDir = join(tmp, "pathbin");
    mkdirSync(execDir, { recursive: true });
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    mkdirSync(pathDir, { recursive: true });

    const siblingBin = join(execDir, "codebuddy");
    const localBin = join(home, ".local", "bin", "codebuddy");
    const pathBin = join(pathDir, "codebuddy");
    writeFileSync(siblingBin, "");
    writeFileSync(localBin, "");
    writeFileSync(pathBin, "");

    assert.equal(
      resolveCodebuddyBin({ CODEBUDDY_BIN: "/custom/cb", PATH: pathDir }, { execPath: join(execDir, "node"), homeDir: home }),
      "/custom/cb",
    );
    assert.equal(
      resolveCodebuddyBin({ PATH: pathDir }, { execPath: join(execDir, "node"), homeDir: home }),
      siblingBin,
    );
    rmSync(siblingBin);
    assert.equal(
      resolveCodebuddyBin({ PATH: pathDir }, { execPath: join(execDir, "node"), homeDir: home }),
      localBin,
    );
    rmSync(localBin);
    assert.equal(
      resolveCodebuddyBin({ PATH: pathDir }, { execPath: join(execDir, "node"), homeDir: home }),
      pathBin,
    );
    assert.equal(
      resolveCodebuddyBin({ PATH: join(tmp, "empty") }, { execPath: join(execDir, "node"), homeDir: home }),
      null,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("cwdSlug and codebuddySessionFile keep dotted directory segments intact", () => {
  const slug = cwdSlug("/var/tmp/.hidden/work-dir");
  assert.equal(slug, "var-tmp-.hidden-work-dir");
  const file = codebuddySessionFile("cb_1234", "/var/tmp/.hidden/work-dir", {
    CODEBUDDY_PROJECTS_DIR: "/opt/cb-projects",
  });
  assert.equal(file, "/opt/cb-projects/var-tmp-.hidden-work-dir/cb_1234.jsonl");
});

test("preparePrompt guards lite free-form prompts while keeping structured line 0 untouched", () => {
  const guarded = preparePrompt("---\nHello", { profile: "lite" });
  assert.ok(guarded.startsWith("[Mode: pure text, no tools available."));
  assert.ok(guarded.endsWith("---\nHello"));

  const structured = 'ZCODE_STRUCTURED_V1 {"type":"object"}\nTask: x';
  assert.equal(preparePrompt(structured, { profile: "lite" }), structured);
  assert.equal(preparePrompt("Read README", { profile: "readonly" }), "Read README");
  assert.throws(() => preparePrompt("   ", { profile: "lite" }), /empty/);
});

test("buildCliArgs covers lite lean system-prompt, effort, maxTurns, addDirs, readonly, workspace, resume, and ephemeral modes", () => {
  const lite = buildCliArgs({ taskId: "cb_1", profile: "lite", model: "hy4flash-free" });
  assert.deepEqual(lite, [
    "-p",
    "--output-format",
    "json",
    "--session-id",
    "cb_1",
    "--tools",
    "",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--strict-mcp-config",
    "--system-prompt",
    DEFAULT_LITE_SYSTEM_PROMPT,
    "--model",
    "hy4flash-free",
  ]);

  const liteNoSp = buildCliArgs({
    taskId: "cb_1b",
    profile: "lite",
    systemPrompt: false,
    effort: "minimal",
    maxTurns: 2,
    appendSystemPrompt: "extra",
    addDirs: ["/ignored/in/lite"],
  });
  assert.equal(liteNoSp.includes("--system-prompt"), false);
  assert.ok(liteNoSp.includes("--effort"));
  assert.equal(liteNoSp[liteNoSp.indexOf("--effort") + 1], "minimal");
  assert.equal(liteNoSp[liteNoSp.indexOf("--max-turns") + 1], "2");
  assert.equal(liteNoSp[liteNoSp.indexOf("--append-system-prompt") + 1], "extra");
  assert.equal(liteNoSp.includes("--add-dir"), false);

  const ro = buildCliArgs({
    taskId: "cb_2",
    profile: "readonly",
    model: "hy4std",
    fallbackModel: "hy4flash-free",
    effort: "low",
    maxTurns: 8,
    addDirs: ["/dir/a", "/dir/b"],
  });
  assert.ok(ro.includes("--tools"));
  assert.ok(ro.includes("--allowedTools"));
  assert.ok(ro.includes("--strict-mcp-config"));
  assert.ok(ro.includes("-y"));
  assert.ok(ro.includes("--fallback-model"));
  assert.equal(ro[ro.indexOf("--effort") + 1], "low");
  assert.equal(ro[ro.indexOf("--max-turns") + 1], "8");
  const adIdx = ro.indexOf("--add-dir");
  assert.deepEqual(ro.slice(adIdx + 1, adIdx + 3), ["/dir/a", "/dir/b"]);

  const ws = buildCliArgs({ profile: "workspace", ephemeral: true });
  assert.deepEqual(ws, ["-p", "--output-format", "json", "--no-session-persistence", "-y"]);

  const res = buildCliArgs({ taskId: "cb_1", profile: "lite", resume: true, effort: "high" });
  assert.deepEqual(res.slice(0, 5), ["-p", "--output-format", "json", "-r", "cb_1"]);
  assert.equal(res.includes("--system-prompt"), false);
  assert.equal(res[res.indexOf("--effort") + 1], "high");

  assert.throws(() => buildCliArgs({ taskId: "cb_1", profile: "admin" }), /Unsupported profile/);
  assert.throws(() => buildCliArgs({ taskId: "cb_1", profile: "lite", effort: "turbo" }), /Unsupported effort/);
  assert.throws(() => buildCliArgs({ taskId: "cb_1", profile: "lite", maxTurns: 0 }), /maxTurns/);
});

test("parseCodebuddyJsonOutput deduplicates rawUsage by messageId and handles errors", () => {
  const stdout = JSON.stringify([
    {
      type: "assistant",
      message: { model: "hy4flash-free", content: [{ type: "text", text: "draft" }] },
      providerData: { messageId: "m1", rawUsage: { prompt_tokens: 100, completion_tokens: 20, credit: 0.05 } },
    },
    {
      type: "assistant",
      message: { model: "hy4flash-free", content: [{ type: "text", text: "draft" }] },
      providerData: { messageId: "m1", rawUsage: { prompt_tokens: 100, completion_tokens: 20, credit: 0.05 } },
    },
    { type: "function_call", name: "Read", callId: "c1" },
    { type: "function_call_result", name: "Read", callId: "c1", status: "ok" },
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "final answer",
      session_id: "cb_abc",
      num_turns: 1,
      duration_ms: 1200,
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 40, cache_creation_input_tokens: 0 },
    },
  ]);

  const parsed = parseCodebuddyJsonOutput(stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.result, "final answer");
  assert.equal(parsed.sessionId, "cb_abc");
  assert.equal(parsed.model, "hy4flash-free");
  assert.equal(parsed.usage.credit, 0.05);
  assert.equal(parsed.usage.toolCalls, 1);
  assert.equal(parsed.usage.modelRequests, 1);
  assert.equal(parsed.usage.totalTokens, 160);

  const errParsed = parseCodebuddyJsonOutput(JSON.stringify([
    { type: "result", subtype: "error_max_turns", is_error: true, errors: ["hit max turns"] },
  ]));
  assert.equal(errParsed.ok, false);
  assert.equal(errParsed.isError, true);
  assert.deepEqual(errParsed.errors, ["hit max turns"]);

  // Real CodeBuddy events expose model under providerData.model / requestModelId and thinking tokens
  const pdParsed = parseCodebuddyJsonOutput(JSON.stringify([
    {
      type: "message",
      providerData: {
        messageId: "m_pd",
        model: "deepseek-v4.1-flash",
        rawUsage: {
          prompt_tokens: 1000,
          completion_tokens: 150,
          completion_thinking_tokens: 45,
          prompt_cache_hit_tokens: 600,
          credit: 0.12,
        },
      },
    },
    { type: "result", subtype: "success", is_error: false, result: "ok" },
  ]));
  assert.equal(pdParsed.model, "deepseek-v4.1-flash");
  assert.equal(pdParsed.usage.reasoningTokens, 45);
  assert.equal(pdParsed.usage.credit, 0.12);

  // Silent empty zero-token response with subtype="success" must fail closed as empty_response
  const emptyParsed = parseCodebuddyJsonOutput(JSON.stringify([
    {
      type: "result",
      subtype: "success",
      is_error: false,
      result: "",
      duration_ms: 244,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  ]));
  assert.equal(emptyParsed.ok, false);
  assert.equal(emptyParsed.isError, true);
  assert.equal(classifyCliError(emptyParsed.errors.join("; ")), "empty_response");
});

test("inspectSessionJsonl tracks active tool calls and honors fromOffset", () => {
  const tmp = makeTempDir();
  try {
    const file = join(tmp, "cb_test.jsonl");
    const t0 = 1_700_000_000_000;
    const part1 =
      JSON.stringify({ type: "function_call", callId: "c1", name: "Bash", timestamp: t0 }) +
      "\n" +
      JSON.stringify({ type: "function_call_result", callId: "c1", name: "Bash", timestamp: t0 + 1000 }) +
      "\n";
    const part2 = JSON.stringify({ type: "function_call", callId: "c2", name: "Read", timestamp: t0 + 5000 }) + "\n";
    writeFileSync(file, part1 + part2, "utf8");

    const fromTurn2 = inspectSessionJsonl(file, { fromOffset: Buffer.byteLength(part1), now: t0 + 7000 });
    assert.equal(fromTurn2.currentTool, "Read");
    assert.equal(fromTurn2.toolCalls, 1);
    assert.equal(fromTurn2.idleSec, 2);
    assert.equal(fromTurn2.stalled, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("mock CodeBuddy lifecycle: stdin --- prompt, wait, followUp accumulation, ephemeral guard", async () => {
  const tmp = makeTempDir();
  try {
    const bin = createFakeCodebuddy(tmp);
    const workdir = join(tmp, "work");
    const projectsDir = join(tmp, "projects");
    const stateDir = join(tmp, "state");
    const logFile = join(tmp, "calls.jsonl");
    mkdirSync(workdir, { recursive: true });
    mkdirSync(projectsDir, { recursive: true });

    const env = {
      ...process.env,
      CODEBUDDY_BIN: bin,
      CODEBUDDY_PROJECTS_DIR: projectsDir,
      ZCODE_MCP_STATE_DIR: stateDir,
      FAKE_CB_LOG: logFile,
    };

    const h = await health({ env });
    assert.equal(h.ok, true);
    assert.equal(h.available, true);
    assert.equal(h.version, "2.180.0 (fake)");

    const started = await run({ prompt: "---\nping world", profile: "lite", cwd: workdir, env });
    assert.match(started.taskId, /^cb_[0-9a-f]+$/);
    const res1 = await wait(started.taskId, { timeoutSec: 15, pollIntervalMs: 50, env });
    assert.equal(res1.status, "completed");
    assert.ok(res1.result.includes("ok:[Mode: pure text"));
    assert.ok(res1.result.includes("---\nping world"));
    assert.equal(res1.usage.credit, 0.0125);
    assert.equal(res1.usage.modelRequests, 1);
    assert.equal(existsSync(join(stateDir, "cb-runs", `${started.taskId}.prompt.txt`)), false);
    assert.equal(existsSync(join(stateDir, "cb-runs", `${started.taskId}.spec.json`)), false);

    // Follow-up resumes session (-r) and accumulates usage across turns
    const fu = await followUp({ taskId: started.taskId, prompt: "second turn", model: "hy4std", env });
    assert.equal(fu.accepted, true);
    const res2 = await wait(started.taskId, { timeoutSec: 15, pollIntervalMs: 50, env });
    assert.equal(res2.status, "completed");
    assert.ok(res2.result.startsWith("followup-ok:"));
    assert.equal(res2.usage.credit, 0.025);
    assert.equal(res2.usage.modelRequests, 2);
    assert.equal(res2.earlierMessages.length, 1);

    const calls = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const runCalls = calls.filter((c) => !c.args.includes("--version"));
    assert.equal(runCalls.length, 2);
    assert.ok(runCalls[0].args.includes("--session-id"));
    assert.ok(runCalls[1].args.includes("-r"));

    // Ephemeral run uses --no-session-persistence and refuses followUp
    const eph = await run({ prompt: "one off", profile: "workspace", cwd: workdir, ephemeral: true, env });
    const ephRes = await wait(eph.taskId, { timeoutSec: 15, pollIntervalMs: 50, env });
    assert.equal(ephRes.status, "completed");
    await assert.rejects(() => followUp({ taskId: eph.taskId, prompt: "again", env }), /ephemeral/);

    const listed = list({ limit: 10, env });
    assert.equal(listed.length, 2);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("cancel kills process group cleanly and preserves cancelled status", async () => {
  const tmp = makeTempDir();
  try {
    const bin = createFakeCodebuddy(tmp);
    const workdir = join(tmp, "work");
    const projectsDir = join(tmp, "projects");
    const stateDir = join(tmp, "state");
    mkdirSync(workdir, { recursive: true });
    mkdirSync(projectsDir, { recursive: true });

    const env = {
      ...process.env,
      CODEBUDDY_BIN: bin,
      CODEBUDDY_PROJECTS_DIR: projectsDir,
      ZCODE_MCP_STATE_DIR: stateDir,
    };

    const started = await run({ prompt: "run __SLOW_TOOL__", profile: "readonly", cwd: workdir, env });

    // Wait briefly until JSONL registers currentTool or childPid is running
    let sawRunning = false;
    for (let i = 0; i < 40; i++) {
      const st = status(started.taskId, { env });
      if (st.status === "running" && st.currentTool === "Grep") {
        sawRunning = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(sawRunning, true);

    const cancelled = await cancel(started.taskId, { env });
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.status, "cancelled");

    await new Promise((r) => setTimeout(r, 200));
    const final = result(started.taskId, { env });
    assert.equal(final.status, "cancelled");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("reconcileRun fail-closes dead orphan worker and frees capacity", async () => {
  const tmp = makeTempDir();
  try {
    const stateDir = join(tmp, "state");
    const bin = createFakeCodebuddy(tmp);
    const workdir = join(tmp, "work");
    mkdirSync(workdir, { recursive: true });

    const taskId = "cb_orphan_001";
    const file = join(stateDir, "cb-runs", `${taskId}.json`);
    writeJsonAtomic(file, {
      taskId,
      backend: "codebuddy",
      status: "running",
      profile: "lite",
      cwd: workdir,
      model: "hy4flash-free",
      runnerPid: 999991,
      childPid: 999992,
      startedAt: Date.now() - 10_000,
      turnStartedAt: Date.now() - 10_000,
    });

    const env = { ...process.env, CODEBUDDY_BIN: bin, ZCODE_MCP_STATE_DIR: stateDir, CODEBUDDY_MAX_RUNNING: "1" };
    assert.equal(runningCount({ env, isPidAlive: () => false }), 0);

    const reconciled = reconcileRun(taskId, { env, isPidAlive: () => false });
    assert.equal(reconciled.status, "failed");
    assert.equal(reconciled.interrupted, true);
    assert.equal(reconciled.error.type, "orphan_process");

    // Simulate an active PID occupying full capacity -> run() rejects cleanly
    writeJsonAtomic(file, {
      taskId,
      backend: "codebuddy",
      status: "running",
      profile: "lite",
      cwd: workdir,
      model: "hy4flash-free",
      runnerPid: process.pid,
      childPid: process.pid,
      startedAt: Date.now(),
    });
    await assert.rejects(() => run({ prompt: "blocked", cwd: workdir, env }), /capacity limit reached/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("health reports unavailable cleanly when codebuddy binary is missing", async () => {
  const tmp = makeTempDir();
  try {
    const h = await health({
      env: { ...process.env, CODEBUDDY_BIN: join(tmp, "missing-codebuddy"), ZCODE_MCP_STATE_DIR: join(tmp, "state") },
    });
    assert.equal(h.ok, false);
    assert.equal(h.available, false);
    assert.match(h.error, /not found/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
