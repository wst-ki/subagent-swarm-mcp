#!/usr/bin/env node
// Shell front end to the zcode_* tools, for agents that can run commands but have no MCP access
// (T3 / Antigravity children, Mac agents over ssh, scripts). Prints JSON, like the MCP tools.
import "../src/silence.mjs";
import { exitAfterFlush, readTextFileWithRetry, writeJsonFileAtomic } from "../src/cli-io.mjs";
import { cancelTask, followUp, getResult, health, listTasks, runTask } from "../src/zcode.mjs";
import { taskStatus } from "../src/store.mjs";
import { summarize } from "../src/progress.mjs";
import { zcodeQuota } from "../src/zcode-quota.mjs";
import { TASK_SPECS, runStructured, structuredResult } from "../src/structured.mjs";
import { readBatchStatus, runStructuredBatch } from "../src/batch.mjs";

const USAGE = `usage: zcode <command>
  run (--file F | --text T | stdin) [--model M] [--provider KEY]   start a task; prints {taskId, ...}
  run-structured --task T --schema JSON_OR_FILE --input JSON_OR_FILE [--domain-rule R] [--model M] [--provider KEY]
  structured-result <taskId> [--domain-rule R]
  batch --id ID --spec PRESET_OR_FILE --input JSONL_FILE [--limit N] [--microbatch K] [--retries 0|1]
      [--concurrency N] [--max-batch-chars N] [--timeout-ms MS] [--capacity-wait-ms MS] [--state-dir DIR]
      [--model M] [--provider KEY] [--export OUT_FILE] [--summary OUT_FILE] [--compact]
  batch-status <batchId> [--state-dir DIR] [--compact]
  quota                    read displayed remaining quota windows from ZCode UI
  status <taskId>          non-blocking status
  result <taskId>          final answer (status only while running)
  followup <taskId> (--file F | --text T | stdin)
  cancel <taskId>
  progress <taskId> [--refresh]   Gemini digest of what the task has done
  list [N]
  health
--provider = billing route: account%3Abigmodel-individual-coding-plan (BigModel 个人, default)
             or account%3Abigmodel-start-plan (Start Plan 免费)
Watch a running task without spending tokens: zcode-watch <taskId> [--timeout SEC]`;

const VALUE_FLAGS = new Set([
  "--file",
  "--text",
  "--model",
  "--provider",
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
  "--max-batch-chars",
  "--timeout-ms",
  "--capacity-wait-ms",
  "--state-dir",
  "--summary",
  "--export",
]);

class CliUsageError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

function die(msg, code = 2) {
  throw new CliUsageError(msg, code);
}

const [cmd, ...rest] = process.argv.slice(2);
const flags = new Map();
const bools = new Set();
const positionals = [];
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (VALUE_FLAGS.has(a)) {
    if (i + 1 >= rest.length) die(`${a} requires a value`);
    flags.set(a, rest[++i]);
  } else if (a.startsWith("--")) {
    bools.add(a);
  } else {
    positionals.push(a);
  }
}

const flag = (name) => flags.get(name);
const numFlag = (name) => (flags.has(name) ? Number(flags.get(name)) : undefined);
const id = () => positionals[0] ?? die("taskId / batchId required");

async function readStdinText() {
  if (process.stdin.isTTY) return "";
  let s = "";
  process.stdin.setEncoding("utf8");
  for await (const c of process.stdin) s += c;
  return s;
}

async function promptArg() {
  const f = flag("--file");
  const t = f ? await readTextFileWithRetry(f) : (flag("--text") ?? (await readStdinText()));
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
  run: async () => runTask({ prompt: await promptArg(), model: flag("--model"), provider: flag("--provider") }),
  "run-structured": async () =>
    runStructured({
      task: flag("--task") ?? die("--task required"),
      schema: await parseJsonOrFile(flag("--schema"), "--schema"),
      input: await parseJsonOrFile(flag("--input"), "--input"),
      domainRule: flag("--domain-rule"),
      model: flag("--model"),
      provider: flag("--provider"),
    }),
  "structured-result": () => structuredResult(id(), { domainRule: flag("--domain-rule") }),
  batch: async () => {
    const batchId = flag("--id") ?? die("--id required");
    const spec = await loadTaskSpec(flag("--spec"));
    const inputPath = flag("--input") ?? die("--input JSONL_FILE required");
    const limit = numFlag("--limit");
    const microbatchSize = numFlag("--microbatch") ?? 1;
    const maxRetries = numFlag("--retries") ?? 1;
    const maxConcurrency = numFlag("--concurrency") ?? 1;
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
      ...(itemTimeoutMs !== undefined ? { itemTimeoutMs } : {}),
      ...(capacityWaitMs !== undefined ? { capacityWaitMs } : {}),
      ...(stateDir ? { stateDir } : {}),
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
    return readBatchStatus(id(), { ...(stateDir ? { stateDir } : {}), includeItems: !compact });
  },
  quota: () => zcodeQuota(),
  status: () => taskStatus(id()),
  result: () => getResult(id()),
  followup: async () => followUp({ taskId: id(), prompt: await promptArg() }),
  cancel: () => cancelTask(id()),
  progress: async () => {
    const sid = id();
    const { digest, at, cached } = await summarize(sid, { force: bools.has("--refresh") });
    return { ...taskStatus(sid), ...digest, summarizedAt: new Date(at).toISOString(), cached };
  },
  list: () => {
    const n = positionals[0] === undefined ? 15 : Number(positionals[0]);
    if (!Number.isInteger(n) || n < 1) die("list [N]: N must be a positive integer");
    return listTasks(n);
  },
  health: () => health(),
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
