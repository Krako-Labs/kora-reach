const SECRET_KEY = /(?:pass(?:word)?|otp|one.?time|token|secret|cookie|authorization|auth.?header|session)/i;

export function redactValue(name: string | undefined, value: unknown): unknown {
  return name && SECRET_KEY.test(name) ? "[REDACTED]" : value;
}

export function sanitizeOrigin(input: string): string {
  try { return new URL(input).origin; } catch { return "unknown"; }
}

export function sanitizeUrl(input: string): string {
  try {
    const url = new URL(input); url.username = ""; url.password = "";
    for (const key of [...url.searchParams.keys()]) if (SECRET_KEY.test(key)) url.searchParams.set(key, "[REDACTED]");
    return url.href;
  } catch { return "unknown"; }
}

export function sanitizeAuditValue(value: unknown, key?: string): unknown {
  if (key && SECRET_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value)) return sanitizeOrigin(value);
    return value.length > 240 ? `${value.slice(0, 237)}...` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map(item => sanitizeAuditValue(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, sanitizeAuditValue(v, k)]));
  return value;
}
