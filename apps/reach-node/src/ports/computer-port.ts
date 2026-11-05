export interface ComputerStatus { platform: string; screenRecording: "granted" | "denied" | "unavailable"; accessibility: "granted" | "denied" | "unavailable"; }
export interface ComputerPort {
  status(): Promise<ComputerStatus>;
  screenshot(): Promise<{ data: string; mimeType: "image/png" }>;
  listApps(): Promise<Array<{ name: string; pid: number; active: boolean }>>;
  listWindows(): Promise<Array<{ app: string; title: string; index: number }>>;
  activate(app: string): Promise<void>;
  click(x: number, y: number, count: 1 | 2): Promise<void>;
  scroll(deltaX: number, deltaY: number): Promise<void>;
  type(text: string): Promise<void>;
  press(key: string, modifiers: string[]): Promise<void>;
}
