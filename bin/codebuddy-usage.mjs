#!/usr/bin/env node
// CodeBuddy credit left on the account + consumed on this machine (CLI transcripts + swarm cb-runs).
// See src/codebuddy-usage.mjs.
import { exitAfterFlush } from "../src/cli-io.mjs";
import { cbConfig, codebuddyUsage, saveToken } from "../src/codebuddy-usage.mjs";

const USAGE = `usage: codebuddy-usage [--json] [--refresh] [--days N] [--expiring-days N] [--runs-dir DIR] [--top N]
       codebuddy-usage set-token        read the access token (JWT) from stdin, hidden on a TTY
  --refresh           skip the ${cbConfig.maxAgeSec}s cache and ask the billing API now
  --days N            local consumption window (default 7)
  --expiring-days N   highlight active packages expiring within N days (default ${cbConfig.expiringSoonDays})
  --runs-dir DIR      override swarm cb-runs directory (default ${cbConfig.runsDir})
  --top N             max hub/swarm tasks shown in text summary (default 10)
token: CODEBUDDY_USAGE_TOKEN, else CODEBUDDY_TOKEN_FILE (default ${cbConfig.tokenFile}),
       else the CodeBuddy CLI login (${cbConfig.cliAuthFile})
env: CODEBUDDY_API_BASE`;

async function readSecret() {
  const { stdin, stderr } = process;
  if (!stdin.isTTY) {
    let s = "";
    for await (const c of stdin) s += c;
    return s;
  }
  stderr.write("access token (input hidden): ");
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let s = "";
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          stdin.setRawMode(false);
          stdin.off("data", onData);
          stdin.pause();
          stderr.write("\n");
          return resolve(s);
        }
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          stderr.write("\n");
          return reject(new Error("cancelled"));
        }
        if (ch === "\u007f") s = s.slice(0, -1);
        else s += ch;
      }
    };
    stdin.on("data", onData);
  });
}

const fmt = (n, maxFrac = 2) => Number(n ?? 0).toLocaleString("en-US", { maximumFractionDigits: maxFrac });

function flagVal(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  if (i + 1 >= argv.length) throw new Error(`${name} requires a value`);
  return argv[i + 1];
}

async function main(argv) {
  if (argv.includes("-h") || argv.includes("--help")) {
    await exitAfterFlush(process.stdout, `${USAGE}\n`, 0);
    return;
  }
  if (argv[0] === "set-token") {
    const { file, expiresAt } = saveToken(await readSecret());
    await exitAfterFlush(
      process.stdout,
      `saved to ${file} (mode 600)${expiresAt ? `, expires ${new Date(expiresAt).toISOString()}` : ""}\n`,
      0,
    );
    return;
  }

  const daysRaw = flagVal(argv, "--days");
  const expRaw = flagVal(argv, "--expiring-days");
  const runsDir = flagVal(argv, "--runs-dir");
  const topRaw = flagVal(argv, "--top");

  const sinceDays = daysRaw !== undefined ? Number(daysRaw) : 7;
  const expiringSoonDays = expRaw !== undefined ? Number(expRaw) : cbConfig.expiringSoonDays;
  const topN = topRaw !== undefined ? Math.max(0, Number(topRaw)) : 10;

  const r = await codebuddyUsage({
    refresh: argv.includes("--refresh"),
    sinceDays,
    expiringSoonDays,
    ...(runsDir ? { runsDir } : {}),
  });

  if (argv.includes("--json")) {
    await exitAfterFlush(process.stdout, JSON.stringify(r, null, 2) + "\n", 0);
    return;
  }

  const lines = [];
  const rem = r.remote.error ? r.remote.last : r.remote;
  if (r.remote.error) lines.push(`remaining: unavailable (${r.remote.error})`);
  if (rem) {
    lines.push(
      `remaining: ${fmt(rem.remain)} / ${fmt(rem.total)} credits (${rem.pct}%, used ${fmt(rem.used)})  [${r.remote.error ? "last good " : ""}${rem.fetchedAt}${rem.cached ? ", cached" : ""}]`,
    );
    if (rem.expiringSoon?.credit > 0) {
      lines.push(
        `  WARNING: ${fmt(rem.expiringSoon.credit)} credits across ${rem.expiringSoon.count} package(s) expire within ${rem.expiringSoon.withinDays} day(s) (earliest: ${rem.expiringSoon.nextExpiry}, ${rem.expiringSoon.nextExpiryDays}d left)`,
      );
    }
    for (const p of rem.packages.filter((x) => x.remain > 0)) {
      const badge = p.expiringSoon ? ` [EXPIRING SOON: ${p.daysLeft}d left]` : p.daysLeft != null ? ` (${p.daysLeft}d left)` : "";
      lines.push(`  ${p.name}: ${fmt(p.remain)} / ${fmt(p.size)}, until ${p.expires ?? "-"}${badge}`);
    }
  }
  if (r.token?.expiresAt) {
    const days = Math.floor((Date.parse(r.token.expiresAt) - Date.now()) / 86_400_000);
    lines.push(`token: ${r.token.source}, expires in ${days} day(s)`);
  }

  const l = r.local;
  const tok = l.tokens;
  lines.push(
    `consumed on this machine, last ${l.sinceDays} day(s): ${fmt(l.credit)} credits over ${fmt(l.requests, 0)} requests (${fmt(l.tasks, 0)} tasks)`,
  );
  lines.push(
    `  sources: cli=${fmt(l.bySource.cli.credit)} (${l.bySource.cli.tasks}t/${l.bySource.cli.requests}r), hub=${fmt(l.bySource.hub.credit)} (${l.bySource.hub.tasks}t/${l.bySource.hub.requests}r), swarm=${fmt(l.bySource.swarm.credit)} (${l.bySource.swarm.tasks}t: ${l.bySource.swarm.ephemeralTasks} ephemeral, ${l.bySource.swarm.persistentTasks} persistent)`,
  );
  lines.push(
    `  tokens: total=${fmt(tok.totalTokens, 0)} (input=${fmt(tok.inputTokens, 0)}, cache_hit=${fmt(tok.cacheReadInputTokens, 0)} [${tok.cacheHitRatePct}%], output=${fmt(tok.outputTokens, 0)}${tok.reasoningTokens > 0 ? `, reasoning=${fmt(tok.reasoningTokens, 0)}` : ""})`,
  );

  if (r.runway) {
    const rw = r.runway;
    lines.push(
      `  burn rate: ${fmt(rw.avgDailyCredit)}/day (${rw.windowDays}d avg), ${fmt(rw.activeDayAvgCredit)}/active-day (${rw.activeDays} active d)` +
        (rw.estimatedDaysRemaining != null ? `, runway ~${rw.estimatedDaysRemaining}d` : ""),
    );
  }

  const models = Object.entries(l.byModel);
  if (models.length) {
    lines.push("by model:");
    for (const [m, s] of models) {
      const remEst = r.runway?.estimatedTasksRemainingByModel?.[m]?.estimatedTasksRemaining;
      const lat = s.latencyMs ? `, p50=${(s.latencyMs.p50 / 1000).toFixed(1)}s/p95=${(s.latencyMs.p95 / 1000).toFixed(1)}s` : "";
      lines.push(
        `  ${m}: ${fmt(s.credit)} credits, ${s.tasks} tasks (${fmt(s.avgCreditPerTask, 4)}/task, ${fmt(s.creditPer1MTokens)}/1M tok), ${s.requests} reqs, ${fmt(s.totalTokens, 0)} tok (${s.cacheHitRatePct}% cache hit)${lat}` +
          (remEst != null ? `, ~${fmt(remEst, 0)} tasks left` : ""),
      );
    }
  }

  const batches = Object.entries(l.byBatch ?? {});
  if (batches.length && topN > 0) {
    lines.push(`by batch (showing ${Math.min(topN, batches.length)} of ${batches.length}):`);
    for (const [bid, b] of batches.slice(0, topN)) {
      lines.push(
        `  ${bid}: ${fmt(b.credit)} credits, ${b.tasks} tasks (${fmt(b.avgCreditPerTask, 4)}/task), ${fmt(b.totalTokens, 0)} tok`,
      );
    }
  }

  const profiles = Object.entries(l.byProfile);
  if (profiles.length) {
    lines.push("by profile:");
    for (const [p, s] of profiles) {
      lines.push(`  ${p}: ${fmt(s.credit)} credits, ${s.tasks} tasks (${fmt(s.avgCreditPerTask, 4)}/task), ${fmt(s.totalTokens, 0)} tok`);
    }
  }

  if (l.daily.length) {
    lines.push("by day:");
    for (const d of l.daily) {
      lines.push(
        `  ${d.date}: ${fmt(d.credit)} credits, ${d.tasks} tasks, ${d.requests} reqs, ${fmt(d.totalTokens, 0)} tok (${d.cacheHitRatePct}% cache hit)`,
      );
    }
  }

  const hubTasks = Object.entries(l.byTask).sort((a, b) => b[1].credit - a[1].credit);
  if (hubTasks.length && topN > 0) {
    lines.push(`top hub tasks (showing ${Math.min(topN, hubTasks.length)} of ${hubTasks.length}):`);
    for (const [id, t] of hubTasks.slice(0, topN)) {
      lines.push(`  ${id}: ${fmt(t.credit)} credits, ${t.requests} requests, peak context ${fmt(t.peakContext, 0)} tokens`);
    }
  }

  if (l.topSwarmTasks.length && topN > 0) {
    const shown = l.topSwarmTasks.slice(0, topN);
    lines.push(`top swarm tasks (showing ${shown.length} of ${l.swarmRuns.total} recorded runs):`);
    for (const t of shown) {
      lines.push(
        `  ${t.taskId} [${t.model}, ${t.profile}${t.ephemeral ? ", ephemeral" : ""}]: ${fmt(t.credit, 4)} credits, ${fmt(t.totalTokens, 0)} tok (${t.cacheHitRatePct}% cache hit)`,
      );
    }
  }

  await exitAfterFlush(process.stdout, lines.join("\n") + "\n", 0);
}

main(process.argv.slice(2)).catch(async (e) => {
  await exitAfterFlush(process.stderr, `codebuddy-usage: ${e.message}\n`, 1);
});
