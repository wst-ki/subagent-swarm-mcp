#!/usr/bin/env node
// Unified shell front end for multi-CLI subagents (codebuddy, zcode, auto).
// Mirrors the MCP swarm_* tools and prints structured JSON to stdout.
import "../src/silence.mjs";
import { exitAfterFlush, readTextFileWithRetry, writeJsonFileAtomic } from "../src/cli-io.mjs";
import {
  listBackends,
  swarmCancel,
  swarmFollowUp,
  swarmList,
  swarmQuota,
  swarmResult,
  swarmRun,
  swarmStatus,
  swarmWait,
} from "../src/backends/registry.mjs";
import { TASK_SPECS, runStructured, structuredResult } from "../src/structured.mjs";
import { exportBatchValidItems, readBatchStatus, runStructuredBatch } from "../src/batch.mjs";

const USAGE = `usage: swarm <command>
  backends                 inspect registered backends (codebuddy, qoder, zcode) and health
  run (--file F | --text T | stdin) [--backend auto|codebuddy|qoder|zcode] [--profile lite|readonly|workspace]
      [--cwd DIR] [--model M] [--fallback-model M] [--provider KEY] [--effort minimal|low|medium|high|xhigh|max]
      [--max-turns N] [--system-prompt TEXT] [--append-system-prompt TEXT] [--add-dir D1,D2] [--ephemeral] [--wait [SEC]]
  run-structured --task T --schema JSON_OR_FILE --input JSON_OR_FILE [--domain-rule R]
      [--backend auto|codebuddy|qoder|zcode] [--profile P] [--cwd DIR] [--model M] [--effort L] [--max-turns N] [--ephemeral] [--wait [SEC]]
  structured-result <taskId> [--domain-rule R]
  batch --id ID --spec PRESET_OR_FILE --input JSONL_FILE [--limit N] [--microbatch K] [--retries 0|1]
      [--backend auto|codebuddy|qoder|zcode] [--profile P] [--cwd DIR] [--model M] [--provider KEY] [--effort L] [--max-turns N]
      [--concurrency N] [--reserve-slots N] [--max-credit N] [--max-batch-chars N] [--timeout-ms MS]
      [--capacity-wait-ms MS] [--state-dir DIR] [--ephemeral] [--export OUT_FILE] [--summary OUT_FILE] [--compact]
  batch-status <batchId> [--state-dir DIR] [--compact]
  batch-export <batchId> [--out FILE] [--spec PRESET_OR_FILE] [--input JSONL_FILE] [--state-dir DIR] [--compact]
  wait <taskId> [timeoutSec]
  status <taskId>
  result <taskId>
  followup <taskId> (--file F | --text T | stdin) [--model M] [--fallback-model M] [--effort L] [--max-turns N]
  cancel <taskId>
  list [N] [--backend all|codebuddy|qoder|zcode]
  quota [--backend all|codebuddy|qoder|zcode] [--refresh] [--days N]`;

const VALUE_FLAGS = new Set([
  "--file",
  "--text",
  "--backend",
  "--profile",
  "--cwd",
  "--model",
  "--fallback-model",
  "--provider",
  "--effort",
  "--max-turns",
  "--system-prompt",
  "--append-system-prompt",
  "--add-dir",
  "--task",
  "--schema",
  "--input",
  "--domain-rule",
  "--id",
  "--spec",
  "--limit",
  "--microbatch",
  "--retries",
  "--concurrency",
  "--reserve-slots",
  "--max-credit",
  "--max-batch-chars",
  "--timeout-ms",
  "--capacity-wait-ms",
  "--state-dir",
  "--summary",
  "--export",
  "--out",
  "--days",
]);

class CliUsageError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

const [cmd, ...rest] = process.argv.slice(2);

function parseOptions(args) {
  const flags = new Map();
  const bools = new Set();
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--wait") {
      const next = args[i + 1];
      if (next !== undefined && /^\d+$/.test(next)) {
        flags.set("--wait", next);
        i++;
      } else {
        flags.set("--wait", "45");
      }
    } else if (VALUE_FLAGS.has(a)) {
      if (i + 1 >= args.length) die(`${a} requires a value`);
      flags.set(a, args[++i]);
    } else if (a.startsWith("--")) {
      bools.add(a);
    } else {
      positionals.push(a);
    }
  }
  return { flags, bools, positionals };
}

function die(msg, code = 2) {
  throw new CliUsageError(msg, code);
}

async function readStdinText() {
  if (process.stdin.isTTY) return "";
  let s = "";
  process.stdin.setEncoding("utf8");
  for await (const c of process.stdin) s += c;
  return s;
}

const { flags, bools, positionals } = parseOptions(rest);
const flag = (name) => flags.get(name);
const numFlag = (name) => (flags.has(name) ? Number(flags.get(name)) : undefined);
const listFlag = (name) =>
  flags.has(name)
    ? flags
        .get(name)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
const pos = (idx = 0, label = "taskId / batchId") =>
  positionals[idx] ?? die(`${label} required`);

async function promptArg() {
  const f = flag("--file");
  const t = f
    ? await readTextFileWithRetry(f)
    : (flag("--text") ?? (await readStdinText()));
  if (!t.trim()) throw new Error("empty prompt: pass --file, --text or stdin");
  return t;
}

async function parseJsonOrFile(val, label) {
  if (!val) throw new Error(`${label} is required`);
  const s = val.trim();
  if (s.startsWith("{") || s.startsWith("[")) return JSON.parse(s);
  return JSON.parse(await readTextFileWithRetry(s));
}

async function loadTaskSpec(specArg) {
  if (!specArg) throw new Error("--spec PRESET_OR_FILE is required (e.g. section-outline-v1 or spec.json)");
  if (TASK_SPECS[specArg]) return TASK_SPECS[specArg];
  const custom = await parseJsonOrFile(specArg, "--spec");
  return {
    templateId: custom.templateId ?? "custom",
    task: custom.task,
    schema: custom.schema,
    domainRule: custom.domainRule ?? null,
    packItem: (row, idx) => ({
      itemId: String(row.itemId ?? row.document_id ?? row.id ?? `item_${idx + 1}`),
      input: row.input !== undefined ? row.input : row,
    }),
    unpackItem: (_row, itemRes) => ({
      itemId: itemRes.itemId,
      status: itemRes.status,
      value: itemRes.value ?? null,
    }),
  };
}

const commands = {
  backends: () => listBackends(),
  health: () => listBackends(),
  run: async () =>
    swarmRun({
      backend: flag("--backend") ?? "auto",
      prompt: await promptArg(),
      profile: flag("--profile"),
      cwd: flag("--cwd"),
      model: flag("--model"),
      fallbackModel: flag("--fallback-model"),
      provider: flag("--provider"),
      effort: flag("--effort"),
      maxTurns: numFlag("--max-turns"),
      systemPrompt: flag("--system-prompt"),
      appendSystemPrompt: flag("--append-system-prompt"),
      addDirs: listFlag("--add-dir"),
      ephemeral: bools.has("--ephemeral"),
      waitSec: numFlag("--wait") ?? 0,
    }),
  "run-structured": async () =>
    runStructured({
      backend: flag("--backend") ?? "auto",
      task: flag("--task") ?? die("--task required"),
      schema: await parseJsonOrFile(flag("--schema"), "--schema"),
      input: await parseJsonOrFile(flag("--input"), "--input"),
      domainRule: flag("--domain-rule"),
      profile: flag("--profile"),
      cwd: flag("--cwd"),
      model: flag("--model"),
      fallbackModel: flag("--fallback-model"),
      provider: flag("--provider"),
      effort: flag("--effort"),
      maxTurns: numFlag("--max-turns"),
      systemPrompt: flag("--system-prompt"),
      appendSystemPrompt: flag("--append-system-prompt"),
      addDirs: listFlag("--add-dir"),
      ephemeral: bools.has("--ephemeral"),
      waitSec: numFlag("--wait") ?? 0,
    }),
  "structured-result": () =>
    structuredResult(pos(0), { domainRule: flag("--domain-rule") }),
  batch: async () => {
    const batchId = flag("--id") ?? die("--id required");
    const spec = await loadTaskSpec(flag("--spec"));
    const inputPath = flag("--input") ?? die("--input JSONL_FILE required");
    const limit = numFlag("--limit");
    const microbatchSize = numFlag("--microbatch") ?? 1;
    const maxRetries = numFlag("--retries") ?? 1;
    const maxConcurrency = numFlag("--concurrency") ?? 1;
    const reserveSlots = numFlag("--reserve-slots") ?? 0;
    const maxCredit = numFlag("--max-credit");
    const maxBatchInputChars = numFlag("--max-batch-chars");
    const itemTimeoutMs = numFlag("--timeout-ms");
    const capacityWaitMs = numFlag("--capacity-wait-ms");
    const stateDir = flag("--state-dir");
    const exportPath = flag("--export");
    const summaryPath = flag("--summary");
    const compact = bools.has("--compact");

    const rawLines = (await readTextFileWithRetry(inputPath))
      .split("\n")
      .filter((l) => l.trim().length > 0);
    const sliced = limit ? rawLines.slice(0, limit) : rawLines;
    const rawRows = sliced.map((l) => JSON.parse(l));
    const items = rawRows.map((row, idx) => spec.packItem(row, idx));

    const summary = await runStructuredBatch({
      batchId,
      templateId: spec.templateId,
      task: spec.task,
      schema: spec.schema,
      domainRule: spec.domainRule,
      items,
      microbatchSize,
      ...(maxBatchInputChars !== undefined ? { maxBatchInputChars } : {}),
      maxRetries,
      maxConcurrency,
      reserveSlots,
      ...(maxCredit !== undefined ? { maxCredit } : {}),
      ...(itemTimeoutMs !== undefined ? { itemTimeoutMs } : {}),
      ...(capacityWaitMs !== undefined ? { capacityWaitMs } : {}),
      ...(stateDir ? { stateDir } : {}),
      backend: flag("--backend") ?? "auto",
      profile: flag("--profile"),
      cwd: flag("--cwd"),
      ephemeral: bools.has("--ephemeral"),
      effort: flag("--effort"),
      maxTurns: numFlag("--max-turns"),
      systemPrompt: flag("--system-prompt"),
      appendSystemPrompt: flag("--append-system-prompt"),
      addDirs: listFlag("--add-dir"),
      model: flag("--model"),
      provider: flag("--provider"),
    });

    if (exportPath) {
      const rawById = new Map(items.map((it, i) => [it.itemId, rawRows[i]]));
      const exported = summary.items
        .filter((it) => it.status === "valid")
        .map((it) => spec.unpackItem(rawById.get(it.itemId), it));
      writeJsonFileAtomic(exportPath, exported);
      summary.exportedTo = exportPath;
      summary.exportedCount = exported.length;
    }
    if (summaryPath) {
      writeJsonFileAtomic(summaryPath, summary);
      summary.summaryPath = summaryPath;
    }
    return compact ? { ...summary, items: undefined } : summary;
  },
  "batch-status": () => {
    const stateDir = flag("--state-dir");
    const compact = bools.has("--compact");
    return readBatchStatus(pos(0, "batchId"), { ...(stateDir ? { stateDir } : {}), includeItems: !compact });
  },
  "batch-export": async () => {
    const batchId = pos(0, "batchId");
    const stateDir = flag("--state-dir");
    const outPath = flag("--out") ?? flag("--export");
    const specArg = flag("--spec");
    const inputPath = flag("--input");
    const compact = bools.has("--compact");

    let unpackItem = null;
    let rawByItemId = null;
    if (specArg) {
      const spec = await loadTaskSpec(specArg);
      unpackItem = spec.unpackItem;
      if (inputPath) {
        const rawRows = (await readTextFileWithRetry(inputPath))
          .split("\n")
          .filter((l) => l.trim().length > 0)
          .map((l) => JSON.parse(l));
        rawByItemId = new Map(rawRows.map((row, idx) => [spec.packItem(row, idx).itemId, row]));
      }
    }

    const exported = exportBatchValidItems(batchId, {
      ...(stateDir ? { stateDir } : {}),
      unpackItem,
      rawByItemId,
    });
    if (outPath) {
      writeJsonFileAtomic(outPath, exported.items);
      exported.exportedTo = outPath;
    }
    return compact ? { ...exported, items: undefined } : exported;
  },
  wait: () =>
    swarmWait({
      taskId: pos(0),
      timeoutSec: positionals[1] ? Number(positionals[1]) : 45,
    }),
  status: () => swarmStatus(pos(0)),
  result: () => swarmResult(pos(0)),
  followup: async () =>
    swarmFollowUp({
      taskId: pos(0),
      prompt: await promptArg(),
      model: flag("--model"),
      fallbackModel: flag("--fallback-model"),
      effort: flag("--effort"),
      maxTurns: numFlag("--max-turns"),
    }),
  cancel: () => swarmCancel(pos(0)),
  list: () => {
    const n = positionals[0] === undefined ? 15 : Number(positionals[0]);
    if (!Number.isInteger(n) || n < 1) die("list [N]: N must be a positive integer");
    return swarmList({ backend: flag("--backend") ?? "all", limit: n });
  },
  quota: () =>
    swarmQuota({
      backend: flag("--backend") ?? "all",
      refresh: bools.has("--refresh"),
      sinceDays: numFlag("--days") ?? 7,
    }),
};

try {
  if (!commands[cmd]) die(USAGE);
  const out = await commands[cmd]();
  await exitAfterFlush(process.stdout, JSON.stringify(out, null, 2) + "\n", 0);
} catch (e) {
  const code = e instanceof CliUsageError ? e.exitCode : 1;
  const msg = e instanceof CliUsageError ? e.message : `Error: ${e?.message ?? e}`;
  await exitAfterFlush(process.stderr, `${msg}\n`, code);
}
