// Pure decision logic for choosing a model in ZCode's composer menu (no CDP, no DOM): src/zcode.mjs
// reads the menu and executes the returned steps, test/*.test.mjs checks the decisions.
//
// ZCode lists the same model names under several billing routes ("providers"), so picking a model is
// really picking (provider, model). The model items carry the URL-ENCODED provider key
// (`chat-model-select-item-custom:account%3A...:GLM-5.3`), the provider submenu the DECODED one
// (`chat-model-select-group-registry-provider:account:...`).

export const MODEL_ITEM_PREFIX = "chat-model-select-item-";
export const PROVIDER_ITEM_PREFIX = "chat-model-select-group-registry-provider:";

/** Accepts "account%3Abigmodel-start-plan" or "account:bigmodel-start-plan"; returns both forms. */
export function normalizeProviderKey(key) {
  const raw = String(key ?? "").trim();
  if (!raw) throw new Error("provider key is empty");
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw; // a stray "%" — keep it literally rather than failing the whole run
  }
  return { encoded: encodeURIComponent(decoded), decoded };
}

/** Normalize and check the provider against the configured allow-list (never a personal API-key route). */
export function resolveProvider(providerKey, allowedProviders = []) {
  const p = normalizeProviderKey(providerKey);
  const allowed = allowedProviders.map((k) => normalizeProviderKey(k));
  if (!allowed.some((a) => a.encoded === p.encoded))
    throw new Error(`Provider "${p.decoded}" is not enabled. Allowed: ${allowed.map((a) => a.decoded).join(", ")}`);
  return p;
}

/**
 * What to do to get (providerKey, model) selected, given the menu items that are currently visible.
 * Each item is `{ testId, role, checked, text }` (see readMenuItems in src/zcode.mjs); `checked` is
 * the item's aria-checked. `allowedProviders` is the allow-list to enforce (ZCODE_MCP_PROVIDERS);
 * without it the key is only normalized, which is what callers that validated it earlier want.
 *
 * Returns `{ status: "already-selected", ... }` or
 * `{ status: "select", steps: [{action: "open-provider-menu"} | {action: "click-provider"|"click-model", testId}] }`.
 */
export function planModelSelection(menuItems = [], { providerKey, model, allowedProviders = null } = {}) {
  const provider = allowedProviders ? resolveProvider(providerKey, allowedProviders) : normalizeProviderKey(providerKey);
  if (typeof model !== "string" || !model.trim()) throw new Error("model is empty");
  const wanted = `${provider.encoded}:${model}`;
  const itemTestId = `${MODEL_ITEM_PREFIX}custom:${wanted}`;
  const items = (menuItems ?? []).filter((i) => i && typeof i.testId === "string");
  const isWanted = (i) => i.testId.startsWith(MODEL_ITEM_PREFIX) && i.testId.endsWith(wanted);
  const base = { provider: provider.decoded, providerKey: provider.encoded, model, testId: itemTestId };

  const chosen = items.find((i) => isWanted(i) && i.checked === true);
  if (chosen) return { status: "already-selected", ...base, testId: chosen.testId };

  const steps = [];
  if (!items.some(isWanted)) {
    // The wanted model is not in the list — the menu is showing another provider's models.
    if (!items.some((i) => i.testId.startsWith(PROVIDER_ITEM_PREFIX))) steps.push({ action: "open-provider-menu" });
    steps.push({ action: "click-provider", testId: PROVIDER_ITEM_PREFIX + provider.decoded, provider: provider.decoded });
  }
  steps.push({ action: "click-model", testId: itemTestId });
  return { status: "select", ...base, steps };
}
