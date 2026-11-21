import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { closeOpenMenu, setMode, setModel, waitForNewTaskComposer, waitForSendEnabled } from "../src/zcode.mjs";

function makeFakeCdp({ initialMode = "变更前确认", withDialog = false, stayDisabled = false } = {}) {
  let mode = initialMode;
  let dialogOpen = false;
  let riskChecked = false;
  let confirmDisabled = true;
  const clicks = [];

  const elements = {
    '[data-testid="chat-mode-select-trigger"]': () => ({ innerText: mode }),
    '[data-testid="yolo-confirmation-risk"]': () => ({
      getAttribute: (name) => (name === "aria-checked" ? String(riskChecked) : null),
    }),
    '[data-testid="yolo-confirmation-confirm"]': () => ({ disabled: confirmDisabled }),
  };

  return {
    clicks,
    async hasTestId(id) {
      if (id === "yolo-confirmation-dialog") return dialogOpen;
      return false;
    },
    async clickTestId(id) {
      clicks.push(id);
      if (id === "chat-mode-select-item-yolo") {
        if (withDialog) dialogOpen = true;
        else mode = "完全访问";
      } else if (id === "yolo-confirmation-risk") {
        riskChecked = true;
        if (!stayDisabled) confirmDisabled = false;
      } else if (id === "yolo-confirmation-confirm") {
        dialogOpen = false;
        mode = "完全访问";
      } else if (id === "yolo-confirmation-cancel") {
        dialogOpen = false;
      }
    },
    async evaluate(expression) {
      return runInNewContext(expression, {
        document: {
          querySelector: (selector) => (elements[selector] ? elements[selector]() : null),
        },
      });
    },
  };
}

test("setMode is a no-op when already in 完全访问 mode", async () => {
  const cdp = makeFakeCdp({ initialMode: "完全访问" });
  await setMode(cdp);
  assert.deepEqual(cdp.clicks, []);
});

test("setMode switches directly via chat-mode-select-item-yolo on ZCode 3.16.1 (no dialog)", async () => {
  const cdp = makeFakeCdp({ initialMode: "变更前确认", withDialog: false });
  await setMode(cdp);
  assert.deepEqual(cdp.clicks, ["chat-mode-select-trigger", "chat-mode-select-item-yolo"]);
});

test("setMode completes yolo-confirmation-dialog on ZCode 3.18.2", async () => {
  const cdp = makeFakeCdp({ initialMode: "变更前确认", withDialog: true, stayDisabled: false });
  await setMode(cdp);
  assert.deepEqual(cdp.clicks, [
    "chat-mode-select-trigger",
    "chat-mode-select-item-yolo",
    "yolo-confirmation-risk",
    "yolo-confirmation-confirm",
  ]);
});

test("setMode cancels yolo-confirmation-dialog and throws if confirm stays disabled", async () => {
  const cdp = makeFakeCdp({ initialMode: "变更前确认", withDialog: true, stayDisabled: true });
  await assert.rejects(setMode(cdp), /yolo confirmation button to enable/);
  assert.deepEqual(cdp.clicks, [
    "chat-mode-select-trigger",
    "chat-mode-select-item-yolo",
    "yolo-confirmation-risk",
    "yolo-confirmation-cancel",
  ]);
});

function makeMenuCdp({
  dialogs = [],
  menuDepth = 0,
  popperStuckOnEscape = false,
  modelItems = [],
  onSelectModel = null,
} = {}) {
  let depth = menuDepth;
  let popperOpen = popperStuckOnEscape;
  let escapes = 0;
  const mouseEvents = [];
  const clicks = [];
  let items = modelItems;

  const visibleEl = (extra = {}) => ({
    getBoundingClientRect: () => ({ width: 100, height: 30 }),
    getAttribute: (k) => extra[k] ?? null,
    innerText: extra.text ?? "",
    querySelector: () => null,
  });

  return {
    clicks,
    mouseEvents,
    get escapes() {
      return escapes;
    },
    get isMenuOpen() {
      return depth > 0 || popperOpen;
    },
    setItems(next) {
      items = next;
    },
    async pressEscape() {
      escapes++;
      if (depth > 0) depth--;
    },
    async call(method, params) {
      if (method === "Input.dispatchMouseEvent") {
        mouseEvents.push(params);
        if (params.type === "mouseReleased" && params.x === 1 && params.y === 1) {
          popperOpen = false;
        }
      }
      return {};
    },
    async clickTestId(id, options) {
      clicks.push(options ? { id, options } : id);
      if (id === "chat-model-select-trigger") {
        depth = 1;
      } else if (id === "composer-provider-trigger") {
        depth = 2;
        if (onSelectModel) await onSelectModel(id, { setItems: (n) => (items = n), setDepth: (d) => (depth = d) });
      } else if (id.startsWith("chat-model-select-group-registry-provider:")) {
        if (onSelectModel) await onSelectModel(id, { setItems: (n) => (items = n), setDepth: (d) => (depth = d) });
      }
    },
    async clickElement(_expr, what) {
      clicks.push(what);
      if (onSelectModel) {
        await onSelectModel(what, { setItems: (n) => (items = n), setDepth: (d) => (depth = d) });
      } else {
        depth = 0;
      }
    },
    async evaluate(expression) {
      const qsa = (selector) => {
        if (selector.includes("alertdialog")) return dialogs.map((d) => visibleEl({ text: d }));
        if (selector.includes("[role=menu],[role=listbox]")) return depth > 0 ? [visibleEl({ role: "menu" })] : [];
        if (selector.includes("data-radix-popper-content-wrapper")) return popperOpen ? [visibleEl()] : [];
        if (selector.includes("menuitemradio")) {
          if (depth === 0) return [];
          return items.map((i) =>
            visibleEl({
              "data-testid": i.testId,
              role: i.role ?? "menuitemradio",
              "aria-checked": String(Boolean(i.checked)),
              text: i.text ?? "",
            }),
          );
        }
        return [];
      };
      return runInNewContext(expression, {
        document: {
          querySelector: () => null,
          querySelectorAll: qsa,
          body: { style: { pointerEvents: popperOpen ? "none" : "" } },
        },
      });
    },
  };
}

test("closeOpenMenu: no-op when clean, refuses on real dialogs, unwinds nested submenus and stubborn popovers", async () => {
  // Clean screen -> 0 escapes
  const clean = makeMenuCdp({ menuDepth: 0 });
  assert.equal(await closeOpenMenu(clean, { delayMs: 1 }), true);
  assert.equal(clean.escapes, 0);

  // Real dialog open -> MUST NOT touch it (0 escapes, 0 mouse events)
  const withDialog = makeMenuCdp({ dialogs: ["登录已过期"], menuDepth: 1 });
  assert.equal(await closeOpenMenu(withDialog, { delayMs: 1 }), false);
  assert.equal(withDialog.escapes, 0);
  assert.equal(withDialog.mouseEvents.length, 0);

  // Nested 2-level Radix submenu -> sends 2 escapes and clears cleanly
  const nested = makeMenuCdp({ menuDepth: 2 });
  assert.equal(await closeOpenMenu(nested, { delayMs: 1 }), true);
  assert.equal(nested.escapes, 2);
  assert.equal(nested.isMenuOpen, false);

  // Unfocused Radix popper that ignores Escape -> falls back to neutral (1,1) corner click
  const stubborn = makeMenuCdp({ menuDepth: 0, popperStuckOnEscape: true });
  assert.equal(await closeOpenMenu(stubborn, { delayMs: 1 }), true);
  assert.equal(stubborn.isMenuOpen, false);
  assert.ok(stubborn.mouseEvents.some((e) => e.type === "mouseReleased" && e.x === 1 && e.y === 1));
});

test("setModel skips redundant double-open when already selected and cleans up menu on failure", async () => {
  const wantedId = "chat-model-select-item-custom:account%3Abigmodel-individual-coding-plan:GLM-5.3-Flash";
  const already = makeMenuCdp({
    modelItems: [{ testId: wantedId, checked: true, text: "GLM-5.3-Flash" }],
  });
  const plan = await setModel(already, "GLM-5.3-Flash", "account%3Abigmodel-individual-coding-plan", {
    allowedProviders: ["account%3Abigmodel-individual-coding-plan"],
    stepDelayMs: 1,
  });
  assert.equal(plan.status, "already-selected");
  // Opened ONCE and closed cleanly (never re-opened for redundant verifyModel!)
  assert.deepEqual(already.clicks, ["chat-model-select-trigger"]);
  assert.equal(already.isMenuOpen, false);

  // Failed switch MUST close the open menu in finally so later clicks are never blocked!
  const failing = makeMenuCdp({
    modelItems: [{ testId: wantedId, checked: false, text: "GLM-5.3-Flash" }],
    onSelectModel: async (_what, { setDepth }) => {
      // Simulate ZCode ignoring the click while leaving the menu open
      setDepth(1);
    },
  });
  await assert.rejects(
    setModel(failing, "GLM-5.3-Flash", "account%3Abigmodel-individual-coding-plan", {
      allowedProviders: ["account%3Abigmodel-individual-coding-plan"],
      verifyTimeout: 300,
      stepDelayMs: 1,
    }),
    /ZCode did not switch to model GLM-5\.3-Flash/,
  );
  assert.equal(failing.isMenuOpen, false);
});

test("setModel uses moveBeforeClick=false for Radix provider submenu and skips redundant model click when auto-checked", async () => {
  const startPlanModel = "chat-model-select-item-custom:account%3Abigmodel-start-plan:GLM-5.3-Flash";
  const personalModel = "chat-model-select-item-custom:account%3Abigmodel-individual-coding-plan:GLM-5.3-Flash";
  const startPlanProvider = "chat-model-select-group-registry-provider:account:bigmodel-start-plan";
  const switcher = makeMenuCdp({
    modelItems: [{ testId: personalModel, checked: true, text: "GLM-5.3-Flash" }],
    onSelectModel: async (id, { setItems, setDepth }) => {
      if (id === "composer-provider-trigger") {
        setItems([
          { testId: personalModel, checked: true, text: "GLM-5.3-Flash" },
          { testId: startPlanProvider, checked: false, text: "Start Plan" },
        ]);
      } else if (id === startPlanProvider) {
        setDepth(1);
        setItems([{ testId: startPlanModel, checked: true, text: "GLM-5.3-Flash" }]);
      }
    },
  });
  const plan = await setModel(switcher, "GLM-5.3-Flash", "account%3Abigmodel-start-plan", {
    allowedProviders: [
      "account%3Abigmodel-individual-coding-plan",
      "account%3Abigmodel-start-plan",
    ],
    stepDelayMs: 1,
  });
  assert.equal(plan.provider, "account:bigmodel-start-plan");
  assert.ok(
    switcher.clicks.some(
      (c) => typeof c === "object" && c.id === startPlanProvider && c.options?.moveBeforeClick === false,
    ),
  );
  assert.equal(switcher.isMenuOpen, false);
});

test("waitForNewTaskComposer waits for workspace + mode triggers and waitForSendEnabled waits past disabled state", async () => {
  // Simulate transitioning from an old session (where v4-composer-input exists but workspace trigger is null)
  // to the new-task composer on the 3rd poll.
  let wsPoll = 0;
  const navCdp = {
    async evaluate(expression) {
      wsPoll++;
      const mounted = wsPoll >= 3;
      const box = () => ({ width: 20, height: 20 });
      return runInNewContext(expression, {
        document: {
          querySelector(sel) {
            if (sel.includes("v4-composer-input")) return { getBoundingClientRect: box };
            if (sel.includes("composer-workspace-trigger")) return mounted ? { getBoundingClientRect: box, innerText: "subagent" } : null;
            if (sel.includes("chat-mode-select-trigger")) return mounted ? { getBoundingClientRect: box, innerText: "完全访问" } : null;
            return null;
          },
        },
      });
    },
  };
  const project = await waitForNewTaskComposer(navCdp, { timeout: 2000, interval: 5 });
  assert.equal(project, "subagent");
  assert.equal(wsPoll, 3);

  // Simulate v4-composer-send staying disabled:pointer-events-none until input nudge fires
  let nudged = false;
  const sendCdp = {
    async evaluate(expression) {
      if (expression.includes("dispatchEvent")) {
        nudged = true;
        return;
      }
      const btn = {
        disabled: !nudged,
        getBoundingClientRect: () => ({ width: 28, height: 28 }),
        getAttribute: () => null,
      };
      return runInNewContext(expression, {
        document: {
          querySelector(sel) {
            if (sel.includes("v4-composer-send")) return btn;
            return null;
          },
        },
        getComputedStyle: () => ({ pointerEvents: nudged ? "auto" : "none" }),
      });
    },
  };
  const ready = await waitForSendEnabled(sendCdp, { timeout: 2000, interval: 5, nudgeAfterMs: 15 });
  assert.equal(ready, true);
  assert.equal(nudged, true);
});
