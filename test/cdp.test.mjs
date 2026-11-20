import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { Cdp } from "../src/cdp.mjs";
import { uiBlocker } from "../src/zcode.mjs";

test("blocked element never dispatches a pointer event", async () => {
  const cdp = new Cdp();
  cdp.evaluate = async () => ({ x: 4, y: 5, blocked: true });
  cdp.call = async () => assert.fail("pointer event dispatched through overlay");
  await assert.rejects(cdp.clickElement("target", "target"), /blocked by another element/);
});

test("authentication and other dialogs are reported without interaction", async () => {
  const visible = (text = "") => ({ innerText: text, getBoundingClientRect: () => ({ width: 10, height: 10 }) });
  const inspect = (dialogs, oauth = null) => uiBlocker({
    evaluate: async expression => runInNewContext(expression, { document: {
      querySelectorAll: () => dialogs,
      querySelector: () => oauth,
    } }),
  });
  assert.equal((await inspect([visible("登录已过期")])).code, "authentication_required");
  assert.equal((await inspect([], visible())).code, "authentication_required");
  assert.equal((await inspect([visible("Other dialog")])).code, "dialog_open");
  assert.equal(await inspect([]), null);
});
