import { test } from "node:test";
import assert from "node:assert/strict";
import { detectQuotaSection, parseQuotaPanel, readSettledQuotaPanel } from "../src/zcode-quota.mjs";

test("quota parser distinguishes context, quota windows and reset display", () => {
  const panel = "上下文容量\n3.3万/100万 (3.3%)\n剩余额度\n获得4次重置额度\n5 小时\n重置\n52% · 01:15\n工具调用\n95% · 11月17日\nZCode MCP\n100% · 11月6日";
  assert.deepEqual(parseQuotaPanel(panel), [
    { kind: "five_hour", label: "5 小时", remainingPercent: 52, resetDisplay: "01:15" },
    { kind: "tool_calls", label: "工具调用", remainingPercent: 95, resetDisplay: "11月17日" },
    { kind: "zcode_mcp", label: "ZCode MCP", remainingPercent: 100, resetDisplay: "11月6日" },
  ]);
});

test("missing or malformed quota does not imply zero", () => {
  assert.deepEqual(parseQuotaPanel("上下文容量\n5 小时\n99%"), []);
  assert.deepEqual(parseQuotaPanel("剩余额度\n5 小时\n加载中\n工具调用\n101%"), []);
});

test("readSettledQuotaPanel waits past stale cached text and converges once async RPC updates DOM", async () => {
  let clock = 0;
  const sleeper = async (ms) => {
    clock += ms;
  };
  const nowFn = () => clock;

  const stale = "剩余额度\n5 小时\n92% · 20:48\n工具调用\n100% · 12月17日";
  const fresh = "剩余额度\n5 小时\n62% · 20:48\n工具调用\n100% · 12月17日";
  // Simulate: T=150ms cached DOM paints (92%), T=300ms still cached, T=450ms RPC lands (62%), T=600ms stable (62%)
  let reads = 0;
  const readText = async () => {
    reads++;
    return clock < 400 ? stale : fresh;
  };

  const res = await readSettledQuotaPanel(readText, {
    appearTimeoutMs: 3000,
    settleMs: 1200,
    pollMs: 150,
    postChangeStabilizeMs: 150,
    sleeper,
    nowFn,
  });

  assert.equal(res.refreshedDuringRead, true);
  assert.equal(res.windows[0].remainingPercent, 62);
  assert.equal(res.windows[0].resetDisplay, "20:48");
  // Converged early (~450ms settle) instead of waiting the full 1200ms
  assert.ok(res.settleWaitMs < 1200);
  assert.equal(reads, 4);
});

test("readSettledQuotaPanel waits full settle window when value is unchanged and ignores transient loading flickers", async () => {
  let clock = 0;
  const sleeper = async (ms) => {
    clock += ms;
  };
  const nowFn = () => clock;

  const steady = "剩余额度\n5 小时\n62% · 20:48";
  const loading = "剩余额度\n5 小时\n加载中";
  let reads = 0;
  const readText = async () => {
    reads++;
    if (reads === 1) return loading; // Initial mount still loading
    if (reads === 4) return loading; // Mid-refresh flicker must not erase valid windows
    return steady;
  };

  const res = await readSettledQuotaPanel(readText, {
    appearTimeoutMs: 3000,
    settleMs: 900,
    pollMs: 150,
    sleeper,
    nowFn,
  });

  assert.equal(res.refreshedDuringRead, false);
  assert.equal(res.windows.length, 1);
  assert.equal(res.windows[0].remainingPercent, 62);
  assert.equal(res.settleWaitMs, 900);
});

test("readSettledQuotaPanel preserves last valid reading if hovercard closes mid-settle", async () => {
  let clock = 0;
  const sleeper = async (ms) => {
    clock += ms;
  };
  const nowFn = () => clock;

  let reads = 0;
  const readText = async () => {
    reads++;
    if (reads === 1) return "剩余额度\n5 小时\n75% · 20:48";
    return null; // Hovercard dismissed unexpectedly
  };

  const res = await readSettledQuotaPanel(readText, {
    appearTimeoutMs: 3000,
    settleMs: 1200,
    pollMs: 150,
    sleeper,
    nowFn,
  });

  assert.equal(res.windows.length, 1);
  assert.equal(res.windows[0].remainingPercent, 75);
  assert.equal(res.settleWaitMs, 150);
});

test("parseQuotaPanel and readSettledQuotaPanel parse Start Plan 今日余额 hovercard and skip promo badges", async () => {
  const startPlanPanel = [
    "上下文容量",
    "3万/100万 (3%)",
    "系统工具",
    "55.2%",
    "今日余额",
    "升级",
    "150% 配额",
    "GLM-5.3-Flash",
    "100% · 11月23日",
  ].join("\n");

  const sec = detectQuotaSection(startPlanPanel);
  assert.equal(sec.section, "今日余额");
  assert.equal(sec.planHint, "start_plan");

  assert.deepEqual(parseQuotaPanel(startPlanPanel), [
    {
      kind: "model_daily",
      label: "GLM-5.3-Flash",
      model: "GLM-5.3-Flash",
      remainingPercent: 100,
      resetDisplay: "11月23日",
    },
  ]);

  let clock = 0;
  const sleeper = async (ms) => {
    clock += ms;
  };
  const updatedPanel = startPlanPanel.replace("100% · 11月23日", "84% · 11月23日");
  const res = await readSettledQuotaPanel(
    async () => (clock < 400 ? startPlanPanel : updatedPanel),
    { appearTimeoutMs: 3000, settleMs: 1200, pollMs: 150, postChangeStabilizeMs: 150, sleeper, nowFn: () => clock },
  );
  assert.equal(res.section, "今日余额");
  assert.equal(res.planHint, "start_plan");
  assert.equal(res.refreshedDuringRead, true);
  assert.equal(res.windows[0].model, "GLM-5.3-Flash");
  assert.equal(res.windows[0].remainingPercent, 84);
});
