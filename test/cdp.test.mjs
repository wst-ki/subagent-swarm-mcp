import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { Cdp } from "../src/cdp.mjs";
import { uiBlocker } from "../src/zcode.mjs";

test("blocked element never dispatches a pointer event and reports blocker details", async () => {
  const cdp = new Cdp();
  cdp.evaluate = async () => ({
    x: 4,
    y: 5,
    blocked: true,
    blocker: { tag: "div", role: "menu", testId: "model-menu", text: "GLM-5.3" },
  });
  cdp.call = async () => assert.fail("pointer event dispatched through overlay");
  await assert.rejects(
    cdp.clickElement("target", "target"),
    /blocked by another element: target \(div\[role=menu\]\[data-testid=model-menu\] "GLM-5\.3"\)/,
  );
});

test("clickElement supports moveBeforeClick=false to avoid Radix submenu pointerleave unmount", async () => {
  const cdp = new Cdp();
  const seen = [];
  cdp.evaluate = async () => ({ x: 100, y: 200, blocked: false, blocker: null });
  cdp.call = async (method, params) => {
    if (method === "Input.dispatchMouseEvent") seen.push(params.type);
    return {};
  };
  await cdp.clickElement("target", "default-click");
  assert.deepEqual(seen, ["mouseMoved", "mousePressed", "mouseReleased"]);

  seen.length = 0;
  await cdp.clickTestId("chat-model-select-group-registry-provider:account:bigmodel-start-plan", {
    moveBeforeClick: false,
  });
  assert.deepEqual(seen, ["mousePressed", "mouseReleased"]);
});

test("clickElement reports disabled / pointer-events:none instead of false overlay blocker", async () => {
  const cdp = new Cdp();
  cdp.evaluate = async () => ({ disabled: true, pointerEvents: "none" });
  cdp.call = async () => assert.fail("pointer event dispatched to disabled element");
  await assert.rejects(
    cdp.clickTestId("v4-composer-send"),
    /UI element is disabled or not clickable \(pointer-events: none\): v4-composer-send/,
  );
});

test("authentication and other dialogs are reported without interaction", async () => {
  const visible = (text = "", testId = null) => ({
    innerText: text,
    getAttribute: (k) => (k === "data-testid" ? testId : null),
    getBoundingClientRect: () => ({ width: 10, height: 10 }),
  });
  const inspect = (dialogs, oauth = null) => uiBlocker({
    evaluate: async expression => runInNewContext(expression, { document: {
      querySelectorAll: () => dialogs,
      querySelector: () => oauth,
    } }),
  });
  assert.equal((await inspect([visible("登录已过期")])).code, "authentication_required");
  assert.equal((await inspect([], visible())).code, "authentication_required");
  const generic = await inspect([visible("Update 3.19.1 available", "update-dialog")]);
  assert.equal(generic.code, "dialog_open");
  assert.equal(generic.testId, "update-dialog");
  assert.equal(generic.text, "Update 3.19.1 available");
  assert.match(generic.message, /\[update-dialog\].*Update 3\.19\.1 available/);
  assert.equal(await inspect([]), null);
});

test("Cdp.call rejects immediately instead of hanging 15s when websocket is not open", async () => {
  const cdp = new Cdp();
  assert.equal(cdp.isOpen, false);
  const t0 = Date.now();
  await assert.rejects(
    cdp.call("Runtime.evaluate", { expression: "1" }, 15_000),
    /DevTools websocket is not open/,
  );
  assert.ok(Date.now() - t0 < 500, "closed socket must reject immediately without waiting for timeout");
});
