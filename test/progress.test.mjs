import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDigest, parseSummaryOutput, summarize } from "../src/progress.mjs";

const base = Date.UTC(2026, 9, 23, 10, 0, 0);
const hhmm = (at) => new Date(base + at * 1000).toTimeString().slice(0, 5);
const row = (data, { at = 0, role = "assistant" } = {}) => ({ time_created: base + at * 1000, role, data });

const tmps = [];
const mkTmp = (pfx) => {
  const d = mkdtempSync(join(tmpdir(), pfx));
  tmps.push(d);
  return d;
};
after(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

const SUMMARY_JSON =
  '{"status":"SUCCESS","structured_output":{"summary":"all good","done":["a"],"doing":"b","next":"c","progressPct":42,"onTrack":true,"concerns":[],"needsAttention":false}}';

function fakeSummary() {
  const d = mkTmp("progress-fake-");
  const script = join(d, "summary.sh");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      'd=$(dirname "$0")',
      'echo x >> "$d/calls.txt"',
      '[ -n "$1" ] && printf %s "$1" > "$d/argv1.txt"',
      '[ -z "$1" ] && cat > "$d/stdin.txt"',
      `printf '%s' '${SUMMARY_JSON}'`,
      "",
    ].join("\n"),
  );
  chmodSync(script, 0o755);
  return { d, script };
}
const callCount = (d) => readFileSync(join(d, "calls.txt"), "utf8").split("\n").filter(Boolean).length;

// ------------------------------------------------------------ buildDigest

test("buildDigest renders tool lines, text snippets and aggregates; skips reasoning/steps/user text", () => {
  const rows = [
    row({ type: "text", text: "Please fix the bug in src/app.mjs and run the tests." }, { role: "user", at: -60 }),
    row({ type: "reasoning", text: "hmm thinking hard" }),
    row({ type: "step-start" }),
    row({ type: "timeline", text: "timeline-noise" }),
    row({ type: "tool", tool: "Read", state: { status: "completed", input: { file_path: "/p/src/app.mjs" } } }, { at: 1 }),
    row({ type: "tool", tool: "Edit", state: { status: "completed", input: { file_path: "/p/src/app.mjs", old_string: "a", new_string: "b" } } }, { at: 2 }),
    row({ type: "tool", tool: "Write", state: { status: "completed", input: { file_path: "/p/src/app.mjs" } } }, { at: 3 }),
    row({ type: "tool", tool: "Grep", state: { status: "completed", input: { pattern: "TODO" } } }, { at: 4 }),
    row({ type: "tool", tool: "Bash", state: { status: "completed", input: { command: "npm test" } } }, { at: 5 }),
    row({ type: "tool", tool: "Bash", state: { status: "error", input: { command: "x".repeat(300) } } }, { at: 6 }),
    row({ type: "text", text: "I fixed the bug. " + "blah ".repeat(100) }, { at: 7 }),
  ];
  const out = buildDigest(rows, { firstUserText: "Fix the bug in src/app.mjs and run the tests" });
  assert.match(out, /^TASK: Fix the bug in src\/app\.mjs and run the tests$/m);
  assert.ok(out.includes(`${hhmm(1)} Read /p/src/app.mjs completed`));
  assert.ok(out.includes(`${hhmm(4)} Grep TODO completed`));
  assert.ok(out.includes(`${hhmm(6)} Bash ${"x".repeat(157)}... error`));
  assert.match(out, new RegExp(`^${hhmm(7)} text I fixed the bug\\..{0,290}\\.\\.\\.$`, "m"));
  assert.ok(out.includes("FILES EDITED: /p/src/app.mjs x2"));
  assert.ok(out.includes("COMMANDS RUN: 2"));
  assert.ok(out.includes("- npm test"));
  assert.ok(!out.includes("hmm thinking hard") && !out.includes("timeline-noise") && !out.includes("Please fix the bug"));
});

test("buildDigest truncates the task prompt to 2000 chars", () => {
  const out = buildDigest([], { firstUserText: "T".repeat(2500) });
  assert.equal(out.split("\n")[0].length, "TASK: ".length + 2000);
  assert.ok(out.split("\n")[0].endsWith("..."));
});

test("buildDigest keeps only the latest maxItems timeline items", () => {
  const rows = Array.from({ length: 80 }, (_, i) =>
    row({ type: "tool", tool: "Read", state: { status: "completed", input: { file_path: `/p/f${i}.mjs` } } }, { at: i + 1 }),
  );
  const out = buildDigest(rows, { maxItems: 5 });
  assert.ok(out.includes(`${hhmm(80)} Read /p/f79.mjs completed`));
  assert.ok(out.includes(`${hhmm(76)} Read /p/f75.mjs completed`));
  assert.ok(!out.includes("/p/f74.mjs"));
  assert.match(out, /\(75 older items omitted\)/);
});

test("buildDigest stays under maxChars by dropping the oldest items first", () => {
  const rows = Array.from({ length: 40 }, (_, i) => row({ type: "text", text: "y".repeat(300) }, { at: i + 1 }));
  const out = buildDigest(rows, { maxChars: 1000 });
  assert.ok(out.length <= 1000);
  assert.ok(out.includes(`${hhmm(40)} text`));
  assert.match(out, /\(\d+ older items omitted\)/);
});

// ------------------------------------------------------- parseSummaryOutput

test("parseSummaryOutput prefers structured_output and normalizes fields", () => {
  const s = parseSummaryOutput(SUMMARY_JSON);
  assert.equal(s.summary, "all good");
  assert.deepEqual(s.done, ["a"]);
  assert.equal(s.progressPct, 42);
  assert.equal(s.onTrack, true);
  assert.equal(s.needsAttention, false);
});

test("parseSummaryOutput clamps progressPct to 0..100", () => {
  const mk = (pct) => JSON.stringify({ structured_output: { summary: "s", progressPct: pct } });
  assert.equal(parseSummaryOutput(mk(150)).progressPct, 100);
  assert.equal(parseSummaryOutput(mk(-5)).progressPct, 0);
});

test("parseSummaryOutput falls back to JSON in .response", () => {
  const s = parseSummaryOutput('{"status":"SUCCESS","response":"{\\"summary\\":\\"via response\\",\\"progressPct\\":50}"}');
  assert.equal(s.summary, "via response");
  assert.equal(s.progressPct, 50);
  assert.deepEqual(s.done, []);
});

test("parseSummaryOutput accepts structured_output as a JSON string", () => {
  const s = parseSummaryOutput(JSON.stringify({ structured_output: JSON.stringify({ summary: "str form" }) }));
  assert.equal(s.summary, "str form");
});

test("parseSummaryOutput returns null for garbage, failures and missing summary", () => {
  assert.equal(parseSummaryOutput("not json <<<"), null);
  assert.equal(parseSummaryOutput('{"status":"ERROR","response":"boom"}'), null);
  assert.equal(parseSummaryOutput('{"structured_output":{"done":["x"]}}'), null);
  assert.equal(parseSummaryOutput('{"response":"also not json"}'), null);
});

// ---------------------------------------------------------------- summarize

test("summarize caches per task and refreshes only when stale AND new parts exist", async () => {
  const { d, script } = fakeSummary();
  const dir = join(mkTmp("progress-state-"), "progress");
  const activity = { rows: [row({ type: "tool", tool: "Bash", state: { status: "completed", input: { command: "npm test" } } })], firstUserText: "do things", lastPartTime: 1000 };
  const t0 = 1_700_000_000_000;
  const sid = "session_test1";
  const opts = (o) => ({ cmd: `${script} {prompt}`, dir, activity, ...o });

  const first = await summarize(sid, opts({ now: t0 }));
  assert.equal(first.cached, false);
  assert.equal(first.digest.progressPct, 42);
  assert.equal(callCount(d), 1);
  assert.ok(existsSync(join(dir, "summary-schema.json")));
  assert.ok(readFileSync(join(d, "argv1.txt"), "utf8").includes("TASK: do things"));

  assert.equal((await summarize(sid, opts({ now: t0 + 5_000 }))).cached, true); // fresh cache
  assert.equal((await summarize(sid, opts({ now: t0 + 400_000 }))).cached, true); // stale but no new parts
  assert.equal(callCount(d), 1);

  const refreshed = await summarize(sid, opts({ now: t0 + 400_000, activity: { ...activity, lastPartTime: 2000 } }));
  assert.equal(refreshed.cached, false);
  assert.equal(refreshed.lastPartTime, 2000);
  assert.equal((await summarize(sid, opts({ now: t0 + 401_000, force: true }))).cached, false);
  assert.equal(callCount(d), 3);

  const md = readFileSync(join(dir, `${sid}.md`), "utf8");
  assert.equal(md.split("\n").filter(Boolean).length, 3);
  assert.match(md, /^- 20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z 42% all good$/m);
});

test("summarize pipes the prompt to stdin when the command has no {prompt} token", async () => {
  const { d, script } = fakeSummary();
  const dir = join(mkTmp("progress-state-"), "progress");
  const activity = { rows: [], firstUserText: "stdin task", lastPartTime: 1 };
  const s = await summarize("session_test2", { cmd: script, dir, activity });
  assert.equal(s.cached, false);
  assert.ok(readFileSync(join(d, "stdin.txt"), "utf8").includes("TASK: stdin task"));
  assert.ok(!existsSync(join(d, "argv1.txt")));
});

test("summarize throws when the summary command fails", async () => {
  const d = mkTmp("progress-fail-");
  const script = join(d, "fail.sh");
  writeFileSync(script, '#!/bin/sh\necho "boom" >&2\nexit 1\n');
  chmodSync(script, 0o755);
  const dir = join(mkTmp("progress-state-"), "progress");
  await assert.rejects(
    summarize("session_test3", { cmd: script, dir, activity: { rows: [], firstUserText: "x", lastPartTime: 1 } }),
    /exited with 1.*boom/,
  );
});
