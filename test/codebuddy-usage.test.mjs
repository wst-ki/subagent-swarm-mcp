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
