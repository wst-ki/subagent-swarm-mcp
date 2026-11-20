// On-demand reading of the official UI's displayed quota, not the context meter.
// Never touches credentials, calls an upstream endpoint, or invokes reset actions.
import { Cdp, sleep } from "./cdp.mjs";
import { config } from "./config.mjs";
import { withUiLock } from "./lock.mjs";
import { uiBlocker } from "./zcode.mjs";

const names = new Map([["5 小时", "five_hour"], ["5小时", "five_hour"], ["每周", "weekly"], ["周额度", "weekly"], ["工具调用", "tool_calls"], ["ZCode MCP", "zcode_mcp"]]);

export function parseQuotaPanel(text) {
  const lines = String(text).split(/\n/).map(s => s.trim()).filter(Boolean);
  const start = lines.indexOf("剩余额度");
  if (start < 0) return [];
  const windows = [];
  let current = null;
  for (const line of lines.slice(start + 1)) {
    const kind = names.get(line);
    if (kind) { current = { kind, label: line }; continue; }
    if (!current) continue;
    const m = line.match(/^(\d+(?:\.\d+)?)%\s*(?:[·•]\s*(.+))?$/);
    if (!m) continue;
    const pct = Number(m[1]);
    if (pct >= 0 && pct <= 100 && !windows.some(w => w.kind === current.kind))
      windows.push({ ...current, remainingPercent: pct, resetDisplay: m[2] ?? null });
    current = null;
  }
  return windows;
}

const readPanel = `(() => { const e = [...document.querySelectorAll('[data-radix-popper-content-wrapper]')].find(e => { const r=e.getBoundingClientRect(); return r.width>0 && r.height>0 && !e.querySelector('[data-context-reset-reminder]') && e.innerText.includes('剩余额度'); }); return e?.innerText ?? null; })()`;

export const hasBlockingPopoverExpr = `(() => {
  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  if ([...document.querySelectorAll('[role=menu],[role=listbox]')].some(visible)) return true;
  return [...document.querySelectorAll('[data-radix-popper-content-wrapper]')].some(e => visible(e) && !e.querySelector('[data-context-reset-reminder]'));
})()`;

export async function zcodeQuota() {
  return withUiLock(async () => {
    const cdp = await Cdp.connect(config.cdpPort);
    let opened = false;
    try {
      const blocker = await uiBlocker(cdp);
      if (blocker) throw new Error(blocker.message);
      if (await cdp.evaluate(hasBlockingPopoverExpr))
        throw new Error("A menu or popover is already open; quota read refused to avoid changing it.");
      // This is a hover card: create a fresh pointer-enter even if a prior read left the pointer on it.
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1, button: "none" });
      await sleep(300);
      await cdp.clickTestId("chat-context-usage-trigger");
      opened = true;
      let text = null;
      for (let i = 0; i < 10; i++) {
        await sleep(200);
        text = await cdp.evaluate(readPanel);
        if (text && parseQuotaPanel(text).length) break;
      }
      const windows = parseQuotaPanel(text ?? "");
      return {
        source: "zcode_ui", observedAt: new Date().toISOString(),
        status: windows.length ? "available" : "unavailable", windows,
        provider: null,
        note: "Displayed values may be cached; account, provider, source update time and undisplayed windows are unknown. Reset times are UI text in the app's timezone. Do not infer zero from missing data.",
      };
    } finally {
      if (opened) {
        try { if (await cdp.evaluate(readPanel)) await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1, button: "none" }); } catch { /* leave the UI alone if it changed */ }
      }
      cdp.close();
    }
  });
}
