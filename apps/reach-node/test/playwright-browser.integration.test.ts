import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlaywrightBrowserAdapter } from "../src/adapters/playwright-browser.js";
import { ControlError } from "../src/control-errors.js";

const suite = process.platform === "darwin" ? describe : describe.skip;

suite.sequential("Playwright managed Chrome adapter", () => {
  let root = ""; let origin = ""; let server: http.Server; let browser: PlaywrightBrowserAdapter; let tabId = "";
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "reach-browser-profile-"));
    server = http.createServer((request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      if (request.url === "/next") { response.end("<title>Next</title><button id='done'>Done</button>"); return; }
      response.end(`<!doctype html><title>Control test</title><input aria-label="Name"><input type="password" value="do-not-expose"><select aria-label="Choice"><option>A</option><option>B</option></select><button id="mutate" onclick="document.body.dataset.changed='yes'">Mutate</button><button id="dialog" onclick="alert('hello')">Dialog</button><a href="/next">Next</a><a href="/next" target="_blank">Popup</a>`);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    browser = new PlaywrightBrowserAdapter(root); await browser.start();
    tabId = (await browser.listTabs())[0]!.id; await browser.navigate(tabId, origin);
  }, 20_000);

  afterAll(async () => {
    await browser?.stop(true).catch(() => undefined);
    await new Promise<void>(resolve => server?.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  it("supports snapshots, form actions, popups, dialogs, navigation, and image screenshots", async () => {
    let snapshot = await browser.snapshot(tabId, 50);
    expect(snapshot.elements.some(element => element.name === "[REDACTED]")).toBe(true);
    const byName = (name: string) => snapshot.elements.find(element => element.name === name)!.ref;
    await browser.act(tabId, byName("Name"), "fill", "Ada");
    snapshot = await browser.snapshot(tabId, 50);
    await browser.act(tabId, snapshot.elements.find(element => element.name === "Choice")!.ref, "select", "B");
    snapshot = await browser.snapshot(tabId, 50);
    await browser.act(tabId, snapshot.elements.find(element => element.name === "Popup")!.ref, "click");
    await browser.waitFor(tabId, { text: "Mutate", state: "visible", timeoutMs: 2000 });
    let tabs = await browser.listTabs();
    for (let attempt = 0; attempt < 20 && tabs.length < 2; attempt += 1) { await new Promise(resolve => setTimeout(resolve, 25)); tabs = await browser.listTabs(); }
    expect(tabs.length).toBeGreaterThanOrEqual(2);
    snapshot = await browser.snapshot(tabId, 50);
    await browser.act(tabId, snapshot.elements.find(element => element.name === "Dialog")!.ref, "click");
    await browser.dialog(tabId, "accept");
    const image = await browser.screenshot(tabId); expect(image.mimeType).toBe("image/png"); expect(Buffer.from(image.data, "base64").subarray(1, 4).toString()).toBe("PNG");
    snapshot = await browser.snapshot(tabId, 50); const next = snapshot.elements.find(element => element.name === "Next")!.ref;
    await browser.act(tabId, next, "click"); await browser.waitFor(tabId, { text: "Done", timeoutMs: 3000 });
    await expect(browser.act(tabId, next, "click")).rejects.toMatchObject({ code: "STALE_ELEMENT" });
    await browser.history(tabId, "back"); await browser.history(tabId, "forward"); await browser.history(tabId, "reload");
  }, 20_000);

  it("enforces expected origins and bounded wait timeouts", async () => {
    await expect(browser.navigate(tabId, `${origin}/next`, "https://example.com")).rejects.toMatchObject({ code: "UNEXPECTED_ORIGIN" });
    await expect(browser.waitFor(tabId, { text: "never-present", timeoutMs: 20 })).rejects.toSatisfy((error: unknown) => error instanceof ControlError && error.code === "ACTION_TIMEOUT");
  });
});
