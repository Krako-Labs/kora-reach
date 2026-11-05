import { AsyncLocalStorage } from "node:async_hooks";
import { ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

export const oauthRequestId = new AsyncLocalStorage<string>();

export class OAuthStorageUnavailable extends ServerError {
  constructor(readonly commitPending = false) {
    super(commitPending ? "OAuth storage commit outcome is pending" : "OAuth storage temporarily unavailable");
  }
}

type Stage = "load" | "wait" | "save" | "commit";

export function logOAuthStage(stage: Stage, outcome: string, startedAt: number): void {
  console.info(JSON.stringify({ event: "oauth_storage", at: new Date().toISOString(),
    requestId: oauthRequestId.getStore(), stage, outcome, durationMs: Math.round(performance.now() - startedAt) }));
}

// The deadline limits the caller's wait. The owner retains its storage lock until
// the underlying I/O settles, including an atomic rename already in progress.
export async function boundedStorage<T>(
  timeoutMs: number, stage: () => Stage, run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const startedAt = performance.now();
  const deadline = setTimeout(() => {
    const current = stage();
    logOAuthStage(current, "timeout", startedAt);
    controller.abort(new OAuthStorageUnavailable(current === "commit"));
  }, timeoutMs);
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => controller.signal.addEventListener("abort",
        () => reject(controller.signal.reason), { once: true })),
      run(controller.signal),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}
