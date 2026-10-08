const retryable = new Set(["succeeded", "failed", "stopped"]);

export function jobAction(job, local) {
  if (!local || !job || job.recovery === "unverified") return null;
  if (job.status === "running") return { kind: "stop", key: job.id + ":stop", label: "Stop" };
  if (retryable.has(job.status)) return { kind: "retry", key: job.id + ":retry", label: "Retry" };
  return null;
}

export function mountJobSummary(host, onAction) {
  const document = host.ownerDocument;
  const header = document.createElement("div");
  header.className = "job-header";
  const identity = document.createElement("div");
  const title = document.createElement("h1");
  const meta = document.createElement("p");
  identity.append(title, meta);
  const actions = document.createElement("div");
  actions.className = "job-actions";
  actions.setAttribute("aria-label", "Job actions");
  header.append(identity, actions);
  const notice = document.createElement("p");
  notice.setAttribute("role", "status");
  host.replaceChildren(header, notice);
  host.tabIndex = -1;
  host.setAttribute("aria-label", "Selected job details");

  let button = null;
  let actionKey = null;

  function render(job, local) {
    title.textContent = job.command ?? "";
    meta.textContent = (job.cwd ?? "") + " · " + (job.status ?? "") + " · " +
      (job.exitCode == null ? "—" : "exit " + job.exitCode);
    notice.textContent = job.recovery === "unverified"
      ? "Execution outcome unverified. Retry and Stop are unavailable until the original runner can be verified."
      : "";
    notice.hidden = !notice.textContent;

    const next = jobAction(job, local);
    if (next?.key === actionKey && button?.isConnected) return;

    const ownedFocus = document.activeElement === button;
    button?.remove();
    button = null;
    actionKey = null;

    if (next) {
      const current = document.createElement("button");
      current.type = "button";
      current.id = next.kind + "-button";
      current.textContent = next.label;
      current.dataset.action = next.kind;
      current.dataset.jobId = job.id;
      if (next.kind === "stop") current.className = "danger";
      current.addEventListener("click", () => onAction(current.dataset.action, current.dataset.jobId));
      actions.append(current);
      button = current;
      actionKey = next.key;
    }

    // Never transfer focus directly between different mutations.
    if (ownedFocus) host.focus({ preventScroll: true });
  }

  return {
    render,
    reset() {
      const ownedFocus = document.activeElement === button;
      button?.remove();
      button = null;
      actionKey = null;
      if (ownedFocus) host.focus({ preventScroll: true });
    },
  };
}
