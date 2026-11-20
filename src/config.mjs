import { homedir } from "node:os";
import { join } from "node:path";

const env = process.env;
const home = homedir();

// Billing routes ("providers") a task may run on. Model item testids in ZCode's menu carry the
// URL-encoded form; these are the two desktop-account routes, never a personal API-key provider.
const DEFAULT_PROVIDERS = "account%3Abigmodel-individual-coding-plan,account%3Abigmodel-start-plan";

export function parseProviders(value) {
  return (value ?? DEFAULT_PROVIDERS)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  cdpPort: Number(env.ZCODE_MCP_CDP_PORT ?? 9222),
  // Sidebar label of the ZCode project all subagent tasks are created in.
  projectName: env.ZCODE_MCP_PROJECT ?? "subagent",
  // Directory of that project; used to list tasks and to sanity-check new sessions.
  projectDir: env.ZCODE_MCP_PROJECT_DIR ?? join(home, "projects", "subagents"),
  // Only these models may be requested. Update when Zhipu ships new ones.
  allowedModels: (env.ZCODE_MCP_MODELS ?? "GLM-5.3,GLM-5.3-Flash").split(",").map((s) => s.trim()),
  defaultModel: env.ZCODE_MCP_DEFAULT_MODEL ?? "GLM-5.3",
  // Billing route that must be selected in ZCode's model menu (the desktop account route).
  providerKey: env.ZCODE_MCP_PROVIDER ?? "account%3Abigmodel-individual-coding-plan",
  // Billing routes a task may be run on (ZCODE_MCP_PROVIDERS); other providers are rejected.
  allowedProviders: parseProviders(env.ZCODE_MCP_PROVIDERS),
  maxRunning: Number(env.ZCODE_MCP_MAX_RUNNING ?? 3),
  maxPromptChars: 100_000,
  zcodeHome: env.ZCODE_MCP_HOME ?? join(home, ".zcode"),
  stateDir: env.ZCODE_MCP_STATE_DIR ?? join(home, ".local", "state", "glm-zcode-mcp"),
  stalledAfterSec: Number(env.ZCODE_MCP_STALLED_SEC ?? 600),
  startingTimeoutSec: Number(env.ZCODE_MCP_STARTING_TIMEOUT_SEC ?? 300),
  // Minimum seconds between real Gemini summary calls per task; see src/progress.mjs.
  summaryMinSec: Number(env.ZCODE_MCP_SUMMARY_MIN_SEC ?? 300),
};

export const paths = {
  cliDb: join(config.zcodeHome, "cli", "db", "db.sqlite"),
  cliLogDir: join(config.zcodeHome, "cli", "log"),
  uiLock: join(config.stateDir, "ui.lock"),
};
