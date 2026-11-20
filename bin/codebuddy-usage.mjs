#!/usr/bin/env node
// CodeBuddy credit left on the account + consumed on this machine. See src/codebuddy-usage.mjs.
import { cbConfig, codebuddyUsage, saveToken } from "../src/codebuddy-usage.mjs";

const USAGE = `usage: codebuddy-usage [--json] [--refresh] [--days N]
       codebuddy-usage set-token        read the access token (JWT) from stdin, hidden on a TTY
  --refresh   skip the ${cbConfig.maxAgeSec}s cache and ask the billing API now
  --days N    local consumption window (default 7)
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

const fmt = (n) => Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 });

async function main(argv) {
  if (argv.includes("-h") || argv.includes("--help")) return console.log(USAGE);
  if (argv[0] === "set-token") {
    const { file, expiresAt } = saveToken(await readSecret());
    console.log(`saved to ${file} (mode 600)${expiresAt ? `, expires ${new Date(expiresAt).toISOString()}` : ""}`);
    return;
  }
  const di = argv.indexOf("--days");
  const r = await codebuddyUsage({ refresh: argv.includes("--refresh"), sinceDays: di >= 0 ? Number(argv[di + 1]) : 7 });
  if (argv.includes("--json")) return console.log(JSON.stringify(r, null, 2));

  const rem = r.remote.error ? r.remote.last : r.remote;
  if (r.remote.error) console.log(`remaining: unavailable (${r.remote.error})`);
  if (rem) {
    console.log(`remaining: ${fmt(rem.remain)} / ${fmt(rem.total)} credits (${rem.pct}%)  [${r.remote.error ? "last good " : ""}${rem.fetchedAt}${rem.cached ? ", cached" : ""}]`);
    for (const p of rem.packages.filter((x) => x.remain > 0)) console.log(`  ${p.name}: ${fmt(p.remain)} / ${fmt(p.size)}, until ${p.expires ?? "-"}`);
  }
  if (r.token?.expiresAt) {
    const days = Math.floor((Date.parse(r.token.expiresAt) - Date.now()) / 86_400_000);
    console.log(`token: ${r.token.source}, expires in ${days} day(s)`);
  }
  const l = r.local;
  console.log(`consumed on this machine, last ${l.sinceDays} day(s): ${fmt(l.credit)} credits over ${l.requests} requests`);
  for (const [d, c] of Object.entries(l.byDay).sort()) console.log(`  ${d}: ${fmt(c)}`);
  const tasks = Object.entries(l.byTask).sort((a, b) => b[1].credit - a[1].credit);
  if (tasks.length) console.log("by hub task:");
  for (const [id, t] of tasks) console.log(`  ${id}: ${fmt(t.credit)} credits, ${t.requests} requests, peak context ${fmt(t.peakContext)} tokens`);
}

main(process.argv.slice(2)).catch((e) => {
  console.error(`codebuddy-usage: ${e.message}`);
  process.exit(1);
});
