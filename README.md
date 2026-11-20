# subagent-swarm-mcp

**简体中文** | [English](README.en.md)

> [!IMPORTANT]
> **学习研究与合理使用声明：** 本项目为非官方开源社区项目，**仅用于个人学习 MCP（Model Context Protocol）协议编排、多 CLI 工具集成与本地交互式开发工作流研究**。本项目不修改任何官方客户端代码，也不包含任何绕过鉴权、限流或计费的机制。使用前请务必遵守 **智谱 AI（Zhipu AI / Z.ai / ZCode）**、**腾讯（CodeBuddy）** 及 **Qoder** 各自的《用户协议》《服务条款》与合理使用政策，**严禁用于商业转售、账号共享或高频自动化刷量，请克制调用频率与并发，切勿给智谱及其他平台服务端造成过大负担**；大规模批量任务请使用平台官方正式按量 API / Batch API 或本地部署模型。详情请务必阅读文末[《安全、合规与免责声明》](#安全合规与免责声明)。

一个运行在 Linux（Node.js >= 24）上的多 CLI 子代理调度 MCP Server 与命令行工具集（前身为 `glm-zcode-mcp`），用于探索和学习如何让 Claude Code、Codex、Antigravity 等 Agent 在本机交互式开发场景下，按任务复杂度与权限需求将轻量辅助任务低开销地分发到多个已合法登录的编程工具（目前已内置 **CodeBuddy CLI**、**Qoder CLI** 与**官方 ZCode 桌面端**，架构通过可插拔注册表预留扩展接口）。

## 架构与后端支持

```text
                       ┌──> CodeBuddy CLI (`cb_*`, 独立脱附 worker) ─> codebuddy -p --output-format json
agent ──MCP/stdio──> subagent-swarm-mcp (`swarm_*` / `zcode_*` / `bin/swarm.mjs`)
                       ├──> Qoder CLI (`qd_*`, 独立脱附 worker) ─────> qodercli -p -o json
                       └──> ZCode (`sess_*`, CDP 127.0.0.1:9222) ──> 官方 ZCode 桌面窗口 + 只读 SQLite/JSONL
```

* **CodeBuddy & Qoder CLI 后端（`codebuddy`、`qoder`）：** 通过独立进程组 worker（`cb_<hex>` / `qd_<uuid>`）与 stdin 管道安全调用对应官方 CLI，原生提供 3 级权限/工具隔离模式（`lite` 零工具 + 精简 `--system-prompt`，实测单次基线输入 Token 下降约 57%；`readonly` 只读检视且 CodeBuddy 内含 `ViewImage` 多模态看图与 `--add-dir` 扩展目录；`workspace` 全量工作区权限）、支持 `effort`（`minimal`～`max` 控思考 Token）、`maxTurns`（防死循环保底）、空响应零 Token 自动 fail-close（`empty_response`）、`waitSec` 单次内联拿结果、`-r` 多轮续聊、`-pgid` 整棵进程树终止、孤儿进程回收与实时 JSONL 工具观测。
* **ZCode 桌面端后端（`zcode`）：** 仅通过 Electron 本地回环 DevTools 端口（`127.0.0.1:9222`）与跨进程 `mkdir` 文件锁配合官方 ZCode 桌面窗口操作（不修改官方客户端文件，不提取或重放账号凭据，也不直接调用外部 ZCode CLI），严格校验计费路由白名单（`ZCODE_MCP_PROVIDERS`），只读读取本地 SQLite 与 JSONL 日志。原有 29 个 `zcode_*`、`hub_*` 与 `codebuddy_usage` 工具保持兼容。
* **智能 `auto` 路由：** 按调用约束（`lite` / `readonly` / `ephemeral` / `effort` / `maxTurns` / `addDirs` / 自定义 `cwd` / 专属模型 / 专属计费路由）、后端健康度与空闲并发槽位自动分流；当本地缓存检测到 CodeBuddy 存在临期额度包且仍有空闲槽位时，自动优先消费临期额度（`CODEBUDDY_PREFER_WHEN_EXPIRING=0` 可关闭）。

## 快速上手

1. **前置条件：** Linux（`x86_64`/`arm64`）、Node.js >= 24，并至少就绪其中一个您本人合法登录的后端：
   * **CodeBuddy CLI：** 已安装并登录 `codebuddy`（可执行 `codebuddy --version`）。
   * **Qoder CLI：** 已安装并登录 `qodercli`（可执行 `qodercli status`）。
   * **ZCode 桌面端：** 官方 ZCode（已实测 `3.16.1` / `3.18.2`）以 `scripts/start-zcode.sh`（或 `scripts/zcode-headless.sh`）启动，已登录个人 Coding Plan，且左侧栏有指向 `~/projects/subagents` 的 `subagent` 项目。
2. **安装并注册到 MCP 客户端：**

   ```bash
   git clone https://github.com/wst-ki/subagent-swarm-mcp.git && cd subagent-swarm-mcp && npm install

   # Claude Code
   claude mcp add subagent-swarm-mcp -s user -- node "$PWD/src/server.mjs"

   # Antigravity (agy)
   agy mcp add subagent-swarm-mcp node "$PWD/src/server.mjs"

   # Codex CLI
   codex mcp add subagent-swarm-mcp -- node "$PWD/src/server.mjs"
   ```

   或在 **Codex**（`~/.codex/config.toml`）中手动加入：

   ```toml
   [mcp_servers.subagent-swarm-mcp]
   command = "node"
   args = ["/absolute/path/to/src/server.mjs"]
   tool_timeout_sec = 120
   ```

## 核心能力一览

* **统一子代理池（`swarm_backends`、`swarm_run`、`swarm_wait`、`swarm_status`、`swarm_result`、`swarm_followup`、`swarm_cancel`、`swarm_list`、`swarm_quota`）：** 跨 `auto`、`codebuddy`、`qoder`、`zcode` 统一调度；对高响应 CLI 模型（如 `hy4flash-free`、`deepseek-v4.1-flash`、`DeepSeek-Flash`）可传入 `waitSec: 30..55` 单次直接拿到结果；无 MCP 环境可使用 `bin/swarm.mjs`。
* **高稳健结构化输出与小批量任务编排（`swarm_run_structured`、`swarm_structured_result`、`swarm_batch_run`、`swarm_batch_status`）：** 支持受限 JSON Schema 与 `domainRule` 校验、单轮纯 JSON 协议（绕开 CodeBuddy `--json-schema` 与 `--tools ""` 碰撞）、JSONL 断点续跑、微批打包、部分失败单独重试、累计 `usage.credit` 预算熔断（`--max-credit` / `maxCredit`）、多任务动态槽位礼让（`--reserve-slots` / `reserveSlots`）、跨进程槽位忙等待退避（`capacityWaitMs`）、机器可读阻塞分类（`blocked.json` 含 `retryable` 与 `recommendedAction`）、实时进度心跳（`progress.json`）、单项超时自动取消防槽位泄漏、额度熔断恢复零漏篇续跑、断点部分结果抢救导出（`swarm batch-export` / `zcode batch-export`）、原子文件落盘（`--summary` / `--export`）、精简输出（`--compact` / `includeItems: false`）与防 `>64 KiB` 管道截断刷新。
* **深度消费与成本观测（`codebuddy_usage`、`bin/codebuddy-usage.mjs`、`swarm_quota`）：** 合并统计 CodeBuddy 本地 CLI 会话记录（`~/.codebuddy/projects/`）与 swarm 脱附任务状态（`<stateDir>/cb-runs/`，完整覆盖 `--no-session-persistence` / `ephemeral` 临时任务且自动去重持久化会话），输出临期额度包告警（`expiringSoon`）、Token 与缓存命中率/思考 Token 明细、按模型/权限档位（`lite` / `readonly` / `workspace`）单次成本核算、日消耗趋势及余量续航预测（`runway`）；同步保留旧版 ZCode 与 Dispatch Hub 能力（`zcode_*`、`zcode_session_*`、`hub_*`、`bin/zcode.mjs`、`bin/zcode-watch.mjs`、`bin/dispatch.mjs`、`hub-kit/`）。

全部 42 个工具参数、CLI 参数、环境变量与技术限制详见 [docs/REFERENCE.md](docs/REFERENCE.md)、[docs/HUB-PLAN.md](docs/HUB-PLAN.md) 与 [docs/SUPERVISOR.md](docs/SUPERVISOR.md)。

## 常用配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `CODEBUDDY_BIN` | 自动探测 | 显式指定 `codebuddy` 可执行文件路径 |
| `CODEBUDDY_DEFAULT_MODEL` | `hy4flash-free` | CodeBuddy 默认模型 |
| `CODEBUDDY_MAX_RUNNING` | `4` | CodeBuddy 并行任务上限 |
| `CODEBUDDY_DEFAULT_CWD` | `ZCODE_MCP_PROJECT_DIR` | CLI 子代理默认工作目录 |
| `QODER_BIN` | 自动探测 | 显式指定 `qodercli` 可执行文件路径 |
| `QODER_DEFAULT_MODEL` | `DeepSeek-Flash` | Qoder 默认模型 |
| `QODER_MAX_RUNNING` | `4` | Qoder 并行任务上限 |
| `ZCODE_MCP_CDP_PORT` | `9222` | ZCode 本地 DevTools 调试端口（`127.0.0.1`） |
| `ZCODE_MCP_PROVIDERS` | `account%3Abigmodel-individual-coding-plan,account%3Abigmodel-start-plan` | ZCode 计费路由白名单 |
| `ZCODE_MCP_MAX_RUNNING` | `3` | ZCode 并行任务上限 |

全部环境变量（`ZCODE_MCP_*`、`CODEBUDDY_*`、`QODER_*`、`HUB_*`、`ZCODE_MCP_LOCAL_MODULE`）详见 [docs/REFERENCE.md](docs/REFERENCE.md#5-environment-variables)。

## 开发与测试

```bash
npm test                                    # 运行离线单元测试（无需实机 CLI 或 ZCode）
ZCODE_MCP_LOCAL_MODULE=none npm test        # 验证无私有扩展模块时的纯净模式
node e2e/client.mjs swarm_backends          # 通过真实 MCP stdio 自检各后端连通性
```

## 安全、合规与免责声明

> [!WARNING]
> **本地执行权限边界：** 在 `workspace` 模式以及所有 ZCode 任务（会自动切换为 **完全访问 / YOLO**）下，子代理拥有当前操作系统用户的完整本地权限。纯文本推理、抽取与分类任务强烈建议优先使用 CodeBuddy / Qoder 的 `profile: "lite"`（零工具）或 `"readonly"`；**严禁**将本地调试端口（`127.0.0.1:9222`）暴露至公网或不可信局域网，也不要向具有工作区写权限的子代理传入未经审查的外部不可信输入。

1. **仅限个人学习与技术研究：** 本项目为开源技术学习与实验性参考实现，旨在演示 MCP Server 开发、多 CLI 抽象适配、结构化输出校验与本地任务编排架构，**不以任何商业盈利为目的，亦不鼓励或支持任何形式的违规自动化滥用**。
2. **严格遵循各平台服务协议与合理使用原则：**
   * 使用本项目对接 **智谱 AI（Zhipu AI / Z.ai / ZCode / GLM Coding Plan）**、**腾讯（CodeBuddy）**、**Qoder** 等第三方服务时，使用者必须自行阅读并严格遵守各平台现行的《用户协议》《服务条款》《使用须知》及配额/速率限制规定（此类个人订阅套餐通常仅限自然人个人交互式软件开发辅助，明确禁止多人共享账号、API 转售/聚合代理、非交互式大规模爬取或恶意刷量）。
   * **请文明、克制使用，切勿给智谱及其他平台服务器造成过大负担：** 请将并发数与任务规模控制在个人日常交互开发合理范围内，避免长时间 7×24 高频满载打满配额窗口；如确有大规模、长时间或生产级批量数据处理需求，请务必使用各平台官方正式提供的按量计费开放 API / Batch API 或本地自部署开源模型。
3. **技术合规边界（零破解、零篡改、零窃密）：** 本项目不修改、不反编译、不注入任何官方客户端程序或二进制文件，不提供任何绕过登录认证、限流保护、计费体系或提取/重放第三方鉴权凭据的功能，也不向作者或任何第三方收集、上传用户数据与账号密钥。
4. **无关联声明与商标归属：** 本项目为独立非官方社区项目，与智谱 AI（Zhipu AI / Z.ai）、腾讯（Tencent）、Qoder 或其他任何提及的软件与平台均无任何关联、合作、授权、背书或赞助关系；文中涉及的产品名称与商标均归其各自合法权利人所有。
5. **风险自担与责任豁免：** 本软件依据 [MIT License](LICENSE) 按“现状（AS-IS）”提供，不附带任何明示或默示担保。因下载、部署、修改、配置或不当使用本项目所导致的任何直接或间接后果（包括但不限于平台限流、风控拦截、套餐权益暂停、账号封禁、额外计费损失、本地文件改动或数据损毁等），**均由使用者本人自行承担全部法律与经济责任**，项目作者及贡献者在法律允许的最大范围内不承担任何责任。
6. **权利人沟通与配合：** 如智谱 AI 或其他相关平台权利人认为本项目的任何部分存在合规、条款冲突或其他疑虑，请随时通过仓库 Issue 联系，作者将在收到通知后第一时间积极配合核查、调整或下架相关内容。

第三方开源代码归属声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
