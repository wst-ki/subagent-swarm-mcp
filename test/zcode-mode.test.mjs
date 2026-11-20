import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { setMode } from "../src/zcode.mjs";

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
