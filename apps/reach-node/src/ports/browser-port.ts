export interface BrowserTab { id: string; title: string; url: string; origin: string; }
export interface BrowserElement { ref: string; role: string; name: string; tag: string; description?: string; }
export interface BrowserSnapshot { tabId: string; generation: number; origin: string; elements: BrowserElement[]; truncated: boolean; }
export interface BrowserStatus { running: boolean; connected: boolean; managed: boolean; profileDirectory?: string; tabs: number; }

export interface BrowserPort {
  start(): Promise<BrowserStatus>;
  status(): Promise<BrowserStatus>;
  stop(terminateManagedBrowser: boolean): Promise<BrowserStatus>;
  close(): Promise<void>;
  listTabs(): Promise<BrowserTab[]>;
  getTab(tabId: string): Promise<BrowserTab>;
  snapshot(tabId: string, maxElements: number): Promise<BrowserSnapshot>;
  screenshot(tabId: string): Promise<{ data: string; mimeType: "image/png" }>;
  navigate(tabId: string, url: string, expectedOrigin?: string): Promise<BrowserTab>;
  act(tabId: string, ref: string, action: "click" | "fill" | "press" | "select" | "get_text" | "get_attribute", value?: string, expectedOrigin?: string): Promise<Record<string, unknown>>;
  waitFor(tabId: string, options: { ref?: string; text?: string; state?: "visible" | "hidden"; timeoutMs: number }): Promise<Record<string, unknown>>;
  history(tabId: string, action: "back" | "forward" | "reload"): Promise<BrowserTab>;
  dialog(tabId: string, action: "accept" | "dismiss", promptText?: string): Promise<Record<string, unknown>>;
}
