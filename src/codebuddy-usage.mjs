// CodeBuddy credit: what is left on the account (WorkBuddy's billing API, called with the user's
// own access token) and what this machine has consumed (both CodeBuddy CLI's local session
// transcripts under ~/.codebuddy/projects/ and swarm runner state files under <stateDir>/cb-runs/,
// deduplicated so persistent runs are never double-counted while ephemeral runs are fully captured).
// The remote request follows github.com/wwenc6621/CodeBuddy-Usage (MIT). It is read-only: no
// check-in, no reward claiming. The token is never printed, logged or written to the cache.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
  runsDir: env.CODEBUDDY_RUNS_DIR ?? join(config.stateDir, "cb-runs"),
  maxAgeSec: Number(env.CODEBUDDY_USAGE_MAX_AGE_SEC ?? 600),
  expiringSoonDays: Number(env.CODEBUDDY_EXPIRING_SOON_DAYS ?? 7),
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

const CB_RUN_FILE_RE = /^cb_[\w-]+\.json$/;
const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;
const r4 = (n) => Math.round(n * 10000) / 10000;

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

export function parsePackageExpiryMs(expires) {
  if (typeof expires !== "string" || !expires.trim()) return null;
  const s = expires.trim();
  const iso = /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?$/.test(s) ? s.replace(/\s+/, "T") : s;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export function annotateAccountSummary(summary, { now = Date.now(), expiringSoonDays = cbConfig.expiringSoonDays } = {}) {
  if (!summary || !Array.isArray(summary.packages)) return summary;
  const windowMs = Math.max(0, Number(expiringSoonDays) || 0) * 86_400_000;
  let expiringCredit = 0;
  const expiringPackages = [];
  const annotatedPackages = summary.packages.map((p) => {
    const remain = Number(p.remain ?? 0);
    const size = Number(p.size ?? 0);
    const used = r2(Math.max(0, size - remain));
    const usedPct = size > 0 ? r2((100 * used) / size) : 0;
    const expiresMs = parsePackageExpiryMs(p.expires);
    const diffMs = expiresMs != null ? expiresMs - now : null;
    const daysLeft = diffMs != null ? r1(diffMs / 86_400_000) : null;
    const expiringSoon = Boolean(remain > 0 && diffMs != null && diffMs >= 0 && diffMs <= windowMs);
    const next = { ...p, used, usedPct, daysLeft, expiringSoon };
    if (expiringSoon) {
      expiringCredit += remain;
      expiringPackages.push({ name: next.name, remain: r2(remain), size: r2(size), expires: next.expires, daysLeft });
    }
    return next;
  });
  const activePackages = annotatedPackages.filter((p) => p.remain > 0).length;
  const used = r2(Math.max(0, Number(summary.total ?? 0) - Number(summary.remain ?? 0)));
  return {
    ...summary,
    used,
    activePackages,
    packages: annotatedPackages,
    expiringSoon: {
      withinDays: Math.max(0, Number(expiringSoonDays) || 0),
      credit: r2(expiringCredit),
      count: expiringPackages.length,
      nextExpiry: expiringPackages[0]?.expires ?? null,
      nextExpiryDays: expiringPackages[0]?.daysLeft ?? null,
      packages: expiringPackages,
    },
  };
}

// Same rules as CodeBuddy-Usage: prefer the current-cycle fields (monthly packages refill next
// cycle, so future credit is not "left now"), and only packages with credit left count in total.
export function summarizeAccounts(accounts = [], { now = Date.now(), expiringSoonDays = cbConfig.expiringSoonDays } = {}) {
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
  const base = { remain: r2(remain), total: r2(total), pct: total > 0 ? r2((100 * remain) / total) : 0, packages };
  return annotateAccountSummary(base, { now, expiringSoonDays });
}

export async function fetchRemote({
  token,
  apiBase = cbConfig.apiBase,
  fetchImpl = fetch,
  timeoutMs = 15_000,
  now = Date.now(),
  expiringSoonDays = cbConfig.expiringSoonDays,
}) {
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
  return summarizeAccounts(accounts, { now, expiringSoonDays });
}

function localDayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function safeReadJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function makeTokenBucket() {
  return {
    inputTokens: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    totalTokens: 0,
  };
}

function addTokens(bucket, tok) {
  bucket.inputTokens += tok.inputTokens;
  bucket.uncachedInputTokens += tok.uncachedInputTokens;
  bucket.outputTokens += tok.outputTokens;
  bucket.reasoningTokens += tok.reasoningTokens;
  bucket.cacheReadInputTokens += tok.cacheReadInputTokens;
  bucket.cacheWriteInputTokens += tok.cacheWriteInputTokens;
  bucket.totalTokens += tok.totalTokens;
}

function cacheHitPct(inputTokens, cacheReadInputTokens) {
  if (inputTokens <= 0) return 0;
  return r2(Math.min(100, (100 * cacheReadInputTokens) / inputTokens));
}

function extractRawUsageTokens(ru) {
  const cacheRead = Number(
    ru.prompt_cache_hit_tokens ?? ru.cache_read_input_tokens ?? ru.prompt_tokens_details?.cached_tokens ?? 0,
  );
  const cacheWrite = Number(ru.cache_creation_input_tokens ?? ru.prompt_cache_write_tokens ?? 0);
  const rawPrompt = Number(ru.prompt_tokens ?? ru.input_tokens ?? 0);
  const miss = ru.prompt_cache_miss_tokens != null ? Number(ru.prompt_cache_miss_tokens) : null;
  const inputTokens =
    miss != null
      ? Math.max(rawPrompt, miss + cacheRead)
      : cacheRead > rawPrompt
        ? rawPrompt + cacheRead + cacheWrite
        : rawPrompt;
  const uncachedInputTokens = miss != null ? Math.max(0, miss) : Math.max(0, inputTokens - cacheRead);
  const outputTokens = Number(ru.completion_tokens ?? ru.output_tokens ?? 0);
  const reasoningTokens = Number(
    ru.completion_thinking_tokens ?? ru.completion_tokens_details?.reasoning_tokens ?? 0,
  );
  const totalTokens = Number(ru.total_tokens ?? inputTokens + outputTokens);
  return {
    inputTokens,
    uncachedInputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
    totalTokens,
    peakContext: rawPrompt || inputTokens,
  };
}

function extractStateUsageTokens(u) {
  const rawIn = Number(u.inputTokens ?? 0);
  const outputTokens = Number(u.outputTokens ?? 0);
  const cacheRead = Number(u.cacheReadInputTokens ?? 0);
  const cacheWrite = Number(u.cacheWriteInputTokens ?? 0);
  const reasoningTokens = Number(u.reasoningTokens ?? 0);
  // CodeBuddy CLI reports input_tokens inclusive of cache_read_input_tokens; handle both inclusive & exclusive safely.
  const inputTokens = cacheRead > rawIn ? rawIn + cacheRead + cacheWrite : rawIn;
  const uncachedInputTokens = Math.max(0, inputTokens - cacheRead);
  const totalTokens = inputTokens + outputTokens;
  return {
    inputTokens,
    uncachedInputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
    totalTokens,
    peakContext: inputTokens,
  };
}

function summarizeLatencies(samples) {
  if (!samples || samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const pick = (q) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))];
  return {
    samples: sorted.length,
    avg: Math.round(sum / sorted.length),
    p50: Math.round(pick(0.5)),
    p95: Math.round(pick(0.95)),
    max: Math.round(sorted[sorted.length - 1]),
  };
}

function buildCbBatchIndex(batchesDir) {
  const map = new Map();
  if (!batchesDir || !existsSync(batchesDir)) return map;
  for (const batchId of readdirSync(batchesDir)) {
    const rp = join(batchesDir, batchId, "results.jsonl");
    if (!existsSync(rp)) continue;
    try {
      for (const line of readFileSync(rp, "utf8").split("\n")) {
        if (!line.includes('"cb_')) continue;
        try {
          const rec = JSON.parse(line);
          if (typeof rec?.taskId === "string" && rec.taskId.startsWith("cb_")) {
            map.set(rec.taskId, batchId);
          }
        } catch {
          // ignore malformed line
        }
      }
    } catch {
      // ignore unreadable batch file
    }
  }
  return map;
}

export function readCachedExpiringCredit({
  stateDir = config.stateDir,
  cacheFile = null,
  now = Date.now(),
  expiringSoonDays = cbConfig.expiringSoonDays,
} = {}) {
  const file = cacheFile ?? join(stateDir, "codebuddy-usage.json");
  const cache = readCache(file);
  if (!cache?.remote) {
    return { credit: 0, count: 0, nextExpiryDays: null, fetchedAt: null };
  }
  const annotated = annotateAccountSummary(cache.remote, { now, expiringSoonDays });
  return {
    credit: annotated?.expiringSoon?.credit ?? 0,
    count: annotated?.expiringSoon?.count ?? 0,
    nextExpiryDays: annotated?.expiringSoon?.nextExpiryDays ?? null,
    fetchedAt: cache.fetchedAt ? new Date(cache.fetchedAt).toISOString() : null,
  };
}

// Local consumption from both ~/.codebuddy/projects/<cwd>/<sid>.jsonl (interactive CLI, hub workers,
// and persistent swarm sessions) and <stateDir>/cb-runs/cb_*.json (ephemeral swarm runs and any
// persisted swarm runs whose JSONL is no longer present). Persistent swarm runs already counted
// from JSONL are automatically deduplicated by sessionFile / sessionId / taskId.
export function localUsage({
  projectsDir = cbConfig.projectsDir,
  runsDir = cbConfig.runsDir,
  batchesDir = runsDir ? join(dirname(runsDir), "batches") : null,
  sinceMs = 0,
  topLimit = 10,
} = {}) {
  const out = {
    credit: 0,
    requests: 0,
    tasks: 0,
    creditPer1MTokens: 0,
    latencyMs: null,
    tokens: { ...makeTokenBucket(), cacheHitRatePct: 0 },
    byDay: {},
    daily: [],
    byTask: {},
    byBatch: {},
    byModel: {},
    byProfile: {},
    bySource: {
      cli: { credit: 0, requests: 0, tasks: 0 },
      hub: { credit: 0, requests: 0, tasks: 0 },
      swarm: { credit: 0, requests: 0, tasks: 0, ephemeralTasks: 0, persistentTasks: 0 },
    },
    swarmRuns: {
      total: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      ephemeral: 0,
      persistent: 0,
      zeroTokenCompleted: 0,
    },
    topSwarmTasks: [],
  };

  // Step 1: Index swarm runner state files (<stateDir>/cb-runs/cb_*.json) and batch attribution.
  const cbRuns = [];
  const cbBySessionFile = new Map();
  const cbBySessionId = new Map();
  const batchByTaskId = buildCbBatchIndex(batchesDir);
  if (runsDir && existsSync(runsDir)) {
    for (const f of readdirSync(runsDir)) {
      if (!CB_RUN_FILE_RE.test(f)) continue;
      const run = safeReadJson(join(runsDir, f));
      if (!run || typeof run.taskId !== "string") continue;
      cbRuns.push(run);
      if (run.sessionFile) cbBySessionFile.set(resolve(run.sessionFile), run);
      if (run.sessionId) cbBySessionId.set(run.sessionId, run);
      cbBySessionId.set(run.taskId, run);
    }
  }

  const allSessionKeys = new Set();
  const allDurations = [];
  const dayBuckets = new Map();
  const modelBuckets = new Map();
  const profileBuckets = new Map();
  const batchBuckets = new Map();
  const sourceSessions = {
    cli: new Set(),
    hub: new Set(),
    swarm: new Set(),
    swarmEphemeral: new Set(),
    swarmPersistent: new Set(),
  };
  const swarmTaskStats = new Map();

  function recordEvent({ ts, credit, requests = 1, model = "unknown", source = "cli", profile = "cli", sessionKey, hubTask = null, swarmRun = null, tok, durationMs = null }) {
    const day = localDayKey(ts);
    out.credit += credit;
    out.requests += requests;
    addTokens(out.tokens, tok);
    out.byDay[day] = (out.byDay[day] ?? 0) + credit;

    if (sessionKey) allSessionKeys.add(sessionKey);
    const validDur = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : null;
    if (validDur !== null) allDurations.push(validDur);

    let db = dayBuckets.get(day);
    if (!db) {
      db = { date: day, credit: 0, requests: 0, sessions: new Set(), tokens: makeTokenBucket() };
      dayBuckets.set(day, db);
    }
    db.credit += credit;
    db.requests += requests;
    if (sessionKey) db.sessions.add(sessionKey);
    addTokens(db.tokens, tok);

    const modelKey = model || "unknown";
    let mb = modelBuckets.get(modelKey);
    if (!mb) {
      mb = { credit: 0, requests: 0, sessions: new Set(), tokens: makeTokenBucket(), peakContext: 0, durations: [] };
      modelBuckets.set(modelKey, mb);
    }
    mb.credit += credit;
    mb.requests += requests;
    if (sessionKey) mb.sessions.add(sessionKey);
    addTokens(mb.tokens, tok);
    mb.peakContext = Math.max(mb.peakContext, tok.peakContext ?? 0);
    if (validDur !== null) mb.durations.push(validDur);

    const profKey = profile || source;
    let pb = profileBuckets.get(profKey);
    if (!pb) {
      pb = { credit: 0, requests: 0, sessions: new Set(), totalTokens: 0 };
      profileBuckets.set(profKey, pb);
    }
    pb.credit += credit;
    pb.requests += requests;
    if (sessionKey) pb.sessions.add(sessionKey);
    pb.totalTokens += tok.totalTokens;

    const src = out.bySource[source] ?? out.bySource.cli;
    src.credit += credit;
    src.requests += requests;
    if (sessionKey && sourceSessions[source]) {
      sourceSessions[source].add(sessionKey);
      if (source === "swarm") {
        if (swarmRun?.ephemeral) sourceSessions.swarmEphemeral.add(sessionKey);
        else sourceSessions.swarmPersistent.add(sessionKey);
      }
    }

    if (hubTask) {
      const t = (out.byTask[hubTask] ??= { credit: 0, requests: 0, peakContext: 0 });
      t.credit += credit;
      t.requests += requests;
      t.peakContext = Math.max(t.peakContext, tok.peakContext ?? 0);
    }

    if (swarmRun) {
      const batchId = batchByTaskId.get(swarmRun.taskId);
      if (batchId) {
        let bb = batchBuckets.get(batchId);
        if (!bb) {
          bb = { credit: 0, requests: 0, sessions: new Set(), totalTokens: 0 };
          batchBuckets.set(batchId, bb);
        }
        bb.credit += credit;
        bb.requests += requests;
        bb.sessions.add(swarmRun.taskId);
        bb.totalTokens += tok.totalTokens;
      }

      let st = swarmTaskStats.get(swarmRun.taskId);
      if (!st) {
        const fallbackDur =
          swarmRun.endedAt && swarmRun.startedAt ? Math.max(0, swarmRun.endedAt - swarmRun.startedAt) : null;
        st = {
          taskId: swarmRun.taskId,
          ...(batchId ? { batchId } : {}),
          model: modelKey,
          profile: swarmRun.profile ?? "lite",
          ephemeral: Boolean(swarmRun.ephemeral),
          status: swarmRun.status ?? "unknown",
          credit: 0,
          requests: 0,
          inputTokens: 0,
          cacheReadInputTokens: 0,
          totalTokens: 0,
          durationMs: durationMs ?? fallbackDur,
          startedAt: swarmRun.createdAt ?? (swarmRun.startedAt ? new Date(swarmRun.startedAt).toISOString() : null),
        };
        swarmTaskStats.set(swarmRun.taskId, st);
      }
      st.credit += credit;
      st.requests += requests;
      st.inputTokens += tok.inputTokens;
      st.cacheReadInputTokens += tok.cacheReadInputTokens;
      st.totalTokens += tok.totalTokens;
      if (modelKey !== "unknown") st.model = modelKey;
    }
  }

  // Step 2: Scan CodeBuddy CLI JSONL session transcripts (~/.codebuddy/projects/<cwd>/<sid>.jsonl).
  const ingestedCbTaskIds = new Set();
  if (projectsDir && existsSync(projectsDir)) {
    for (const dir of readdirSync(projectsDir)) {
      const full = join(projectsDir, dir);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      const hubTask = dir.match(/work-(T\d{8}-\d{6}-[a-z0-9]+)$/)?.[1] ?? null;
      for (const f of readdirSync(full).filter((n) => n.endsWith(".jsonl"))) {
        const filePath = join(full, f);
        try {
          if (statSync(filePath).mtimeMs < sinceMs) continue;
        } catch {
          continue;
        }
        const stem = f.slice(0, -6);
        let matchedCb = cbBySessionFile.get(resolve(filePath)) ?? cbBySessionId.get(stem) ?? null;
        const seen = new Set();
        for (const line of readFileSync(filePath, "utf8").split("\n")) {
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
          if (!matchedCb && typeof x.sessionId === "string") {
            matchedCb = cbBySessionId.get(x.sessionId) ?? null;
          }
          if (matchedCb) ingestedCbTaskIds.add(matchedCb.taskId);

          const c = Number(p.rawUsage.credit ?? 0);
          const tok = extractRawUsageTokens(p.rawUsage);
          const model =
            p.model ?? p.requestModelId ?? x.message?.model ?? matchedCb?.actualModel ?? matchedCb?.model ?? "unknown";
          const source = matchedCb ? "swarm" : hubTask ? "hub" : "cli";
          const profile = matchedCb?.profile ?? (hubTask ? "hub" : "cli");
          const sessionKey = matchedCb
            ? `swarm:${matchedCb.taskId}`
            : hubTask
              ? `hub:${hubTask}`
              : `cli:${dir}/${stem}`;
          recordEvent({
            ts: x.timestamp,
            credit: c,
            requests: 1,
            model,
            source,
            profile,
            sessionKey,
            hubTask,
            swarmRun: matchedCb,
            tok,
          });
        }
      }
    }
  }

  // Step 3: Ingest swarm runner state files not already counted from JSONL (especially ephemeral runs).
  for (const run of cbRuns) {
    const runTs = run.endedAt ?? run.startedAt ?? 0;
    if (runTs >= sinceMs) {
      out.swarmRuns.total++;
      if (run.status === "completed") out.swarmRuns.completed++;
      else if (run.status === "failed") out.swarmRuns.failed++;
      else if (run.status === "cancelled") out.swarmRuns.cancelled++;
      if (run.ephemeral) out.swarmRuns.ephemeral++;
      else out.swarmRuns.persistent++;
      if (
        run.status === "completed" &&
        Number(run.usage?.totalTokens ?? 0) === 0 &&
        Number(run.usage?.credit ?? 0) === 0
      ) {
        out.swarmRuns.zeroTokenCompleted++;
      }
    }

    if (ingestedCbTaskIds.has(run.taskId)) continue;

    const turns =
      Array.isArray(run.turns) && run.turns.length > 0
        ? run.turns
        : run.usage
          ? [
              {
                startedAt: run.startedAt,
                endedAt: run.endedAt,
                durationMs: run.endedAt && run.startedAt ? Math.max(0, run.endedAt - run.startedAt) : null,
                usage: run.usage,
              },
            ]
          : [];

    for (const turn of turns) {
      const ts = turn.endedAt ?? turn.startedAt ?? runTs;
      if (!ts || ts < sinceMs) continue;
      const u = turn.usage;
      if (!u) continue;
      const c = Number(u.credit ?? 0);
      const reqs = Number(u.modelRequests ?? 0);
      const tok = extractStateUsageTokens(u);
      if (reqs === 0 && c === 0 && tok.totalTokens === 0) continue;
      const model = run.actualModel || run.model || "unknown";
      recordEvent({
        ts,
        credit: c,
        requests: reqs > 0 ? reqs : 1,
        model,
        source: "swarm",
        profile: run.profile ?? "lite",
        sessionKey: `swarm:${run.taskId}`,
        swarmRun: run,
        tok,
        durationMs: Number.isFinite(turn.durationMs) ? turn.durationMs : null,
      });
    }
  }

  // Finalize & round all aggregates cleanly.
  out.credit = r2(out.credit);
  out.tasks = allSessionKeys.size;
  out.creditPer1MTokens = out.tokens.totalTokens > 0 ? r2((out.credit * 1_000_000) / out.tokens.totalTokens) : 0;
  out.latencyMs = summarizeLatencies(allDurations);
  out.tokens.cacheHitRatePct = cacheHitPct(out.tokens.inputTokens, out.tokens.cacheReadInputTokens);

  for (const k of Object.keys(out.byDay)) out.byDay[k] = r2(out.byDay[k]);
  for (const t of Object.values(out.byTask)) t.credit = r2(t.credit);

  const sortedBatches = [...batchBuckets.entries()].sort((a, b) => b[1].credit - a[1].credit || b[1].requests - a[1].requests);
  for (const [bid, bb] of sortedBatches) {
    const tasks = bb.sessions.size;
    out.byBatch[bid] = {
      credit: r2(bb.credit),
      tasks,
      requests: bb.requests,
      avgCreditPerTask: tasks > 0 ? r4(bb.credit / tasks) : 0,
      totalTokens: bb.totalTokens,
    };
  }

  out.daily = [...dayBuckets.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((db) => ({
      date: db.date,
      credit: r2(db.credit),
      requests: db.requests,
      tasks: db.sessions.size,
      inputTokens: db.tokens.inputTokens,
      outputTokens: db.tokens.outputTokens,
      cacheReadInputTokens: db.tokens.cacheReadInputTokens,
      totalTokens: db.tokens.totalTokens,
      cacheHitRatePct: cacheHitPct(db.tokens.inputTokens, db.tokens.cacheReadInputTokens),
    }));

  const sortedModels = [...modelBuckets.entries()].sort((a, b) => b[1].credit - a[1].credit || b[1].requests - a[1].requests);
  for (const [m, mb] of sortedModels) {
    const tasks = mb.sessions.size;
    out.byModel[m] = {
      credit: r2(mb.credit),
      requests: mb.requests,
      tasks,
      avgCreditPerTask: tasks > 0 ? r4(mb.credit / tasks) : 0,
      avgCreditPerRequest: mb.requests > 0 ? r4(mb.credit / mb.requests) : 0,
      creditPer1MTokens: mb.tokens.totalTokens > 0 ? r2((mb.credit * 1_000_000) / mb.tokens.totalTokens) : 0,
      latencyMs: summarizeLatencies(mb.durations),
      inputTokens: mb.tokens.inputTokens,
      uncachedInputTokens: mb.tokens.uncachedInputTokens,
      outputTokens: mb.tokens.outputTokens,
      reasoningTokens: mb.tokens.reasoningTokens,
      cacheReadInputTokens: mb.tokens.cacheReadInputTokens,
      totalTokens: mb.tokens.totalTokens,
      cacheHitRatePct: cacheHitPct(mb.tokens.inputTokens, mb.tokens.cacheReadInputTokens),
      peakContext: mb.peakContext,
    };
  }

  const sortedProfiles = [...profileBuckets.entries()].sort((a, b) => b[1].credit - a[1].credit || b[1].requests - a[1].requests);
  for (const [p, pb] of sortedProfiles) {
    const tasks = pb.sessions.size;
    out.byProfile[p] = {
      credit: r2(pb.credit),
      requests: pb.requests,
      tasks,
      avgCreditPerTask: tasks > 0 ? r4(pb.credit / tasks) : 0,
      totalTokens: pb.totalTokens,
    };
  }

  out.bySource.cli.credit = r2(out.bySource.cli.credit);
  out.bySource.cli.tasks = sourceSessions.cli.size;
  out.bySource.hub.credit = r2(out.bySource.hub.credit);
  out.bySource.hub.tasks = sourceSessions.hub.size;
  out.bySource.swarm.credit = r2(out.bySource.swarm.credit);
  out.bySource.swarm.tasks = sourceSessions.swarm.size;
  out.bySource.swarm.ephemeralTasks = sourceSessions.swarmEphemeral.size;
  out.bySource.swarm.persistentTasks = sourceSessions.swarmPersistent.size;

  out.topSwarmTasks = [...swarmTaskStats.values()]
    .sort((a, b) => b.credit - a.credit || b.totalTokens - a.totalTokens)
    .slice(0, Math.max(0, topLimit))
    .map((st) => ({
      taskId: st.taskId,
      ...(st.batchId ? { batchId: st.batchId } : {}),
      model: st.model,
      profile: st.profile,
      ephemeral: st.ephemeral,
      status: st.status,
      credit: r4(st.credit),
      requests: st.requests,
      totalTokens: st.totalTokens,
      cacheHitRatePct: cacheHitPct(st.inputTokens, st.cacheReadInputTokens),
      durationMs: st.durationMs,
      startedAt: st.startedAt,
    }));

  return out;
}

export function computeRunway(remote, local, { sinceDays = 7 } = {}) {
  const rem = remote?.error ? remote.last : remote;
  const windowDays = Math.max(1, Number(sinceDays) || 7);
  const activeDays = Object.values(local?.byDay ?? {}).filter((c) => Number(c) > 0).length;
  const avgDailyCredit = r2((local?.credit ?? 0) / windowDays);
  const activeDayAvgCredit = activeDays > 0 ? r2((local?.credit ?? 0) / activeDays) : 0;
  const remainingCredit = rem && Number.isFinite(rem.remain) ? rem.remain : null;
  const estimatedDaysRemaining =
    remainingCredit != null && avgDailyCredit > 0 ? r1(remainingCredit / avgDailyCredit) : null;
  const estimatedActiveDaysRemaining =
    remainingCredit != null && activeDayAvgCredit > 0 ? r1(remainingCredit / activeDayAvgCredit) : null;

  const estimatedTasksRemainingByModel = {};
  if (remainingCredit != null && local?.byModel) {
    for (const [model, stats] of Object.entries(local.byModel)) {
      if (stats.avgCreditPerTask > 0) {
        estimatedTasksRemainingByModel[model] = {
          avgCreditPerTask: stats.avgCreditPerTask,
          estimatedTasksRemaining: Math.floor(remainingCredit / stats.avgCreditPerTask),
        };
      }
    }
  }

  let expiringRisk = null;
  if (rem?.expiringSoon?.credit > 0 && rem.expiringSoon.nextExpiryDays != null) {
    const pace = Math.max(avgDailyCredit, activeDayAvgCredit);
    const projectedUse = r2(pace * Math.max(0, rem.expiringSoon.nextExpiryDays));
    expiringRisk = {
      expiringCredit: rem.expiringSoon.credit,
      nextExpiry: rem.expiringSoon.nextExpiry,
      nextExpiryDays: rem.expiringSoon.nextExpiryDays,
      likelyUnusedCredit: r2(Math.max(0, rem.expiringSoon.credit - projectedUse)),
    };
  }

  return {
    windowDays,
    activeDays,
    avgDailyCredit,
    activeDayAvgCredit,
    estimatedDaysRemaining,
    estimatedActiveDaysRemaining,
    expiringRisk,
    estimatedTasksRemainingByModel,
  };
}

function readCache(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Remaining (cached for maxAgeSec unless refresh) + local consumption + runway forecast. Never
// throws for a remote failure: `remote.error` says what went wrong and `remote.last` keeps the last
// good reading.
export async function codebuddyUsage({
  refresh = false,
  maxAgeSec = cbConfig.maxAgeSec,
  sinceDays = 7,
  expiringSoonDays = cbConfig.expiringSoonDays,
  projectsDir = cbConfig.projectsDir,
  runsDir = cbConfig.runsDir,
  fetchImpl,
  now = Date.now(),
} = {}) {
  const local = localUsage({ projectsDir, runsDir, sinceMs: now - sinceDays * 86_400_000 });
  const cache = readCache(cbConfig.cacheFile);
  let remote;
  let tokenInfo = null;
  try {
    const tok = readToken();
    if (tok) tokenInfo = { source: tok.source, expiresAt: tok.expiresAt ? new Date(tok.expiresAt).toISOString() : null };
    if (!refresh && cache?.fetchedAt && now - cache.fetchedAt < maxAgeSec * 1000) {
      remote = {
        ...annotateAccountSummary(cache.remote, { now, expiringSoonDays }),
        fetchedAt: new Date(cache.fetchedAt).toISOString(),
        cached: true,
      };
    } else if (!tok) {
      throw new Error(`no access token: set CODEBUDDY_USAGE_TOKEN or run \`codebuddy-usage set-token\` (file ${cbConfig.tokenFile})`);
    } else {
      const r = await fetchRemote({ token: tok.token, fetchImpl, now, expiringSoonDays });
      mkdirSync(dirname(cbConfig.cacheFile), { recursive: true });
      writeFileSync(cbConfig.cacheFile, JSON.stringify({ fetchedAt: now, remote: r }));
      remote = { ...r, fetchedAt: new Date(now).toISOString(), cached: false };
    }
  } catch (e) {
    remote = {
      error: e.message,
      last: cache?.remote
        ? { ...annotateAccountSummary(cache.remote, { now, expiringSoonDays }), fetchedAt: new Date(cache.fetchedAt).toISOString() }
        : null,
    };
  }
  const localWithWindow = { sinceDays, ...local };
  const runway = computeRunway(remote, localWithWindow, { sinceDays });
  return { remote, token: tokenInfo, local: localWithWindow, runway };
}
