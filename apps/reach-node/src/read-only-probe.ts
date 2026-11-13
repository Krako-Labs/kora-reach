// A stuck diagnostic is unknown, never proof of access or a safe restart.
// This read-only bound does NOT cancel the underlying adapter call. Callers
// must never use it as an exclusive service-idle or activation guarantee.
export async function boundedReadOnlyProbe<T>(
  probe: () => Promise<T>, deadlineMs = 1_200,
): Promise<T | undefined> {
  if (!Number.isFinite(deadlineMs) || deadlineMs < 1 || deadlineMs > 10_000) {
    throw new Error("Invalid diagnostic deadline");
  }
  return new Promise<T | undefined>(resolve => {
    let settled = false;
    const finish = (value: T | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), deadlineMs);
    timer.unref();
    // Catch both synchronous throws and asynchronous rejections. A late result
    // cannot overwrite the unknown result already reported to the caller.
    void Promise.resolve().then(probe).then(finish, () => finish(undefined));
  });
}
