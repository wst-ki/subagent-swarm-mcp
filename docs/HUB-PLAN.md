# Dispatch Hub — plan (v0.2)

Goal: a host-agnostic way for one **master** agent (Claude Code, Codex, ...) to hand batches of tasks to many
**worker** agents on different machines, get woken when something needs it, and keep every subscription's quota busy.
Backend only. No T3 dependency.

## Roles

| Role | Where | Does | Token cost |
|---|---|---|---|
| master | any host with a shell or MCP | posts tasks, answers questions, final review | expensive, so wake it rarely |
| hub | a git repo on the hub host, separate from any project | the only shared state: queue, roster, results | none |
| daemon | hub host, long-running `dispatch daemon` | expires leases, runs local workers, accepts results, calls the scheduler | none |
| scheduler | `agy -p` with Gemini 3.8 Flash, called by the daemon | decides which worker gets which queued task | cheap (Gemini quota) |
| workers | hub host (ZCode, local CLIs), remote (manual: user pastes a prompt) | claim, work, report | their own quota |

The user curates the roster (`workers.json` in the hub) and can override any assignment (`dispatch assign`).
The scheduler only proposes; hard constraints are enforced in code.

## Hub repository

Bare repo `~/dispatch/hub.git` (env `HUB_REMOTE`). The daemon/CLI keep a working clone in
`<stateDir>/hub` (env `HUB_WORKDIR`; `stateDir` from `src/config.mjs`). Remote workers clone `hub-host:dispatch/hub.git`.
Single branch `main`. Every state change is one commit. Plain-text files so a POSIX shell can edit them.

```
PROTOCOL.md             how a worker agent uses bin/hub (remote/manual agents read this)
SCHEDULER.md            scheduling policy in plain language (user-editable; fed to the scheduler prompt)
workers.json            roster (user-edited)
bin/hub                 POSIX sh worker helper (needs only sh + git)
tasks/<id>/
  task.md               instructions for the worker (written by master)
  spec.json             machine-readable spec (below)
  state                 one word: queued|assigned|running|done|need-info|failed|accepted|rejected|cancelled
  assignee              worker id, or empty
  lease                 unix seconds deadline while running, or empty
  attempts              integer
  note                  one line: latest scheduler reason / failure / question
  run                   local runner bookkeeping, e.g. "zcode:sess_abc" or "pid:1234" (local workers only)
  answer.md             master's answer to a need-info question (optional)
  result/report.md      worker's report (fixed headings, short)
  result/patch.diff     `git diff --binary <base>` of the work (code tasks)
  result/accept.log     tail of the acceptance run
```

Heartbeats do **not** touch `main`: a worker force-pushes `refs/hb/<workerId>` (an empty-tree commit whose message
is the unix time). `online` = heartbeat younger than `HUB_ONLINE_SEC` (default 180).

Task id: `T<yyyymmdd>-<HHMMSS>-<2 random base36>` (sortable).

`spec.json`:
```json
{ "id": "...", "title": "...", "kind": "code|text|review",
  "repo": "/abs/path/on/hub-host or null", "base": "<commit sha> or null",
  "tier": "low|mid|high", "accept": "shell command run in the patched checkout, or null",
  "timeoutMin": 45, "avoidVendors": [], "preferWorkers": [], "review": false,
  "parent": null, "createdAt": "ISO", "createdBy": "master id" }
```

`workers.json`:
```json
{ "workers": [
  { "id": "local-zcode-glm53", "kind": "zcode", "host": "local", "vendor": "zhipu", "model": "GLM-5.3",
    "provider": "account%3Abigmodel-individual-coding-plan",
    "tier": "high", "maxParallel": 2, "enabled": true, "kinds": ["code", "text", "review"], "costRank": 1 },
  { "id": "local-codex", "kind": "cli", "host": "local", "vendor": "openai", "model": "gpt-6.1-sol", "tier": "high",
    "maxParallel": 1, "enabled": true, "kinds": ["code", "text", "review"], "costRank": 2,
    "cmd": ["codex", "exec", "-s", "workspace-write", "--skip-git-repo-check", "-m", "gpt-6.1-sol", "{prompt}"] },
  { "id": "remote-codex", "kind": "manual", "host": "remote", "vendor": "openai", "model": "gpt-6.1-sol", "tier": "high",
    "maxParallel": 1, "enabled": true, "kinds": ["code", "text", "review"], "costRank": 2 }
] }
```
`{prompt}` in `cmd` is replaced by the prompt text; `{workdir}` by the task working directory.
A zcode worker's optional `provider` is the billing route its tasks run on (default
`ZCODE_MCP_PROVIDER`; e.g. `"provider": "account%3Abigmodel-start-plan"` for Start Plan 免费).

### State machine

```
post                      -> queued
assign (scheduler/user)   queued -> assigned            (assignee, note = reason)
claim (worker)            assigned(to me) -> running    (lease = now + timeoutMin, attempts += 1)
report (worker)           running -> done               (result/*)
ask (worker)              running -> need-info          (note = question)
answer (master)           need-info -> assigned         (answer.md, same assignee)
fail (worker)             running -> failed             (note)
accept (daemon)           done -> accepted | rejected   (result/accept.log)
expire (daemon)           running -> queued             when lease passed or assignee heartbeat stale > HUB_STALE_SEC (300);
                                                        -> failed when attempts >= 3
cancel (master)           any non-terminal -> cancelled
requeue (master)          failed|rejected|cancelled -> queued (assignee cleared)
assign (user override)    queued|assigned -> assigned to the given worker
```
Terminal: accepted, cancelled (and failed/rejected until requeued).

### Concurrency

Every mutation: `fetch` → `reset --hard origin/main` → check the precondition (`from` states) → write files →
commit → `push`. Push rejected → retry from fetch (up to 8 times, small random backoff). Precondition no longer
true → `HubConflictError`. Same algorithm in `bin/hub` (sh) and in Node.

## Notification (how the master learns things)

`dispatch wait [--until attention|change|idle] [--timeout SEC] [--cursor NAME]` blocks, then prints one line per
event and exits 0 (exit 2 on timeout, printing `timeout`). It compares current states against a cursor file
`<stateDir>/hub-cursor-<NAME>.json` (default name `master`) and updates it.

- `change`: any state change.
- `attention` (default): a task entered need-info / failed / rejected, **or** the hub became idle
  (nothing queued/assigned/running) after some change. On idle it also prints the accepted tasks since the cursor.
- `idle`: only the idle condition.

Line format: `<id> <state> <assignee|-> <+adds/-dels|-> "<title>" <note>` (≤ 200 chars).

Hosts: Claude Code runs `dispatch wait` as a background command (it is woken when the command exits).
Hosts without background commands run it in the foreground with a timeout. MCP-only hosts use `hub_wait` (≤ 55 s).

## Scheduler (agy + Gemini Flash)

Runs inside the daemon only when there is at least one queued task **and** at least one eligible worker with a free
slot (no LLM call otherwise), at most once per `HUB_SCHED_MIN_SEC` (30).

1. Build a compact snapshot: queued tasks `{id,title,kind,tier,attempts,note,avoidVendors,preferWorkers,parentVendor}`
   and workers `{id,kind,vendor,tier,model,costRank,online,busy,maxParallel,cooldownUntil}`; drop disabled workers.
2. Prompt = `SCHEDULER.md` + snapshot JSON + "Return assignments". Command (env `HUB_SCHEDULER_CMD` overrides):
   `agy -p <prompt> --model gemini-3.8-flash-medium --output-format json --json-schema <schemaFile> --disable-slash-commands`
   run in an empty temp dir, timeout 90 s. Parse stdout JSON, take `.structured_output.assignments`
   (`[{task, worker, reason}]`); fall back to parsing `.response`.
3. Validate every proposal in code: task still queued; worker exists, enabled, `kinds` includes task kind,
   online (manual workers) or always-online (local kinds), has a free slot (count after earlier proposals),
   vendor not in `avoidVendors`, not cooling down; review tasks: vendor != parent's assignee vendor. Drop invalid ones
   (log why).
4. Apply valid ones via `assign` (note = reason, ≤ 120 chars).
5. If agy fails twice in a row or `HUB_SCHEDULER=rules`: deterministic fallback — `preferWorkers` first, then
   workers whose tier ≥ task tier, fewest busy, lowest `costRank`.

Cooldown: when a local worker's output matches `/usage limit|rate limit|429|quota/i`, the daemon records
`cooldownUntil` (now + 60 min) in `<stateDir>/hub-cooldown.json` and requeues the task.

## Local runner (daemon)

For tasks `assigned` to a local worker (`kind` zcode or cli), each tick:

- Claim it (`running`), then prepare the working dir:
  zcode → `<zcodeProjectDir>/hub/<taskId>` (inside ZCode's project); cli → `<stateDir>/work/<taskId>`.
  Local code/review tasks use detached worktrees by default (`HUB_CHECKOUT_MODE=clone` opts out);
  remote repositories still use clones. Review source is prepared at base to avoid extra clones.
  Local code/review tasks: `git worktree add --detach <dir> <base>`; clone mode uses
  `git clone --no-checkout <repo> <dir> && git -C <dir> checkout --detach <base>`; text tasks: empty dir.
- Prompt = rendered template: task.md, answer.md if present, absolute workdir, rules (work only in workdir, do not
  commit, do not push, finish by writing `REPORT.md` with headings `## Result`, `## Changes`, `## Checks run`,
  `## Open questions`), and "if you must ask the master, write only `## Open questions` and stop".
- zcode: `runTask({prompt, model})` from `src/zcode.mjs`; write `run` = `zcode:<sid>`. Poll `taskStatus(sid)`.
  cli: spawn detached with cwd = workdir, stdout/stderr to `<workdir>/.hub-out.log`; `run` = `pid:<pid>`.
- Finished: `git add -A && git diff --cached --binary <base>` → `result/patch.diff` (exclude `REPORT.md` and
  `.hub-out.log`); `REPORT.md` (or the zcode final answer, or the last 80 log lines) → `result/report.md`.
  Report has a non-empty `## Open questions` and no patch → `ask`; error/cancelled → `fail`; else `report`.
- After `answer`, a zcode task that still has its session uses `followUp` instead of a new task.
- The daemon checks local heartbeats before expiration each tick, refreshing at most once a minute
  by default (or one-third of a shorter configured stale/online window, at tick granularity).
  CLI output is capped by a detached logging supervisor (10 MiB rolling tail by default), which
  survives daemon restarts. Result collection reads a 64 KiB tail. Logs/reports are never staged
  by the runner when exporting a code patch.
- Hourly cleanup removes known idle terminal checkouts: accepted after 1 hour, failed/rejected/
  cancelled after 3 days by default. Git worktrees are unregistered as well as removed. Hub
  records and result artifacts remain; live/unknown workers and active tasks are skipped.

## Acceptance (daemon, local)

Host policy (optional): if `HUB_HOST_POLICY` or `local/presets.mjs` configures an execution-host
policy, worker prompts include it; build/compile/package/release workflows should be routed explicitly
to a configured remote build host rather than relying on automatic command relocation.

For each `done` task:
- code: temp `git worktree add --detach <tmp> <base>` in `spec.repo`, `git apply --index result/patch.diff`
  (failure → rejected), run `spec.accept` (`sh -c`, timeout 15 min) → exit 0 accepted, else rejected. Write the last
  80 lines to `result/accept.log`. No accept command → accepted with note `no accept command`. Always remove the
  worktree.
- `spec.review: true` and the code checks passed: instead of `accepted`, post a child task
  `{kind:"review", parent:<id>, avoidVendors:[<implementer vendor>], tier:"mid"}` whose task.md is the neutral
  review template + the patch, and leave the parent `done` with note `awaiting review <childId>`. When the child is
  `done`, parse `VERDICT: PASS|NEEDS_FIX` from its report → parent accepted / rejected (child → accepted).
- text: accepted (the master reads the report).

## Master interfaces

CLI `dispatch` (`bin/dispatch.mjs`, added to package.json `bin`):
`init`, `post`, `board [--all] [--json]`, `show <id>`, `wait`, `answer <id> (--file f | --text t)`, `cancel <id>`,
`requeue <id>`, `assign <id> <worker>`, `workers`, `daemon [--once]`.
`post` flags: `--title`, `--file task.md` (or stdin), `--repo`, `--base` (default: HEAD of repo), `--kind`,
`--tier`, `--accept`, `--timeout`, `--prefer w1,w2`, `--avoid vendor1,...`, `--review`.

MCP tools in `src/server.mjs`: `hub_post`, `hub_board`, `hub_show`, `hub_wait` (≤ 55 s), `hub_answer`,
`hub_cancel`, `hub_requeue`, `hub_assign`.

## Remote / manual workers

The user pastes into a remote agent:
> You are dispatch worker `remote-codex`. Run `git -C ~/hub pull || git clone hub-host:dispatch/hub.git ~/hub`, read
> `~/hub/PROTOCOL.md`, then loop `sh ~/hub/bin/hub next remote-codex` → do the task → `sh ~/hub/bin/hub done ...`
> until `next` prints `NONE`.

`bin/hub` (sh + git only):
- `next <worker> [--wait SEC]`: heartbeat; claim the oldest task assigned to me (assigned → running); if none, keep
  heartbeating and re-check every 15 s up to `--wait` (default 120); prints `NONE` or `TASK <id> <workdir> <task.md>`.
  Code tasks: clones `spec.repo` (prefixed `${HUB_SSH_HOST}:` when the path is not local) at `base` into
  `${HUB_WORK:-~/hub-work}/<id>`. Starts a background heartbeat loop (pid file) for the duration of the task.
- `done <worker> <id>`: diff + REPORT.md → result, running → done, stop heartbeat loop.
- `ask <worker> <id> <question>` / `fail <worker> <id> <reason>` / `hb <worker>`.

## Module layout and ownership

Part A (hub core) — owned by GLM worker A:
- `src/hub/repo.mjs` — git plumbing: ensure bare+clone, `mutate(fn)` with fetch/reset/commit/push/retry, heartbeat refs.
- `src/hub/tasks.mjs` — `Hub` class (contract below).
- `src/hub/wait.mjs` — cursor diff + `waitForEvents()`.
- `hub-kit/` — PROTOCOL.md, SCHEDULER.md, workers.example.json, bin/hub (seeded into a new hub by `init`).
- `bin/dispatch.mjs` — CLI (the `daemon` subcommand does `await import("../src/hub/daemon.mjs")` and calls
  `runDaemon({ once })`).
- tests: `test/hub-tasks.test.mjs`, `test/hub-wait.test.mjs`, `test/hub-sh.test.mjs` (temp dirs, real git, two
  clones racing for one claim).

Part B (automation) — owned by GLM worker B:
- `src/hub/scheduler.mjs`, `src/hub/runner.mjs`, `src/hub/accept.mjs`, `src/hub/daemon.mjs`.
- `src/server.mjs` — add the `hub_*` tools (keep the existing `zcode_*` tools untouched).
- `scripts/dispatch-daemon.service` — systemd user unit example.
- tests: `test/hub-scheduler.test.mjs`, `test/hub-accept.test.mjs`, `test/hub-runner.test.mjs` using an in-memory
  fake implementing the contract (B must not depend on A's code being present), a fake scheduler command, and a
  fake zcode adapter.

Every Part-B function that needs the hub takes it as a parameter (`hub`) so it can be faked; the zcode functions are
injected too (`adapters = { zcode: { runTask, followUp, taskStatus, getResult } }`).

### Contract: `src/hub/tasks.mjs`

```js
export class HubConflictError extends Error {}
export const STATES = ["queued","assigned","running","done","need-info","failed","accepted","rejected","cancelled"];

export class Hub {
  constructor({ remote, workdir, actor })   // defaults from env/config
  async init()                               // create bare + seed hub-kit if missing; ensure working clone
  async sync()                               // fetch + reset --hard origin/main
  async list({ sync = true } = {})           // -> Task[] sorted by id
  async get(id)                              // -> Task | null
  async workers()                            // -> Worker[] (roster + online, lastSeen, busy = # running|assigned)
  async post(spec, body)                     // -> Task (state queued)
  async transition(id, { from, to, set = {}, files = {}, remove = [], message })
                                             // atomic CAS; set: {assignee, lease, note, attempts}; files: {rel: string|Buffer}
  async assign(id, worker, reason)           // queued|assigned -> assigned
  async claim(id, worker)                    // assigned(worker) -> running
  async report(id, worker, { report, patch })// running -> done
  async ask(id, worker, question)            // running -> need-info
  async fail(id, worker, reason)             // running -> failed
  async answer(id, text)                     // need-info -> assigned
  async accept(id, { ok, log, note })        // done -> accepted|rejected
  async cancel(id) ; async requeue(id)
  async expireStale(now = Date.now())        // -> ids requeued/failed
  async heartbeat(workerId) ; async lastSeen(workerId)   // ms or null
  async readTaskFile(id, rel)                // string | null
  taskDir(id)                                // abs path in working clone
}
// Task   = { id, state, assignee, lease, attempts, note, spec, updatedAt }
// Worker = roster entry + { online, lastSeen, busy }
```
`wait.mjs`: `export async function waitForEvents(hub, { until, timeoutSec, cursor, pollMs = 2000 })`
→ `{ timedOut, lines: string[] }`.

## Out of scope for v0.2

Quota probing, multi-round review, a UI, remote daemons.
