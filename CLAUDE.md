# CLAUDE.md

MCP server (stdio, Node >= 24, ESM, no build step) — package `subagent-swarm-mcp` (legacy bin `glm-zcode-mcp`) — that lets an agent delegate subtasks across multiple CLI/app backends (`codebuddy` CLI, `qodercli`, and the official ZCode Electron desktop app over CDP). See README.md for user-facing docs.

## Commands

**Local overrides & host policy:** if `local/AGENTS.md` exists in this checkout, read and follow it
for environment-specific overrides. Hub runner prompt policies can be configured via `HUB_HOST_POLICY` /
`HUB_WORKDIR_RULE` or an untracked `local/presets.mjs` loaded by `src/local-loader.mjs`.
See `AGENTS.md` for details.

```bash
npm install
npm test                          # node:test unit tests, no ZCode needed (test/*.test.mjs)
node --test test/store.test.mjs   # single test file
node e2e/client.mjs zcode_health  # call one tool over real MCP stdio: node e2e/client.mjs <tool> '<json args>'
node e2e/scenario{1,2,3}.mjs      # real end-to-end runs against a live ZCode (spend quota)
bin/zcode-watch.mjs <taskId...>   # background Gemini progress watcher for running tasks (README)
node scripts/screenshot.mjs       # screenshot of the ZCode window, for debugging UI changes
```

The e2e scripts and anything touching `src/zcode.mjs` need ZCode running with
`--remote-debugging-port=9222` (`scripts/start-zcode.sh`) and a `subagent` project in its sidebar.

## Architecture

Two strictly separated halves:

- **Write path (UI, `src/cdp.mjs` + `src/zcode.mjs`)**: submit / follow-up / cancel click through the real ZCode UI
  via CDP. Always wrapped in `withUiLock` (`src/lock.mjs`, atomic-`mkdir` cross-process mutex) because there is one
  window and several MCP processes (Claude Code, Codex) may run at once. Capacity (`ZCODE_MCP_MAX_RUNNING`) is
  checked *inside* the lock.
- **Read path (`src/store.mjs`)**: read-only. `taskId` is ZCode's own session id; the server keeps no state.
  Status comes from `~/.zcode/cli/log/zcode-*.jsonl` (`LogTailer`: live `turn.*` / `tool.call.*` events) combined
  with `~/.zcode/cli/db/db.sqlite` (`turn_usage`, `message`, `part`). `turn_usage` is only written at turn end, so
  "running" must be derived from the log events, not the DB.
- **Backend adapters (`src/backends/`)**:
  - `src/backends/cli-common.mjs`: shared detached worker spawning, atomic state writes, PID-group cancellation, orphan reconciliation, live JSONL tool inspection, and credit summation for CLI backends.
  - `src/backends/codebuddy.mjs` & `src/backends/qoder.mjs` + `bin/codebuddy-runner.mjs`: run standalone `codebuddy` (`cb_<hex>`) or `qodercli` (`qd_<uuid>`) in a detached worker process group, supporting `lite` (zero-tool), `readonly`, and `workspace` profiles, `--session-id` / `-r` resumption, `--no-session-persistence`, and `-pgid` cancellation. Note `qodercli status -o json` is scrubbed to exclude email/username/avatar PII, and `qodercli --session-id` requires a valid RFC 4122 UUID.
  - `src/backends/zcode.mjs`: adapts `src/zcode.mjs`/`src/store.mjs` without altering ZCode behavior.
  - `src/backends/registry.mjs`: uniform router (`auto` / `codebuddy` / `qoder` / `zcode`) and `swarm_*` APIs (`bin/swarm.mjs` mirrors them on shell).
- `src/server.mjs` registers the 29 legacy tools (10 `zcode_*` + 4 `zcode_session_*` + 4 structured/batch + 10 `hub_*` + `codebuddy_usage`) and 13 unified `swarm_*` tools; `src/progress.mjs` + `bin/zcode-watch.mjs`
  add Gemini progress digests (`zcode_progress`, `zcode-watch`); `bin/zcode.mjs` and `bin/swarm.mjs` expose the shell CLIs;
  `src/codebuddy-usage.mjs` (+ `bin/codebuddy-usage.mjs`, `codebuddy_usage`) reports CodeBuddy credit left/consumed; `src/config.mjs` holds env-driven config.
- **Dispatch hub (`src/hub/`, `bin/dispatch.mjs`, `hub-kit/`; design in `docs/HUB-PLAN.md`)**: task state lives in a
  separate bare git repo (never in project repos), one commit per transition, CAS via fetch/reset/commit/push retry.
  `tasks.mjs` is the contract; `scheduler.mjs`/`runner.mjs`/`accept.mjs`/`daemon.mjs` take the hub and adapters as
  parameters so tests use `test/helpers/fake-hub.mjs`. `hub-kit/bin/hub` must stay POSIX sh + git only (remote/Mac workers).
  Worker↔supervisor messages live on `refs/progress|inbox/<taskId>` (`src/hub/channel.mjs`), never on main.

## Gotchas (each one was a real bug)

- **Never press Escape blindly.** On a running task's page Escape = "interrupt", which silently cancels another
  task. Use `closeOpenMenu` (only presses it if a `[role=menu|listbox]` is open).
- Radix menus ignore `el.click()`; use CDP `Input.dispatchMouseEvent` (`clickElement`/`clickTestId`).
- New tasks default to mode "变更前确认"; `setMode` forces "完全访问" every time via `chat-mode-select-item-yolo`
  (because 3.18.2 added a subtitle line) and completes `yolo-confirmation-dialog` (`yolo-confirmation-risk` +
  `yolo-confirmation-confirm`) when ZCode 3.18.2 prompts for per-switch confirmation. The model trigger's
  aria-label names only the model, and the menu lists the same models under several billing routes: the
  selection is *(provider, model)*, decided by `planModelSelection` (`src/model-select.mjs`) — the checked
  `chat-model-select-item-custom:<providerKey>:<model>`, switching via `composer-provider-trigger` when
  needed. Providers must be in `allowedProviders` (`ZCODE_MCP_PROVIDERS`), never a personal API-key route.
- `runTask` returns a `warning` when the session's `model.providerId` differs from the requested provider;
  the menu can lie, ZCode's own record cannot.
- Do not read `credentials.json`, replay ZCode's tokens, or call Zhipu's API directly; the project's whole point is
  to go through the real desktop app. Don't add such shortcuts.
- agy is a full agent: the scheduler prompt must forbid tools, or it sometimes runs a command, gets auto-denied in
  headless mode and returns an empty response. The snapshot must contain every field the policy mentions.
- Workers answer "## Open questions: None." — only real questions may turn a run into need-info; reviews never ask.
- The daemon heartbeats local workers *before* `expireStale`, else a restart requeues tasks whose ZCode sessions run on.
- Never print, log or cache the CodeBuddy access token (`codebuddy-usage`); it lives only in env or a 0600 file.
- `zcode_wait` max is 55 s (clients commonly time out tool calls at 60 s).
- Selectors rely on ZCode's `data-testid`s (`v4-composer-input`, `v4-composer-send`, `v4-stop`,
  `virtual-project-*`, `chat-mode-select-trigger`, `chat-mode-select-item-yolo`, `yolo-confirmation-*`,
  `chat-model-select-*`, `task-item-<sid>`); a ZCode update can
  break them, so re-run `zcode_health` and the e2e scenarios after upgrading.
- `src/silence.mjs` must stay the first import in `server.mjs` (suppresses the `node:sqlite` experimental warning,
  which would otherwise go to stderr).
- **Linux cgroup escape & orphaned turns**: Electron/Chromium calls `systemd1.Manager.StartTransientUnit("app-zcode-<pid>.scope")`
  over D-Bus on launch, moving `ZCode` and all `zcode-cli` children out of a `MemoryMax`-capped unit/scope unless
  `DBUS_SESSION_BUS_ADDRESS=unix:path=/dev/null` is set for `/usr/bin/zcode`; `scripts/zcode.slice` + `scripts/app-zcode-.scope-memory.conf`
  provide a belt-and-suspenders systemd cap (`MemoryHigh=5G`, `MemoryMax=6G`, `MemorySwapMax=0`). `src/store.mjs` uses
  `zcode_protocol.startup.started`, OS boot time (`SYSTEM_BOOT_AT`), and `ZCODE_MCP_STARTING_TIMEOUT_SEC` (default `300`)
  to fail-close orphaned `running`/`starting` sessions after an OOM kill or reboot instead of blocking capacity for 6 h.

## Conventions

Plain ESM JavaScript, no TypeScript or build tooling, minimal dependencies (`@modelcontextprotocol/sdk`, `zod`).
Tool results are JSON text; failures return `isError` via the `guard` wrapper.
