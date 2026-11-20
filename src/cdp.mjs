// Minimal Chrome DevTools Protocol client for the ZCode (Electron) renderer.
// Uses Node's built-in WebSocket, so there are no extra dependencies.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ZcodeUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "ZcodeUnavailableError";
  }
}

export async function waitFor(fn, { timeout = 10_000, interval = 200, what = "condition" } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(interval);
  }
}

export class Cdp {
  #ws;
  #id = 0;
  #pending = new Map();

  static async connect(port) {
    let list;
    try {
      list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
    } catch {
      throw new ZcodeUnavailableError(
        `Cannot reach ZCode's debugging port 127.0.0.1:${port}. Start ZCode with ` +
          `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1 (see README).`,
      );
    }
    const page = list.find((t) => t.type === "page" && t.url.includes("renderer/index.html")) ?? list.find((t) => t.type === "page");
    if (!page) throw new ZcodeUnavailableError("ZCode is running but has no open window.");
    const cdp = new Cdp();
    cdp.#ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      cdp.#ws.onopen = resolve;
      cdp.#ws.onerror = () => reject(new ZcodeUnavailableError("Failed to open the ZCode DevTools websocket."));
    });
    cdp.#ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      const p = m.id && cdp.#pending.get(m.id);
      if (p) {
        cdp.#pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      }
    };
    cdp.#ws.onclose = () => {
      for (const p of cdp.#pending.values()) p.reject(new Error("DevTools websocket closed"));
      cdp.#pending.clear();
    };
    return cdp;
  }

  call(method, params = {}, timeout = 15_000) {
    return new Promise((resolve, reject) => {
      const id = ++this.#id;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, timeout);
      this.#pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const r = await this.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("Page script error: " + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result?.value;
  }

  // Real pointer events are required: Radix menus ignore element.click().
  async #clickAt({ x, y }) {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
      await this.call("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
  }

  // `elementExpr` is a JS expression evaluating to a DOM element (or null).
  async clickElement(elementExpr, what) {
    const pt = await this.evaluate(`(() => {
      const e = (${elementExpr});
      if (!e) return null;
      const r = e.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      const blocked = !hit || (hit !== e && !e.contains(hit));
      const blocker = blocked && hit ? {
        tag: (hit.tagName || '').toLowerCase(),
        role: hit.getAttribute?.('role') || null,
        testId: hit.getAttribute?.('data-testid') || null,
        text: (hit.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 80) || null,
      } : null;
      return { x, y, blocked, blocker };
    })()`);
    if (!pt) throw new Error(`UI element not found or not visible: ${what ?? elementExpr}`);
    if (pt.blocked) {
      const b = pt.blocker;
      const detail = b
        ? ` (${b.tag}${b.role ? `[role=${b.role}]` : ""}${b.testId ? `[data-testid=${b.testId}]` : ""}${b.text ? ` "${b.text}"` : ""})`
        : "";
      throw new Error(`UI element is blocked by another element: ${what ?? elementExpr}${detail}. Check for an open dialog or overlay.`);
    }
    await this.#clickAt(pt);
  }

  clickTestId(testId) {
    return this.clickElement(`document.querySelector('[data-testid=${JSON.stringify(testId)}]')`, testId);
  }

  clickText(text) {
    return this.clickElement(
      `[...document.querySelectorAll('button,[role=menuitem],[role=menuitemradio],[role=button],a')]
         .filter(e => (e.innerText || '').trim() === ${JSON.stringify(text)}).pop()`,
      `text "${text}"`,
    );
  }

  hasTestId(testId) {
    return this.evaluate(`(() => { const e = document.querySelector('[data-testid=${JSON.stringify(testId)}]'); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`);
  }

  async pressEscape() {
    for (const type of ["keyDown", "keyUp"])
      await this.call("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  }

  screenshot() {
    return this.call("Page.captureScreenshot", { format: "png" }).then((r) => Buffer.from(r.data, "base64"));
  }

  close() {
    try {
      this.#ws.close();
    } catch {}
  }
}
