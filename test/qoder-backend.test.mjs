import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildCliArgs,
  cancel,
  cwdSlug,
  followUp,
  health,
  inspectSessionJsonl,
  list,
  parseQoderJsonOutput,
  preparePrompt,
  qoderSessionFile,
  quota,
  reconcileRun,
  resolveQoderBin,
  result,
  run,
  runningCount,
  status,
  wait,
} from "../src/backends/qoder.mjs";
import { writeJsonAtomic } from "../src/backends/cli-common.mjs";

function makeTempDir(prefix = "qd-test-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

function createFakeQoder(dir) {
  const binPath = join(dir, "fake-qodercli.mjs");
  const script = `#!/usr/bin/env node
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("1.1.83 (fake)\\n");
  process.exit(0);
}
if (args[0] === "status") {
  process.stdout.write(JSON.stringify({
    logged_in: process.env.FAKE_QD_LOGGED_OUT !== "1",
    version: "1.1.83",
    auth_source: "local",
    account_type: "user",
    login_method: "browser",
    username: "TestUserShouldNotLeak",
    email: "private@example.invalid",
    avatar_url: "https://example.invalid/avatar",
    user_type: "personal_professional_trial",
  }));
  process.exit(0);
}

const flagVal = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const stdin = readFileSync(0, "utf8");
const sessionId = flagVal("--session-id") || flagVal("-r") || "00000000-0000-4000-8000-000000000000";
const model = flagVal("-m") || "DeepSeek-Flash";
const logFile = process.env.FAKE_QD_LOG;
if (logFile) {
  appendFileSync(logFile, JSON.stringify({ args, stdin, sessionId, model }) + "\\n", "utf8");
}

const projectsDir = process.env.QODER_PROJECTS_DIR;
const slug = resolve(process.cwd()).replace(/[\\\\/.:]/g, "-");
const sessionFile = projectsDir ? join(projectsDir, slug, sessionId + ".jsonl") : null;
const persistent = !args.includes("--no-session-persistence") && Boolean(sessionFile);

if (stdin.includes("__SLOW_TOOL__")) {
  if (persistent) {
    mkdirSync(dirname(sessionFile), { recursive: true });
    appendFileSync(sessionFile, JSON.stringify({
      type: "assistant",
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "Grep", input: { pattern: "foo" } }],
      },
    }) + "\\n", "utf8");
  }
  const timer = setTimeout(() => {
    process.stdout.write(JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "done slow",
      session_id: sessionId,
      total_credits: 0.01,
    }));
  }, 15000);
  process.on("SIGTERM", () => {
    clearTimeout(timer);
    process.exit(143);
  });
} else {
  const isFollowUp = args.includes("-r");
  const isStructured = stdin.startsWith("ZCODE_STRUCTURED_V1 ");
  const replyText = isStructured
    ? JSON.stringify({ ok: true, echo: isFollowUp ? "followup" : "initial" })
    : (isFollowUp ? "qd-followup:" : "qd-ok:") + stdin.slice(0, 200);

  if (persistent) {
    mkdirSync(dirname(sessionFile), { recursive: true });
    const firstLine = stdin.split("\\n")[0];
    appendFileSync(sessionFile, JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: firstLine }] },
      timestamp: new Date().toISOString(),
    }) + "\\n", "utf8");
  }

  process.stdout.write(JSON.stringify({
    type: "result",
    subtype: "success",
    duration_ms: 1100,
    duration_api_ms: 950,
    is_error: false,
    num_turns: 1,
    result: replyText,
    total_credits: 0.0112,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    modelUsage: { dfmodel: { inputTokens: 0, outputTokens: 0, credits: 0.0112 } },
    session_id: sessionId,
  }));
}
`;
  writeFileSync(binPath, script, "utf8");
  chmodSync(binPath, 0o755);
  return binPath;
}

test("resolveQoderBin respects precedence without hardcoding paths", () => {
  const tmp = makeTempDir();
  try {
    const execDir = join(tmp, "nodebin");
    const home = join(tmp, "home");
    const pathDir = join(tmp, "pathbin");
    mkdirSync(execDir, { recursive: true });
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    mkdirSync(join(home, ".qoder", "bin"), { recursive: true });
    mkdirSync(pathDir, { recursive: true });

    const localBin = join(home, ".local", "bin", "qodercli");
    const siblingBin = join(execDir, "qodercli");
    const qoderBin = join(home, ".qoder", "bin", "qodercli");
    const pathBin = join(pathDir, "qodercli");
    writeFileSync(localBin, "");
    writeFileSync(siblingBin, "");
    writeFileSync(qoderBin, "");
    writeFileSync(pathBin, "");

    assert.equal(
      resolveQoderBin({ QODER_BIN: "/custom/qd", PATH: pathDir }, { execPath: join(execDir, "node"), homeDir: home }),
      "/custom/qd",
    );
    assert.equal(
      resolveQoderBin({ PATH: pathDir }, { execPath: join(execDir, "node"), homeDir: home }),
      localBin,
    );
    rmSync(localBin);
    assert.equal(
      resolveQoderBin({ PATH: pathDir }, { execPath: join(execDir, "node"), homeDir: home }),
      siblingBin,
    );
    rmSync(siblingBin);
    assert.equal(
      resolveQoderBin({ PATH: pathDir }, { execPath: join(execDir, "node"), homeDir: home }),
      qoderBin,
    );
    rmSync(qoderBin);
    assert.equal(
      resolveQoderBin({ PATH: pathDir }, { execPath: join(execDir, "node"), homeDir: home }),
      pathBin,
    );
    assert.equal(
      resolveQoderBin({ PATH: join(tmp, "empty") }, { execPath: join(execDir, "node"), homeDir: home }),
      null,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("qoder cwdSlug keeps leading hyphen and replaces dots", () => {
  assert.equal(cwdSlug("/var/tmp/.hidden/qd.work"), "-var-tmp--hidden-qd-work");
  assert.equal(
    qoderSessionFile("11111111-2222-4333-8444-555555555555", "/tmp/qd.dot", { QODER_PROJECTS_DIR: "/opt/qd" }),
    "/opt/qd/-tmp-qd-dot/11111111-2222-4333-8444-555555555555.jsonl",
  );
});

test("qoder preparePrompt and buildCliArgs handle lite, readonly, workspace, resume, ephemeral", () => {
  const guarded = preparePrompt("---\nhi", { profile: "lite" });
  assert.ok(guarded.startsWith("[Mode: pure text, no tools available."));
  const structured = 'ZCODE_STRUCTURED_V1 {"type":"object"}\nTask: x';
  assert.equal(preparePrompt(structured, { profile: "lite" }), structured);

  const uuid = "11111111-2222-4333-8444-555555555555";
  const lite = buildCliArgs({ sessionId: uuid, profile: "lite", model: "DeepSeek-Flash" });
  assert.deepEqual(lite, [
    "-p",
    "-o",
    "json",
    "--session-id",
    uuid,
    "--tools",
    "",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--strict-mcp-config",
    "-m",
    "DeepSeek-Flash",
  ]);

  const ro = buildCliArgs({ sessionId: uuid, profile: "readonly", model: "Qwen3.8-Flash" });
  assert.ok(ro.includes("--allowed-tools"));
  assert.ok(ro.includes("--dangerously-skip-permissions"));
  assert.ok(!ro.includes("--allowedTools"));

  const ws = buildCliArgs({ profile: "workspace", ephemeral: true });
  assert.deepEqual(ws, ["-p", "-o", "json", "--no-session-persistence", "--dangerously-skip-permissions"]);

  const res = buildCliArgs({ sessionId: uuid, profile: "readonly", resume: true });
  assert.deepEqual(res.slice(0, 5), ["-p", "-o", "json", "-r", uuid]);
});

test("parseQoderJsonOutput extracts total_credits, model, turns, and errors", () => {
  const parsed = parseQoderJsonOutput(
    JSON.stringify({
      type: "result",
      subtype: "success",
      duration_ms: 1300,
      is_error: false,
      num_turns: 2,
      result: "OK",
      total_credits: 0.02817,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      modelUsage: { auto: { credits: 0 }, dfmodel: { inputTokens: 0, outputTokens: 0, credits: 0.02817 } },
      session_id: "22222222-3333-4444-8555-666666666666",
    }),
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.result, "OK");
  assert.equal(parsed.model, "dfmodel");
  assert.equal(parsed.usage.credit, 0.0282);
  assert.equal(parsed.usage.modelRequests, 2);

  const failed = parseQoderJsonOutput(JSON.stringify({ type: "result", is_error: true, errors: ["credit limit"] }));
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.errors, ["credit limit"]);
});

test("inspectSessionJsonl parses Claude-style tool_use / tool_result from Qoder transcripts", () => {
  const tmp = makeTempDir();
  try {
    const file = join(tmp, "qd.jsonl");
    const t0 = 1_700_000_000_000;
    const line1 = JSON.stringify({
      type: "assistant",
      timestamp: new Date(t0).toISOString(),
      message: { content: [{ type: "tool_use", id: "t1", name: "Read" }] },
    }) + "\n";
    const line2 = JSON.stringify({
      type: "user",
      timestamp: new Date(t0 + 500).toISOString(),
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    }) + "\n";
    const line3 = JSON.stringify({
      type: "assistant",
      timestamp: new Date(t0 + 2000).toISOString(),
      message: { content: [{ type: "tool_use", id: "t2", name: "Bash" }] },
    }) + "\n";
    writeFileSync(file, line1 + line2 + line3, "utf8");

    const snap = inspectSessionJsonl(file, { fromOffset: 0, now: t0 + 3000 });
    assert.equal(snap.toolCalls, 2);
    assert.equal(snap.currentTool, "Bash");
    assert.equal(snap.idleSec, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("mock qodercli lifecycle: UUID session-id, health PII strip, wait, followUp, ephemeral, quota", async () => {
  const tmp = makeTempDir();
  try {
    const bin = createFakeQoder(tmp);
    const workdir = join(tmp, "work");
    const projectsDir = join(tmp, "projects");
    const stateDir = join(tmp, "state");
    const logFile = join(tmp, "qd-calls.jsonl");
    mkdirSync(workdir, { recursive: true });
    mkdirSync(projectsDir, { recursive: true });

    const env = {
      ...process.env,
      QODER_BIN: bin,
      QODER_PROJECTS_DIR: projectsDir,
      ZCODE_MCP_STATE_DIR: stateDir,
      FAKE_QD_LOG: logFile,
    };

    const h = await health({ env });
    assert.equal(h.ok, true);
    assert.equal(h.loggedIn, true);
    assert.equal(h.userType, "personal_professional_trial");
    assert.equal(JSON.stringify(h).includes("TestUserShouldNotLeak"), false);
    assert.equal(JSON.stringify(h).includes("private@example.invalid"), false);

    // Unauthenticated health fails cleanly
    const loggedOutHealth = await health({ env: { ...env, FAKE_QD_LOGGED_OUT: "1" } });
    assert.equal(loggedOutHealth.ok, false);
    assert.match(loggedOutHealth.error, /not logged in/);

    const started = await run({ prompt: "---\nping qoder", profile: "lite", cwd: workdir, env });
    assert.match(started.taskId, /^qd_[0-9a-f-]{36}$/);
    const res1 = await wait(started.taskId, { timeoutSec: 15, pollIntervalMs: 50, env });
    assert.equal(res1.status, "completed");
    assert.ok(res1.result.includes("qd-ok:"));
    assert.ok(res1.result.includes("---\nping qoder"));
    assert.equal(res1.usage.credit, 0.0112);

    const fu = await followUp({ taskId: started.taskId, prompt: "next turn", model: "Qwen3.8-Flash", env });
    assert.equal(fu.accepted, true);
    const res2 = await wait(started.taskId, { timeoutSec: 15, pollIntervalMs: 50, env });
    assert.equal(res2.status, "completed");
    assert.equal(res2.usage.credit, 0.0224);
    assert.equal(res2.earlierMessages.length, 1);

    const calls = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(calls.length, 2);
    assert.ok(calls[0].args.includes("--session-id"));
    assert.ok(calls[1].args.includes("-r"));
    assert.equal(calls[0].args[calls[0].args.indexOf("--session-id") + 1], started.taskId.slice(3));

    const eph = await run({ prompt: "temp", profile: "workspace", cwd: workdir, ephemeral: true, env });
    const ephRes = await wait(eph.taskId, { timeoutSec: 15, pollIntervalMs: 50, env });
    assert.equal(ephRes.status, "completed");
    await assert.rejects(() => followUp({ taskId: eph.taskId, prompt: "no", env }), /ephemeral/);

    const listed = list({ limit: 10, env });
    assert.equal(listed.length, 2);

    const q = await quota({ env });
    assert.equal(q.account.loggedIn, true);
    assert.equal(JSON.stringify(q).includes("private@example.invalid"), false);
    assert.equal(q.local.runs, 2);
    assert.equal(q.local.credit, 0.0336);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("qoder cancel terminates process group cleanly and orphan reconciliation frees capacity", async () => {
  const tmp = makeTempDir();
  try {
    const bin = createFakeQoder(tmp);
    const workdir = join(tmp, "work");
    const projectsDir = join(tmp, "projects");
    const stateDir = join(tmp, "state");
    mkdirSync(workdir, { recursive: true });
    mkdirSync(projectsDir, { recursive: true });

    const env = {
      ...process.env,
      QODER_BIN: bin,
      QODER_PROJECTS_DIR: projectsDir,
      ZCODE_MCP_STATE_DIR: stateDir,
      QODER_MAX_RUNNING: "1",
    };

    const started = await run({ prompt: "run __SLOW_TOOL__", profile: "readonly", cwd: workdir, env });
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
    assert.equal(result(started.taskId, { env }).status, "cancelled");

    // Reconcile dead orphan runner -> failed & capacity reset to 0
    const orphanId = "qd_dead0000-0000-4000-8000-000000000001";
    writeJsonAtomic(join(stateDir, "qd-runs", `${orphanId}.json`), {
      taskId: orphanId,
      backend: "qoder",
      status: "running",
      profile: "lite",
      cwd: workdir,
      runnerPid: 999991,
      childPid: 999992,
      startedAt: Date.now() - 5000,
    });
    assert.equal(runningCount({ env, isPidAlive: () => false }), 0);
    const rec = reconcileRun(orphanId, { env, isPidAlive: () => false });
    assert.equal(rec.status, "failed");
    assert.equal(rec.error.type, "orphan_process");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
