const conclusions = {
  terminal_verified: ["Completion record verified", "A matching durable result records the shell leader’s completion. Other processes it started may still be running.", "verified"],
  runner_verified: ["Runner responded", "The matching runner reported running during this observation. No durable completion record was found.", "verified"],
  unverified: ["Execution outcome unverified", "The evidence does not establish the execution outcome. Missing or unreachable evidence does not prove the process has stopped.", "uncertain"],
  identity_unavailable: ["Run identity unavailable", "This job has no usable run identity for diagnosis. Its stored status alone cannot verify the original runner.", "uncertain"],
};
const records = {
  matched: ["Identity matched", "The record matches this job and run."],
  missing: ["Not found", "No record was found. Absence does not establish an execution outcome."],
  invalid: ["Invalid record", "The record could not be validated."],
  identity_mismatch: ["Identity mismatch", "The record belongs to a different job or run."],
  unreadable: ["Unreadable", "The record could not be read."],
  unsafe_file: ["Unsafe file rejected", "The record location or file type failed the safety checks."],
  too_large: ["Size limit exceeded", "The record exceeds the bounded read limit."],
  not_checked: ["Not checked", "This record was not needed or could not be checked without run identity."],
};
const probes = {
  not_attempted: ["Not attempted", "No runner request was needed or a matching endpoint was unavailable."],
  running: ["Running response", "The authenticated runner reported running for this job and run."],
  terminal_response: ["Completion response only", "A runner response alone is not durable completion evidence."],
  refused: ["Request refused", "The endpoint refused the request or returned a redirect. No redirect was followed."],
  unreachable: ["Unreachable", "The endpoint could not be reached. This does not prove process exit."],
  timeout: ["Timed out", "The runner did not respond within the deadline. This does not prove process exit."],
  invalid_response: ["Invalid response", "The response could not be validated."],
  identity_mismatch: ["Identity mismatch", "The response did not match this job and run."],
  too_large: ["Response too large", "The response exceeded the bounded read limit."],
};
const statuses = { running: "Running", succeeded: "Succeeded", failed: "Failed", stopped: "Stopped", interrupted: "Interrupted" };
const recoveries = { attached: "Runner attached", terminal: "Terminal recorded", unverified: "Unverified", unavailable: "Unavailable" };
const own = (map, key) => typeof key === "string" && Object.hasOwn(map, key);
function time(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("Invalid observation");
  return new Date(value).toISOString();
}

// Project only known display fields. Never forward raw records, errors or enum values.
export function diagnosticView(body, jobId) {
  const d = body?.diagnostics;
  if (!d || d.version !== 1 || d.jobId !== jobId || d.readOnly !== true ||
      d.atomicSnapshot !== false || d.descendantsVerified !== false ||
      !own(conclusions, d.conclusion) || !own(statuses, d.stored?.status) ||
      !own(recoveries, d.stored?.recovery)) throw new Error("Invalid observation");
  const evidence = [
    ["Execution claim", records, d.evidence?.claim],
    ["Runner endpoint", records, d.evidence?.endpoint],
    ["Durable completion", records, d.evidence?.terminal],
    ["Runner response", probes, d.evidence?.probe],
  ].map(([name, map, code]) => {
    if (!own(map, code)) throw new Error("Invalid observation");
    return { name, label: map[code][0], detail: map[code][1] };
  });
  let terminal = null;
  if (d.conclusion === "terminal_verified") {
    if (d.evidence.terminal !== "matched" || !own(statuses, d.terminal?.status) ||
        !["succeeded", "failed", "stopped"].includes(d.terminal.status) ||
        !(d.terminal.exitCode === null || Number.isSafeInteger(d.terminal.exitCode))) throw new Error("Invalid observation");
    terminal = { status: statuses[d.terminal.status], exit: d.terminal.exitCode === null ? "Not recorded" : String(d.terminal.exitCode), ended: time(d.terminal.endedAt) };
  }
  if (d.conclusion === "runner_verified" && (d.evidence.probe !== "running" || d.evidence.terminal !== "missing")) throw new Error("Invalid observation");
  const [title, description, tone] = conclusions[d.conclusion];
  return { title, description, tone, evidence, terminal,
    stored: statuses[d.stored.status], recovery: recoveries[d.stored.recovery],
    started: time(d.startedAt), observed: time(d.observedAt) };
}

// Selection-scoped, memory-only, single-flight observations. No timers or mutations.
export function createDiagnosticController(load, changed) {
  let scope = null, generation = 0, request = null;
  let state = { open: false, phase: "idle", view: null };
  const emit = () => changed({ ...state, available: Boolean(scope) });
  function cancel() { generation++; request?.abort(); request = null; }
  function select(next) {
    if (scope?.nodeId === next?.nodeId && scope?.jobId === next?.jobId) return;
    cancel(); scope = next; state = { open: false, phase: "idle", view: null }; emit();
  }
  function close() { cancel(); state = { open: false, phase: "idle", view: null }; emit(); }
  async function refresh() {
    if (!scope || request) return;
    const current = scope, ticket = ++generation, controller = new AbortController();
    request = controller; state = { open: true, phase: "loading", view: null }; emit();
    try {
      const body = await load(current.jobId, controller.signal);
      if (ticket !== generation) return;
      state = { open: true, phase: "ready", view: diagnosticView(body, current.jobId) };
    } catch (error) {
      if (ticket !== generation) return;
      state = { open: true, phase: error?.message === "Authentication required" ? "auth" : "error", view: null };
    } finally {
      if (ticket === generation) { request = null; emit(); }
    }
  }
  return { select, close, refresh, reset() { cancel(); scope = null; state = { open: false, phase: "idle", view: null }; emit(); } };
}

export function mountDiagnostics(host, load) {
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
  };
  const bar = node("div", "diagnostic-bar");
  const toggle = node("button", "quiet", "Inspect run evidence");
  toggle.type = "button";
  toggle.setAttribute("aria-controls", "diagnostic-content");
  const badge = node("span", "diagnostic-badge", "READ ONLY · LOCAL");
  bar.append(toggle, badge);
  const content = node("section", "diagnostic-content");
  content.id = "diagnostic-content";
  content.setAttribute("aria-label", "Run evidence");
  const actions = node("div", "diagnostic-actions");
  const heading = node("h2", "", "Run evidence");
  const refresh = node("button", "quiet", "Refresh evidence");
  refresh.type = "button";
  actions.append(heading, refresh);
  const status = node("p", "diagnostic-message");
  status.setAttribute("role", "status");
  const result = node("div", "diagnostic-result");
  content.append(actions, status, result);
  host.replaceChildren(bar, content);
  let expanded = false;
  const controller = createDiagnosticController(load, (state) => {
    host.hidden = !state.available;
    expanded = state.open;
    toggle.textContent = expanded ? "Hide run evidence" : "Inspect run evidence";
    toggle.setAttribute("aria-expanded", String(expanded));
    content.hidden = !expanded;
    // aria-disabled keeps the focused Refresh button stable while loading.
    refresh.setAttribute("aria-disabled", String(state.phase === "loading"));
    result.setAttribute("aria-busy", String(state.phase === "loading"));
    status.textContent = state.phase === "loading" ? "Reading evidence…" :
      state.phase === "auth" ? "Authentication required. Connect with an access token, then inspect again." :
      state.phase === "error" ? "Evidence could not be loaded. Use Refresh evidence to try again." : "";
    result.replaceChildren();
    if (!state.view) return;
    const v = state.view;
    const summary = node("div", "diagnostic-summary " + v.tone);
    summary.append(node("h3", "", v.title), node("p", "", v.description));
    const stored = node("p", "diagnostic-stored", "Stored at request start: " + v.stored + " · " + v.recovery);
    const interval = node("p", "diagnostic-time", "Observation (UTC): " + v.started + " → " + v.observed);
    const list = node("dl", "diagnostic-evidence");
    for (const entry of v.evidence) {
      const row = node("div", "diagnostic-row");
      const detail = node("dd");
      detail.append(node("strong", "", entry.label), node("span", "", entry.detail));
      row.append(node("dt", "", entry.name), detail); list.append(row);
    }
    result.append(summary, stored, interval, list);
    if (v.terminal) result.append(node("p", "diagnostic-terminal",
      "Recorded outcome: " + v.terminal.status + " · Exit code: " + v.terminal.exit + " · Ended (UTC): " + v.terminal.ended));
    result.append(node("p", "diagnostic-limit",
      "This is a point-in-time, non-atomic observation. Background reconciliation may update the job separately. Diagnosis does not change Stop or Retry availability. Preserve uncertain evidence; do not replay a command to resolve uncertainty."));
  });
  toggle.addEventListener("click", () => expanded ? controller.close() : void controller.refresh());
  refresh.addEventListener("click", () => void controller.refresh());
  controller.reset();
  return controller;
}
