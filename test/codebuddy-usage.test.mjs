import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// cbConfig reads env at import time, so point every path at a temp dir before importing.
const root = mkdtempSync(join(tmpdir(), "cb-usage-"));
after(() => rmSync(root, { recursive: true, force: true }));
process.env.ZCODE_MCP_STATE_DIR = join(root, "state");
process.env.CODEBUDDY_PROJECTS_DIR = join(root, "projects");
delete process.env.CODEBUDDY_USAGE_TOKEN;
delete process.env.CODEBUDDY_TOKEN_FILE;
process.env.CODEBUDDY_AUTH_FILE = join(root, "cli-auth.info"); // never the real CLI login
const { cbConfig, codebuddyUsage, fetchRemote, localUsage, readToken, saveToken, summarizeAccounts } = await import("../src/codebuddy-usage.mjs");

const jwt = (exp) => `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.sig`;

const ACCOUNTS = [
  // monthly package: the cycle fields win over the lifetime ones
  { PackageName: "monthly", CapacityRemainPrecise: "900", CapacitySizePrecise: "1200", CycleCapacityRemainPrecise: "80.5", CycleCapacitySizePrecise: "100", CycleEndTime: "2026-11-01 00:00:00" },
  { PackageName: "one-off", CapacityRemainPrecise: "19.5", CapacitySizePrecise: "50", CycleEndTime: "2026-10-30 00:00:00" },
  // used up: not part of the total
  { PackageName: "empty", CapacityRemainPrecise: "0", CapacitySizePrecise: "500", CycleEndTime: "2026-10-26 00:00:00" },
];

test("summarizeAccounts: cycle fields first, exhausted packages excluded from total", () => {
  const s = summarizeAccounts(ACCOUNTS);
  assert.equal(s.remain, 100);
  assert.equal(s.total, 150);
  assert.equal(s.pct, 66.67);
  assert.deepEqual(s.packages.map((p) => p.name), ["one-off", "monthly", "empty"]);
});

test("fetchRemote: bearer token, billing endpoint, 401 and API errors", async () => {
  let seen;
  const fake = async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ data: { Response: { Data: { Accounts: ACCOUNTS } } } }), { status: 200 });
  };
  const r = await fetchRemote({ token: "tok", apiBase: "https://x.test", fetchImpl: fake });
  assert.equal(r.remain, 100);
  assert.equal(seen.url, "https://x.test/billing/meter/get-user-resource");
  assert.equal(seen.init.headers.authorization, "Bearer tok");
  assert.equal(JSON.parse(seen.init.body).ProductCode, "p_tcaca");

  await assert.rejects(fetchRemote({ token: "t", fetchImpl: async () => new Response("", { status: 401 }) }), /401/);
  const apiErr = async () => new Response(JSON.stringify({ data: { Response: { Error: { Code: "AuthFailure", Message: "bad" } } } }), { status: 200 });
  await assert.rejects(fetchRemote({ token: "t", fetchImpl: apiErr }), /AuthFailure bad/);
});

test("readToken/saveToken: 0600 file, Bearer prefix stripped, JWT expiry, env wins, loose perms refused", () => {
  const file = join(root, "tok");
  assert.equal(readToken({ envToken: "", file }), null);
  const exp = Math.floor(Date.now() / 1000) + 86_400 * 30;
  saveToken(`Bearer ${jwt(exp)}`, file);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const t = readToken({ envToken: "", file });
  assert.equal(t.token, jwt(exp));
  assert.equal(t.expiresAt, exp * 1000);
  assert.equal(readToken({ envToken: "from-env", file }).source, "env CODEBUDDY_USAGE_TOKEN");
  chmodSync(file, 0o644);
  assert.throws(() => readToken({ envToken: "", file }), /chmod 600/);
});

test("readToken: falls back to the CodeBuddy CLI login, accessToken only, encrypted values ignored", () => {
  const cliFile = join(root, "cli.info");
  const missing = join(root, "none");
  assert.equal(readToken({ envToken: "", file: missing, cliFile }), null);
  writeFileSync(cliFile, JSON.stringify({ account: { uid: "u" }, auth: { accessToken: jwt(1), refreshToken: "r.r.r", expiresAt: 1795349729085 } }));
  const t = readToken({ envToken: "", file: missing, cliFile });
  assert.deepEqual(t, { token: jwt(1), source: "codebuddy CLI login", expiresAt: 1795349729085 });
  writeFileSync(cliFile, JSON.stringify({ auth: { accessToken: "enc:v1:AAAA" } }));
  assert.equal(readToken({ envToken: "", file: missing, cliFile }), null);
});

function writeSession(dir, lines) {
  mkdirSync(join(cbConfig.projectsDir, dir), { recursive: true });
  writeFileSync(join(cbConfig.projectsDir, dir, "s1.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}
const step = (messageId, credit, prompt_tokens, timestamp) => ({ type: "message", timestamp, providerData: { messageId, rawUsage: { credit, prompt_tokens } } });

test("localUsage: dedupes by messageId, groups by day and hub task, honours sinceMs", () => {
  const t0 = new Date(2026, 9, 25, 10).getTime();
  writeSession("home-dev-.local-state-glm-zcode-mcp-work-T20261025-052552-36", [
    step("m1", 0.3, 24000, t0),
    { type: "function_call", timestamp: t0, providerData: { messageId: "m1", rawUsage: { credit: 0.3, prompt_tokens: 24000 } } }, // same request
    step("m2", 0.5, 41000, t0 + 1000),
    { type: "message", role: "user", timestamp: t0 },
  ]);
  writeSession("tmp", [step("m9", 0.09, 6000, t0 - 86_400_000)]);
  const u = localUsage();
  assert.equal(u.credit, 0.89);
  assert.equal(u.requests, 3);
  assert.deepEqual(u.byDay, { "2026-10-24": 0.09, "2026-10-25": 0.8 });
  assert.deepEqual(u.byTask["T20261025-052552-36"], { credit: 0.8, requests: 2, peakContext: 41000 });
  assert.equal(localUsage({ sinceMs: t0 - 1000 }).credit, 0.8);
});

test("codebuddyUsage: caches the remote reading, keeps the last good one on failure, never stores the token", async () => {
  process.env.CODEBUDDY_USAGE_TOKEN = "secret-token-value";
  try {
    let calls = 0;
    const good = async () => (calls++, new Response(JSON.stringify({ data: { Response: { Data: { Accounts: ACCOUNTS } } } }), { status: 200 }));
    const a = await codebuddyUsage({ fetchImpl: good, sinceDays: 3650 });
    assert.equal(a.remote.remain, 100);
    assert.equal(a.remote.cached, false);
    const b = await codebuddyUsage({ fetchImpl: good });
    assert.equal(b.remote.cached, true);
    assert.equal(calls, 1);
    assert.ok(!readFileSync(cbConfig.cacheFile, "utf8").includes("secret-token-value"));

    const down = async () => new Response("", { status: 503 });
    const c = await codebuddyUsage({ refresh: true, fetchImpl: down });
    assert.match(c.remote.error, /503/);
    assert.equal(c.remote.last.remain, 100);
    assert.ok(!JSON.stringify(c).includes("secret-token-value"));
  } finally {
    delete process.env.CODEBUDDY_USAGE_TOKEN;
  }
});

test("summarizeAccounts: computes expiringSoon alerts, usedPct, and daysLeft relative to now", () => {
  const now = Date.parse("2026-10-27T00:00:00");
  const s = summarizeAccounts(ACCOUNTS, { now, expiringSoonDays: 4 });
  assert.equal(s.used, 50);
  assert.equal(s.activePackages, 2);
  assert.equal(s.expiringSoon.count, 1);
  assert.equal(s.expiringSoon.credit, 19.5);
  assert.equal(s.expiringSoon.nextExpiry, "2026-10-30 00:00:00");
  assert.equal(s.expiringSoon.nextExpiryDays, 3);
  const oneOff = s.packages.find((p) => p.name === "one-off");
  assert.equal(oneOff.expiringSoon, true);
  assert.equal(oneOff.used, 30.5);
  assert.equal(oneOff.usedPct, 61);
  const monthly = s.packages.find((p) => p.name === "monthly");
  assert.equal(monthly.expiringSoon, false);
  assert.equal(monthly.daysLeft, 5);
});

test("localUsage: merges ephemeral cb-runs + JSONL without double-counting persistent swarm runs", () => {
  const projDir = join(root, "merged-projects");
  const runsDir = join(root, "merged-cb-runs");
  mkdirSync(join(projDir, "proj-a"), { recursive: true });
  mkdirSync(runsDir, { recursive: true });

  const t0 = new Date(2026, 10, 19, 10, 0, 0).getTime();
  const persistJsonl = join(projDir, "proj-a", "cb_persist01.jsonl");

  // Persistent swarm run whose JSONL exists on disk (must be counted ONCE from JSONL, tagged as swarm/readonly)
  writeFileSync(
    persistJsonl,
    [
      JSON.stringify({
        type: "message",
        timestamp: t0,
        sessionId: "cb_persist01",
        providerData: {
          messageId: "pm1",
          model: "deepseek-v4.1-flash",
          rawUsage: {
            prompt_tokens: 10000,
            prompt_cache_hit_tokens: 8000,
            prompt_cache_miss_tokens: 2000,
            completion_tokens: 500,
            completion_thinking_tokens: 120,
            total_tokens: 10500,
            credit: 0.25,
          },
        },
      }),
    ].join("\n") + "\n",
  );
  writeFileSync(
    join(runsDir, "cb_persist01.json"),
    JSON.stringify({
      taskId: "cb_persist01",
      backend: "codebuddy",
      status: "completed",
      profile: "readonly",
      model: "deepseek-v4.1-flash",
      actualModel: "deepseek-v4.1-flash",
      ephemeral: false,
      sessionFile: persistJsonl,
      sessionId: "cb_persist01",
      startedAt: t0,
      endedAt: t0 + 4000,
      turns: [{ index: 1, startedAt: t0, endedAt: t0 + 4000, durationMs: 4000, usage: { inputTokens: 10000, outputTokens: 500, cacheReadInputTokens: 8000, totalTokens: 18500, modelRequests: 1, credit: 0.25 } }],
      usage: { inputTokens: 10000, outputTokens: 500, cacheReadInputTokens: 8000, totalTokens: 18500, modelRequests: 1, credit: 0.25 },
    }),
  );

  // Ephemeral swarm run (NO JSONL on disk — previously 100% invisible!)
  writeFileSync(
    join(runsDir, "cb_eph01.json"),
    JSON.stringify({
      taskId: "cb_eph01",
      backend: "codebuddy",
      status: "completed",
      profile: "lite",
      model: "deepseek-v4.1-flash",
      actualModel: null,
      ephemeral: true,
      sessionFile: null,
      sessionId: "01a1-uuid-eph",
      startedAt: t0 + 10_000,
      endedAt: t0 + 18_000,
      turns: [{ index: 1, startedAt: t0 + 10_000, endedAt: t0 + 18_000, durationMs: 8000, usage: { inputTokens: 12000, outputTokens: 1000, cacheReadInputTokens: 6000, cacheWriteInputTokens: 0, totalTokens: 19000, modelRequests: 1, credit: 0.35 } }],
      usage: { inputTokens: 12000, outputTokens: 1000, cacheReadInputTokens: 6000, cacheWriteInputTokens: 0, totalTokens: 19000, modelRequests: 1, credit: 0.35 },
    }),
  );

  // Zero-token completed ephemeral run (edge case tracked in swarmRuns.zeroTokenCompleted)
  writeFileSync(
    join(runsDir, "cb_zero01.json"),
    JSON.stringify({
      taskId: "cb_zero01",
      backend: "codebuddy",
      status: "completed",
      profile: "lite",
      model: "hy4flash-free",
      ephemeral: true,
      sessionFile: null,
      startedAt: t0 + 20_000,
      endedAt: t0 + 20_200,
      turns: [{ index: 1, startedAt: t0 + 20_000, endedAt: t0 + 20_200, durationMs: 200, usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, totalTokens: 0, modelRequests: 1, credit: 0 } }],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, totalTokens: 0, modelRequests: 1, credit: 0 },
    }),
  );

  // Interactive CLI session
  writeFileSync(
    join(projDir, "proj-a", "interactive.jsonl"),
    JSON.stringify({
      type: "message",
      timestamp: t0 + 30_000,
      providerData: {
        messageId: "im1",
        model: "glm-5.3",
        rawUsage: { prompt_tokens: 4000, prompt_cache_hit_tokens: 0, completion_tokens: 400, total_tokens: 4400, credit: 0.4 },
      },
    }) + "\n",
  );

  const u = localUsage({ projectsDir: projDir, runsDir, sinceMs: t0 - 1000 });
  // 0.25 (persist once) + 0.35 (ephemeral) + 0.40 (cli) = 1.00 (no double counting!)
  assert.equal(u.credit, 1);
  assert.equal(u.requests, 4);
  assert.equal(u.tasks, 4);
  assert.equal(u.bySource.swarm.credit, 0.6);
  assert.equal(u.bySource.swarm.ephemeralTasks, 2);
  assert.equal(u.bySource.swarm.persistentTasks, 1);
  assert.equal(u.bySource.cli.credit, 0.4);
  assert.equal(u.swarmRuns.total, 3);
  assert.equal(u.swarmRuns.ephemeral, 2);
  assert.equal(u.swarmRuns.persistent, 1);
  assert.equal(u.swarmRuns.zeroTokenCompleted, 1);

  // Token math normalizes inclusive inputTokens without double-counting cacheRead
  assert.equal(u.tokens.inputTokens, 26000);
  assert.equal(u.tokens.cacheReadInputTokens, 14000);
  assert.equal(u.tokens.uncachedInputTokens, 12000);
  assert.equal(u.tokens.outputTokens, 1900);
  assert.equal(u.tokens.reasoningTokens, 120);
  assert.equal(u.tokens.totalTokens, 27900);
  assert.equal(u.tokens.cacheHitRatePct, 53.85);

  assert.equal(u.byModel["deepseek-v4.1-flash"].credit, 0.6);
  assert.equal(u.byModel["deepseek-v4.1-flash"].tasks, 2);
  assert.equal(u.byModel["deepseek-v4.1-flash"].avgCreditPerTask, 0.3);
  assert.equal(u.byProfile.readonly.credit, 0.25);
  assert.equal(u.byProfile.lite.credit, 0.35);
  assert.equal(u.topSwarmTasks[0].taskId, "cb_eph01");
  assert.equal(u.daily.length, 1);
  assert.equal(u.daily[0].credit, 1);
});

test("codebuddyUsage: computes runway burn rate, model task capacity, and expiring risk", async () => {
  process.env.CODEBUDDY_USAGE_TOKEN = "secret-runway-tok";
  try {
    const now = Date.parse("2026-10-27T00:00:00");
    const runsDir = join(root, "runway-cb-runs");
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(
      join(runsDir, "cb_rw1.json"),
      JSON.stringify({
        taskId: "cb_rw1",
        status: "completed",
        profile: "lite",
        model: "deepseek-v4.1-flash",
        ephemeral: true,
        startedAt: now - 86_400_000,
        endedAt: now - 86_400_000 + 2000,
        turns: [{ index: 1, startedAt: now - 86_400_000, endedAt: now - 86_400_000 + 2000, usage: { inputTokens: 5000, outputTokens: 500, cacheReadInputTokens: 2500, modelRequests: 1, credit: 2 } }],
        usage: { inputTokens: 5000, outputTokens: 500, cacheReadInputTokens: 2500, modelRequests: 1, credit: 2 },
      }),
    );
    const fakeFetch = async () =>
      new Response(JSON.stringify({ data: { Response: { Data: { Accounts: ACCOUNTS } } } }), { status: 200 });
    const res = await codebuddyUsage({
      refresh: true,
      sinceDays: 4,
      expiringSoonDays: 4,
      projectsDir: join(root, "empty-proj"),
      runsDir,
      fetchImpl: fakeFetch,
      now,
    });
    assert.equal(res.remote.expiringSoon.credit, 19.5);
    assert.equal(res.runway.avgDailyCredit, 0.5);
    assert.equal(res.runway.activeDayAvgCredit, 2);
    assert.equal(res.runway.estimatedDaysRemaining, 200);
    assert.equal(res.runway.estimatedTasksRemainingByModel["deepseek-v4.1-flash"].estimatedTasksRemaining, 50);
    assert.equal(res.runway.expiringRisk.expiringCredit, 19.5);
    assert.equal(res.runway.expiringRisk.likelyUnusedCredit, 13.5);
  } finally {
    delete process.env.CODEBUDDY_USAGE_TOKEN;
  }
});
