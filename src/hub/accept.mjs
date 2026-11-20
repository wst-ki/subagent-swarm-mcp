// Acceptance: for each done task, replay its patch on a fresh worktree of spec.repo, run the
// accept command and record accepted/rejected. Tasks with spec.review get a review child task
// whose VERDICT line decides the parent.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const git = (cwd, ...args) => exec("git", args, { cwd, maxBuffer: 100 * 1024 * 1024 });
const tail = (s, n = 80) => String(s ?? "").split("\n").slice(-n).join("\n").trim();

export function parseVerdict(report) {
  const m = String(report ?? "").match(/^\s*VERDICT:\s*(PASS|NEEDS_FIX)\s*$/im);
  return m ? m[1].toUpperCase() : null;
}

export function reviewBody(parent, patch) {
  const s = parent.spec ?? {};
  return `You are an independent reviewer. Review the patch below for task ${parent.id} ("${s.title ?? ""}").
You did not write this code; judge it neutrally: correctness, edge cases, security, tests.

The patch is a git diff against base ${s.base}:

${patch ?? "(no changes)"}

- This is a read-only review: do not modify any files.
- End your report with exactly one verdict line: "VERDICT: PASS" or "VERDICT: NEEDS_FIX".
`;
}

const DEFAULT_ACCEPT_MIN = Number(process.env.HUB_ACCEPT_TIMEOUT_MIN ?? 30);
// bash + pipefail so `pnpm typecheck | tail` fails when typecheck fails (dash has no pipefail).
const SHELL = existsSync("/bin/bash") ? ["/bin/bash", ["-o", "pipefail", "-c"]] : ["sh", ["-c"]];

export async function runAccept(hub, { log = () => {}, tmpBase = tmpdir(), acceptTimeoutMs } = {}) {
  const tasks = await hub.list();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const done = tasks.filter((t) => t.state === "done");
  const out = { accepted: [], rejected: [], reviews: [] };

  // Finished review children decide their parents first.
  for (const c of done.filter((t) => t.spec?.parent)) {
    try {
      const parent = byId.get(c.spec.parent);
      const report = (await hub.readTaskFile(c.id, "result/report.md")) ?? "";
      const verdict = parseVerdict(report);
      if (parent && parent.state === "done" && parent.note === `awaiting review ${c.id}`) {
        await hub.accept(parent.id, { ok: verdict === "PASS", log: tail(report), note: `review ${verdict ?? "NEEDS_FIX"}` });
        (verdict === "PASS" ? out.accepted : out.rejected).push(parent.id);
      }
      await hub.accept(c.id, { ok: true, log: `VERDICT: ${verdict ?? "(none)"}`, note: "review completed" });
      out.accepted.push(c.id);
    } catch (e) {
      log(`review child ${c.id}: ${e.message}`);
    }
  }

  for (const t of done.filter((x) => !x.spec?.parent)) {
    if ((t.note ?? "").startsWith("awaiting review ")) continue;
    try {
      const spec = t.spec ?? {};
      if (spec.kind !== "code" || !spec.repo || !spec.base) {
        await hub.accept(t.id, { ok: true, note: spec.kind === "code" ? "code task without repo/base: no checks" : "text task" });
        out.accepted.push(t.id);
        continue;
      }
      const patch = await hub.readTaskFile(t.id, "result/patch.diff");
      const res = patch?.trim()
        ? await runChecks(spec, patch, { tmpBase, acceptTimeoutMs: acceptTimeoutMs ?? (spec.acceptTimeoutMin ?? DEFAULT_ACCEPT_MIN) * 60_000 })
        : { ok: false, log: "", note: "empty patch: the worker changed nothing" };
      if (!res.ok) {
        await hub.accept(t.id, { ok: false, log: res.log, note: res.note });
        out.rejected.push(t.id);
        continue;
      }
      if (spec.review) {
        const workers = await hub.workers();
        const vendor = workers.find((w) => w.id === t.assignee)?.vendor;
        const child = await hub.post(
          {
            title: `Review ${t.id}`,
            kind: "review",
            repo: spec.repo,
            base: spec.base,
            tier: "mid",
            accept: null,
            timeoutMin: 30,
            avoidVendors: vendor ? [vendor] : [],
            preferWorkers: [],
            review: false,
            parent: t.id,
          },
          reviewBody(t, patch),
        );
        await hub.transition(t.id, { from: ["done"], to: "done", set: { note: `awaiting review ${child.id}` }, message: `awaiting review ${child.id}` });
        out.reviews.push({ parent: t.id, child: child.id });
        log(`${t.id}: checks passed, review child ${child.id}`);
        continue;
      }
      await hub.accept(t.id, { ok: true, log: res.log, note: res.note });
      out.accepted.push(t.id);
    } catch (e) {
      log(`accept ${t.id}: ${e.message}`);
    }
  }
  return out;
}

async function runChecks(spec, patch, { tmpBase, acceptTimeoutMs }) {
  const dir = mkdtempSync(join(tmpBase, "hub-accept-"));
  const wt = join(dir, "wt");
  try {
    try {
      await git(spec.repo, "worktree", "add", "--detach", wt, spec.base);
    } catch (e) {
      return { ok: false, log: tail(`${e.stdout ?? ""}${e.stderr ?? ""}`), note: "worktree setup failed" };
    }
    const patchFile = join(dir, "patch.diff");
    writeFileSync(patchFile, patch ?? "");
    try {
      await git(wt, "apply", "--index", patchFile);
    } catch (e) {
      return { ok: false, log: tail(`$ git apply --index patch.diff\n${e.stdout ?? ""}${e.stderr ?? ""}`), note: "patch did not apply" };
    }
    if (!spec.accept) return { ok: true, log: "", note: "no accept command" };
    try {
      const r = await exec(SHELL[0], [...SHELL[1], spec.accept], { cwd: wt, timeout: acceptTimeoutMs, maxBuffer: 10 * 1024 * 1024 });
      return { ok: true, log: tail(`${r.stdout ?? ""}${r.stderr ?? ""}`), note: "accept command passed" };
    } catch (e) {
      const timedOut = e.killed || Boolean(e.signal);
      return { ok: false, log: tail(`${e.stdout ?? ""}${e.stderr ?? ""}${timedOut ? "\n(timed out)" : ""}`), note: timedOut ? "accept command timed out" : "accept command failed" };
    }
  } finally {
    await git(spec.repo, "worktree", "remove", "--force", wt).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}
