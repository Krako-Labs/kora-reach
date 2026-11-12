// Exclusive, in-memory, fixture-only maintenance admission contract.
// No HTTP endpoint, live launchd operation, or production-activation authority.
// A snapshot from the current /api/reach/restart-impact (atomicSnapshot:false)
// MUST fail. Real services need a separately integrated, process-owned fence.
export function idleObservationIsComplete(snapshot) {
  return snapshot && typeof snapshot === "object" &&
    snapshot.atomicSnapshot === true &&
    snapshot.idleConfirmed === true &&
    snapshot.activeMcpRequests === 0 &&
    snapshot.backgroundReconciliationActive === false &&
    snapshot.jobInspectionAvailable === true &&
    snapshot.browserInspectionAvailable === true &&
    snapshot.managedBrowser === false &&
    Array.isArray(snapshot.managedProcesses) && snapshot.managedProcesses.length === 0 &&
    Array.isArray(snapshot.durableJobs) && snapshot.durableJobs.length === 0;
}

export class FixtureMaintenanceGate {
  #admissionsClosed = false;
  #inFlight = new Set();

  enterWork() {
    if (this.#admissionsClosed) throw Error("Fixture maintenance admission closed");
    const token = Symbol("fixture-work");
    this.#inFlight.add(token);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#inFlight.delete(token);
    };
  }

  get state() {
    return { admissionsClosed: this.#admissionsClosed, inFlight: this.#inFlight.size };
  }

  async runExclusive(observe, execute, deadlineMs = 1_200) {
    if (this.#admissionsClosed) throw Error("Fixture maintenance lease already held");
    if (typeof observe !== "function" || typeof execute !== "function") {
      throw Error("Fixture maintenance requires inspection and one guarded action");
    }
    if (!Number.isFinite(deadlineMs) || deadlineMs < 1 || deadlineMs > 10_000) {
      throw Error("Invalid fixture maintenance observation deadline");
    }
    // Close admissions synchronously, BEFORE awaiting the external observation.
    this.#admissionsClosed = true;
    try {
      if (this.#inFlight.size !== 0) throw Error("Fixture maintenance active work");
      let timer;
      let observation;
      try {
        // A slow probe must not hold new work indefinitely. Late success cannot
        // authorize a switch after this observation deadline has elapsed.
        observation = await Promise.race([
          Promise.resolve().then(observe).catch(() => undefined),
          new Promise(resolve => { timer = setTimeout(() => resolve(undefined), deadlineMs); }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (this.#inFlight.size !== 0 || !idleObservationIsComplete(observation)) {
        throw Error("Fixture maintenance idle unverified");
      }
      // The caller can run only one fixture transaction before admission reopens.
      return await execute();
    } finally {
      this.#admissionsClosed = false;
    }
  }
}
