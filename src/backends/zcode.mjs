// ZCode desktop UI backend adapter for subagent-swarm-mcp.
// Wraps existing CDP/SQLite ZCode helpers in the uniform backend interface without altering
// any zcode_* behavior or adding new dependencies.
import { resolve } from "node:path";
import { sleep } from "../cdp.mjs";
import { config } from "../config.mjs";
import { taskStatus } from "../store.mjs";
import { zcodeQuota } from "../zcode-quota.mjs";
import {
  cancelTask,
  followUp as zcodeFollowUp,
  getResult,
  health as zcodeHealth,
  listTasks,
  runTask,
} from "../zcode.mjs";

export const id = "zcode";
export const profiles = ["workspace"];

export function supports(taskId) {
  return typeof taskId === "string" && /^sess(ion)?_[\w-]+$/.test(taskId);
}

export function maxRunning() {
  return config.maxRunning;
}

export function defaultModel() {
  return config.defaultModel;
}

export function models() {
  return config.allowedModels;
}

export async function run({ prompt, model, profile, cwd, provider, shouldAbort } = {}) {
  if (profile && profile !== "workspace") {
    throw new Error(
      `ZCode backend always runs with full workspace access and cannot enforce profile "${profile}". Use backend "codebuddy" for lite/readonly isolation.`,
    );
  }
  if (cwd && resolve(cwd) !== resolve(config.projectDir)) {
    throw new Error(
      `ZCode backend is bound to configured projectDir "${config.projectDir}" and cannot switch cwd to "${cwd}".`,
    );
  }
  const res = await runTask({ prompt, model, provider, shouldAbort });
  return { ...res, backend: "zcode", profile: "workspace" };
}

export function status(taskId) {
  return { ...taskStatus(taskId), backend: "zcode" };
}

export function result(taskId) {
  return { ...getResult(taskId), backend: "zcode" };
}

export async function wait(taskId, { timeoutSec = 45, onProgress = null, pollIntervalMs = 1000 } = {}) {
  const end = Date.now() + timeoutSec * 1000;
  let tick = 0;
  for (;;) {
    const st = taskStatus(taskId);
    if (st.status !== "running" && st.status !== "starting") {
      return { ...getResult(taskId), backend: "zcode" };
    }
    if (Date.now() >= end) {
      return { ...st, backend: "zcode" };
    }
    if (onProgress && ++tick % Math.max(1, Math.round(5000 / pollIntervalMs)) === 0) {
      await onProgress({
        tick,
        elapsedSec: st.elapsedSec,
        currentTool: st.currentTool ?? null,
      });
    }
    await sleep(pollIntervalMs);
  }
}

export async function followUp({ taskId, prompt } = {}) {
  const res = await zcodeFollowUp({ taskId, prompt });
  return { ...res, backend: "zcode" };
}

export async function cancel(taskId) {
  const res = await cancelTask(taskId);
  return { ...res, backend: "zcode" };
}

export function list({ limit = 15 } = {}) {
  return listTasks(limit).map((t) => ({ ...t, backend: "zcode" }));
}

export async function health() {
  const h = await zcodeHealth();
  return {
    ...h,
    backend: "zcode",
    available: Boolean(h.cdp),
    defaultModel: config.defaultModel,
    profiles,
  };
}

export async function quota() {
  return zcodeQuota();
}
