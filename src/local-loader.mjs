import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DISABLED_VALUES = new Set(["none", "0", "false"]);

/**
 * Load an optional untracked local extension module (`local/presets.mjs` by default).
 * Set `ZCODE_MCP_LOCAL_MODULE=none` to disable loading, or a file path to load a custom module.
 */
export async function loadLocalExtension({ env = process.env } = {}) {
  const override = env.ZCODE_MCP_LOCAL_MODULE?.trim();
  if (override) {
    if (DISABLED_VALUES.has(override.toLowerCase())) return {};
    const abs = resolve(override);
    if (!existsSync(abs)) {
      throw new Error(`ZCODE_MCP_LOCAL_MODULE not found: ${abs}`);
    }
    return await import(pathToFileURL(abs).href);
  }
  const defaultUrl = new URL("../local/presets.mjs", import.meta.url);
  if (!existsSync(defaultUrl)) return {};
  return await import(defaultUrl.href);
}

export const localExtension = await loadLocalExtension();
