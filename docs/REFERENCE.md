# Reference Documentation

Detailed specification for **subagent-swarm-mcp** (legacy bin `glm-zcode-mcp`) MCP tools, backends, billing routes, structured contracts, CLI tools, environment variables, and technical limits. See [README.md](../README.md) (简体中文) or [README.en.md](../README.en.md) (English) for quick start, educational/fair-use boundaries, and the full compliance disclaimer.

---

## 1. MCP Tools (42 Tools)

### Unified Multi-CLI Swarm Pool (13)

| Tool | Purpose |
|---|---|
| `swarm_backends {}` | Inspect registered backends (`codebuddy`, `qoder`, `zcode`), binary/CDP availability, profiles, allowed models, and running/max concurrency. |
| `swarm_run {prompt, backend?, model?, fallbackModel?, profile?, cwd?, provider?, effort?, maxTurns?, systemPrompt?, appendSystemPrompt?, addDirs?, ephemeral?, waitSec?}` | Run a task on `auto` (default), `codebuddy`, `qoder`, or `zcode`. CLI backends default to `profile: "lite"` (zero tools + lean system prompt on CodeBuddy); `effort` (`minimal`..`max`), `maxTurns` (1..100), `systemPrompt`/`appendSystemPrompt`, and `addDirs` configure CodeBuddy CLI directly; set `waitSec` (1–55) for single-call inline completion. |
| `swarm_wait {taskId, timeoutSec?}` | Block up to 55 s on any `cb_*`, `qd_*`, or `sess_*` task and return final result/usage when done. |
| `swarm_status {taskId}` | Non-blocking status with live tool tracking and automatic dead-worker reconciliation. |
| `swarm_result {taskId}` | Return final answer, model metadata, and token/credit usage (`cb_*`, `qd_*`, or `sess_*`). |
| `swarm_followup {taskId, prompt, model?, fallbackModel?}` | Continue a finished, non-ephemeral task (`-r` on CodeBuddy/Qoder; composer send on ZCode). |
| `swarm_cancel {taskId}` | Terminate a `cb_*` or `qd_*` worker process group (`-pgid`) or click ZCode stop on `sess_*`. |
| `swarm_list {backend?, limit?}` | Merged newest-first task list across `all`, `codebuddy`, `qoder`, or `zcode`. |
| `swarm_quota {backend?, refresh?, sinceDays?}` | Read CodeBuddy billing/local usage, Qoder account/local usage, ZCode displayed quota, or all (`all`). |
| `swarm_run_structured {task, input, schema, domainRule?, backend?, profile?, cwd?, ephemeral?, waitSec?, model?, fallbackModel?, provider?}` | Execute a bounded JSON Schema contract (`backend` defaults to `auto`; CLI defaults to `lite`); evaluates inline when `waitSec > 0` completes in time. |
| `swarm_structured_result {taskId}` | Recover stored contract (from `<stateDir>/cb-runs/`, `<stateDir>/qd-runs/`, JSONL, or ZCode SQLite) and validate output. |
| `swarm_batch_run {batchId, task, schema, items, backend?, profile?, cwd?, ephemeral?, microbatchSize?, maxConcurrency?, reserveSlots?, maxCredit?, capacityWaitMs?, includeItems?, ...}` | Checkpoint-resumable structured batching across `auto` (default), `codebuddy`, `qoder`, or `zcode`, with credit budget caps (`maxCredit`), dynamic slot yielding (`reserveSlots`), busy-slot backoff (`capacityWaitMs`, default 5 min), machine-actionable blockers (`retryable`, `recommendedAction`), live `progress.json` heartbeats, automatic timeout cancellation + retry, and compact mode (`includeItems: false`). |
| `swarm_batch_status {batchId, includeItems?}` | Read `<stateDir>/batches/<batchId>/` manifest, counts, aggregated token + `credit` usage, live `progress.json`, blockers, and optional per-item array (`includeItems`). |

### Legacy Core ZCode Control & Monitoring (10)

| Tool | Purpose |
|---|---|
| `zcode_run {prompt, model?, provider?}` | Start a task in the configured project; returns `taskId` in ~4 s. |
| `zcode_wait {taskId, timeoutSec?}` | Block up to 55 s; returns status plus result when finished. |
| `zcode_status {taskId}` | Non-blocking state (`running / completed / failed / cancelled / starting`), elapsed time, current tool, tool-call count, idle time. |
| `zcode_result {taskId}` | Final answer text, observed model/provider, and token usage. |
| `zcode_followup {taskId, prompt}` | Continue a finished task inside the same ZCode session. |
| `zcode_cancel {taskId}` | Click ZCode's stop button for a running task. |
| `zcode_list {limit?}` | List recent non-archived tasks in the project. |
| `zcode_progress {taskId, refresh?}` | Gemini Flash digest (`summary`, `done`, `doing`, `next`, `progressPct`, `onTrack`, `concerns`, `needsAttention`). Cached in `<stateDir>/progress/<taskId>.json` and appended to `<taskId>.md`. |
| `zcode_health {}` | Check DevTools port, target project visibility, running count, and known login/dialog blockers. |
| `zcode_quota {}` | Briefly open the UI context hover card under the UI lock and parse displayed quota windows. |

> **`zcode_quota` caveats:** Holds the hovercard open for a brief settle window (`ZCODE_MCP_QUOTA_SETTLE_MS`, default `1200` ms, converging early once an async UI update stabilizes) so ZCode's background entitlement refresh completes instead of returning the previous open's cached percentage (`refreshedDuringRead` indicates whether the DOM updated during the wait). Parses both **BigModel 个人** (`剩余额度`: `5 小时` / `每周` / `工具调用` / `ZCode MCP`) and **Start Plan 免费** (`今日余额`: per-model daily quota rows such as `GLM-5.3-Flash`, skipping promo badges like `150% 配额`), returning `section` and `planHint`. Missing or unrecognized windows report as unknown (never zero). Displayed account/provider identity cannot be independently verified, so do not use it as an automated billing-route gate. It never clicks reset actions or handles credentials.

### Legacy ZCode Session Snapshots, Events & Model IO (4)

| Tool | Purpose & Caveats |
|---|---|
| `zcode_session_parts {taskId, after?, limit?, includeContent?}` | Read paginated assistant text/tool **snapshots** from SQLite. Metadata only by default; opt-in `includeContent` omits parts > 8 KiB. Pagination is by part ID, not chronological or a live cursor. |
| `zcode_session_part_content {taskId, partId, offset?, limit?, expected?}` | Read a large part's JSON in bounded base64 byte chunks (max 8 KiB); pass the returned version as `expected` on subsequent chunks (same-size updates within the same millisecond are indistinguishable). |
| `zcode_session_events {taskId, cursor?, limit?, start?}` | Poll bounded JSONL lifecycle events (`turn.*`, `model.request.*`, `tool.call.*`). Starts at the newest log by default, or oldest retained with `start: "oldest"`. Drain `hasMore` pages and inspect `gaps` for rotated/missing/oversize history. Does not return assistant text or tool inputs/outputs. |
| `zcode_session_model_io {taskId, cursor?, includeContent?}` | Read one optional ZCode model-IO JSONL record per call (metadata only by default; opt-in for text and tool args). Recording may be absent or incomplete; lines > 1 MiB stop with a gap. Request bodies and headers are never returned. |

### Legacy Structured Output & Batches (4)

| Tool | Purpose |
|---|---|
| `zcode_run_structured {task, input, schema, domainRule?, model?, provider?}` | Start a ZCode session with a bounded JSON Schema contract and optional preset or declarative `domainRule`. Contract is stored in the initial user prompt. |
| `zcode_structured_result {taskId, domainRule?}` | Recover the original contract from SQLite and validate the final JSON response (`valid`, `invalid`, `pending`, or `task_not_completed`). |
| `zcode_batch_run {batchId, task, schema, items, domainRule?, templateId?, model?, provider?, fallbackProvider?, maxConcurrency?, reserveSlots?, maxRetries?, microbatchSize?, maxBatchInputChars?, capacityWaitMs?, includeItems?}` | Run or idempotently resume a JSONL-checkpointed batch on ZCode (`backend: "zcode"`), with optional `reserveSlots` yielding, automatic jittered backoff retries on upstream `concurrency_limit` (`429 / 3008`), and allow-listed `fallbackProvider` automatic failover on quota exhaustion (e.g. `Start Plan 免费` -> `BigModel 个人`). |
| `zcode_batch_status {batchId, includeItems?}` | Read `<stateDir>/batches/<batchId>/` checkpoint manifest, per-item statuses (omitted when `includeItems: false`), deduplicated token usage, and circuit-breaker state (`blocked.json`). |

### Dispatch Hub (10) & CodeBuddy Credit (1)

| Tool | Purpose |
|---|---|
| `hub_post {title, task, repo?, base?, kind?, tier?, accept?, acceptTimeoutMin?, timeoutMin?, preferWorkers?, avoidVendors?, review?}` | Queue a self-contained task on the Git-backed dispatch hub (`docs/HUB-PLAN.md`). |
| `hub_board {}` | List all hub tasks with state, assignee, attempt count, and latest note. |
| `hub_show {id}` | Inspect a task in full: `spec`, `taskMd`, `answerMd`, `reportMd`, `acceptLog`. |
| `hub_wait {until?, timeoutSec?, cursor?}` | Block up to 55 s until `attention` (need-info / failed / rejected / idle after change), `change`, or `idle`. Re-call if `timedOut`. |
| `hub_answer {id, text}` | Answer a `need-info` task and return it to its assignee (ZCode workers receive a follow-up). |
| `hub_cancel {id}` / `hub_requeue {id}` | Cancel an active/done task, or requeue a failed/rejected/cancelled task. |
| `hub_assign {id, worker, reason?}` | Override the scheduler and assign a queued/assigned task to `worker`. |
| `hub_tell {id, text}` | Append a 1-line (<= 300 char) message to the task's `refs/inbox/<id>` stream. |
| `hub_log {id}` | Read the merged, time-sorted timeline of state changes, `PROGRESS`, and `INBOX` lines. |
| `codebuddy_usage {refresh?, sinceDays?, expiringSoonDays?}` | Read CodeBuddy/WorkBuddy account credit (read-only WorkBuddy billing API, 10 min cache, with `expiringSoon` alerts) + deduplicated local consumption across both `~/.codebuddy/projects/*/*.jsonl` and `<stateDir>/cb-runs/cb_*.json` (capturing `ephemeral: true` runs), including tokens/cache-hit/reasoning breakdowns, per-model/per-profile costs, daily trends, top tasks, and burn-rate `runway`. |

---

## 2. Backends, Profiles & Billing Routes

### CodeBuddy CLI Backend (`codebuddy`)

| Profile | CLI Flags | Capabilities |
|---|---|---|
| `lite` (default) | `--tools "" --mcp-config '{"mcpServers":{}}' --strict-mcp-config --system-prompt "..."` | Zero tools, no MCP servers, lean pure-text `--system-prompt` (cuts baseline input tokens ~57%; disable via `systemPrompt: false` or `CODEBUDDY_LITE_SYSTEM_PROMPT=off`), plus memory-guard prefix on free-form prompts. Lowest token/credit cost; best for pure reasoning and `ZCODE_STRUCTURED_V1` single-turn extraction (intentionally avoids `--json-schema` which conflicts with `--tools ""`). Silent zero-token empty responses fail closed as `empty_response`. |
| `readonly` | `--tools Read,ViewImage,Glob,Grep,WebSearch,WebFetch --allowedTools Read,ViewImage,Glob,Grep,WebSearch,WebFetch --mcp-config '{"mcpServers":{}}' --strict-mcp-config -y [--add-dir ...]` | Non-destructive codebase/image/web inspection in `cwd` (plus optional `addDirs`, `effort`, and `maxTurns` loop guard). |
| `workspace` | `-y [--add-dir ...]` | Full built-in + configured MCP workspace access inside `cwd` (plus optional `addDirs`, `effort`, and `maxTurns`). |

Default model: `hy4flash-free`. Other supported models include `hy4flash`, `hy4std`, `deepseek-v4.1-flash`, `glm-5.3`, `glm-5.3-flash`, `glm-5.2`, `space-bunny`, `minimax-m3.1-flash`, `minimax-m2.7`, `kimi-k3.1-pro`, `kimi-k3-1`, `kimi-k2.8-preview`, `deepseek-v4-pro`, `step-5-preview`, and `mimo-v2.6-pro`.

### Qoder CLI Backend (`qoder`)

| Profile | CLI Flags | Capabilities |
|---|---|---|
| `lite` (default) | `--tools "" --mcp-config '{"mcpServers":{}}' --strict-mcp-config` | Zero tools, no MCP servers, memory/tool-guard prefix on free-form prompts. |
| `readonly` | `--tools Read,Glob,Grep,WebSearch,WebFetch --allowed-tools Read,Glob,Grep,WebSearch,WebFetch --dangerously-skip-permissions --mcp-config '{"mcpServers":{}}' --strict-mcp-config` | Non-destructive codebase/web inspection in `cwd`. |
| `workspace` | `--dangerously-skip-permissions` | Full built-in + workspace access inside `cwd`. |

Default model: `DeepSeek-Flash`. Requires RFC 4122 UUID session IDs internally (`taskId = qd_<uuid>`), maps `<cwd>` to `~/.qoder/projects/<cwd-slug>/`, and extracts `total_credits` from `-p -o json` output (`qodercli status -o json` excludes PII such as email/username). Other models include `Auto`, `Ultimate`, `Fast`, `Efficient`, `Sonus`, `Cantus`, `Qwen4-Max`, `Qwen4-Max-Preview`, `Qwen3.8-Max`, `Qwen3.8-Flash`, `Kimi-K3.1-Pro`, `Kimi-K2.8-Preview`, `GLM-5.3`, `GLM-5.3-Flash`, `DeepSeek-V4-Pro`, and `MiniMax-M3.1-Flash`.

### ZCode Billing Routes (Providers)

ZCode's model menu groups the same model names under multiple billing routes, so each run selects a *(provider, model)* pair:

| Provider (`--provider` / `provider`) | Menu label | Models |
|---|---|---|
| `account%3Abigmodel-individual-coding-plan` (default) | BigModel 个人 | `GLM-5.3`, `GLM-5.3-Flash` |
| `account%3Abigmodel-start-plan` | Start Plan 免费 | `GLM-5.3`, `GLM-5.3-Flash` |

`ZCODE_MCP_PROVIDER` sets the default route and `ZCODE_MCP_PROVIDERS` defines the allow-list (requests outside the allow-list are rejected so personal API-key routes are never chosen accidentally). Because the trigger's `aria-label` displays only the model name, `setModel` opens the menu and waits dynamically for items to render, exits immediately in a single pass when the desired `(provider, model)` is already checked (eliminating redundant menu double-opens), switches providers via `composer-provider-trigger` when needed, verifies `aria-checked`, always closes menus in `finally` (unwinding nested Radix submenus and stray non-dialog popovers without ever touching real auth/confirmation dialogs), and compares SQLite `model.providerId` after creation (attaching a `warning` on mismatch).

---

## 3. Structured Contracts & Auto-Microbatching

* **Supported JSON Schema keywords:** `type`, `description`, scalar `enum`, object `properties`, `required`, `additionalProperties: false`, array `items`, `minItems`, `maxItems`, string `minLength`, `maxLength`, and numeric `minimum`, `maximum`. Root must be an object; every object must declare `properties` and `additionalProperties: false`. Bounds: schema <= 16 KiB, result <= 256 KiB.
* **Domain rules (`domainRule`):**
  * Built-in presets: `section-outline-v1` and `section-outline-microbatch-v1`.
  * Declarative JSON rule object: `{ arrayField, matchInputIds, uniqueField, noLevelJump, fieldConstraints }`, enforcing cross-field semantic checks without modifying repository code.
  * Optional private extensions: place untracked exports (`DOMAIN_VALIDATORS`, `TASK_SPECS`, `LOCAL_HOST_POLICY`, `LOCAL_WORKDIR_RULE`) in `local/presets.mjs` (gitignored) or point `ZCODE_MCP_LOCAL_MODULE` to a JS file (`none` disables loading).
* **Plan B batching & recovery:** Deterministic keys `sha256(templateId + itemId + inputHash + schemaHash + domainRule)`, append-only checkpoints (`manifest.jsonl`, `results.jsonl`, `progress.json`, `summary.json`, `blocked.json`) under `<stateDir>/batches/<batchId>/`, adaptive polling (500 ms–5 s on CLI backends, 2–5 s on ZCode), dynamic slot yielding (`reserveSlots`), busy-slot backoff (`capacityWaitMs`, default 5 min), credit budget cap (`maxCredit`), automatic slot cleanup + `<= 1` retry on `invalid` or `timeout`, and immediate 0-retry circuit breaking (`blocked.json`, enriched with `retryable` and `recommendedAction`: `cooldown_quota` / `wait_capacity` / `increase_credit_budget` / `check_billing_route` / `needs_human_auth`) on `quota_or_rate_limit`, `capacity_exhausted`, `credit_budget_reached`, login/dialog blockers, or billing route mismatch (resuming a blocked batch re-runs both `quota_or_rate_limit`/`capacity_exhausted` and `pending` items). With `microbatchSize > 1`, items pack up to `maxBatchInputChars`; valid items persist immediately while only failed subset items are retried individually. Use `swarm batch-export` / `zcode batch-export` to salvage already-`valid` items from `results.jsonl` after any mid-wave interruption.

---

## 4. CLI Tools

All binaries are exposed via `package.json` `bin` (or `node bin/<name>.mjs`):

### `swarm` (`bin/swarm.mjs`)
* `swarm backends` | `swarm list [N] [--backend all|codebuddy|qoder|zcode]` | `swarm quota [--backend all|codebuddy|qoder|zcode] [--refresh] [--days N]`
* `swarm run (--file F | --text T | stdin) [--backend auto|codebuddy|qoder|zcode] [--profile lite|readonly|workspace] [--cwd DIR] [--model M] [--fallback-model M] [--ephemeral] [--wait [SEC]]`
* `swarm run-structured --task T --schema JSON_OR_FILE --input JSON_OR_FILE [--domain-rule R] [--backend ...] [--profile ...] [--cwd DIR] [--ephemeral] [--wait [SEC]]`
* `swarm structured-result <taskId>` | `swarm wait <taskId> [SEC]` | `swarm status|result|cancel <taskId>` | `swarm followup <taskId> (--text T | --file F | stdin) [--model M]`
* `swarm batch --id ID --spec PRESET_OR_FILE --input JSONL_FILE [--limit N] [--microbatch K] [--retries 0|1] [--backend ...] [--provider KEY] [--fallback-provider KEY] [--concurrency N] [--reserve-slots N] [--max-credit N] [--max-batch-chars N] [--timeout-ms MS] [--capacity-wait-ms MS] [--state-dir DIR] [--ephemeral] [--export OUT] [--summary OUT] [--compact]`
* `swarm batch-status <batchId> [--state-dir DIR] [--compact]` | `swarm batch-export <batchId> [--out FILE] [--spec PRESET_OR_FILE] [--input JSONL_FILE] [--state-dir DIR] [--compact]`

### `zcode` (`bin/zcode.mjs`) & `zcode-watch` (`bin/zcode-watch.mjs`)
* `zcode run (--file F | --text T | stdin) [--model M] [--provider KEY]`
* `zcode run-structured --task T --schema JSON_OR_FILE --input JSON_OR_FILE [--domain-rule R]`
* `zcode structured-result <taskId> [--domain-rule R]`
* `zcode batch --id ID --spec PRESET_OR_FILE --input JSONL_FILE [--limit N] [--microbatch K] [--retries 0|1] [--concurrency N] [--reserve-slots N] [--max-batch-chars N] [--timeout-ms MS] [--capacity-wait-ms MS] [--state-dir DIR] [--model M] [--provider KEY] [--fallback-provider KEY] [--export OUT] [--summary OUT] [--compact]`
* `zcode batch-status <batchId> [--state-dir DIR] [--compact]` | `zcode batch-export <batchId> [--out FILE] [--spec PRESET_OR_FILE] [--input JSONL_FILE] [--state-dir DIR] [--compact]` | `zcode status|result|cancel|list|health|quota` | `zcode followup <taskId> ...` | `zcode progress <taskId> [--refresh]`
* `zcode-watch <taskId...> [--every SEC] [--timeout SEC] [--quiet]`: exits `0` when all tasks finish (`DONE`), `3` on `ATTENTION`, `4` when `--timeout` expires with tasks still running, `2` on usage error.

### `dispatch` (`bin/dispatch.mjs`) & `hub-kit/bin/hub`
* **Architecture:** Bare Git repo (`HUB_REMOTE`, single `main` branch, CAS retry), long-running `dispatch daemon` (10 s tick), optional LLM scheduler (`agy -p` with deterministic fallback via `HUB_SCHEDULER=rules`), and local (`zcode`/`cli`) or remote (`manual` via POSIX-only `hub-kit/bin/hub`) workers. See [HUB-PLAN.md](HUB-PLAN.md) and [SUPERVISOR.md](SUPERVISOR.md).
* **Master commands:** `dispatch init`, `post`, `board [--all] [--json]`, `show <id>`, `wait [--until attention|change|idle] [--timeout SEC] [--cursor NAME]`, `answer <id> (--file F | --text T)`, `assign <id> <worker>`, `tell <id> (--file F | --text T) [--from NAME]`, `log <id>`, `watch <id...> [--timeout SEC] [--quiet-min MIN]`, `cancel <id>`, `requeue <id>`, `workers`, `daemon [--once]`, `cleanup [--apply]`.
* **Checkouts, acceptance & retention:** Local code/review tasks use detached Git worktrees by default (`HUB_CHECKOUT_MODE=clone` opts out); acceptance replays `result/patch.diff` in a clean worktree (`bash -o pipefail -c`) and optionally spawns a cross-vendor `--review` child task expecting `VERDICT: PASS|NEEDS_FIX`. CLI worker logs are capped by a detached rolling supervisor (`HUB_WORKER_LOG_MAX_MB=10`), and hourly cleanup reclaims expired idle terminal checkouts (1 h for `accepted`, 3 d for `failed`/`rejected`/`cancelled`) while keeping hub records and artifacts intact.
* **Host policy:** Configure `HUB_HOST_POLICY` / `HUB_WORKDIR_RULE` (or `local/presets.mjs`) to inject build-host separation instructions into worker prompts; the daemon does not relocate shell commands automatically.

### `codebuddy-usage` (`bin/codebuddy-usage.mjs`)
* `codebuddy-usage [--refresh] [--json] [--days N] [--expiring-days N] [--runs-dir DIR] [--top N]` | `codebuddy-usage set-token` (saves hidden JWT with `0600` permissions).
* Merges local consumption across `~/.codebuddy/projects/*/*.jsonl` and `<stateDir>/cb-runs/cb_*.json` (capturing `ephemeral: true` runs while deduplicating persistent sessions), reports expiring-soon packages (`expiringSoon`), token/cache-hit/reasoning breakdowns, per-model/per-profile unit economics, daily trends, and burn-rate `runway`.
* Token lookup order: `CODEBUDDY_USAGE_TOKEN` -> `CODEBUDDY_TOKEN_FILE` (`0600` enforced) -> CodeBuddy CLI's own `accessToken` file (never refreshed so the CLI is never logged out). Unofficial WorkBuddy web billing endpoint; may change without notice.

---

## 5. Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `CODEBUDDY_BIN` | auto-discovered | Explicit path to `codebuddy` binary |
| `CODEBUDDY_DEFAULT_MODEL` | `hy4flash-free` | Default CodeBuddy CLI model |
| `CODEBUDDY_MODELS` | 16 built-in CLI models | Comma-separated model list reported by `swarm_backends` |
| `CODEBUDDY_MAX_RUNNING` | `4` | Concurrent running CodeBuddy task cap |
| `CODEBUDDY_DEFAULT_CWD` | `ZCODE_MCP_PROJECT_DIR` | Default working directory for CodeBuddy tasks |
| `CODEBUDDY_PROJECTS_DIR` | `~/.codebuddy/projects` | CodeBuddy CLI transcript root |
| `CODEBUDDY_RUNS_DIR` | `<stateDir>/cb-runs` | Swarm CodeBuddy run state directory merged into `codebuddy-usage` |
| `CODEBUDDY_EXPIRING_SOON_DAYS` | `7` | Window (days) for highlighting expiring active credit packages |
| `CODEBUDDY_PREFER_WHEN_EXPIRING` | `1` (enabled) | In `backend: "auto"`, prefer CodeBuddy while cached expiring credits & free slots exist (`0` disables) |
| `CODEBUDDY_LITE_SYSTEM_PROMPT` | built-in lean prompt | Override CodeBuddy `lite` `--system-prompt`, or `off` to disable |
| `CODEBUDDY_DEFAULT_EFFORT` | unset | Default CodeBuddy `--effort` (`minimal`/`low`/`medium`/`high`/`xhigh`/`max`) |
| `CODEBUDDY_API_BASE` | `https://www.workbuddy.cn` | Use `https://www.workbuddy.ai` for international |
| `QODER_BIN` | auto-discovered | Explicit path to `qodercli` binary |
| `QODER_DEFAULT_MODEL` | `DeepSeek-Flash` | Default Qoder CLI model |
| `QODER_MODELS` | 17 built-in CLI models | Comma-separated Qoder model list |
| `QODER_MAX_RUNNING` | `4` | Concurrent running Qoder task cap |
| `QODER_DEFAULT_CWD` | `ZCODE_MCP_PROJECT_DIR` | Default working directory for Qoder tasks |
| `QODER_PROJECTS_DIR` | `~/.qoder/projects` | Qoder CLI transcript root |
| `ZCODE_MCP_CDP_PORT` | `9222` | Loopback Chrome DevTools port on `127.0.0.1` |
| `ZCODE_MCP_PROJECT` | `subagent` | Target ZCode sidebar project label |
| `ZCODE_MCP_PROJECT_DIR` | `~/projects/subagents` | Directory mapped to the ZCode project |
| `ZCODE_MCP_MODELS` | `GLM-5.3,GLM-5.3-Flash` | Allowed ZCode model names |
| `ZCODE_MCP_DEFAULT_MODEL` | `GLM-5.3` | Default ZCode model when omitted |
| `ZCODE_MCP_PROVIDER` | `account%3Abigmodel-individual-coding-plan` | Default ZCode billing route |
| `ZCODE_MCP_PROVIDERS` | `account%3Abigmodel-individual-coding-plan,account%3Abigmodel-start-plan` | Allowed ZCode billing routes; all others refused |
| `ZCODE_MCP_MAX_RUNNING` | `3` | Concurrent running ZCode task cap |
| `ZCODE_MCP_AUTO_DISMISS_POPOVER` | `1` (enabled) | Allow `zcode_quota` to dismiss stale non-dialog Radix popovers before reading (`0` refuses instead; real dialogs are never touched) |
| `ZCODE_MCP_QUOTA_SETTLE_MS` | `1200` | Milliseconds `zcode_quota` holds the hovercard open for ZCode's async entitlement refresh before reading (`0..5000`; converges early on update) |
| `ZCODE_MCP_STALLED_SEC` | `600` | Idle seconds before reporting a stalled task |
| `ZCODE_MCP_STARTING_TIMEOUT_SEC` | `300` | Seconds before an unstarted session fails closed |
| `ZCODE_MCP_LOCAL_MODULE` | unset (`local/presets.mjs`) | Optional extension path, or `none` to disable |
| `ZCODE_MCP_SUMMARY_MIN_SEC` | `300` | Minimum seconds between `zcode_progress` LLM calls |
| `ZCODE_MCP_SUMMARY_CMD` | `agy -p {prompt} --model gemini-3.8-flash-low ...` | Digest command template |
| `HUB_REMOTE` | `~/dispatch/hub.git` | Bare hub Git repository |
| `HUB_WORKDIR` | `<stateDir>/hub` | Daemon/CLI working clone |
| `HUB_TICK_SEC` | `10` | Daemon loop interval in seconds |
| `HUB_CHECKOUT_MODE` | `worktree` | `worktree` or `clone` for local code/review tasks |
| `HUB_WORK_RETENTION_DAYS` | `3` | Retention days for failed/rejected/cancelled checkouts (`0` disables) |
| `HUB_SUCCESS_RETENTION_HOURS` | `1` | Retention hours for accepted checkouts |
| `HUB_CLEANUP_INTERVAL_SEC` | `3600` | Seconds between cleanup scans |
| `HUB_WORKER_LOG_MAX_MB` | `10` | Rolling CLI worker log cap in MiB |
| `HUB_ONLINE_SEC` / `HUB_STALE_SEC` | `180` / `300` | Heartbeat online threshold & lease expiration |
| `HUB_SCHED_MIN_SEC` / `HUB_SCHEDULER` | `30` / unset | Scheduler cooldown & `rules` deterministic mode |
| `HUB_ACCEPT_TIMEOUT_MIN` | `30` | Default `--accept` timeout in minutes |
| `HUB_HOST_POLICY` / `HUB_WORKDIR_RULE` | unset | Optional prompt policy rules injected into hub workers |
| `HUB_DIR` / `HUB_WORK` / `HUB_SSH_HOST` | `..` / `~/hub-work` / origin host | Worker-side (`hub-kit/bin/hub`) settings |

---

## 6. Known Technical Limits

* **ZCode cancel does not kill child shell processes:** Clicking stop ends the ZCode turn, but commands already spawned (e.g. `sleep 90`) may keep running. By contrast, `codebuddy` backend runs each worker in its own process group and `swarm_cancel` signals `-pgid`.
* **Stateless worker context:** Subagents cannot see the caller's conversation; prompts must be self-contained.
* **Escape key semantics (ZCode):** Never send a bare Escape to ZCode (on an active task it interrupts generation); the server only presses Escape when closing an open dropdown menu.
* **UI coupling (ZCode):** Automation targets ZCode's `data-testid` attributes (`3.16.1` / `3.18.2` verified). After upgrading ZCode, re-run `zcode_health` and `node e2e/scenario1.mjs`; `node scripts/screenshot.mjs` captures the current window for debugging.
* **Linux cgroup memory caps (ZCode):** Electron/Chromium migrates into an uncapped `app-zcode-*.scope` over D-Bus unless constrained. `scripts/start-zcode.sh` and `scripts/zcode-headless.sh` enforce `MemoryHigh=5G`, `MemoryMax=6G`, `MemorySwapMax=0` (see `scripts/zcode.slice` and `scripts/app-zcode-.scope-memory.conf`), and `src/store.mjs` uses OS boot time + `zcode_protocol.startup.started` to fail-close orphaned sessions after an OOM kill or reboot.
