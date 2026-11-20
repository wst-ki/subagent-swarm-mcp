# subagent-swarm-mcp

[简体中文](README.md) | **English**

> [!IMPORTANT]
> **Educational Use, Fair Use & Compliance Notice:** This is an unofficial open-source community project created **strictly for personal learning, technical research into MCP (Model Context Protocol) orchestration, and interactive local development workflow experimentation**. It does not modify any official client binaries or bypass authentication, rate limits, or billing. Before running it, you must review and comply with the Terms of Service and Acceptable Use Policies of **Zhipu AI (Z.ai / ZCode)**, **Tencent (CodeBuddy)**, and **Qoder**. **Do not use it for commercial reselling, account sharing, or high-volume automated abuse; keep concurrency and request volume modest so as not to place undue load on Zhipu AI or other providers' infrastructure.** For large-scale or production batch processing, use official pay-as-you-go APIs / Batch APIs or self-hosted local models. Please read the full [Security, Compliance & Disclaimer](#security-compliance--disclaimer) section below.

A multi-CLI MCP server and toolkit (Linux, Node.js >= 24; previously `glm-zcode-mcp`) for learning and exploring how coding agents such as Claude Code, Codex, and Antigravity can delegate lightweight helper tasks, multimodal image inspection, and small structured jobs across your legitimately signed-in coding tools (**CodeBuddy CLI**, **Qoder CLI**, and the **official ZCode desktop app**, with an extensible backend registry for additional CLIs).

## Backends & How It Works

```text
                       ┌──> CodeBuddy CLI (`cb_*`, detached runner) ─> codebuddy -p --output-format json
agent ──MCP/stdio──> subagent-swarm-mcp (`swarm_*` / `zcode_*` / `bin/swarm.mjs`)
                       ├──> Qoder CLI (`qd_*`, detached runner) ──────> qodercli -p -o json
                       └──> ZCode (`sess_*`, CDP 127.0.0.1:9222) ─────> ZCode Electron window + read-only SQLite/JSONL
```

* **CodeBuddy & Qoder CLI backends (`codebuddy`, `qoder`):** Launch standalone official `codebuddy` (`cb_<hex>`) or `qodercli` (`qd_<uuid>`) binaries in detached worker process groups via stdin, with three permission profiles (`lite` = zero tools / minimal token overhead, `readonly` = `Read[,ViewImage],Glob,Grep,WebSearch,WebFetch`, `workspace` = full workspace access in `cwd`), inline wait (`waitSec`), `-r` session follow-up, `-pgid` process-tree cancellation, orphan fail-close, and live JSONL tool inspection.
* **ZCode desktop backend (`zcode`):** Interacts solely with your local official ZCode desktop window over loopback Chromium DevTools (`127.0.0.1:9222`) using an atomic `mkdir` cross-process UI lock (never modifying official binaries, extracting/replaying credentials, or invoking an external ZCode CLI), enforces a strict billing-route allow-list (`ZCODE_MCP_PROVIDERS`), and performs read-only SQLite/JSONL status monitoring. All 29 legacy `zcode_*`, `hub_*`, and `codebuddy_usage` tools remain compatible.
* **Smart `auto` routing:** Picks healthy backends with spare capacity (`codebuddy` and `qoder` for `lite`, `readonly`, `ephemeral`, custom `cwd`, or fast CLI models; `zcode` when `provider` or ZCode models are requested or CLI capacity is full).

## Quick Start

1. **Prerequisites:** Linux (`x86_64`/`arm64`), Node.js >= 24, plus at least one legitimately signed-in backend under your own account:
   * **CodeBuddy CLI:** `codebuddy` installed and signed in (`codebuddy --version`).
   * **Qoder CLI:** `qodercli` installed and signed in (`qodercli status`).
   * **ZCode desktop:** Official ZCode (`3.16.1` / `3.18.2` tested) launched with `scripts/start-zcode.sh` (or `scripts/zcode-headless.sh`), signed in to your personal Coding Plan, with a sidebar project named `subagent` pointing to `~/projects/subagents`.
2. **Install & register MCP:**

   ```bash
   git clone https://github.com/wst-ki/subagent-swarm-mcp.git && cd subagent-swarm-mcp && npm install

   # Claude Code
   claude mcp add subagent-swarm-mcp -s user -- node "$PWD/src/server.mjs"

   # Antigravity (agy)
   agy mcp add subagent-swarm-mcp node "$PWD/src/server.mjs"

   # Codex CLI
   codex mcp add subagent-swarm-mcp -- node "$PWD/src/server.mjs"
   ```

   Or add manually to **Codex** (`~/.codex/config.toml`):

   ```toml
   [mcp_servers.subagent-swarm-mcp]
   command = "node"
   args = ["/absolute/path/to/src/server.mjs"]
   tool_timeout_sec = 120
   ```

## Features & Toolset

* **Unified Swarm Pool (`swarm_backends`, `swarm_run`, `swarm_wait`, `swarm_status`, `swarm_result`, `swarm_followup`, `swarm_cancel`, `swarm_list`, `swarm_quota`):** Route tasks across `auto`, `codebuddy`, `qoder`, or `zcode`; use `waitSec: 30..55` on `swarm_run` for single-call inline completion on fast CLI models (`hy4flash-free`, `deepseek-v4.1-flash`, `DeepSeek-Flash`); mirrored on shell via `bin/swarm.mjs`.
* **Resilient Structured Output & Small-Batch Runner (`swarm_run_structured`, `swarm_structured_result`, `swarm_batch_run`, `swarm_batch_status`):** Bounded JSON Schema + `domainRule` validation, single-turn extraction (avoids CodeBuddy `--json-schema` multi-turn tool-loop bugs in zero-tool mode), JSONL checkpoints, microbatching, partial recovery, cumulative `usage.credit` tracking, busy-slot backoff (`capacityWaitMs`), automatic timeout cancellation + retry, lossless quota-cooldown resume, atomic `--export`/`--summary` writes, `--compact` / `includeItems: false`, and full pipe flushing (prevents `>64 KiB` stdout truncation).
* **Legacy ZCode & Dispatch Hub Tools (`zcode_*`, `zcode_session_*`, `hub_*`, `codebuddy_usage`):** Preserved for existing workflows, ZCode UI automation (`bin/zcode.mjs`, `bin/zcode-watch.mjs`), and Git-backed task dispatching (`bin/dispatch.mjs`, `hub-kit/`).

Full tool tables, CLI flags, environment variables, and technical limits live in [docs/REFERENCE.md](docs/REFERENCE.md), [docs/HUB-PLAN.md](docs/HUB-PLAN.md), and [docs/SUPERVISOR.md](docs/SUPERVISOR.md).

## Essential Configuration

| Variable | Default | Purpose |
|---|---|---|
| `CODEBUDDY_BIN` | auto-discovered | Explicit path to `codebuddy` binary |
| `CODEBUDDY_DEFAULT_MODEL` | `hy4flash-free` | Default CodeBuddy model |
| `CODEBUDDY_MAX_RUNNING` | `4` | Concurrent CodeBuddy worker cap |
| `CODEBUDDY_DEFAULT_CWD` | `ZCODE_MCP_PROJECT_DIR` | Default working directory for CLI runs |
| `QODER_BIN` | auto-discovered | Explicit path to `qodercli` binary |
| `QODER_DEFAULT_MODEL` | `DeepSeek-Flash` | Default Qoder model |
| `QODER_MAX_RUNNING` | `4` | Concurrent Qoder worker cap |
| `ZCODE_MCP_CDP_PORT` | `9222` | Loopback ZCode DevTools port (`127.0.0.1`) |
| `ZCODE_MCP_PROVIDERS` | `account%3Abigmodel-individual-coding-plan,account%3Abigmodel-start-plan` | Allowed ZCode billing routes |
| `ZCODE_MCP_MAX_RUNNING` | `3` | Concurrent ZCode task cap |

See [docs/REFERENCE.md](docs/REFERENCE.md#5-environment-variables) for all variables (`ZCODE_MCP_*`, `CODEBUDDY_*`, `QODER_*`, `HUB_*`, `ZCODE_MCP_LOCAL_MODULE`).

## Development

```bash
npm test                                    # offline unit tests (no live CLI/ZCode required)
ZCODE_MCP_LOCAL_MODULE=none npm test        # verify clean mode without local/presets.mjs
node e2e/client.mjs swarm_backends          # live MCP stdio backend inspection
```

## Security, Compliance & Disclaimer

> [!WARNING]
> **Execution Trust Boundary:** In `workspace` profile and all ZCode runs (which switch ZCode to **Full Access** / YOLO), subagents execute with your OS user's full local permissions. Prefer `profile: "lite"` (zero tools) or `profile: "readonly"` for pure-text extraction and inspection tasks on CodeBuddy or Qoder. **Never** expose local CDP (`127.0.0.1:9222`) to any non-loopback network or pass untrusted external prompts into workspace-enabled subagents.

1. **Educational & Research Purpose Only:** This repository is an experimental, non-commercial open-source reference project intended solely for learning MCP server engineering, multi-CLI backend abstractions, structured output validation, and local workflow orchestration. It is not intended for commercial use or abusive automation.
2. **Respect Platform Terms of Service & Fair Use:**
   * When connecting to **Zhipu AI (Z.ai / ZCode / GLM Coding Plan)**, **Tencent (CodeBuddy)**, **Qoder**, or any other third-party service, you are solely responsible for reading and complying with each provider's current User Agreement, Terms of Service, Acceptable Use Policy, and quota/rate-limit rules (individual coding subscriptions typically restrict usage to personal, interactive software development and prohibit account sharing, API reselling/proxying, scraping, or non-interactive bulk abuse).
   * **Be considerate and avoid excessive server load:** Keep concurrency and request rates modest and proportional to normal interactive personal use—do not run continuous 24/7 max-quota workloads that place undue burden on Zhipu AI or other providers' services. For large-scale, unattended, or production batch workloads, use official pay-as-you-go APIs / Batch APIs or locally hosted open-weight models instead.
3. **Technical Integrity (No Cracking, No Binary Patching, No Credential Harvesting):** This project does not modify, decompile, or patch any official client binary; it does not circumvent authentication, rate limits, or billing, nor does it harvest, replay, or transmit user credentials or private data to any third party.
4. **No Affiliation & Trademarks:** This is an independent, unofficial community project and is not affiliated with, endorsed by, authorized by, or sponsored by Zhipu AI (Z.ai), Tencent, Qoder, or any other vendor. All product names and trademarks belong to their respective owners.
5. **Use at Your Own Risk ("AS-IS"):** Provided "as is" under the [MIT License](LICENSE) without warranty of any kind. You assume full responsibility and liability for any consequence arising from using or misconfiguring this software—including but not limited to rate limiting, risk-control flags, subscription suspension, account termination, billing charges, or unintended local file modifications. To the fullest extent permitted by law, the author and contributors disclaim all liability.
6. **Rights-Holder Cooperation:** If Zhipu AI or any other platform rights holder has any compliance or policy concern regarding any part of this repository, please open an Issue and the maintainer will promptly cooperate to review, adjust, or remove the relevant content.

Third-party attributions are documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
