// High-level operations against the running ZCode desktop app.
import { Cdp, ZcodeUnavailableError, sleep, waitFor } from "./cdp.mjs";
import { config } from "./config.mjs";
import { withUiLock } from "./lock.mjs";
import { MODEL_ITEM_PREFIX, normalizeProviderKey, planModelSelection, resolveProvider } from "./model-select.mjs";
import { findSessionByPrompt, finalAnswer, listSessions, runningSessions, sessionProviderId, sessionRow, taskStatus, tailer } from "./store.mjs";

const norm = (s) => s.replace(/\s+/g, " ").trim();
const FULL_ACCESS = "完全访问";

// Read-only check: do not dismiss authentication dialogs or attempt to log in.
export async function uiBlocker(cdp) {
  return cdp.evaluate(`(() => {
    const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const dialogs = [...document.querySelectorAll('[role=alertdialog],[role=dialog]')].filter(visible);
    if (dialogs.some(e => /登录已过期|login expired|session expired/i.test(e.innerText || '')))
      return { code: 'authentication_required', message: 'ZCode login has expired; sign in in the ZCode window.' };
    const oauthCancel = document.querySelector('[data-testid="oauth-cancel"]');
    if (oauthCancel && visible(oauthCancel))
      return { code: 'authentication_required', message: 'ZCode is on the login screen; complete sign-in in the ZCode window.' };
    if (dialogs.length) return { code: 'dialog_open', message: 'A ZCode dialog is open; inspect it before submitting tasks.' };
    return null;
  })()`);
}

async function withCdp(fn) {
  const cdp = await Cdp.connect(config.cdpPort);
  try {
    return await fn(cdp);
  } finally {
    cdp.close();
  }
}

/** Is a dropdown (menu / listbox) currently open? */
async function menuOpen(cdp) {
  return Boolean(await cdp.evaluate(`!!document.querySelector('[role=menu],[role=listbox]')`));
}

/**
 * Close a dropdown only if one is actually open. Never press Escape blindly: on a running task's
 * page Escape means "interrupt generation" and would silently cancel another task.
 */
async function closeOpenMenu(cdp) {
  if (await menuOpen(cdp)) {
    await cdp.pressEscape();
    await sleep(200);
  }
}

/** Get back to the workspace view (settings pages hide the composer / sidebar). */
async function ensureWorkspace(cdp) {
  if (await cdp.hasTestId("yolo-confirmation-cancel")) {
    await cdp.clickTestId("yolo-confirmation-cancel");
    await sleep(200);
  }
  const blocker = await uiBlocker(cdp);
  if (blocker) throw new ZcodeUnavailableError(blocker.message);
  const inSettings = await cdp.evaluate(
    `[...document.querySelectorAll('button')].some(b => (b.innerText||'').trim() === '返回工作区' && b.getBoundingClientRect().width > 0)`,
  );
  if (inSettings) {
    await cdp.clickText("返回工作区");
    await sleep(600);
  }
  await closeOpenMenu(cdp);
  await waitFor(() => cdp.hasTestId("v4-composer-input").then((v) => v || cdp.hasTestId("task-new-button")), { what: "ZCode workspace view" });
}

/** Switch the composer mode to FULL_ACCESS ("完全访问"), handling 3.18.2's risk confirmation dialog if shown. */
export async function setMode(cdp) {
  const label = () => cdp.evaluate(`document.querySelector('[data-testid="chat-mode-select-trigger"]')?.innerText.trim()`);
  if ((await label()) === FULL_ACCESS) return;
  await cdp.clickTestId("chat-mode-select-trigger");
  await sleep(400);
  await cdp.clickTestId("chat-mode-select-item-yolo");
  await sleep(300);
  if (await cdp.hasTestId("yolo-confirmation-dialog")) {
    try {
      const checked = await cdp.evaluate(
        `document.querySelector('[data-testid="yolo-confirmation-risk"]')?.getAttribute('aria-checked') === 'true'`,
      );
      if (!checked) await cdp.clickTestId("yolo-confirmation-risk");
      await waitFor(
        () => cdp.evaluate(`document.querySelector('[data-testid="yolo-confirmation-confirm"]')?.disabled === false`),
        { timeout: 3000, what: "yolo confirmation button to enable" },
      );
      await cdp.clickTestId("yolo-confirmation-confirm");
    } catch (err) {
      await cdp.clickTestId("yolo-confirmation-cancel").catch(() => {});
      throw err;
    }
  }
  await waitFor(async () => (await label()) === FULL_ACCESS, { timeout: 4000, what: `mode "${FULL_ACCESS}"` });
}

/** Visible menu entries (model items, provider items, …) with the attributes the planner needs. */
function readMenuItems(cdp) {
  return cdp.evaluate(`[...document.querySelectorAll('[role=menuitemradio],[role=menuitem]')]
    .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
    .map(e => ({ testId: e.getAttribute('data-testid') || '', role: e.getAttribute('role') || '',
                 checked: e.getAttribute('aria-checked') === 'true', text: (e.innerText || '').trim().slice(0, 200) }))`);
}

async function openModelMenu(cdp) {
  await cdp.clickTestId("chat-model-select-trigger");
  await sleep(400);
}

/**
 * Select (provider, model) in the composer's model menu. The model trigger's aria-label only names
 * the model, so it cannot tell the two billing routes apart: the menu is always opened and the
 * checked item's testid (`…-custom:<providerKey>:<model>`) is what counts. See planModelSelection.
 */
async function setModel(cdp, model, provider) {
  const opts = { providerKey: provider, model, allowedProviders: config.allowedProviders };
  await closeOpenMenu(cdp); // a stale menu would be toggled shut instead of opened
  await openModelMenu(cdp);
  const plan = planModelSelection(await readMenuItems(cdp), opts);
  for (const step of plan.steps ?? []) {
    if (step.action === "open-provider-menu") {
      await cdp.clickTestId("composer-provider-trigger");
      await sleep(400);
    } else if (step.action === "click-provider") {
      await cdp.clickTestId(step.testId);
      await sleep(400);
      // Some Radix menus close on select; make sure the model list is the one we look at.
      if (!(await menuOpen(cdp))) await openModelMenu(cdp);
      try {
        await waitFor(
          async () => (await readMenuItems(cdp)).some((i) => i.testId.endsWith(`${plan.providerKey}:${model}`)),
          { timeout: 4000, what: `model ${model} of provider ${plan.provider} to appear` },
        );
      } catch {
        await closeOpenMenu(cdp).catch(() => {});
        throw new Error(`Provider ${plan.provider} does not offer model ${model} in ZCode's model menu.`);
      }
    } else if (step.action === "click-model") {
      await cdp.clickElement(`document.querySelector('[data-testid=${JSON.stringify(step.testId)}]')`, `model menu item ${model} (${plan.provider})`);
      await sleep(300);
    }
  }
  await closeOpenMenu(cdp);
  await verifyModel(cdp, plan);
}

/** Confirm on the live menu that (provider, model) is really checked; throws with what ZCode shows instead. */
async function verifyModel(cdp, plan) {
  const wanted = `${plan.providerKey}:${plan.model}`;
  let seen = null;
  try {
    await waitFor(
      async () => {
        await openModelMenu(cdp);
        const items = await readMenuItems(cdp);
        await closeOpenMenu(cdp);
        seen = items.find((i) => i.checked && i.testId.startsWith(MODEL_ITEM_PREFIX)) ?? null;
        return seen?.testId.endsWith(wanted) ? true : null;
      },
      { timeout: 6000, interval: 500, what: `model ${plan.model} on provider ${plan.provider}` },
    );
  } catch {
    await closeOpenMenu(cdp).catch(() => {});
    throw new Error(
      `ZCode did not switch to model ${plan.model} on provider ${plan.provider} ` +
        `(checked model item: ${seen ? `"${seen.testId}"` : "none"}). Refusing to send the prompt; ` +
        `pick the billing route manually in ZCode's model menu and check ZCODE_MCP_PROVIDERS.`,
    );
  }
}

/** providerId ZCode wrote for the session, best effort: it may lag a moment behind the send. */
async function actualProviderId(sid, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const id = sessionProviderId(sid);
      if (id) return id;
    } catch {
      // locked/unreadable db: no provider check rather than a failed run
    }
    if (Date.now() > end) return null;
    await sleep(250);
  }
}

async function typePrompt(cdp, prompt) {
  await cdp.clickTestId("v4-composer-input");
  await cdp.evaluate(`(() => { const e = document.querySelector('[data-testid="v4-composer-input"]'); e.focus(); const range = document.createRange(); range.selectNodeContents(e); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); })()`);
  await cdp.call("Input.insertText", { text: prompt });
  await waitFor(
    async () => norm((await cdp.evaluate(`document.querySelector('[data-testid="v4-composer-input"]')?.innerText ?? ''`)) || "") === norm(prompt),
    { timeout: 5000, what: "prompt to appear in the composer" },
  ).catch(() => {
    throw new Error("The prompt did not land in ZCode's input box correctly; aborting before sending.");
  });
}

async function clearComposer(cdp) {
  await cdp
    .evaluate(`(() => { const e = document.querySelector('[data-testid="v4-composer-input"]'); if (e) { e.focus(); const range = document.createRange(); range.selectNodeContents(e); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); document.execCommand('delete'); } })()`)
    .catch(() => {});
}

function assertCapacity() {
  const running = runningSessions();
  if (running.length >= config.maxRunning)
    throw new Error(`ZCode already has ${running.length} running task(s) (limit ${config.maxRunning}). Wait for one to finish (zcode_wait) and retry.`);
}

/** Start a new task in the subagent project. Resolves once ZCode has accepted it. */
export async function runTask({ prompt, model, provider }) {
  if (!prompt?.trim()) throw new Error("prompt is empty");
  if (prompt.length > config.maxPromptChars) throw new Error(`prompt too long (${prompt.length} > ${config.maxPromptChars} chars)`);
  model ??= config.defaultModel;
  if (!config.allowedModels.includes(model)) throw new Error(`Model "${model}" is not enabled. Allowed: ${config.allowedModels.join(", ")}`);
  // Billing route: defaults to ZCODE_MCP_PROVIDER, must be one of ZCODE_MCP_PROVIDERS.
  const route = resolveProvider(provider ?? config.providerKey, config.allowedProviders);

  return withUiLock(() =>
    withCdp(async (cdp) => {
      assertCapacity(); // inside the lock so concurrent submitters can't both squeeze past the limit
      await ensureWorkspace(cdp);
      // New task in the configured project (found by its sidebar label).
      await cdp.clickElement(
        `(() => { let n = [...document.querySelectorAll('[data-testid="virtual-project-toggle"]')].find(t => t.innerText.trim() === ${JSON.stringify(config.projectName)});
                  for (let i = 0; n && i < 6; i++) { n = n.parentElement; const b = n?.querySelector('[data-testid="virtual-project-create-task"]'); if (b) return b; }
                  return null; })()`,
        `"new task" button of project "${config.projectName}"`,
      );
      await waitFor(() => cdp.hasTestId("v4-composer-input"), { what: "new task composer" });
      await sleep(400);
      const project = await cdp.evaluate(`document.querySelector('[data-testid="composer-workspace-trigger"]')?.innerText.trim()`);
      if (project !== config.projectName)
        throw new Error(`New task opened in project "${project}", expected "${config.projectName}". Refusing to send.`);

      await setMode(cdp);
      await setModel(cdp, model, route.encoded);
      await typePrompt(cdp, prompt);

      const t0 = Date.now();
      try {
        await cdp.clickTestId("v4-composer-send");
      } catch (e) {
        await clearComposer(cdp);
        throw e;
      }
      let sid;
      try {
        sid = await waitFor(
          async () => {
            const found = findSessionByPrompt(prompt, t0 - 3000);
            if (found) return found;
            if (await cdp.hasTestId("start-plan-recommendation-dialog")) {
              if (route.decoded === "account:bigmodel-start-plan") {
                await cdp.clickTestId("confirm-dialog-confirm");
              } else {
                await cdp
                  .evaluate(`(() => { const cb = document.querySelector('[data-testid="start-plan-recommendation-dialog"] [role="checkbox"]'); if (cb && cb.getAttribute('aria-checked') === 'false') cb.click(); })()`)
                  .catch(() => {});
                await sleep(100);
                await cdp.clickElement(
                  `[...document.querySelectorAll('[data-testid="start-plan-recommendation-dialog"] button')].find(b => (b.innerText||'').trim() === '不了')`,
                  `decline start-plan switch ("不了")`,
                );
              }
              await sleep(300);
            }
            return null;
          },
          { timeout: 30_000, interval: 400, what: "ZCode to create the session" },
        );
      } catch {
        throw new Error("The send button was clicked, but no matching new session was found in ZCode's database. The outcome is uncertain; inspect the composer and zcode_list before retrying to avoid duplicates.");
      }
      const row = sessionRow(sid);
      const out = { taskId: sid, model, provider: route.decoded, project: config.projectName, directory: row?.directory ?? null, mode: FULL_ACCESS };
      // The menu can lie (a run once went to another billing route); the session's own record cannot.
      const actual = await actualProviderId(sid);
      if (actual && normalizeProviderKey(actual).encoded !== route.encoded)
        out.warning = `ZCode is running this session on provider "${actual}" instead of the requested "${route.decoded}". The prompt was sent anyway; check the run's billing.`;
      return out;
    }),
  );
}

/** Send a follow-up message to an existing (finished) task. */
export async function followUp({ taskId, prompt }) {
  if (!prompt?.trim()) throw new Error("prompt is empty");
  const st = taskStatus(taskId);
  if (st.status === "unknown") throw new Error(`Unknown task ${taskId}`);
  if (st.status === "running" || st.status === "starting") throw new Error(`Task ${taskId} is still ${st.status}; wait for it to finish first.`);

  return withUiLock(() =>
    withCdp(async (cdp) => {
      assertCapacity();
      await ensureWorkspace(cdp);
      await cdp.clickTestId(`task-item-${taskId}`).catch(() => {
        throw new Error(`Task ${taskId} is not in ZCode's sidebar (archived?). Start a new task instead.`);
      });
      await waitFor(() => cdp.hasTestId("v4-composer-input"), { what: "task composer" });
      await sleep(500);
      await setMode(cdp);
      await typePrompt(cdp, prompt);
      const before = (tailer.refresh(), tailer.sessions.get(taskId)?.turns.size ?? 0);
      try {
        await cdp.clickTestId("v4-composer-send");
      } catch (e) {
        await clearComposer(cdp);
        throw e;
      }
      await waitFor(() => (tailer.refresh(), (tailer.sessions.get(taskId)?.turns.size ?? 0) > before), {
        timeout: 30_000,
        interval: 400,
        what: "ZCode to start the follow-up turn",
      });
      return { taskId, accepted: true };
    }),
  );
}

/** Stop a running task via the UI's stop button. */
export async function cancelTask(taskId) {
  const st = taskStatus(taskId);
  if (st.status !== "running") return { ...st, cancelled: false, note: `Task is ${st.status}; nothing to cancel.` };
  return withUiLock(() =>
    withCdp(async (cdp) => {
      await ensureWorkspace(cdp);
      await cdp.clickTestId(`task-item-${taskId}`).catch(() => {
        throw new Error(`Task ${taskId} is not in ZCode's sidebar; cannot cancel from the UI.`);
      });
      await waitFor(() => cdp.hasTestId("v4-stop"), { timeout: 5000, what: "stop button" }).catch(() => {
        throw new Error("The stop button is not visible; the task may have just finished.");
      });
      await cdp.clickTestId("v4-stop");
      const final = await waitFor(
        () => {
          const s = taskStatus(taskId);
          return s.status !== "running" ? s : null;
        },
        { timeout: 20_000, interval: 500, what: "task to stop" },
      );
      return { ...final, cancelled: final.status === "cancelled" };
    }),
  );
}

export function getResult(taskId) {
  const status = taskStatus(taskId);
  const out = { ...status };
  if (status.status === "completed" || status.status === "failed" || status.status === "cancelled") {
    const ans = finalAnswer(taskId);
    out.result = ans.text;
    out.model = ans.model;
    if (ans.allText.length > 1) out.earlierMessages = ans.allText.slice(0, -1);
  }
  return out;
}

export function listTasks(limit = 15) {
  tailer.refresh();
  return listSessions(config.projectDir, limit).map((s) => {
    const st = taskStatus(s.id);
    return { taskId: s.id, title: s.title || null, status: st.status, createdAt: new Date(s.time_created).toISOString() };
  });
}

export async function health() {
  const out = { ok: false, project: config.projectName, projectDir: config.projectDir, models: config.allowedModels, maxRunning: config.maxRunning };
  try {
    await withCdp(async (cdp) => {
      out.cdp = true;
      out.zcodeVersion = await cdp.evaluate("navigator.userAgent.match(/ZCode\\/([\\d.]+)/)?.[1] ?? null");
      out.blocker = await uiBlocker(cdp);
      out.projectVisible = await cdp.evaluate(
        `[...document.querySelectorAll('[data-testid="virtual-project-toggle"]')].some(t => t.innerText.trim() === ${JSON.stringify(config.projectName)})`,
      );
    });
  } catch (e) {
    out.cdp = false;
    out.error = e.message;
    return out;
  }
  out.runningTasks = runningSessions().length;
  out.ok = Boolean(out.projectVisible && !out.blocker);
  if (out.blocker) out.error = out.blocker.message;
  else if (!out.projectVisible) out.error = `Project "${config.projectName}" not found in ZCode's sidebar.`;
  return out;
}

export { ZcodeUnavailableError };
