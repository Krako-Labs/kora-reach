export const CONTROL_ERROR_CODES = [
  "BROWSER_NOT_RUNNING", "CDP_UNAVAILABLE", "TAB_NOT_FOUND", "ELEMENT_NOT_FOUND",
  "STALE_ELEMENT", "ELEMENT_NOT_VISIBLE", "ELEMENT_DISABLED", "NAVIGATION_TIMEOUT",
  "ACTION_TIMEOUT", "UNEXPECTED_ORIGIN", "COMPUTER_PERMISSION_DENIED",
  "SCREEN_CAPTURE_UNAVAILABLE", "ACCESSIBILITY_PERMISSION_DENIED",
] as const;

export type ControlErrorCode = (typeof CONTROL_ERROR_CODES)[number];

export class ControlError extends Error {
  constructor(readonly code: ControlErrorCode, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "ControlError";
  }
}

export function controlErrorData(error: unknown): Record<string, unknown> {
  if (error instanceof ControlError) return { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) };
  return { code: "ACTION_TIMEOUT", message: error instanceof Error ? error.message : String(error) };
}
