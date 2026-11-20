// CodeBuddy credit: what is left on the account (WorkBuddy's billing API, called with the user's
// own access token) and what this machine has consumed (the CodeBuddy CLI's local session transcripts).
// The remote request follows github.com/wwenc6621/CodeBuddy-Usage (MIT). It is read-only: no
// check-in, no reward claiming. The token is never printed, logged or written to the cache.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { config } from "./config.mjs";

const env = process.env;

export const cbConfig = {
  apiBase: (env.CODEBUDDY_API_BASE ?? "https://www.workbuddy.cn").replace(/\/$/, ""), // intl: https://www.workbuddy.ai
  tokenFile: env.CODEBUDDY_TOKEN_FILE ?? join(config.stateDir, "codebuddy-token"),
  // The CodeBuddy CLI's own login (the user allowed reusing it). The CLI refreshes it; we only read.
  cliAuthFile:
    env.CODEBUDDY_AUTH_FILE ??
    join(
      homedir(),
      ...(process.platform === "darwin" ? ["Library", "Application Support"] : [".local", "share"]),
      "CodeBuddyExtension", "Data", "Public", "auth", "Tencent-Cloud.coding-copilot.info",
    ),
  cacheFile: join(config.stateDir, "codebuddy-usage.json"),
  projectsDir: env.CODEBUDDY_PROJECTS_DIR ?? join(homedir(), ".codebuddy", "projects"),
  maxAgeSec: Number(env.CODEBUDDY_USAGE_MAX_AGE_SEC ?? 600),
};

// Package codes the billing page asks for (copied from CodeBuddy-Usage; update if packages go missing).
const PACKAGE_CODES = [
  "TCACA_code_008_cfWoLwvjU4",
  "TCACA_code_009_0XmEQc2xOf",
  "TCACA_code_038_OhvqZtiPKr",
  "TCACA_code_007_nzdH5h4Nl0",
  "TCACA_code_028_NtpWi0jzXs",
  "TCACA_code_029_6wCGEWquYy",
  "TCACA_code_030_BjSt89qTvr",
];
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

function jwtExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

const isJwt = (t) => /^[\w-]+\.[\w-]+\.[\w-]+$/.test(t);

// Never calls the refresh endpoint: that would rotate the refresh token under the CLI and log it out.
function readCliLogin(file) {
  if (!existsSync(file)) return null;
  const auth = JSON.parse(readFileSync(file, "utf8"))?.auth;
  const token = auth?.accessToken;
  // On platforms where the CLI encrypts credential fields the value is not a JWT; we can't use it.
  if (typeof token !== "string" || !isJwt(token)) return null;
  return { token, source: "codebuddy CLI login", expiresAt: typeof auth.expiresAt === "number" ? auth.expiresAt : jwtExpiry(token) };
}

// Token from CODEBUDDY_USAGE_TOKEN, the token file (which must not be group/world readable), or
// the CodeBuddy CLI's own login, in that order.
export function readToken({ envToken = env.CODEBUDDY_USAGE_TOKEN, file = cbConfig.tokenFile, cliFile = cbConfig.cliAuthFile } = {}) {
  let token = envToken?.trim();
  let source = "env CODEBUDDY_USAGE_TOKEN";
  if (!token && existsSync(file)) {
    if (process.platform !== "win32" && statSync(file).mode & 0o077) throw new Error(`${file} is readable by others; run: chmod 600 ${file}`);
    token = readFileSync(file, "utf8").trim();
    source = file;
  }
  token = token?.replace(/^bearer\s+/i, "");
  if (token) return { token, source, expiresAt: jwtExpiry(token) };
  return cliFile ? readCliLogin(cliFile) : null;
}

export function saveToken(token, file = cbConfig.tokenFile) {
  const t = String(token ?? "").trim().replace(/^bearer\s+/i, "");
  if (!t) throw new Error("empty token");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, t + "\n", { mode: 0o600 });
  return { file, expiresAt: jwtExpiry(t) };
}

const num = (s) => parseFloat(s ?? "0") || 0;

// Same rules as CodeBuddy-Usage: prefer the current-cycle fields (monthly packages refill next
// cycle, so future credit is not "left now"), and only packages with credit left count in total.
export function summarizeAccounts(accounts = []) {
  let remain = 0;
  let total = 0;
  const packages = [];
  for (const a of accounts) {
    const cycle = a.CycleCapacityRemainPrecise != null && a.CycleCapacitySizePrecise != null;
    const r = num(cycle ? a.CycleCapacityRemainPrecise : a.CapacityRemainPrecise);
    const s = num(cycle ? a.CycleCapacitySizePrecise : a.CapacitySizePrecise);
    remain += r;
    if (r > 0) total += s;
    packages.push({ name: a.PackageName ?? "-", remain: r, size: s, expires: a.CycleEndTime ?? null });
  }
  packages.sort((x, y) => (y.remain > 0) - (x.remain > 0) || String(x.expires).localeCompare(String(y.expires)));
  const round = (n) => Math.round(n * 100) / 100;
  return { remain: round(remain), total: round(total), pct: total > 0 ? round((100 * remain) / total) : 0, packages };
}

export async function fetchRemote({ token, apiBase = cbConfig.apiBase, fetchImpl = fetch, timeoutMs = 15_000 }) {
  const resp = await fetchImpl(`${apiBase}/billing/meter/get-user-resource`, {
    method: "POST",
    headers: {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json",
      origin: apiBase,
      referer: `${apiBase}/profile/plans-usage`,
      "x-client-platform": "web",
      "user-agent": USER_AGENT,
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      PageNumber: 1,
      PageSize: 200,
      ProductCode: "p_tcaca",
      Status: [0, 3],
      OnlyValidPeriod: true,
      PackageCodes: PACKAGE_CODES,
      NeedInUsage: true,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (resp.status === 401) throw new Error("token rejected (401): expired or invalid, set a new one");
  if (!resp.ok) throw new Error(`billing API HTTP ${resp.status}`);
  const json = await resp.json();
  const r = json?.data?.Response;
  if (r?.Error) throw new Error(`billing API error: ${r.Error.Code ?? ""} ${r.Error.Message ?? ""}`.trim());
  const accounts = r?.Data?.Accounts;
  if (!Array.isArray(accounts)) throw new Error("billing API: unexpected response shape");
  return summarizeAccounts(accounts);
}

// Credit consumed per day and per hub task, from ~/.codebuddy/projects/<cwd>/<sid>.jsonl. Each
// model request carries providerData.rawUsage (credit, prompt_tokens = context size at that step);
// one request can span several lines, so dedupe by messageId.
export function localUsage({ projectsDir = cbConfig.projectsDir, sinceMs = 0 } = {}) {
  const out = { credit: 0, requests: 0, byDay: {}, byTask: {} };
  if (!existsSync(projectsDir)) return out;
  for (const dir of readdirSync(projectsDir)) {
    const full = join(projectsDir, dir);
    if (!statSync(full).isDirectory()) continue;
    const task = dir.match(/work-(T\d{8}-\d{6}-[a-z0-9]+)$/)?.[1] ?? null;
    for (const f of readdirSync(full).filter((n) => n.endsWith(".jsonl"))) {
      if (statSync(join(full, f)).mtimeMs < sinceMs) continue;
      const seen = new Set();
      for (const line of readFileSync(join(full, f), "utf8").split("\n")) {
        if (!line.includes('"rawUsage"')) continue;
        let x;
        try {
          x = JSON.parse(line);
        } catch {
          continue;
        }
        const p = x.providerData;
        if (!p?.rawUsage || !p.messageId || seen.has(p.messageId) || (x.timestamp ?? 0) < sinceMs) continue;
        seen.add(p.messageId);
        const c = p.rawUsage.credit ?? 0;
        const d = new Date(x.timestamp);
        const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        out.credit += c;
        out.requests++;
        out.byDay[day] = (out.byDay[day] ?? 0) + c;
        if (task) {
          const t = (out.byTask[task] ??= { credit: 0, requests: 0, peakContext: 0 });
          t.credit += c;
          t.requests++;
          t.peakContext = Math.max(t.peakContext, p.rawUsage.prompt_tokens ?? 0);
        }
      }
    }
  }
  const r2 = (n) => Math.round(n * 100) / 100;
  out.credit = r2(out.credit);
  for (const k of Object.keys(out.byDay)) out.byDay[k] = r2(out.byDay[k]);
  for (const t of Object.values(out.byTask)) t.credit = r2(t.credit);
  return out;
}

function readCache(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Remaining (cached for maxAgeSec unless refresh) + local consumption. Never throws for a remote
// failure: `remote.error` says what went wrong and `remote.last` keeps the last good reading.
export async function codebuddyUsage({ refresh = false, maxAgeSec = cbConfig.maxAgeSec, sinceDays = 7, fetchImpl, now = Date.now() } = {}) {
  const local = localUsage({ sinceMs: now - sinceDays * 86_400_000 });
  const cache = readCache(cbConfig.cacheFile);
  let remote;
  let tokenInfo = null;
  try {
    const tok = readToken();
    if (tok) tokenInfo = { source: tok.source, expiresAt: tok.expiresAt ? new Date(tok.expiresAt).toISOString() : null };
    if (!refresh && cache?.fetchedAt && now - cache.fetchedAt < maxAgeSec * 1000) {
      remote = { ...cache.remote, fetchedAt: new Date(cache.fetchedAt).toISOString(), cached: true };
    } else if (!tok) {
      throw new Error(`no access token: set CODEBUDDY_USAGE_TOKEN or run \`codebuddy-usage set-token\` (file ${cbConfig.tokenFile})`);
    } else {
      const r = await fetchRemote({ token: tok.token, fetchImpl });
      mkdirSync(dirname(cbConfig.cacheFile), { recursive: true });
      writeFileSync(cbConfig.cacheFile, JSON.stringify({ fetchedAt: now, remote: r }));
      remote = { ...r, fetchedAt: new Date(now).toISOString(), cached: false };
    }
  } catch (e) {
    remote = { error: e.message, last: cache?.remote ? { ...cache.remote, fetchedAt: new Date(cache.fetchedAt).toISOString() } : null };
  }
  return { remote, token: tokenInfo, local: { sinceDays, ...local } };
}
