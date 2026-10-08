export function previewScopeKey(nodeId, jobId, artifact) {
  return [nodeId, jobId, artifact.id, artifact.revision].map(value => String(value)).join(":");
}

export function createPreviewLifecycle() {
  let generation = 0;
  let current = null;

  function begin(key, options = {}) {
    if (!options.force && current?.key === key) return null;
    current?.controller.abort();
    const operation = {
      key,
      generation: ++generation,
      controller: new AbortController(),
      status: "loading",
      recoveryClaimed: false,
    };
    current = operation;
    return operation;
  }

  function complete(operation, status) {
    if (!isCurrent(operation)) return false;
    operation.status = status;
    return true;
  }

  function claimRecovery(operation) {
    if (!isCurrent(operation) || operation.status !== "loading" ||
        operation.recoveryClaimed) return false;
    operation.recoveryClaimed = true;
    return true;
  }

  function invalidate() {
    current?.controller.abort();
    generation += 1;
    current = null;
  }

  function isCurrent(operation) {
    return Boolean(operation && current === operation && current.generation === generation);
  }

  function has(key) {
    return current?.key === key;
  }

  function status(key) {
    return current?.key === key ? current.status : null;
  }

  return { begin, complete, claimRecovery, invalidate, isCurrent, has, status };
}
