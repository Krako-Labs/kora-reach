/**
 * In-process admission fence for request and background-reconciliation lifetimes.
 *
 * This is a local synchronization primitive, not a cross-process lock, a
 * persisted maintenance lease, or authority to restart a live service.
 * No user-facing route can acquire exclusive maintenance.
 */
export class ReachRequestAdmissionFence {
  #closed = false;
  #active = new Set<symbol>();
  #uncertainDisconnects = 0;
  readonly #trustedIdleProbe: () => Promise<boolean>;

  constructor(trustedIdleProbe: () => Promise<boolean>) {
    this.#trustedIdleProbe = trustedIdleProbe;
  }

  enter(): (() => void) | undefined {
    if (this.#closed) return undefined;
    const token = Symbol("reach-work");
    this.#active.add(token);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active.delete(token);
    };
  }

  /**
   * An HTTP disconnect does not prove an effect stopped. Hold the fixture
   * maintenance gate closed until independent reconciliation. This counter
   * is intentionally process-local and cannot prove safety after a restart.
   */
  noteUncertainDisconnect(): void {
    this.#uncertainDisconnects++;
  }

  get status(): Readonly<{ admissionsClosed: boolean; active: number; uncertainDisconnects: number }> {
    return {
      admissionsClosed: this.#closed,
      active: this.#active.size,
      uncertainDisconnects: this.#uncertainDisconnects,
    };
  }

  /**
   * Isolated test transaction ONLY. Inspection is caller-supplied and cannot
   * establish live OS/launchd/runner idleness. Never invoke a live upgrade.
   */
  async withExclusiveFixture<T>(
    inspect: () => Promise<boolean>,
    action: () => Promise<T>,
    deadlineMs = 1_200,
  ): Promise<T> {
    // Only isolated Vitest server fixtures may close admissions. This is not
    // an operator interface or permission to update a running installation.
    if (process.env.VITEST !== "true") {
      throw new Error("Reach exclusive fixture disabled outside tests");
    }
    if (this.#closed) throw new Error("Reach admission already held");
    if (typeof inspect !== "function" || typeof action !== "function") {
      throw new Error("Reach fixture inspection and action required");
    }
    if (!Number.isFinite(deadlineMs) || deadlineMs < 1 || deadlineMs > 10_000) {
      throw new Error("Invalid Reach fixture inspection deadline");
    }
    this.#closed = true; // synchronous, before the first await
    try {
      if (this.#active.size || this.#uncertainDisconnects) {
        throw new Error("Reach admission has active or uncertain work");
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      let inspected = false;
      try {
        inspected = await Promise.race([
          // Caller-supplied fixture evidence must never override the actual
          // server's in-process observations. Both must affirm idle.
          Promise.all([
            Promise.resolve().then(inspect),
            Promise.resolve().then(this.#trustedIdleProbe),
          ]).then(([fixtureIdle, serverIdle]) => fixtureIdle === true && serverIdle === true)
            .catch(() => false),
          new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), deadlineMs); }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (!inspected || this.#active.size || this.#uncertainDisconnects) {
        throw new Error("Reach fixture idle unverified");
      }
      return await action();
    } finally {
      this.#closed = false;
    }
  }
}
