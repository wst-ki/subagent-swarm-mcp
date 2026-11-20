import { closeSync, fstatSync, ftruncateSync, openSync, readSync, writeFileSync } from "node:fs";

export function workerLogLimit(env = process.env) {
  const mb = Number(env.HUB_WORKER_LOG_MAX_MB ?? 10);
  if (!Number.isFinite(mb) || mb < 1 || !Number.isSafeInteger(Math.floor(mb * 1024 * 1024))) {
    throw new Error("HUB_WORKER_LOG_MAX_MB must be at least 1 and finite");
  }
  return Math.floor(mb * 1024 * 1024);
}

export function readLogTail(path, maxBytes = 64 * 1024) {
  let fd;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, maxBytes));
    const n = readSync(fd, buf, 0, buf.length, size - buf.length);
    return buf.subarray(0, n).toString("utf8");
  } catch (e) {
    if (e.code === "ENOENT") return "";
    throw e;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Keep one bounded tail file. Compact to half the limit on overflow so tiny writes don't
// repeatedly copy the whole file. The detached worker wrapper owns the descriptor.
export class WorkerLog {
  constructor(path, maxBytes) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024) throw new Error("invalid worker log byte limit");
    this.maxBytes = maxBytes;
    this.fd = openSync(path, "a+");
    this.size = fstatSync(this.fd).size;
    if (this.size > maxBytes) this.append(Buffer.alloc(0));
  }

  append(chunk) {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    if (chunk.length >= this.maxBytes) {
      ftruncateSync(this.fd, 0);
      chunk = chunk.subarray(chunk.length - this.maxBytes);
      this.size = 0;
    } else if (this.size + chunk.length > this.maxBytes) {
      const keep = Math.min(Math.floor(this.maxBytes / 2), this.maxBytes - chunk.length, this.size);
      const tail = Buffer.alloc(keep);
      const n = readSync(this.fd, tail, 0, keep, this.size - keep);
      ftruncateSync(this.fd, 0);
      writeFileSync(this.fd, tail.subarray(0, n));
      this.size = n;
    }
    writeFileSync(this.fd, chunk);
    this.size += chunk.length;
  }

  close() { closeSync(this.fd); }
}
