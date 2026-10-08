import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { ControlError } from "../control-errors.js";
import { redactValue, sanitizeOrigin, sanitizeUrl } from "../control-redaction.js";
import type { BrowserElement, BrowserPort, BrowserSnapshot, BrowserStatus, BrowserTab } from "../ports/browser-port.js";

interface RefRecipe { selector: string; role: string; name: string; }
type AriaRole = Parameters<Page["getByRole"]>[0];
interface RefState { generation: number; documentToken: string; selectors: Map<string, RefRecipe>; }
interface PendingDialog { type: string; message: string; accept: (text?: string) => Promise<void>; dismiss: () => Promise<void>; }

const PROFILE = path.join(os.homedir(), "Library", "Application Support", "KoraReach", "ChromeProfile");
const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
  path.join(os.homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
];

async function chromeExecutable(): Promise<string> {
  for (const candidate of CHROME_CANDIDATES) {
    try { await access(candidate); return candidate; } catch { /* continue */ }
  }
  throw new ControlError("CDP_UNAVAILABLE", "Google Chrome was not found in a standard macOS location");
}

async function loopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function tab(page: Page, id: string): BrowserTab {
  return { id, title: "", url: sanitizeUrl(page.url()), origin: sanitizeOrigin(page.url()) };
}

function timeoutError(error: unknown, navigation = false): never {
  const message = error instanceof Error ? error.message : String(error);
  if (/Timeout/i.test(message)) throw new ControlError(navigation ? "NAVIGATION_TIMEOUT" : "ACTION_TIMEOUT", message);
  throw error;
}

export class PlaywrightBrowserAdapter implements BrowserPort {
  readonly profileDirectory: string;
  #browser?: Browser;
  #child?: ChildProcess;
  #port?: number;
  #starting?: Promise<BrowserStatus>;
  #tabs = new Map<string, Page>();
  #pageIds = new WeakMap<Page, string>();
  #refs = new Map<string, RefState>();
  #dialogs = new Map<string, PendingDialog>();
  #dialogWaiters = new Map<string, () => void>();
  #nextTab = 1;

  constructor(profileDirectory = PROFILE) { this.profileDirectory = profileDirectory; }

  async start(): Promise<BrowserStatus> {
    if (this.#browser?.isConnected()) return this.status();
    if (this.#child && this.#port) { await this.#ensureConnected(); return this.status(); }
    if (this.#starting) return this.#starting;
    this.#starting = this.#start().finally(() => { this.#starting = undefined; });
    return this.#starting;
  }

  async #start(): Promise<BrowserStatus> {
    const executable = await chromeExecutable();
    this.#port = await loopbackPort();
    this.#child = spawn(executable, [
      `--remote-debugging-port=${this.#port}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${this.profileDirectory}`,
      "--no-first-run", "--no-default-browser-check", "about:blank",
    ], { stdio: "ignore", detached: false });
    this.#child.once("exit", () => { this.#child = undefined; void this.#disconnect(); });
    const deadline = Date.now() + 10_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        this.#browser = await chromium.connectOverCDP(`http://127.0.0.1:${this.#port}`, { timeout: 750 });
        this.#browser.on("disconnected", () => void this.#disconnect());
        this.#rebuildTabs();
        return this.status();
      } catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    this.#child?.kill("SIGTERM");
    throw new ControlError("CDP_UNAVAILABLE", `Managed Chrome did not become ready within 10 seconds: ${lastError instanceof Error ? lastError.message : "unknown error"}`);
  }

  async #disconnect(): Promise<void> { this.#browser = undefined; this.#tabs.clear(); this.#refs.clear(); this.#dialogs.clear(); }

  #rebuildTabs(): void {
    this.#tabs.clear();
    for (const context of this.#browser?.contexts() ?? []) for (const page of context.pages()) this.#admitPage(page);
    for (const context of this.#browser?.contexts() ?? []) context.on("page", page => this.#admitPage(page));
  }

  #admitPage(page: Page): string {
    let id = this.#pageIds.get(page);
    if (!id) { id = `tab-${this.#nextTab++}`; this.#pageIds.set(page, id); }
    this.#tabs.set(id, page);
    page.on("close", () => { this.#tabs.delete(id!); this.#refs.delete(id!); this.#dialogs.delete(id!); });
    page.on("framenavigated", frame => { if (frame === page.mainFrame()) this.#refs.delete(id!); });
    page.on("dialog", dialog => {
      this.#dialogs.set(id!, { type: dialog.type(), message: dialog.message(), accept: text => dialog.accept(text), dismiss: () => dialog.dismiss() });
      this.#dialogWaiters.get(id!)?.(); this.#dialogWaiters.delete(id!);
    });
    return id;
  }

  async #ensureConnected(): Promise<Browser> {
    if (this.#browser?.isConnected()) return this.#browser;
    if (this.#child && this.#port) {
      try {
        this.#browser = await chromium.connectOverCDP(`http://127.0.0.1:${this.#port}`, { timeout: 1500 });
        this.#browser.on("disconnected", () => void this.#disconnect());
        this.#rebuildTabs();
        return this.#browser;
      } catch { /* report below */ }
    }
    throw new ControlError("BROWSER_NOT_RUNNING", "Managed Chrome is not running");
  }

  async #page(tabId: string): Promise<Page> {
    await this.#ensureConnected();
    const page = this.#tabs.get(tabId);
    if (!page || page.isClosed()) throw new ControlError("TAB_NOT_FOUND", `Unknown browser tab: ${tabId}`);
    return page;
  }

  async status(): Promise<BrowserStatus> {
    const connected = Boolean(this.#browser?.isConnected());
    return { running: Boolean(this.#child) || connected, connected, managed: Boolean(this.#child), profileDirectory: this.profileDirectory, tabs: connected ? this.#tabs.size : 0 };
  }

  async stop(terminateManagedBrowser: boolean): Promise<BrowserStatus> {
    const child = this.#child;
    if (terminateManagedBrowser && this.#browser?.isConnected()) await this.#browser.close().catch(() => undefined);
    if (terminateManagedBrowser && this.#child) { this.#child.kill("SIGTERM"); this.#child = undefined; }
    await this.#disconnect();
    if (terminateManagedBrowser && child?.exitCode === null) await Promise.race([new Promise<void>(resolve => child.once("exit", () => resolve())), new Promise<void>(resolve => setTimeout(resolve, 2000))]);
    return this.status();
  }

  async close(): Promise<void> { await this.stop(false); }

  async listTabs(): Promise<BrowserTab[]> {
    const connected = await this.#ensureConnected();
    for (const context of connected.contexts()) for (const page of context.pages()) if (!this.#pageIds.has(page)) this.#admitPage(page);
    return Promise.all([...this.#tabs].map(async ([id, page]) => ({ ...tab(page, id), title: await page.title() })));
  }

  async getTab(tabId: string): Promise<BrowserTab> { const page = await this.#page(tabId); return { ...tab(page, tabId), title: await page.title() }; }

  async snapshot(tabId: string, maxElements: number): Promise<BrowserSnapshot> {
    const page = await this.#page(tabId);
    const snapshotScript = String.raw`(() => {
      const root = document.documentElement;
      if (!root.dataset.krakoDocumentToken) root.dataset.krakoDocumentToken = String(Date.now()) + "-" + String(Math.random());
      const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
      const interactive = 'a[href],button,input,select,textarea,[role],[contenteditable="true"],[tabindex]';
      const all = [...document.querySelectorAll(interactive)].filter(visible);
      return { token: String(root.dataset.krakoDocumentToken || ""), count: all.length, items: all.slice(0, __KRAKO_LIMIT__).map((el, i) => {
        el.setAttribute("data-krako-ref", String(i + 1));
        const h = el; const input = el;
        const role = el.getAttribute("role") || ({ A: "link", BUTTON: "button", INPUT: input.type || "textbox", SELECT: "combobox", TEXTAREA: "textbox" }[el.tagName] ?? el.tagName.toLowerCase());
        const sensitive = /password|otp|one.?time|token|secret/i.test(String(input.type || "") + " " + String(input.name || "") + " " + String(input.autocomplete || ""));
        const name = el.getAttribute("aria-label") || el.getAttribute("title") || (h.innerText || input.placeholder || input.name || "").trim().replace(/\s+/g, " ").slice(0, 160);
        return { selector: '[data-krako-ref="' + String(i + 1) + '"]', role, name: sensitive ? "[REDACTED]" : name, tag: el.tagName.toLowerCase(), description: sensitive ? "sensitive input" : undefined };
      }) };
    })()`;
    const result = await page.evaluate(snapshotScript.replace("__KRAKO_LIMIT__", String(maxElements))) as { token: string; count: number; items: Array<{ selector: string; role: string; name: string; tag: string; description?: string }> };
    const previous = this.#refs.get(tabId); const generation = (previous?.generation ?? 0) + 1;
    const selectors = new Map<string, RefRecipe>();
    const elements: BrowserElement[] = result.items.map((item, index) => { const ref = `e${index + 1}`; selectors.set(ref, { selector: item.selector, role: item.role, name: item.name }); return { ref, role: item.role, name: item.name, tag: item.tag, ...(item.description ? { description: item.description } : {}) }; });
    this.#refs.set(tabId, { generation, documentToken: result.token, selectors });
    return { tabId, generation, origin: sanitizeOrigin(page.url()), elements, truncated: result.count > result.items.length };
  }

  async #resolve(tabId: string, ref: string, expectedOrigin?: string) {
    const page = await this.#page(tabId);
    if (expectedOrigin && sanitizeOrigin(page.url()) !== sanitizeOrigin(expectedOrigin)) throw new ControlError("UNEXPECTED_ORIGIN", `Expected ${sanitizeOrigin(expectedOrigin)}, found ${sanitizeOrigin(page.url())}`);
    const state = this.#refs.get(tabId); if (!state) throw new ControlError("STALE_ELEMENT", "Take a new snapshot before using an element reference");
    const token = await page.evaluate(String.raw`(() => String(document.documentElement.dataset.krakoDocumentToken || ""))()`) as string;
    if (token !== state.documentToken) throw new ControlError("STALE_ELEMENT", "The document changed after this reference was created");
    const recipe = state.selectors.get(ref); if (!recipe) throw new ControlError("ELEMENT_NOT_FOUND", `Unknown element reference: ${ref}`);
    let locator = recipe.name && recipe.name !== "[REDACTED]" ? page.getByRole(recipe.role as AriaRole, { name: recipe.name, exact: true }) : page.locator(recipe.selector);
    if (await locator.count() !== 1) locator = page.locator(recipe.selector);
    if (await locator.count() !== 1) throw new ControlError("STALE_ELEMENT", "The referenced element no longer resolves uniquely");
    return { page, locator };
  }

  async screenshot(tabId: string) { const page = await this.#page(tabId); return { data: (await page.screenshot({ type: "png" })).toString("base64"), mimeType: "image/png" as const }; }

  async navigate(tabId: string, url: string, expectedOrigin?: string): Promise<BrowserTab> {
    const page = await this.#page(tabId); if (expectedOrigin && sanitizeOrigin(url) !== sanitizeOrigin(expectedOrigin)) throw new ControlError("UNEXPECTED_ORIGIN", "Navigation target does not match expected origin");
    try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 }); } catch (error) { timeoutError(error, true); }
    return this.getTab(tabId);
  }

  async act(tabId: string, ref: string, action: "click" | "fill" | "press" | "select" | "get_text" | "get_attribute", value?: string, expectedOrigin?: string): Promise<Record<string, unknown>> {
    const { locator } = await this.#resolve(tabId, ref, expectedOrigin);
    if (!(await locator.isVisible())) throw new ControlError("ELEMENT_NOT_VISIBLE", "Referenced element is not visible");
    if (["click", "fill", "press", "select"].includes(action) && !(await locator.isEnabled())) throw new ControlError("ELEMENT_DISABLED", "Referenced element is disabled");
    try {
      if (action === "click") {
        let dialogOpened!: () => void;
        const opened = new Promise<void>(resolve => { dialogOpened = resolve; });
        this.#dialogWaiters.set(tabId, dialogOpened);
        const clicking = locator.click({ timeout: 10_000 });
        const outcome = await Promise.race([clicking.then(() => "clicked" as const), opened.then(() => "dialog" as const)]);
        this.#dialogWaiters.delete(tabId);
        if (outcome === "dialog") { void clicking.catch(() => undefined); return { ok: true, dialogPending: true }; }
      }
      else if (action === "fill") await locator.fill(value ?? "", { timeout: 10_000 });
      else if (action === "press") await locator.press(value ?? "Enter", { timeout: 10_000 });
      else if (action === "select") await locator.selectOption(value ?? "", { timeout: 10_000 });
      else if (action === "get_text") return { text: (await locator.innerText()).slice(0, 100_000) };
      else return { value: redactValue(value, await locator.getAttribute(value ?? "")) };
    } catch (error) { timeoutError(error); }
    return { ok: true };
  }

  async waitFor(tabId: string, options: { ref?: string; text?: string; state?: "visible" | "hidden"; timeoutMs: number }): Promise<Record<string, unknown>> {
    const page = await this.#page(tabId);
    try {
      if (options.ref) { const { locator } = await this.#resolve(tabId, options.ref); await locator.waitFor({ state: options.state ?? "visible", timeout: options.timeoutMs }); }
      else if (options.text) await page.getByText(options.text, { exact: false }).first().waitFor({ state: options.state ?? "visible", timeout: options.timeoutMs });
      else await page.waitForLoadState("domcontentloaded", { timeout: options.timeoutMs });
    } catch (error) { timeoutError(error); }
    return { ok: true };
  }

  async history(tabId: string, action: "back" | "forward" | "reload"): Promise<BrowserTab> {
    const page = await this.#page(tabId);
    try { if (action === "back") await page.goBack({ timeout: 15_000, waitUntil: "commit" }); else if (action === "forward") await page.goForward({ timeout: 15_000, waitUntil: "commit" }); else await page.reload({ timeout: 15_000, waitUntil: "commit" }); } catch (error) { timeoutError(error, true); }
    return this.getTab(tabId);
  }

  async dialog(tabId: string, action: "accept" | "dismiss", promptText?: string): Promise<Record<string, unknown>> {
    await this.#page(tabId); const dialog = this.#dialogs.get(tabId); if (!dialog) throw new ControlError("ELEMENT_NOT_FOUND", "No pending dialog for this tab");
    this.#dialogs.delete(tabId); if (action === "accept") await dialog.accept(promptText); else await dialog.dismiss();
    return { ok: true, type: dialog.type, message: dialog.message.slice(0, 240) };
  }
}
