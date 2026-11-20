import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuotaPanel } from "../src/zcode-quota.mjs";

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
