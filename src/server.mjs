#!/usr/bin/env node
import "./silence.mjs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { config } from "./config.mjs";
import { sleep } from "./cdp.mjs";
import { cancelTask, followUp, getResult, health, listTasks, runTask } from "./zcode.mjs";
import { taskStatus } from "./store.mjs";
import { sessionPartContent, sessionParts } from "./session-snapshot.mjs";
import { readSessionEvents } from "./session-events.mjs";
import { readModelIo } from "./session-model-io.mjs";
import { Hub } from "./hub/tasks.mjs";
import { waitForEvents } from "./hub/wait.mjs";
import { taskTimeline } from "./hub/watch.mjs";
import { summarize } from "./progress.mjs";
import { codebuddyUsage } from "./codebuddy-usage.mjs";
import { zcodeQuota } from "./zcode-quota.mjs";
import { DOMAIN_VALIDATORS, runStructured, structuredResult } from "./structured.mjs";
import { readBatchStatus, runStructuredBatch } from "./batch.mjs";
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
} from "./backends/registry.mjs";

const server = new McpServer({ name: "subagent-swarm-mcp", version: "0.2.0" });

const ok = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: `Error: ${e?.message ?? e}` }] });
const guard = (fn) => async (args, extra) => {
  try {
    return ok(await fn(args, extra));
  } catch (e) {
    return fail(e);
  }
};

const taskId = z.string().regex(/^sess(ion)?_[\w-]+$/, "taskId as returned by zcode_run");
const model = z.enum(config.allowedModels);
const domainRuleNames = Object.keys(DOMAIN_VALIDATORS);
const domainRulePreset = domainRuleNames.length > 0 ? z.enum(domainRuleNames) : z.string().min(1).max(120);
const domainRule = z.union([domainRulePreset, z.record(z.string(), z.unknown())]);

server.registerTool(
  "zcode_run_structured",
  {
    title: "Start a structured ZCode task",
    description: "Start a normal ZCode session with a bounded JSON schema contract and optional domain semantic rule preset (e.g. section-outline-v1, or a declarative rule object). This uses subscription quota and FULL ACCESS like zcode_run. The schema and domainRule are stored in the session prompt; use zcode_structured_result after completion.",
    inputSchema: { task: z.string().min(1).max(10000), input: z.unknown(), schema: z.record(z.string(), z.unknown()), domainRule: domainRule.optional(), model: model.optional(), provider: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  guard((args) => runStructured(args)),
);

server.registerTool(
  "zcode_structured_result",
  {
    title: "Validate a structured ZCode result",
    description: "Recover the original schema and optional domainRule/input from the session and validate the final JSON answer. Invalid, unfinished, failed and cancelled tasks never count as valid.",
    inputSchema: { taskId, domainRule: domainRule.optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  guard(({ taskId, domainRule }) => structuredResult(taskId, { domainRule })),
);

server.registerTool(
  "zcode_batch_run",
  {
    title: "Run or resume a checkpointed structured ZCode batch",
    description: "Execute or resume a low-CPU structured batch with deterministic item keys, append-only JSONL checkpoints (manifest.jsonl, results.jsonl, summary.json, blocked.json), bounded retry (0 or 1), and circuit breaking on quota/rate-limit, login blockers, or provider route mismatch.",
    inputSchema: {
      batchId: z.string().regex(/^[a-zA-Z0-9._-]{1,120}$/),
      templateId: z.string().min(1).max(120).optional(),
      task: z.string().min(1).max(10000),
      schema: z.record(z.string(), z.unknown()),
      domainRule: domainRule.optional(),
      items: z.array(z.object({ itemId: z.string().min(1).max(200), input: z.unknown() })).min(1).max(200),
      microbatchSize: z.number().int().min(1).max(50).optional(),
      maxBatchInputChars: z.number().int().min(1000).max(60000).optional(),
      model: model.optional(),
      provider: z.string().optional(),
      maxConcurrency: z.number().int().min(1).max(config.maxRunning).optional(),
      maxRetries: z.number().int().min(0).max(1).optional(),
      pollIntervalMs: z.number().int().min(500).max(10000).optional(),
      itemTimeoutMs: z.number().int().min(5000).max(300000).optional(),
      capacityWaitMs: z.number().int().min(0).max(1800000).optional(),
      includeItems: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  guard((args) => runStructuredBatch(args)),
);

server.registerTool(
  "zcode_batch_status",
  {
    title: "Read checkpointed ZCode batch status",
    description: "Read the current checkpointed manifest, item statuses, aggregated token usage, and any circuit-breaker blocker for a batchId.",
    inputSchema: {
      batchId: z.string().regex(/^[a-zA-Z0-9._-]{1,120}$/),
      includeItems: z.boolean().optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  guard(({ batchId, includeItems }) => readBatchStatus(batchId, includeItems !== undefined ? { includeItems } : undefined)),
);

server.registerTool(
  "zcode_run",
  {
    title: "Start a ZCode subagent task",
    description:
      "Delegate a task to a GLM subagent running in the official ZCode desktop app (uses the user's GLM Coding Plan quota). " +
      "Returns a taskId immediately; the task runs in the background. Use zcode_wait to block until it finishes, or zcode_status to poll. " +
      "The subagent runs with FULL ACCESS (shell, file read/write anywhere the OS user can) in the project folder " +
      `${config.projectDir}. It cannot see this conversation, so put ALL needed context in the prompt: goal, absolute file paths, constraints, ` +
      "and the exact output format you want back. Prefer small, well-scoped tasks. Several tasks may run in parallel (limit " +
      `${config.maxRunning}). Models: ${config.allowedModels.join(" | ")} (default ${config.defaultModel}; Flash is faster and cheaper for simple work). ` +
      "provider picks the billing route (the model menu lists the same names under both): " +
      "account%3Abigmodel-individual-coding-plan = BigModel 个人 (default), account%3Abigmodel-start-plan = Start Plan 免费.",
    inputSchema: {
      prompt: z.string().min(1).describe("Complete, self-contained task description."),
      model: model.optional().describe(`Model to use. Default ${config.defaultModel}.`),
      provider: z
        .string()
        .optional()
        .describe(
          `Billing route (provider). Default ${config.providerKey} = BigModel 个人; ` +
            "account%3Abigmodel-start-plan = Start Plan 免费 (the decoded form account:… works too). Others are refused.",
        ),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  guard(({ prompt, model, provider }) => runTask({ prompt, model, provider })),
);

server.registerTool(
  "zcode_status",
  {
    title: "Get ZCode task status",
    description:
      "Non-blocking status of a task: running | completed | failed | cancelled | starting. While running it includes elapsedSec, " +
      "the tool currently executing, tool call count and idleSec (seconds since the last activity; `stalled: true` if suspiciously long). " +
      "Does not include the answer — use zcode_result or zcode_wait for that.",
    inputSchema: { taskId },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  guard(({ taskId }) => taskStatus(taskId)),
);

server.registerTool(
  "zcode_session_model_io",
  {
    title: "Read an optional ZCode model IO record",
    description: "Read one retained model IO JSONL record for a session. Recording may be absent or incomplete. " +
      "Returns metadata and tool names by default; includeContent also returns assistant text and tool arguments. " +
      "Never returns request headers or full prompt; not a per-token event stream. Records over 1 MiB are reported and not skipped.",
    inputSchema: { taskId, cursor: z.string().max(1024).optional(), includeContent: z.boolean().optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  guard(({ taskId, cursor, includeContent = false }) => readModelIo({ taskId, cursor, includeContent })),
);

server.registerTool(
  "zcode_session_events",
  {
    title: "Poll ZCode session lifecycle events",
    description: "Read a bounded page of existing ZCode JSONL lifecycle events for a session. " +
      "Pass the returned cursor on subsequent calls. This is not the v4 stream: assistant text and tool arguments/results are unavailable. " +
      "The first call starts at the newest log by default, or the oldest retained log with start=oldest; gaps report incomplete history, rotation, truncation or unreadable records.",
    inputSchema: { taskId, cursor: z.string().max(1024).optional(), limit: z.number().int().min(1).max(100).optional(), start: z.enum(["latest", "oldest"]).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  guard(({ taskId, cursor, limit = 50, start = "latest" }) => readSessionEvents({ taskId, cursor, limit, start })),
);

server.registerTool(
  "zcode_session_part_content",
  {
    title: "Read a session part in bounded chunks",
    description: "Read UTF-8 JSON bytes of an assistant text or tool snapshot in base64 chunks. " +
      "Pass version as expected on subsequent pages; updates normally invalidate the read, but same-millisecond same-size changes may be missed. " +
      "Content may contain task text, tool arguments and output.",
    inputSchema: {
      taskId, partId: z.string().min(1).max(256), offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1).optional(),
      limit: z.number().int().min(1).max(8192).optional(),
      expected: z.object({ updatedAt: z.number().int(), contentBytes: z.number().int().min(0) }).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  guard((args) => sessionPartContent(args)),
);

server.registerTool(
  "zcode_session_parts",
  {
    title: "Read a bounded ZCode session snapshot",
    description: "Read a page of assistant text and tool part snapshots from ZCode's SQLite database. " +
      "This is not a live event stream: parts can change and pagination cannot detect changes to earlier rows. " +
      "Content is omitted by default; opting in may expose task text, tool arguments and results. " +
      "Parts above 8192 bytes are omitted, and the cursor sorts by ID, not chronological order.",
    inputSchema: {
      taskId,
      after: z.string().max(256).optional().describe("nextAfter from the previous page, or omit to start."),
      limit: z.number().int().min(1).max(50).optional(),
      includeContent: z.boolean().optional().describe("Include small part content; default false."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  guard(({ taskId, after = "", limit = 25, includeContent = false }) => sessionParts({ taskId, after, limit, includeContent })),
);

server.registerTool(
  "zcode_wait",
  {
    title: "Wait for a ZCode task",
    description:
      "Block until the task finishes or timeoutSec elapses (default 45, max 55 so it stays under typical 60s tool-call timeouts), then return its status; when finished the result text is included. " +
      "If it returns status 'running', just call zcode_wait again. Prefer this over tight polling.",
    inputSchema: { taskId, timeoutSec: z.number().int().min(1).max(55).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  guard(async ({ taskId, timeoutSec = 45 }, extra) => {
    const end = Date.now() + timeoutSec * 1000;
    const progressToken = extra?._meta?.progressToken;
    let tick = 0;
    for (;;) {
      const st = taskStatus(taskId);
      if (st.status !== "running" && st.status !== "starting") return getResult(taskId);
      if (Date.now() >= end) return st;
      if (progressToken !== undefined && ++tick % 5 === 0)
        await extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken, progress: tick, message: `running ${st.elapsedSec}s${st.currentTool ? `, tool: ${st.currentTool}` : ""}` },
        });
      await sleep(1000);
    }
  }),
);

server.registerTool(
  "zcode_result",
  {
    title: "Get ZCode task result",
    description: "Final answer text of a finished task (plus token usage). For a task still running this returns its status without a result.",
    inputSchema: { taskId },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  guard(({ taskId }) => getResult(taskId)),
);

server.registerTool(
  "zcode_progress",
  {
    title: "Gemini progress digest for a ZCode task",
    description:
      "Cheap Gemini Flash digest (via the agy CLI) of what the task's subagent has done so far: summary, done/doing/next, " +
      "an estimated progressPct against the task prompt, onTrack, concerns and needsAttention. Works while the task runs and " +
      "after it finishes (summary of the whole run). Digests are cached per task for ZCODE_MCP_SUMMARY_MIN_SEC seconds " +
      "(default 300) and only recomputed when new activity exists; set refresh to bypass the cache. " +
      "For unattended watching prefer bin/zcode-watch.mjs (see README) over polling this.",
    inputSchema: { taskId, refresh: z.boolean().optional().describe("Force a fresh digest, ignoring the cache.") },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  guard(async ({ taskId, refresh = false }) => {
    const st = taskStatus(taskId);
    if (st.status === "unknown") throw new Error(st.note ?? `Unknown task ${taskId}.`);
    const s = await summarize(taskId, { force: refresh });
    return {
      status: st.status,
      elapsedSec: st.elapsedSec ?? null,
      toolCalls: st.toolCalls ?? st.usage?.toolCalls ?? null,
      idleSec: st.idleSec ?? null,
      ...s.digest,
      summarizedAt: new Date(s.at).toISOString(),
      cached: s.cached,
    };
  }),
);

server.registerTool(
  "zcode_followup",
  {
    title: "Send a follow-up to a ZCode task",
    description:
      "Continue a FINISHED task with another message in the same ZCode conversation (it keeps its earlier context). " +
      "Returns immediately; use zcode_wait afterwards. The task must not be running, and must still be visible in ZCode's sidebar (not archived).",
    inputSchema: { taskId, prompt: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  guard(({ taskId, prompt }) => followUp({ taskId, prompt })),
);

server.registerTool(
  "zcode_cancel",
  {
    title: "Cancel a running ZCode task",
    description: "Stop a running task (clicks ZCode's stop button). Work already done on disk is not rolled back.",
    inputSchema: { taskId },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  guard(({ taskId }) => cancelTask(taskId)),
);

server.registerTool(
  "zcode_list",
  {
    title: "List recent ZCode tasks",
    description: "Recent (non-archived) tasks in the subagent project with their status.",
    inputSchema: { limit: z.number().int().min(1).max(50).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  guard(({ limit }) => listTasks(limit ?? 15)),
);

server.registerTool(
  "zcode_quota",
  {
    title: "Read displayed ZCode quota",
    description: "Read the remaining quota percentages displayed by the official ZCode UI on demand. " +
      "May be cached; account and provider cannot be verified, reset times are display text, and missing windows mean unknown. " +
      "Temporarily opens and closes the context popover; never presses reset or reads credentials.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  guard(() => zcodeQuota()),
);

server.registerTool(
  "zcode_health",
  {
    title: "Check the ZCode connection",
    description: "Verify ZCode is running with its debugging port, the subagent project exists, and report how many tasks are running.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  guard(() => health()),
);

// ------------------------------------------------------------------ hub tools
// Dispatch-hub tools (docs/HUB-PLAN.md). The hub is a bare git repo (env HUB_REMOTE); the
// daemon on the hub host runs local workers, these tools are what a master agent uses.

let hubSingleton = null;
async function getHub() {
  if (!hubSingleton) {
    hubSingleton = new Hub({});
    await hubSingleton.init();
  }
  return hubSingleton;
}

const hubTaskId = z.string().regex(/^T\d{8}-\d{6}-[0-9a-z]{2,}$/, "task id as shown by hub_board");

server.registerTool(
  "hub_post",
  {
    title: "Post a task to the dispatch hub",
    description:
      "Queue a task for the dispatch hub's workers (ZCode / CLI agents on the hub host, manual workers on remote machines). " +
      "Returns once the task is queued; a daemon assigns and runs it, and hub_wait wakes you when it needs attention. " +
      "The task body must be self-contained (the worker cannot see this conversation). Code tasks need repo (absolute path on the hub host) " +
      "and base (commit sha); the worker's changes come back as a patch that is replayed and checked by the hub's acceptance step.",
    inputSchema: {
      title: z.string().min(1).max(200),
      task: z.string().min(1).describe("Markdown instructions for the worker (task.md)."),
      repo: z.string().optional().describe("Absolute path of the git repo on the hub host (code tasks)."),
      base: z.string().optional().describe("Commit sha to build on. Default: the repo's HEAD when the daemon prepares the task."),
      kind: z.enum(["code", "text", "review"]).optional().describe("Default code."),
      tier: z.enum(["low", "mid", "high"]).optional().describe("Default mid."),
      accept: z
        .string()
        .optional()
        .describe("Command run with bash -o pipefail in a fresh checkout + the patch (no node_modules: install first); non-zero exit rejects."),
      acceptTimeoutMin: z.number().int().min(1).max(240).optional().describe("Accept command time limit. Default 30."),
      timeoutMin: z.number().int().min(1).max(1440).optional().describe("Default 45."),
      preferWorkers: z.array(z.string()).optional(),
      avoidVendors: z.array(z.string()).optional(),
      review: z.boolean().optional().describe("Have a second, different-vendor agent review the patch before acceptance."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  guard(async (a) => {
    const hub = await getHub();
    return hub.post(
      {
        title: a.title,
        kind: a.kind ?? "code",
        tier: a.tier ?? "mid",
        repo: a.repo ?? null,
        base: a.base ?? null,
        accept: a.accept ?? null,
        acceptTimeoutMin: a.acceptTimeoutMin ?? null,
        timeoutMin: a.timeoutMin ?? 45,
        preferWorkers: a.preferWorkers ?? [],
        avoidVendors: a.avoidVendors ?? [],
        review: a.review ?? false,
      },
      a.task,
    );
  }),
);

server.registerTool(
  "hub_board",
  {
    title: "List hub tasks",
    description: "All tasks in the dispatch hub with state, assignee and latest note. States: queued, assigned, running, done, need-info, failed, accepted, rejected, cancelled.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  guard(async () => {
    const hub = await getHub();
    return {
      tasks: (await hub.list()).map((t) => ({
        id: t.id,
        state: t.state,
        assignee: t.assignee || null,
        title: t.spec?.title ?? null,
        attempts: t.attempts,
        note: t.note || null,
      })),
    };
  }),
);

server.registerTool(
  "hub_show",
  {
    title: "Show one hub task",
    description: "Full task record: spec, note, the instructions given to the worker, the master answer, and (once done) the worker's report.",
    inputSchema: { id: hubTaskId },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  guard(async ({ id }) => {
    const hub = await getHub();
    const t = await hub.get(id);
    if (!t) throw new Error(`no task ${id}`);
    const clip = (s, n = 8000) => (s == null ? null : s.length > n ? s.slice(0, n) + "\n…(truncated)" : s);
    return {
      ...t,
      taskMd: clip(await hub.readTaskFile(id, "task.md")),
      answerMd: clip(await hub.readTaskFile(id, "answer.md")),
      reportMd: clip(await hub.readTaskFile(id, "result/report.md")),
      acceptLog: clip(await hub.readTaskFile(id, "result/accept.log")),
    };
  }),
);

server.registerTool(
  "hub_wait",
  {
    title: "Wait for hub events",
    description:
      "Block until the hub needs the master's attention (a task entered need-info / failed / rejected, or the hub went idle after a change) " +
      "or timeoutSec elapses (default 55, max 55). Returns { timedOut, lines }; if timedOut, just call hub_wait again.",
    inputSchema: {
      until: z.enum(["attention", "change", "idle"]).optional().describe("Default attention."),
      timeoutSec: z.number().int().min(1).max(55).optional(),
      cursor: z.string().optional().describe("Cursor name, for concurrent waiters. Default master."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  guard(async ({ until = "attention", timeoutSec = 55, cursor = "master" }) => {
    const hub = await getHub();
    return waitForEvents(hub, { until, timeoutSec, cursor });
  }),
);

server.registerTool(
  "hub_answer",
  {
    title: "Answer a hub task's question",
    description: "Reply to a task in need-info; it goes back to the same worker (a ZCode worker continues its session with the answer).",
    inputSchema: { id: hubTaskId, text: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  guard(async ({ id, text }) => (await getHub()).answer(id, text)),
);

server.registerTool(
  "hub_cancel",
  {
    title: "Cancel a hub task",
    description: "Cancel a task that is not finished. Terminal: accepted, cancelled (and failed/rejected until requeued).",
    inputSchema: { id: hubTaskId },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  guard(async ({ id }) => (await getHub()).cancel(id)),
);

server.registerTool(
  "hub_requeue",
  {
    title: "Requeue a hub task",
    description: "Put a failed / rejected / cancelled task back into the queue with its assignee cleared.",
    inputSchema: { id: hubTaskId },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  guard(async ({ id }) => (await getHub()).requeue(id)),
);

server.registerTool(
  "hub_assign",
  {
    title: "Override a hub task's assignment",
    description: "Assign a queued (or assigned) task to a specific worker yourself, bypassing the scheduler. See hub_board / the workers roster for ids.",
    inputSchema: { id: hubTaskId, worker: z.string().min(1), reason: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  guard(async ({ id, worker, reason }) => (await getHub()).assign(id, worker, reason ?? "manual override")),
);

server.registerTool(
  "hub_tell",
  {
    title: "Message a hub task's worker",
    description:
      "Append a short message (collapsed to one line, max 300 chars) to the task's inbox. The worker sees INBOX lines on its next hub say/inbox/next and is expected to follow them. " +
      "Use for nudges and clarifications that do not need a state change (unlike hub_answer, which replies to need-info).",
    inputSchema: { id: hubTaskId, text: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  guard(async ({ id, text }) => {
    const hub = await getHub();
    return { id, stream: "inbox", sha: await hub.tell(id, "master", text) };
  }),
);

server.registerTool(
  "hub_log",
  {
    title: "Hub task timeline",
    description:
      "One merged, time-sorted line per event on a task: state changes (the hub's commit subjects), worker PROGRESS lines and INBOX messages. " +
      "A cheap way to see how a task is going without hub_show's full payload; for unattended watching prefer `dispatch watch` (README).",
    inputSchema: { id: hubTaskId },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  guard(async ({ id }) => {
    const hub = await getHub();
    return { id, lines: (await taskTimeline(hub, id)).map((e) => e.line) };
  }),
);

server.registerTool(
  "codebuddy_usage",
  {
    title: "CodeBuddy credit",
    description:
      "CodeBuddy/WorkBuddy credit left on the account (billing API, cached 10 min; needs the user's access token, see README) and " +
      "credit consumed on this machine by the CodeBuddy CLI per day and per hub task (from its local transcripts). " +
      "Returns { remote: { remain, total, pct, packages } | { error, last }, token, local }.",
    inputSchema: {
      refresh: z.boolean().optional().describe("Skip the cache and ask the billing API now."),
      sinceDays: z.number().int().min(1).max(90).optional().describe("Local consumption window, default 7."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  guard(async ({ refresh = false, sinceDays = 7 }) => codebuddyUsage({ refresh, sinceDays })),
);

// ------------------------------------------------------------------ swarm tools
// Unified multi-CLI subagent routing across CodeBuddy (`cb_*`), Qoder (`qd_*`), and ZCode (`sess_*`).

const swarmTaskId = z
  .string()
  .regex(/^(sess(ion)?_[\w-]+|cb_[\w-]+|qd_[\w-]+)$/, "taskId (cb_*, qd_*, or sess_*) returned by swarm_run / zcode_run");
const swarmBackend = z.enum(["auto", "zcode", "codebuddy", "qoder"]);
const swarmProfile = z.enum(["lite", "readonly", "workspace"]);
const swarmModel = z.string().min(1).max(120);

function makeProgressReporter(extra) {
  const progressToken = extra?._meta?.progressToken;
  if (progressToken === undefined) return null;
  return async ({ tick, elapsedSec, currentTool }) => {
    await extra.sendNotification({
      method: "notifications/progress",
      params: {
        progressToken,
        progress: tick,
        message: `running ${elapsedSec}s${currentTool ? `, tool: ${currentTool}` : ""}`,
      },
    });
  };
}

server.registerTool(
  "swarm_backends",
  {
    title: "List available swarm backends and live health",
    description:
      "Inspect registered subagent CLI/UI backends (codebuddy, qoder, zcode), their availability, supported models, profiles, and active/max concurrency.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  guard(() => listBackends()),
);

server.registerTool(
  "swarm_run",
  {
    title: "Run a subagent task on an available CLI backend",
    description:
      "Delegate a task to the selected CLI backend ('auto', 'codebuddy', 'qoder', or 'zcode'). " +
      "On CLI backends (codebuddy, qoder), `profile` defaults to 'lite' (zero tools, minimal token/credit cost; great for fast pure-reasoning/extraction), " +
      "`readonly` enables Read/ViewImage/Glob/Grep/WebSearch/WebFetch, and `workspace` grants full workspace access in `cwd`. " +
      "Set `waitSec` (e.g. 30-55) for single-call inline completion on fast CLI tasks, or omit / 0 to return taskId immediately.",
    inputSchema: {
      prompt: z.string().min(1).describe("Complete, self-contained task prompt."),
      backend: swarmBackend.optional().describe("Target backend: auto (default), codebuddy, qoder, or zcode."),
      model: swarmModel.optional().describe("Model ID (e.g. hy4flash-free, deepseek-v4.1-flash, DeepSeek-Flash, Qwen3.8-Flash, GLM-5.3)."),
      fallbackModel: swarmModel.optional().describe("Optional fallback model when backend supports it (e.g. codebuddy)."),
      profile: swarmProfile.optional().describe("Tool/permission profile: lite (default on CLI backends), readonly, or workspace."),
      cwd: z.string().min(1).max(1024).optional().describe("Working directory for CLI backends (must exist)."),
      provider: z.string().optional().describe("ZCode-only billing route override."),
      ephemeral: z.boolean().optional().describe("Disable session persistence on CLI backends (--no-session-persistence)."),
      waitSec: z.number().int().min(0).max(55).optional().describe("Wait up to N seconds inline (0 = async return immediately, max 55)."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  guard((args, extra) =>
    swarmRun({
      ...args,
      onProgress: makeProgressReporter(extra),
    }),
  ),
);

server.registerTool(
  "swarm_wait",
  {
    title: "Wait for any swarm subagent task",
    description:
      "Block until a cb_* or sess_* task reaches a terminal state or timeoutSec elapses (default 45, max 55). Returns status and final result when complete.",
    inputSchema: {
      taskId: swarmTaskId,
      timeoutSec: z.number().int().min(1).max(55).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  guard(({ taskId, timeoutSec = 45 }, extra) =>
    swarmWait({
      taskId,
      timeoutSec,
      onProgress: makeProgressReporter(extra),
    }),
  ),
);

server.registerTool(
  "swarm_status",
  {
    title: "Get swarm subagent task status",
    description: "Non-blocking status check for any cb_* or sess_* task, reconciling dead worker processes automatically.",
    inputSchema: { taskId: swarmTaskId },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  guard(({ taskId }) => swarmStatus(taskId)),
);

server.registerTool(
  "swarm_result",
  {
    title: "Get swarm subagent task result",
    description: "Return the final result text, model info, and token/credit usage for a finished cb_* or sess_* task.",
    inputSchema: { taskId: swarmTaskId },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  guard(({ taskId }) => swarmResult(taskId)),
);

server.registerTool(
  "swarm_followup",
  {
    title: "Send a follow-up prompt to a finished swarm task",
    description: "Continue a finished, non-ephemeral cb_* or sess_* task in the same conversation session.",
    inputSchema: {
      taskId: swarmTaskId,
      prompt: z.string().min(1),
      model: swarmModel.optional(),
      fallbackModel: swarmModel.optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  guard((args) => swarmFollowUp(args)),
);

server.registerTool(
  "swarm_cancel",
  {
    title: "Cancel a running swarm subagent task",
    description: "Terminate a running cb_* process group or click Stop on a running sess_* ZCode task.",
    inputSchema: { taskId: swarmTaskId },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  guard(({ taskId }) => swarmCancel(taskId)),
);

server.registerTool(
  "swarm_list",
  {
    title: "List recent swarm tasks across backends",
    description: "List recent tasks from CodeBuddy, Qoder, ZCode, or all merged newest-first.",
    inputSchema: {
      backend: z.enum(["all", "zcode", "codebuddy", "qoder"]).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  guard(({ backend = "all", limit = 15 }) => swarmList({ backend, limit })),
);

server.registerTool(
  "swarm_quota",
  {
    title: "Read quota across swarm backends",
    description: "Read available quota/usage information from CodeBuddy, Qoder, ZCode UI, or all (`all`).",
    inputSchema: {
      backend: z.enum(["all", "zcode", "codebuddy", "qoder"]).optional(),
      refresh: z.boolean().optional(),
      sinceDays: z.number().int().min(1).max(90).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  guard(({ backend = "all", refresh = false, sinceDays = 7 }) => swarmQuota({ backend, refresh, sinceDays })),
);

server.registerTool(
  "swarm_run_structured",
  {
    title: "Run a structured JSON-contract task on a swarm backend",
    description:
      "Execute a bounded JSON Schema + optional domainRule task on 'auto' (default), 'codebuddy', or 'zcode'. " +
      "CLI backends default to zero-tool 'lite' profile; set waitSec > 0 to wait and validate inline.",
    inputSchema: {
      task: z.string().min(1).max(10000),
      input: z.unknown(),
      schema: z.record(z.string(), z.unknown()),
      domainRule: domainRule.optional(),
      backend: swarmBackend.optional(),
      profile: swarmProfile.optional(),
      cwd: z.string().min(1).max(1024).optional(),
      ephemeral: z.boolean().optional(),
      waitSec: z.number().int().min(0).max(55).optional(),
      model: swarmModel.optional(),
      fallbackModel: swarmModel.optional(),
      provider: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  guard(({ backend = "auto", ...rest }, extra) =>
    runStructured({
      backend,
      ...rest,
      onProgress: makeProgressReporter(extra),
    }),
  ),
);

server.registerTool(
  "swarm_structured_result",
  {
    title: "Validate a structured swarm task result",
    description: "Recover the stored JSON Schema + domainRule contract for a cb_* or sess_* task and validate its output.",
    inputSchema: { taskId: swarmTaskId },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  guard(({ taskId }) => structuredResult(taskId)),
);

server.registerTool(
  "swarm_batch_run",
  {
    title: "Run or resume a checkpointed structured swarm batch",
    description:
      "Execute or resume a checkpointed structured batch (with microbatching, partial recovery, and circuit breakers) across 'auto' (default), 'codebuddy', or 'zcode'.",
    inputSchema: {
      batchId: z.string().regex(/^[a-zA-Z0-9._-]{1,120}$/),
      templateId: z.string().min(1).max(120).optional(),
      task: z.string().min(1).max(10000),
      schema: z.record(z.string(), z.unknown()),
      domainRule: domainRule.optional(),
      items: z.array(z.object({ itemId: z.string().min(1).max(200), input: z.unknown() })).min(1).max(200),
      microbatchSize: z.number().int().min(1).max(50).optional(),
      maxBatchInputChars: z.number().int().min(1000).max(60000).optional(),
      backend: swarmBackend.optional(),
      profile: swarmProfile.optional(),
      cwd: z.string().min(1).max(1024).optional(),
      ephemeral: z.boolean().optional(),
      model: swarmModel.optional(),
      provider: z.string().optional(),
      maxConcurrency: z.number().int().min(1).max(8).optional(),
      maxRetries: z.number().int().min(0).max(1).optional(),
      pollIntervalMs: z.number().int().min(250).max(10000).optional(),
      itemTimeoutMs: z.number().int().min(5000).max(300000).optional(),
      capacityWaitMs: z.number().int().min(0).max(1800000).optional(),
      includeItems: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  guard(({ backend = "auto", ...rest }) => runStructuredBatch({ backend, ...rest })),
);

server.registerTool(
  "swarm_batch_status",
  {
    title: "Read checkpointed swarm batch status",
    description: "Read the current manifest, item statuses, aggregated token/credit usage, and any blocker for a batchId.",
    inputSchema: {
      batchId: z.string().regex(/^[a-zA-Z0-9._-]{1,120}$/),
      includeItems: z.boolean().optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  guard(({ batchId, includeItems }) => readBatchStatus(batchId, includeItems !== undefined ? { includeItems } : undefined)),
);

await server.connect(new StdioServerTransport());
