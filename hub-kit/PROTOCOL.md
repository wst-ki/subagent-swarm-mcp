# Dispatch hub — worker protocol

This repository is the dispatch hub: a queue of tasks plus their results, coordinated entirely
through git (single branch `main`, one commit per state change). As a worker agent you claim a
task, do the work locally, and push the result back. You only need this file and `bin/hub`;
`SCHEDULER.md` is for the scheduler, `workers.json` is the roster curated by the user.

## Setup (once per machine)

```sh
git clone <hub-remote> ~/hub        # or, on an existing clone: git -C ~/hub pull
```

Your worker id and capabilities are listed in `workers.json`. Optional environment:
`HUB_DIR` (hub clone location; default: the directory containing `bin/hub`), `HUB_WORK`
(scratch dir for task checkouts, default `~/hub-work`), `HUB_SSH_HOST` (host that serves
non-local task repos; defaults to the SSH host of the hub's `origin` remote).

## Execution host policy

If your operator configures an execution-host policy (for example via `HUB_HOST_POLICY` or
local project instructions), follow it strictly: keep heavy builds, compilation, packaging,
Docker image builds, and full dependency installs on the designated build host rather than
the coordination host. If a required remote build workflow is unavailable, report the
blocker instead of falling back locally or claiming a build check passed.

## Work loop

Repeat until `next` prints `NONE` (or your operator tells you to stop):

1. `sh bin/hub next <worker-id> [--wait SEC]`
   Heartbeats, then claims the oldest task assigned to you. Prints either `NONE` (nothing to
   do; with `--wait N` it keeps re-checking every 15 s for N seconds) or
   `TASK <id> <workdir> <task.md>`.
2. Read `<task.md>`. If `<task-dir>/answer.md` exists, that is the master's answer to an earlier
   question of yours — read it too.
3. Do the work **inside `<workdir>` only**. For code tasks `<workdir>` is a checkout of the
   task's repo at the base commit. Never commit or push the work repo; leave your changes on
   disk (uncommitted).
   Use the prepared checkout instead of cloning another copy. Run checks for the affected
   workspace first; install dependencies only when required. Reuse the configured global
   package cache/store instead of creating a task-specific store under `/tmp`.
4. When finished, write `<workdir>/REPORT.md` with exactly these headings:

   ```
   ## Result
   ## Changes
   ## Checks run
   ## Open questions
   ```

   If you cannot proceed without the master, fill in only `## Open questions` (one short,
   concrete question), then run `ask` (below) instead of `done` and stop working.
5. `sh bin/hub done <worker-id> <id>` — packages `REPORT.md` and the diff of the work repo
   into `result/`, sets the task to `done`, and stops the heartbeat loop.
6. Alternatives:
   - `sh bin/hub ask <worker-id> <id> <question>` — task becomes `need-info`; the master's
     answer will appear as `answer.md` and the task comes back to you (`assigned`).
   - `sh bin/hub fail <worker-id> <id> <reason>` — you cannot do the task at all.
   - `sh bin/hub hb <worker-id>` — one manual heartbeat.

While a task is claimed, `bin/hub` heartbeats for you in the background (every 30 s). A claim
is leased: if you go silent past the task's `timeoutMin`, the daemon expires the lease and the
task goes back to `queued` (or to `failed` after 3 attempts).

## Progress and inbox (say / INBOX)

While you work on a task, two message streams run alongside the state machine (they live on git
refs, never touch `main`, and do not change the task's state):

- **Run `sh bin/hub say <worker-id> <id> <one short line>` after every meaningful step, and at
  least every 5 minutes while working.** It appends your progress line (for the supervisor and
  the master), sends a heartbeat, and then prints any unread inbox messages.
- Lines like `INBOX <YYYY-mm-dd HH:MM> <from>: <text>` are messages from the supervisor or the
  master. Read them and follow them.
- `sh bin/hub inbox <worker-id> <id>` sends a heartbeat and prints unread inbox messages without
  adding a progress line. `sh bin/hub next` also prints unread INBOX lines right after the `TASK`
  line when it claims a task.
- For a blocking question — you cannot continue without the master — use
  `sh bin/hub ask <worker-id> <id> <question>`, then
  `sh bin/hub next <worker-id> --wait 900` to receive the task back with `answer.md`.

## Task layout

Each task lives in `tasks/<id>/`: `spec.json` (kind `code|text|review`, `repo`, `base`, `tier`,
`accept` command, `timeoutMin`, `avoidVendors`, `preferWorkers`, …), `task.md` (instructions),
bookkeeping files (`state`, `assignee`, `lease`, `attempts`, `note`), optionally `answer.md`,
and once finished `result/report.md` + `result/patch.diff`.

States: `queued → assigned → running → done → accepted|rejected`, with `need-info` (waiting for
the master), `failed` and `cancelled` as the side exits; `requeue` can revive a
failed/rejected/cancelled task.

## Rules

- Work only inside the given `<workdir>`. Do not commit or push the work repo.
- Do not edit the hub except through `bin/hub` (every state change must be one clean commit).
- Finish every task with `REPORT.md`, even a failed one — then use `fail` instead of `done`.
- Keep questions rare and self-contained; the master pays per wake-up.
