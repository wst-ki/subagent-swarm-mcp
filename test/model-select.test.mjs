import { test } from "node:test";
import assert from "node:assert/strict";
import { planModelSelection, resolveProvider } from "../src/model-select.mjs";
import { config, parseProviders } from "../src/config.mjs";

const IND = "account%3Abigmodel-individual-coding-plan";
const START = "account%3Abigmodel-start-plan";
const ALLOWED = [IND, START];

// The real testids from ZCode's model menu (2026-10-25).
const modelItem = (key, model, checked = false) => ({
  testId: `chat-model-select-item-custom:${key}:${model}`,
  role: "menuitemradio",
  checked,
  text: model,
});
const providerItem = (decoded, checked, text) => ({
  testId: `chat-model-select-group-registry-provider:${decoded}`,
  role: "menuitemradio",
  checked,
  text,
});
const trigger = { testId: "chat-model-select-trigger", role: "menuitem", checked: false, text: "GLM-5.3 思考强度" };

test("planModelSelection: the wanted (provider, model) is already checked", () => {
  const plan = planModelSelection(
    [trigger, modelItem(IND, "GLM-5.3", true), modelItem(IND, "GLM-5.3-Flash")],
    { providerKey: IND, model: "GLM-5.3", allowedProviders: ALLOWED },
  );
  assert.equal(plan.status, "already-selected");
  assert.equal(plan.steps, undefined);
  assert.equal(plan.provider, "account:bigmodel-individual-coding-plan");
  assert.equal(plan.testId, `chat-model-select-item-custom:${IND}:GLM-5.3`);
});

test("planModelSelection: same provider, different model → just click the model item", () => {
  const plan = planModelSelection(
    [trigger, modelItem(IND, "GLM-5.3", true), modelItem(IND, "GLM-5.3-Flash")],
    { providerKey: IND, model: "GLM-5.3-Flash", allowedProviders: ALLOWED },
  );
  assert.equal(plan.status, "select");
  assert.deepEqual(plan.steps, [{ action: "click-model", testId: `chat-model-select-item-custom:${IND}:GLM-5.3-Flash` }]);
});

test("planModelSelection: another provider's model is checked → open provider submenu, pick provider, pick model", () => {
  const plan = planModelSelection(
    [trigger, modelItem(IND, "GLM-5.3", true), modelItem(IND, "GLM-5.3-Flash")],
    { providerKey: START, model: "GLM-5.3", allowedProviders: ALLOWED },
  );
  assert.equal(plan.status, "select");
  assert.deepEqual(plan.steps, [
    { action: "open-provider-menu" },
    // provider group testids use the DECODED key, model items the encoded one
    { action: "click-provider", testId: "chat-model-select-group-registry-provider:account:bigmodel-start-plan", provider: "account:bigmodel-start-plan" },
    { action: "click-model", testId: `chat-model-select-item-custom:${START}:GLM-5.3` },
  ]);
});

test("planModelSelection: the same provider given decoded; an open provider submenu is not reopened", () => {
  const plan = planModelSelection(
    [modelItem(IND, "GLM-5.3", true), providerItem("account:bigmodel-individual-coding-plan", true, "BigModel 个人"),
     providerItem("account:bigmodel-start-plan", false, "Start Plan 免费")],
    { providerKey: "account:bigmodel-start-plan", model: "GLM-5.3-Flash", allowedProviders: ALLOWED },
  );
  assert.deepEqual(
    plan.steps.map((s) => s.action),
    ["click-provider", "click-model"],
  );
  assert.equal(plan.steps[1].testId, `chat-model-select-item-custom:${START}:GLM-5.3-Flash`);
});

test("planModelSelection: without an allow-list the key is only normalized (validated earlier)", () => {
  const plan = planModelSelection([modelItem(IND, "GLM-5.3", true)], { providerKey: "account:bigmodel-start-plan", model: "GLM-5.3" });
  assert.equal(plan.status, "select");
  assert.equal(plan.steps.at(-1).testId, `chat-model-select-item-custom:${START}:GLM-5.3`);
});

test("planModelSelection: a provider outside ZCODE_MCP_PROVIDERS is rejected", () => {
  assert.throws(
    () => planModelSelection([], { providerKey: "account%3Asome-personal-api-key", model: "GLM-5.3", allowedProviders: ALLOWED }),
    /not enabled.*bigmodel-individual-coding-plan, account:bigmodel-start-plan/,
  );
  assert.throws(() => resolveProvider("", ALLOWED), /provider key is empty/);
});

test("ZCODE_MCP_PROVIDERS parsing", () => {
  assert.deepEqual(parseProviders(undefined), [IND, START]);
  assert.deepEqual(parseProviders(" a , b ,, "), ["a", "b"]);
  assert.ok(config.allowedProviders.includes(config.providerKey)); // the default route is always allowed
});
