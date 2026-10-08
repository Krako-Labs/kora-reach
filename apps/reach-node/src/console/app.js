import { mountDiagnostics } from "./diagnostics.js";
import { mountJobList } from "./job-list.js";
import { mountJobSummary } from "./job-detail.js";
import { formatBytes, mountArtifactList } from "./artifact-list.js";
import { createPreviewLifecycle, previewScopeKey } from "./preview-lifecycle.js";

const $ = (selector) => document.querySelector(selector);
const state = {
  token: sessionStorage.getItem("reach-token") || "",
  nodes: [],
  localNodeId: null,
  selectedNodeId: sessionStorage.getItem("reach-node-id"),
  jobs: [],
  selectedId: null,
  selectedArtifactId: null,
  previewUrl: null,
  previewBlob: null,
};

async function api(path, options = {}) {
  const headers = {
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
    ...options.headers,
  };
  const response = await fetch(`/api/reach${path}`, { ...options, headers });
  if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (response.status === 401) {
    setConnection(false, "Token required");
    $("#token-dialog").showModal();
    throw new Error("Authentication required");
  }
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function selectedNode() {
  return state.nodes.find((node) => node.id === state.selectedNodeId);
}

function scopedJobsPath(suffix = "") {
  return `/nodes/${encodeURIComponent(state.selectedNodeId)}/jobs${suffix}`;
}

function setConnection(online, label) {
  $("#connection-dot").classList.toggle("online", online);
  $("#connection-label").textContent = label;
}

function escapeHtml(value) {
  const span = document.createElement("span");
  span.textContent = value ?? "";
  return span.innerHTML;
}

const previewLifecycle = createPreviewLifecycle();
let previewRenderCleanup = null;

function retirePreviewRender() {
  const cleanup = previewRenderCleanup;
  previewRenderCleanup = null;
  cleanup?.();
}

function revokePreviewBlob() {
  if (state.previewUrl && state.previewBlob) URL.revokeObjectURL(state.previewUrl);
  state.previewBlob = null;
  state.previewUrl = null;
}

function resetPreview() {
  previewLifecycle.invalidate();
  state.selectedArtifactId = null;
  revokePreviewBlob();
  $("#preview-toolbar").hidden = true;
  renderPreviewMessage("idle", "Select an artifact to preview.");
  artifactList?.select(null);
}

let selectionEpoch = 0;
let diagnostics = null;
let jobSummary = null;
function invalidateSelection() {
  selectionEpoch++;
  diagnostics?.reset();
}

function ensureJobView() {
  if ($("#run-evidence")) return;
  $("#job-view").innerHTML = '<div id="job-summary"></div><div id="run-evidence" class="diagnostics" hidden></div><pre class="terminal"></pre>';
  jobSummary = mountJobSummary($("#job-summary"), (action, id) => {
    const request = action === "retry" ? retryJob(id) : action === "stop" ? stopJob(id) : null;
    if (!request) return;
    void request.catch(error => setConnection(false, error.message));
  });
  diagnostics = mountDiagnostics($("#run-evidence"), (id, signal) =>
    api(`/jobs/${encodeURIComponent(id)}/diagnostics`, { method: "GET", cache: "no-store", signal }));
}

function clearSelection(clearJobs = true) {
  invalidateSelection();
  state.selectedId = null;
  if (clearJobs) { state.jobs = []; renderJobs(); }
  resetPreview();
  $("#job-view").className = "job-view empty";
  $("#job-view").innerHTML = '<div class="empty-state"><div class="empty-icon">↗</div><h1>Your work, within reach.</h1><p>Select a job to inspect its logs and output files.</p></div>';
  $("#artifact-count").textContent = "0";
  artifactList.render([], null, false, null);
}

function renderNodes() {
  const select = $("#node-select");
  select.innerHTML = state.nodes.map((node) =>
    `<option value="${escapeHtml(node.id)}">${escapeHtml(node.name)}${node.local ? " · local" : node.connected ? " · connected" : " · reconnect"}</option>`
  ).join("");
  select.value = state.selectedNodeId;
  const node = selectedNode();
  const local = node?.local;
  $("#composer").classList.toggle("remote", !local);
  $("#command").disabled = !local;
  $("#cwd").disabled = !local;
  $("#run-button").disabled = !local;
  $("#new-button").disabled = !local;
  $("#node-mode-label").textContent = local ? `Runs on ${node.name}` : "Remote nodes are read-only";
  setConnection(Boolean(node?.connected), node ? `${node.name} · ${node.connected ? "online" : "reconnect required"}` : "No node");
}

async function refreshNodes() {
  const previousNodeId = state.selectedNodeId;
  const { nodes } = await api("/nodes");
  state.nodes = nodes;
  state.localNodeId = nodes.find((node) => node.local)?.id ?? null;
  if (!nodes.some((node) => node.id === state.selectedNodeId)) state.selectedNodeId = state.localNodeId;
  if (previousNodeId !== state.selectedNodeId) clearSelection();
  sessionStorage.setItem("reach-node-id", state.selectedNodeId || "");
  renderNodes();
}

const jobList = mountJobList($("#job-list"), id => {
  void selectJob(id).catch(error => setConnection(false, error.message));
});

const artifactList = mountArtifactList($("#artifact-list"), id => {
  void selectArtifact(id).catch(error => setConnection(false, error.message));
});

function renderJobs() {
  jobList.render(state.jobs, state.selectedId);
}

async function refreshJobs() {
  try {
    if (!state.selectedNodeId) await refreshNodes();
    const nodeId = state.selectedNodeId, epoch = selectionEpoch;
    const { jobs } = await api(scopedJobsPath());
    if (nodeId !== state.selectedNodeId || epoch !== selectionEpoch) return;
    state.jobs = jobs;
    if (!state.selectedId && state.jobs.length) state.selectedId = state.jobs[0].id;
    if (state.selectedId && !state.jobs.some((job) => job.id === state.selectedId)) {
      clearSelection(false);
      state.selectedId = state.jobs[0]?.id ?? null;
    }
    renderJobs();
    if (state.selectedId) await renderSelected();
    const node = selectedNode();
    setConnection(Boolean(node?.connected), node ? `${node.name} · ${node.connected ? "online" : "reconnect required"}` : "No node");
  } catch (error) {
    if (error.message !== "Authentication required") setConnection(false, error.message);
  }
}

async function selectJob(id) {
  if (id !== state.selectedId) {
    invalidateSelection();
    resetPreview();
    artifactList.render([], null, false, null);
    $("#artifact-count").textContent = "0";
  }
  state.selectedId = id;
  renderJobs();
  await renderSelected();
}

async function renderSelected() {
  const nodeId = state.selectedNodeId, jobId = state.selectedId, epoch = selectionEpoch;
  ensureJobView();
  diagnostics.select(selectedNode()?.local && nodeId === state.localNodeId ? { nodeId, jobId } : null);
  const { job } = await api(scopedJobsPath(`/${jobId}`));
  if (epoch !== selectionEpoch || nodeId !== state.selectedNodeId || jobId !== state.selectedId) return;
  const latest = state.jobs.findIndex((candidate) => candidate.id === job.id);
  if (latest >= 0) state.jobs[latest] = job;
  const local = selectedNode()?.local;
  $("#job-view").classList.remove("empty");
  jobSummary.render(job, local);
  $(".terminal").textContent = job.output || (job.status === "running" ? "Waiting for output…" : "No output");
  if (!job.artifacts.some((artifact) => artifact.id === state.selectedArtifactId)) state.selectedArtifactId = job.artifacts[0]?.id ?? null;
  renderArtifacts(job);
  if (state.selectedArtifactId) {
    const artifact = job.artifacts.find((candidate) => candidate.id === state.selectedArtifactId);
    const key = previewScopeKey(state.selectedNodeId, job.id, artifact);
    if (artifactList.element(artifact.id) && !previewLifecycle.has(key)) await previewArtifact(job, artifact.id);
    else if (artifact) updatePreviewToolbar(job, artifact);
  } else {
    resetPreview();
  }
  const terminal = $(".terminal");
  terminal.scrollTop = terminal.scrollHeight;
}

function renderArtifacts(job) {
  $("#artifact-count").textContent = job.artifacts.length;
  artifactList.render(job.artifacts, state.selectedArtifactId, job.status === "running",
    state.selectedNodeId + ":" + job.id);
}

function inlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/\`([^\`]+)\`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

function markdownToHtml(text) {
  const lines = text.split(/\r?\n/);
  let html = "";
  let listOpen = false;
  let codeOpen = false;
  for (const line of lines) {
    if (line.startsWith("```")) {
      if (listOpen) { html += "</ul>"; listOpen = false; }
      html += codeOpen ? "</code></pre>" : "<pre><code>";
      codeOpen = !codeOpen;
      continue;
    }
    if (codeOpen) { html += `${escapeHtml(line)}\n`; continue; }
    const list = line.match(/^[-*] (.*)$/);
    if (list) {
      if (!listOpen) { html += "<ul>"; listOpen = true; }
      html += `<li>${inlineMarkdown(list[1])}</li>`;
      continue;
    }
    if (listOpen) { html += "</ul>"; listOpen = false; }
    const heading = line.match(/^(#{1,4}) (.*)$/);
    if (heading) {
      const level = heading[1].length;
      html += `<h${level}>${inlineMarkdown(heading[2])}</h${level}>`;
    } else if (line.startsWith("> ")) {
      html += `<blockquote>${inlineMarkdown(line.slice(2))}</blockquote>`;
    } else if (line.trim()) {
      html += `<p>${inlineMarkdown(line)}</p>`;
    }
  }
  if (listOpen) html += "</ul>";
  if (codeOpen) html += "</code></pre>";
  return html;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { cell += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell); cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell); rows.push(row); row = []; cell = "";
      if (rows.length >= 200) break;
    } else cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function csvToHtml(text) {
  const rows = parseCsv(text);
  if (!rows.length) return '<p class="muted">Empty CSV file.</p>';
  return `<table><thead><tr>${rows[0].slice(0, 30).map((cell) => `<th>${escapeHtml(cell)}</th>`).join("")}</tr></thead><tbody>${rows.slice(1).map((row) => `<tr>${row.slice(0, 30).map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

function updatePreviewToolbar(job, artifact) {
  $("#preview-toolbar").hidden = false;
  $("#preview-name").textContent = artifact.name;
  $("#preview-meta").textContent = `${artifact.kind} · ${formatBytes(artifact.size)} · ${new Date(artifact.modifiedAt).toLocaleTimeString()}`;
  $("#preview-live").hidden = job.status !== "running";
  const index = job.artifacts.findIndex((candidate) => candidate.id === artifact.id);
  $("#previous-artifact").disabled = index <= 0;
  $("#next-artifact").disabled = index < 0 || index >= job.artifacts.length - 1;
}

function setPreviewActionsReady(artifact, ready) {
  $("#download-artifact").disabled = !ready;
  $("#open-artifact").disabled = !ready || artifact.previewMode === "html" ||
    artifact.mediaType === "image/svg+xml";
}

function renderPreviewMessage(kind, message, retry = false) {
  retirePreviewRender();
  const preview = $("#preview");
  preview.replaceChildren();
  preview.classList.toggle("preview-loading", kind === "loading");
  preview.setAttribute("aria-busy", kind === "loading" ? "true" : "false");
  if (kind === "error") {
    preview.setAttribute("role", "alert");
    preview.setAttribute("aria-live", "assertive");
  } else if (kind === "loading") {
    preview.setAttribute("role", "status");
    preview.setAttribute("aria-live", "polite");
  } else {
    preview.removeAttribute("role");
    preview.removeAttribute("aria-live");
  }
  const status = document.createElement("div");
  status.className = `preview-state ${kind}`;
  const copy = document.createElement("p");
  copy.textContent = message;
  status.append(copy);
  if (retry) {
    const button = document.createElement("button");
    button.id = "retry-preview";
    button.type = "button";
    button.textContent = "Retry preview";
    button.addEventListener("click", () => { void retryCurrentPreview(); });
    status.append(button);
  }
  preview.append(status);
}

function previewStillCurrent(operation, nodeId, jobId, artifactId, revision) {
  if (!previewLifecycle.isCurrent(operation) || nodeId !== state.selectedNodeId ||
      jobId !== state.selectedId || artifactId !== state.selectedArtifactId) return false;
  const job = state.jobs.find(candidate => candidate.id === jobId);
  const artifact = job?.artifacts.find(candidate => candidate.id === artifactId);
  return artifact?.revision === revision;
}

async function selectArtifact(artifactId) {
  const job = state.jobs.find(candidate => candidate.id === state.selectedId);
  if (!job?.artifacts.some(artifact => artifact.id === artifactId)) return;
  await previewArtifact(job, artifactId);
}

async function retryCurrentPreview() {
  const job = state.jobs.find(candidate => candidate.id === state.selectedId);
  const artifact = job?.artifacts.find(candidate => candidate.id === state.selectedArtifactId);
  if (!job || !artifact) return;
  await previewArtifact(job, artifact.id, { force: true });
}

function completeDirectPreview(operation, nodeId, job, artifact) {
  if (!previewStillCurrent(operation, nodeId, job.id, artifact.id, artifact.revision) ||
      !previewLifecycle.complete(operation, "success")) return;
  retirePreviewRender();
  const preview = $("#preview");
  preview.classList.remove("preview-loading");
  preview.setAttribute("aria-busy", "false");
  preview.removeAttribute("role");
  preview.removeAttribute("aria-live");
  updatePreviewToolbar(job, artifact);
  setPreviewActionsReady(artifact, true);
}

function failDirectPreview(operation, nodeId, job, artifact) {
  if (!previewStillCurrent(operation, nodeId, job.id, artifact.id, artifact.revision) ||
      !previewLifecycle.complete(operation, "error")) return;
  setPreviewActionsReady(artifact, false);
  renderPreviewMessage("error", "Preview unavailable. The artifact was not changed.", true);
}

function recoveryUrl(url, operation) {
  return `${url}&renderAttempt=${operation.generation}`;
}

async function recoverDirectPreview(operation, nodeId, job, artifact, url) {
  if (!previewStillCurrent(operation, nodeId, job.id, artifact.id, artifact.revision)) return;
  if (!previewLifecycle.claimRecovery(operation)) {
    failDirectPreview(operation, nodeId, job, artifact);
    return;
  }
  renderPreviewMessage("loading", `Restoring preview for ${artifact.name}…`);
  try {
    await api("/preview-session", { method: "POST", signal: operation.controller.signal });
    if (!previewStillCurrent(operation, nodeId, job.id, artifact.id, artifact.revision)) return;
    mountDirectPreview(operation, nodeId, job, artifact, url, recoveryUrl(url, operation));
  } catch (error) {
    if (error?.name === "AbortError" ||
        !previewStillCurrent(operation, nodeId, job.id, artifact.id, artifact.revision)) return;
    failDirectPreview(operation, nodeId, job, artifact);
  }
}

function mountDirectPreview(operation, nodeId, job, artifact, baseUrl, mountUrl = baseUrl) {
  if (!previewStillCurrent(operation, nodeId, job.id, artifact.id, artifact.revision)) return;
  retirePreviewRender();
  const preview = $("#preview");
  preview.replaceChildren();
  preview.classList.add("preview-loading");
  preview.setAttribute("aria-busy", "true");
  preview.setAttribute("role", "status");
  preview.setAttribute("aria-live", "polite");

  let element;
  let readyEvent;
  if (artifact.previewMode === "image") {
    element = document.createElement("img");
    element.alt = artifact.name;
    readyEvent = "load";
  } else if (artifact.previewMode === "video" || artifact.previewMode === "audio") {
    element = document.createElement(artifact.previewMode);
    element.controls = true;
    element.autoplay = true;
    element.preload = "metadata";
    readyEvent = "loadedmetadata";
  } else {
    element = document.createElement("iframe");
    element.setAttribute("sandbox", "");
    element.title = artifact.name;
    readyEvent = "load";
  }

  let settled = false;
  const cleanup = () => {
    element.removeEventListener(readyEvent, ready);
    element.removeEventListener("error", failed);
    if (previewRenderCleanup === cleanup) previewRenderCleanup = null;
  };
  const ready = () => {
    if (settled) return;
    settled = true;
    cleanup();
    completeDirectPreview(operation, nodeId, job, artifact);
  };
  const failed = () => {
    if (settled) return;
    settled = true;
    cleanup();
    void recoverDirectPreview(operation, nodeId, job, artifact, baseUrl);
  };
  element.addEventListener(readyEvent, ready);
  element.addEventListener("error", failed);
  previewRenderCleanup = cleanup;
  element.src = mountUrl;
  preview.append(element);
}

async function previewArtifact(job, artifactId, options = {}) {
  const currentJob = state.jobs.find(candidate => candidate.id === state.selectedId);
  const artifact = currentJob?.id === job.id
    ? currentJob.artifacts.find(candidate => candidate.id === artifactId)
    : null;
  if (!artifact) return;
  const nodeId = state.selectedNodeId;
  const jobId = state.selectedId;
  const revision = artifact.revision;
  const key = previewScopeKey(nodeId, jobId, artifact);
  const operation = previewLifecycle.begin(key, options);
  if (!operation) return;
  state.selectedArtifactId = artifactId;
  artifactList.select(artifactId);
  revokePreviewBlob();
  updatePreviewToolbar(currentJob, artifact);
  setPreviewActionsReady(artifact, false);
  renderPreviewMessage("loading", `Loading preview for ${artifact.name}…`);
  const mode = artifact.previewMode;
  const streamsDirectly = ["image", "video", "audio", "pdf", "html"].includes(mode);
  let nextUrl;
  let nextBlob = null;
  try {
    if (streamsDirectly) {
      await api("/preview-session", { method: "POST", signal: operation.controller.signal });
      nextUrl = `/api/reach/preview/${encodeURIComponent(nodeId)}/${encodeURIComponent(jobId)}/${encodeURIComponent(artifactId)}?revision=${encodeURIComponent(revision)}`;
    } else {
      const suffix = `/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(artifactId)}`;
      const response = await fetch(`/api/reach${scopedJobsPath(suffix)}`, {
        headers: state.token ? { Authorization: `Bearer ${state.token}` } : {},
        cache: "no-store",
        signal: operation.controller.signal,
      });
      if (!response.ok) throw new Error("Preview request failed");
      nextBlob = await response.blob();
      nextUrl = URL.createObjectURL(nextBlob);
    }
    let text = null;
    if (!streamsDirectly) text = await nextBlob.text();
    if (!previewStillCurrent(operation, nodeId, jobId, artifactId, revision)) {
      if (nextBlob) URL.revokeObjectURL(nextUrl);
      return;
    }
    if (streamsDirectly) {
      state.previewBlob = null;
      state.previewUrl = nextUrl;
      updatePreviewToolbar(currentJob, artifact);
      mountDirectPreview(operation, nodeId, currentJob, artifact, nextUrl);
      return;
    }
    previewLifecycle.complete(operation, "success");
    state.previewBlob = nextBlob;
    state.previewUrl = nextUrl;
    updatePreviewToolbar(currentJob, artifact);
    setPreviewActionsReady(artifact, true);
    const preview = $("#preview");
    preview.classList.remove("preview-loading");
    preview.setAttribute("aria-busy", "false");
    preview.removeAttribute("role");
    preview.removeAttribute("aria-live");
    if (mode === "markdown") preview.innerHTML = `<article class="rich-document">${markdownToHtml(text)}</article>`;
    else if (mode === "json") {
      let pretty = text;
      try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch {}
      preview.innerHTML = `<pre class="rich-text">${escapeHtml(pretty)}</pre>`;
    } else if (mode === "csv") preview.innerHTML = `<div class="table-wrap">${csvToHtml(text)}</div>`;
    else preview.innerHTML = `<pre class="rich-text">${escapeHtml(text)}</pre>`;
  } catch (error) {
    if (nextBlob && nextUrl) URL.revokeObjectURL(nextUrl);
    if (error?.name === "AbortError" ||
        !previewStillCurrent(operation, nodeId, jobId, artifactId, revision)) return;
    previewLifecycle.complete(operation, "error");
    setPreviewActionsReady(artifact, false);
    renderPreviewMessage("error", "Preview unavailable. The artifact was not changed.", true);
  }
}

function moveArtifact(offset) {
  const job = state.jobs.find((candidate) => candidate.id === state.selectedId);
  if (!job) return;
  const index = job.artifacts.findIndex((artifact) => artifact.id === state.selectedArtifactId);
  const target = job.artifacts[index + offset];
  if (target && artifactList.element(target.id)) void previewArtifact(job, target.id);
}

async function retryJob(id) {
  const { job } = await api(`/jobs/${id}/retry`, { method: "POST" });
  invalidateSelection();
  state.selectedId = job.id;
  resetPreview();
  await refreshJobs();
}

async function stopJob(id) {
  await api(`/jobs/${id}/stop`, { method: "POST" });
  await refreshJobs();
}

$("#composer").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#run-button");
  button.disabled = true;
  try {
    const { job } = await api("/jobs", { method: "POST", body: JSON.stringify({ command: $("#command").value, cwd: $("#cwd").value || undefined }) });
    invalidateSelection();
    state.selectedId = job.id;
    resetPreview();
    $("#command").value = "";
    await refreshJobs();
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = !selectedNode()?.local;
  }
});

$("#node-select").addEventListener("change", async (event) => {
  state.selectedNodeId = event.target.value;
  sessionStorage.setItem("reach-node-id", state.selectedNodeId);
  clearSelection();
  renderNodes();
  await refreshJobs();
});
$("#connect-node-button").addEventListener("click", () => $("#node-dialog").showModal());
$("#node-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = $("#save-node");
  button.disabled = true;
  try {
    const { node } = await api("/nodes/connect", { method: "POST", body: JSON.stringify({ baseUrl: $("#node-url").value, token: $("#node-token").value }) });
    $("#node-token").value = "";
    $("#node-dialog").close();
    await refreshNodes();
    state.selectedNodeId = node.id;
    sessionStorage.setItem("reach-node-id", node.id);
    clearSelection();
    renderNodes();
    await refreshJobs();
  } catch (error) {
    $("#node-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
$("#new-button").addEventListener("click", () => $("#command").focus());
$("#token-button").addEventListener("click", () => { $("#token").value = state.token; $("#token-dialog").showModal(); });
$("#token-form").addEventListener("submit", (event) => {
  event.preventDefault();
  invalidateSelection();
  resetPreview();
  state.token = $("#token").value.trim();
  sessionStorage.setItem("reach-token", state.token);
  $("#token-dialog").close();
  queueMicrotask(() => { void refreshNodes().then(refreshJobs).catch(error => setConnection(false, error.message)); });
});
$("#previous-artifact").addEventListener("click", () => moveArtifact(-1));
$("#next-artifact").addEventListener("click", () => moveArtifact(1));
$("#download-artifact").addEventListener("click", () => {
  if (!state.previewUrl) return;
  const artifact = state.jobs.find((job) => job.id === state.selectedId)?.artifacts.find((candidate) => candidate.id === state.selectedArtifactId);
  const link = document.createElement("a");
  link.href = state.previewUrl;
  link.download = artifact?.name || "artifact";
  link.click();
});
$("#open-artifact").addEventListener("click", () => {
  if (state.previewUrl) window.open(state.previewUrl, "_blank", "noopener,noreferrer");
});

await refreshNodes().then(refreshJobs).catch(error => {
  if (error.message !== "Authentication required") setConnection(false, error.message);
});
// Authentication may be completed later; polling must still be installed.
setInterval(refreshJobs, 1_000);
setInterval(() => {
  if (state.previewUrl && !state.previewBlob) void api("/preview-session", { method: "POST" }).catch(() => undefined);
}, 10 * 60 * 1_000);
