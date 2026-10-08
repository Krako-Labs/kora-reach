// Focus movement never changes selection or requests job evidence.
export function navigationIndex(key, index, length, modified = false) {
  if (modified || length < 1 || index < 0 || index >= length) return null;
  if (key === "ArrowUp") return Math.max(0, index - 1);
  if (key === "ArrowDown") return Math.min(length - 1, index + 1);
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  return null;
}

export function mountJobList(container, onSelect) {
  const document = container.ownerDocument;
  const cards = new Map();
  const empty = document.createElement("p");
  empty.className = "muted";
  empty.textContent = "No jobs on this node.";
  container.tabIndex = -1;
  container.setAttribute("role", "group");
  container.setAttribute("aria-label", "Jobs");
  container.setAttribute("aria-describedby", "job-keyboard-hint");

  container.addEventListener("keydown", event => {
    const buttons = [...container.querySelectorAll("[data-job-id]")];
    const index = buttons.indexOf(event.target);
    const target = navigationIndex(event.key, index, buttons.length,
      event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing);
    if (target === null) return;
    event.preventDefault();
    buttons[target].focus();
  });

  return {
    render(jobs, selectedId) {
      const active = document.activeElement;
      const ownedFocus = container.contains(active);
      const previous = [...cards.keys()];
      const focusedId = active?.dataset?.jobId;
      const focusedIndex = previous.indexOf(focusedId);
      const ids = new Set(jobs.map(job => job.id));
      for (const [id, card] of cards) {
        if (!ids.has(id)) { card.remove(); cards.delete(id); }
      }
      if (jobs.length) empty.remove();
      jobs.forEach((job, index) => {
        let card = cards.get(job.id);
        if (!card) {
          card = document.createElement("button");
          card.type = "button";
          card.className = "job-card";
          card.dataset.jobId = job.id;
          card.innerHTML = '<span class="row"><span class="job-command"></span><span class="status"></span></span><span class="job-meta"></span>';
          card.addEventListener("click", () => onSelect(job.id));
          cards.set(job.id, card);
        }
        card.classList.toggle("selected", job.id === selectedId);
        if (job.id === selectedId) card.setAttribute("aria-current", "true");
        else card.removeAttribute("aria-current");
        const command = card.querySelector(".job-command");
        if (command.textContent !== job.command) command.textContent = job.command;
        const status = card.querySelector(".status");
        const code = ["running", "succeeded", "failed", "stopped", "interrupted"].includes(job.status) ? job.status : "unknown";
        status.className = "status " + code;
        if (status.textContent !== code) status.textContent = code;
        const meta = card.querySelector(".job-meta");
        const label = (job.cwd ?? "") + " · " + new Date(job.startedAt).toLocaleTimeString();
        if (meta.textContent !== label) meta.textContent = label;
        if (container.children[index] !== card) container.insertBefore(card, container.children[index] ?? null);
      });
      // Map order follows the displayed order, including after server reordering.
      const ordered = jobs.map(job => [job.id, cards.get(job.id)]);
      cards.clear();
      for (const [id, card] of ordered) cards.set(id, card);
      if (!jobs.length && !empty.isConnected) container.append(empty);
      if (ownedFocus && (document.activeElement !== active || !active.isConnected)) {
        const fallback = cards.get(focusedId) ??
          cards.get(jobs[Math.min(Math.max(focusedIndex, 0), jobs.length - 1)]?.id) ?? container;
        fallback.focus({ preventScroll: true });
      }
    },
  };
}
