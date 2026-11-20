#!/usr/bin/env node
// Detached worker wrapper shared by CLI backends (CodeBuddy, Qoder, and future CLIs).
// Runs in its own session (spawned detached by the backend adapter), pipes the prompt
// into the target CLI via stdin, keeps the CLI in its own process group so cancel() can
// terminate the entire tree safely, and persists structured turn results atomically.
import "../src/silence.mjs";
import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import {
  classifyCliError,
  inspectCliSessionJsonl,
  sumUsageList,
  writeJsonAtomic,
} from "../src/backends/cli-common.mjs";
import { parseCodebuddyJsonOutput } from "../src/backends/codebuddy.mjs";
import { parseQoderJsonOutput } from "../src/backends/qoder.mjs";

function parseArgs(argv) {
  let specPath = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--spec" && argv[i + 1]) {
      specPath = argv[++i];
    }
  }
  if (!specPath) throw new Error("Missing --spec <path> argument");
  return specPath;
}

function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function patchState(stateFile, updater) {
  const prev = readJsonSafe(stateFile);
  if (!prev) return null;
  const next = updater(prev);
  if (next) writeJsonAtomic(stateFile, next);
  return next;
}

const MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

function appendCapped(chunks, totalObj, chunk, maxBytes, keepTail = false) {
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (!keepTail) {
    const remaining = maxBytes - totalObj.bytes;
    if (remaining <= 0) return;
    const slice = buf.length > remaining ? buf.subarray(0, remaining) : buf;
    chunks.push(slice);
    totalObj.bytes += slice.length;
    return;
  }
  chunks.push(buf);
  totalObj.bytes += buf.length;
  while (totalObj.bytes > maxBytes && chunks.length > 1) {
    const dropped = chunks.shift();
    totalObj.bytes -= dropped.length;
  }
  if (totalObj.bytes > maxBytes && chunks.length === 1) {
    const excess = totalObj.bytes - maxBytes;
    chunks[0] = chunks[0].subarray(excess);
    totalObj.bytes = chunks[0].length;
  }
}

async function main() {
  const specPath = parseArgs(process.argv.slice(2));
  const spec = readJsonSafe(specPath);
  if (!spec || !spec.stateFile || !spec.promptFile || !spec.bin || !Array.isArray(spec.args)) {
    throw new Error(`Invalid runner spec: ${specPath}`);
  }

  let promptText = "";
  try {
    promptText = readFileSync(spec.promptFile, "utf8");
  } finally {
    rmSync(spec.promptFile, { force: true });
    rmSync(specPath, { force: true });
  }

  const child = spawn(spec.bin, spec.args, {
    cwd: spec.cwd || process.cwd(),
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...(spec.env ?? {}) },
  });

  const stdoutChunks = [];
  const stdoutSize = { bytes: 0 };
  const stderrChunks = [];
  const stderrSize = { bytes: 0 };

  child.stdout.on("data", (chunk) => appendCapped(stdoutChunks, stdoutSize, chunk, MAX_STDOUT_BYTES, false));
  child.stderr.on("data", (chunk) => appendCapped(stderrChunks, stderrSize, chunk, MAX_STDERR_BYTES, true));

  const forwardSignal = (sig) => {
    if (child.pid) {
      try {
        process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          // ignore
        }
      }
    }
  };
  process.on("SIGTERM", () => forwardSignal("SIGTERM"));
  process.on("SIGINT", () => forwardSignal("SIGINT"));

  let settled = false;

  child.on("error", (err) => {
    if (settled) return;
    settled = true;
    patchState(spec.stateFile, (prev) => {
      const wasCancelled = prev.cancelRequested || prev.status === "cancelled";
      return {
        ...prev,
        status: wasCancelled ? "cancelled" : "failed",
        endedAt: prev.endedAt ?? Date.now(),
        error: wasCancelled ? prev.error : { type: "spawn_error", message: err.message, code: err.code ?? null },
      };
    });
    process.exitCode = 1;
  });

  if (child.pid) {
    patchState(spec.stateFile, (prev) => {
      const wasCancelled = prev.cancelRequested || prev.status === "cancelled";
      return {
        ...prev,
        runnerPid: process.pid,
        childPid: child.pid,
        pgid: child.pid,
        status: wasCancelled ? "cancelled" : "running",
      };
    });
  }

  child.stdin.on("error", () => {
    // Child may exit before consuming all of stdin
  });
  child.stdin.end(promptText, "utf8");

  child.on("close", (code, signal) => {
    if (settled) return;
    settled = true;

    const stdout = Buffer.concat(stdoutChunks).toString("utf8");
    const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
    const parseOutput = spec.backend === "qoder" ? parseQoderJsonOutput : parseCodebuddyJsonOutput;
    const parsed = parseOutput(stdout);
    const cliLabel = spec.backend === "qoder" ? "Qoder" : "CodeBuddy";

    const exitResult = patchState(spec.stateFile, (prev) => {
      const wasCancelled = Boolean(prev.cancelRequested || prev.status === "cancelled");
      const ok = !wasCancelled && parsed.ok && !parsed.isError && (code === 0 || (code === null && !signal));
      const finalStatus = wasCancelled ? "cancelled" : ok ? "completed" : "failed";

      const turnUsage = { ...(parsed.usage ?? sumUsageList([])) };
      if (turnUsage.toolCalls === 0 && prev.sessionFile) {
        const jsonlStats = inspectCliSessionJsonl(prev.sessionFile, {
          fromOffset: prev.jsonlStartOffset ?? 0,
        });
        if (jsonlStats.toolCalls > 0) turnUsage.toolCalls = jsonlStats.toolCalls;
      }

      const prevTurns = Array.isArray(prev.turns) ? prev.turns : [];
      const turnRecord = {
        index: prevTurns.length + 1,
        startedAt: prev.turnStartedAt ?? prev.startedAt,
        endedAt: Date.now(),
        exitCode: code,
        signal,
        subtype: parsed.subtype,
        numTurns: parsed.numTurns,
        durationMs: parsed.durationMs,
        usage: turnUsage,
      };
      const turns = [...prevTurns, turnRecord];
      const cumulativeUsage = sumUsageList(turns.map((t) => t.usage));
      const totalNumTurns = turns.reduce((acc, t) => acc + (Number(t.numTurns) || 0), 0);

      let errorObj = null;
      if (finalStatus === "failed") {
        const errorText = [
          ...(parsed.errors ?? []),
          stderr || null,
          !parsed.ok && !parsed.errors?.length && stdout.trim() ? stdout.trim().slice(-500) : null,
          code !== 0 && code !== null ? `exit code ${code}` : null,
          signal ? `signal ${signal}` : null,
        ]
          .filter(Boolean)
          .join("; ");
        errorObj = {
          type: classifyCliError(errorText),
          code: code ?? signal ?? null,
          message: errorText || `${cliLabel} execution failed`,
          ...(stderr ? { stderr: stderr.slice(-2000) } : {}),
        };
      }

      return {
        ...prev,
        status: finalStatus,
        endedAt: wasCancelled && prev.endedAt ? prev.endedAt : Date.now(),
        exitCode: code,
        signal: signal ?? null,
        subtype: parsed.subtype ?? prev.subtype,
        actualModel: parsed.model ?? prev.actualModel ?? null,
        sessionId: parsed.sessionId ?? prev.sessionId ?? null,
        result: parsed.result,
        error: errorObj,
        turns,
        numTurns: totalNumTurns,
        usage: cumulativeUsage,
      };
    });

    process.exitCode = exitResult?.status === "completed" ? 0 : (code ?? 1);
  });
}

main().catch((err) => {
  process.stderr.write(`cli-runner fatal: ${err?.stack ?? err}\n`);
  process.exit(1);
});
