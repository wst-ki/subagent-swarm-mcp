#!/usr/bin/env node
// Detached logging supervisor. The daemon records this pid; its worker stays in the same
// process group so cancellation reaches both. No dependency on the daemon's stdout pipes.
import { spawn } from "node:child_process";
import { WorkerLog } from "../src/hub/worker-log.mjs";

const [path, limit, command, ...args] = process.argv.slice(2);
if (!command) throw new Error("hub-worker: missing worker command");
const log = new WorkerLog(path, Number(limit));
const child = spawn(command, args, { stdio: ["inherit", "pipe", "pipe"] });
child.stdout.on("data", (chunk) => log.append(chunk));
child.stderr.on("data", (chunk) => log.append(chunk));
child.on("error", (e) => log.append(`\nworker could not start: ${e.message}\n`));
child.on("close", (code, signal) => {
  if (signal) log.append(`\nworker exited by signal ${signal}\n`);
  log.close();
  process.exitCode = code ?? 1;
});
