// Only accepts the child handle spawned by this QC run. Never find/kill Chrome by name.
// Chromium routes SIGINT through AttemptExit; SIGTERM uses SessionEnding instead.
export async function stopChromeFixture(child, { timeoutMs = 5000, killWaitMs = 1000 } = {}) {
  const record = (reason, code, signal, forced = false) => ({
    pid: child.pid ?? null, reason, code, signal, forced,
    clean: reason === "requested_exit" && code === 0 && signal === null && !forced,
  });
  if (!child.pid) return record("spawn_failed", child.exitCode, child.signalCode);
  if (child.exitCode !== null || child.signalCode !== null)
    return record("exited_before_cleanup", child.exitCode, child.signalCode);

  return new Promise((resolve) => {
    let timer, killTimer, forced = false, finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      child.off("exit", onExit);
      child.off("error", onError);
      resolve(result);
    };
    const onExit = (code, signal) => finish(record("requested_exit", code, signal, forced));
    const onError = () => finish(record("shutdown_error", child.exitCode, child.signalCode, forced));
    child.once("exit", onExit);
    child.once("error", onError);
    timer = setTimeout(() => {
      forced = true;
      killTimer = setTimeout(() => finish(record("exit_timeout", child.exitCode, child.signalCode, true)), killWaitMs);
      try { child.kill("SIGKILL"); } catch { onError(); }
    }, timeoutMs);
    try { child.kill("SIGINT"); } catch { onError(); }
  });
}
