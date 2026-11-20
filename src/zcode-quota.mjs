// On-demand reading of the official UI's displayed quota, not the context meter.
// Supports both BigModel Individual Coding Plan ("剩余额度") and Start Plan ("今日余额") panels.
// Never touches credentials, calls an upstream endpoint, or invokes reset actions.
import { Cdp, sleep } from "./cdp.mjs";
import { config } from "./config.mjs";
import { withUiLock } from "./lock.mjs";
import { OPEN_POPOVER_EXPR, closeOpenMenu, uiBlocker } from "./zcode.mjs";

const names = new Map([
  ["5 小时", "five_hour"],
  ["5小时", "five_hour"],
  ["每周", "weekly"],
  ["周额度", "weekly"],
  ["工具调用", "tool_calls"],
  ["ZCode MCP", "zcode_mcp"],
]);

const SECTION_HEADERS = [
  { label: "剩余额度", planHint: "individual_coding_plan" },
  { label: "今日余额", planHint: "start_plan" },
];

const MODEL_LABEL_RE = /^[A-Za-z][A-Za-z0-9._-]{1,40}$/;

export function detectQuotaSection(text) {
  const lines = String(text ?? "").split(/\n/).map((s) => s.trim()).filter(Boolean);
  for (const h of SECTION_HEADERS) {
    const index = lines.indexOf(h.label);
    if (index >= 0) return { section: h.label, planHint: h.planHint, index, lines };
  }
  return { section: null, planHint: null, index: -1, lines };
}

export function parseQuotaPanel(text) {
  const { section, index: start, lines } = detectQuotaSection(text);
  if (start < 0) return [];
  const allowModelLabels = section === "今日余额";
  const windows = [];
  const seenKeys = new Set();
  let current = null;
  for (const line of lines.slice(start + 1)) {
    const kind = names.get(line);
    if (kind) {
      current = { kind, label: line };
      continue;
    }
    if (allowModelLabels && MODEL_LABEL_RE.test(line)) {
      current = { kind: "model_daily", label: line, model: line };
      continue;
    }
    if (!current) continue;
    const m = line.match(/^(\d+(?:\.\d+)?)%\s*(?:[·•]\s*(.+))?$/);
    if (!m) continue;
    const pct = Number(m[1]);
    const key = current.kind === "model_daily" ? `${current.kind}:${current.model}` : current.kind;
    if (pct >= 0 && pct <= 100 && !seenKeys.has(key)) {
      seenKeys.add(key);
      windows.push({ ...current, remainingPercent: pct, resetDisplay: m[2] ?? null });
    }
    current = null;
  }
  return windows;
}

const windowsSignature = (windows) =>
  windows.map((w) => `${w.kind}:${w.model ?? ""}:${w.remainingPercent}:${w.resetDisplay ?? ""}`).join("|");

/**
 * Poll the open quota hovercard until it renders valid windows and then wait for ZCode's async
 * entitlement refresh (`getEntitlementSnapshot`, typically ~250-350 ms) to settle.
 * - Supports both "剩余额度" (Individual Coding Plan) and "今日余额" (Start Plan) hovercards.
 * - Avoids the 1-call-lagged stale-cache bug where opening the popover immediately paints the
 *   previous reading before the async RPC updates the DOM.
 * - Converges early once a live DOM update is observed and stabilizes for one extra poll.
 * - Never discards already-parsed windows if a transient "加载中" or panel close happens.
 */
export async function readSettledQuotaPanel(
  readTextFn,
  {
    appearTimeoutMs = 3000,
    settleMs = 1200,
    pollMs = 150,
    postChangeStabilizeMs = 150,
    sleeper = sleep,
    nowFn = Date.now,
  } = {},
) {
  const start = nowFn();
  let initialSig = null;
  let latestSig = null;
  let latestWindows = [];
  let latestSection = { section: null, planHint: null };
  let appearedAt = null;
  let changedAt = null;

  // Phase 1: Wait for the hovercard to mount with at least one parsed quota window.
  while (nowFn() - start < appearTimeoutMs) {
    await sleeper(pollMs);
    const text = await readTextFn();
    if (!text) continue;
    const parsed = parseQuotaPanel(text);
    if (parsed.length > 0) {
      const sec = detectQuotaSection(text);
      latestWindows = parsed;
      latestSection = { section: sec.section, planHint: sec.planHint };
      initialSig = windowsSignature(parsed);
      latestSig = initialSig;
      appearedAt = nowFn();
      break;
    }
  }

  if (appearedAt === null || settleMs <= 0) {
    return {
      windows: latestWindows,
      section: latestSection.section,
      planHint: latestSection.planHint,
      refreshedDuringRead: false,
      settleWaitMs: 0,
    };
  }

  // Phase 2: Keep the hovercard open long enough for the async refresh RPC to update the DOM.
  let lastChangeSig = initialSig;
  while (nowFn() - appearedAt < settleMs) {
    await sleeper(pollMs);
    const text = await readTextFn();
    if (!text) break; // Panel closed unexpectedly; keep best valid reading instead of burning time.
    const parsed = parseQuotaPanel(text);
    if (parsed.length === 0) continue; // Ignore transient loading flicker during refresh.
    const sec = detectQuotaSection(text);
    const sig = windowsSignature(parsed);
    latestWindows = parsed;
    latestSection = { section: sec.section, planHint: sec.planHint };
    latestSig = sig;
    if (sig !== initialSig) {
      if (sig !== lastChangeSig) {
        lastChangeSig = sig;
        changedAt = nowFn();
      } else if (changedAt !== null && nowFn() - changedAt >= postChangeStabilizeMs) {
        break;
      }
    }
  }

  return {
    windows: latestWindows,
    section: latestSection.section,
    planHint: latestSection.planHint,
    refreshedDuringRead: latestSig !== initialSig,
    settleWaitMs: Math.max(0, Math.round(nowFn() - appearedAt)),
  };
}

const readPanel = `(() => { const e = [...document.querySelectorAll('[data-radix-popper-content-wrapper]')].find(e => { const r=e.getBoundingClientRect(); return r.width>0 && r.height>0 && !e.querySelector('[data-context-reset-reminder]') && (e.innerText.includes('剩余额度') || e.innerText.includes('今日余额')); }); return e?.innerText ?? null; })()`;

export const hasBlockingPopoverExpr = OPEN_POPOVER_EXPR;

function defaultSettleMs() {
  const raw = Number(process.env.ZCODE_MCP_QUOTA_SETTLE_MS ?? 1200);
  if (!Number.isFinite(raw)) return 1200;
  return Math.max(0, Math.min(5000, Math.round(raw)));
}

export async function zcodeQuota({
  autoDismissPopover = process.env.ZCODE_MCP_AUTO_DISMISS_POPOVER !== "0",
  settleMs = defaultSettleMs(),
} = {}) {
  return withUiLock(async () => {
    const cdp = await Cdp.connect(config.cdpPort);
    let opened = false;
    try {
      const blocker = await uiBlocker(cdp);
      if (blocker) throw new Error(blocker.message);
      if (await cdp.evaluate(hasBlockingPopoverExpr)) {
        const cleared = autoDismissPopover ? await closeOpenMenu(cdp) : false;
        if (!cleared) {
          throw new Error("A menu or popover is already open; quota read refused to avoid changing it.");
        }
      }
      // This is a hover card: create a fresh pointer-enter even if a prior read left the pointer on it.
      await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1, button: "none" });
      await sleep(300);
      await cdp.clickTestId("chat-context-usage-trigger");
      opened = true;
      const settled = await readSettledQuotaPanel(() => cdp.evaluate(readPanel), { settleMs });
      const { windows, section, planHint, refreshedDuringRead, settleWaitMs } = settled;
      return {
        source: "zcode_ui",
        observedAt: new Date().toISOString(),
        status: windows.length ? "available" : "unavailable",
        section,
        planHint,
        windows,
        refreshedDuringRead,
        settleWaitMs,
        provider: null,
        note: "Waits for ZCode's async hovercard refresh window before reading (supports both 剩余额度 / 今日余额 panels); account, verified provider, upstream timestamp and undisplayed windows remain unknown. Reset times are UI text in the app's timezone. Do not infer zero from missing data.",
      };
    } finally {
      if (opened) {
        try {
          if (await cdp.evaluate(readPanel)) {
            await cdp.call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1, button: "none" });
            await sleep(150);
          }
          await closeOpenMenu(cdp).catch(() => {});
        } catch { /* leave the UI alone if it changed */ }
      }
      cdp.close();
    }
  });
}
