export function artifactNavigationIndex(key, index, length, modified = false) {
  if (modified || length < 1 || index < 0 || index >= length) return null;
  if (key === "ArrowUp") return Math.max(0, index - 1);
  if (key === "ArrowDown") return Math.min(length - 1, index + 1);
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  return null;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export function mountArtifactList(container, onSelect) {
  const document = container.ownerDocument;
  const cards = new Map();
  const empty = document.createElement("p");
  empty.className = "muted";
  container.tabIndex = -1;
  container.setAttribute("role", "group");
  container.setAttribute("aria-label", "Artifacts");
  container.setAttribute("aria-describedby", "artifact-keyboard-hint");
  container.replaceChildren();
  let scopeKey = null;

  container.addEventListener("keydown", event => {
    const buttons = [...container.querySelectorAll("[data-artifact-id]")];
    const index = buttons.indexOf(event.target);
    const target = artifactNavigationIndex(event.key, index, buttons.length,
      event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing);
    if (target === null) return;
    event.preventDefault();
    buttons[target].focus();
  });

  function clearCards() {
    for (const card of cards.values()) card.remove();
    cards.clear();
  }

  function select(selectedId) {
    for (const [id, card] of cards) {
      card.classList.toggle("selected", id === selectedId);
      if (id === selectedId) card.setAttribute("aria-current", "true");
      else card.removeAttribute("aria-current");
    }
  }

  return {
    render(artifacts, selectedId, running, nextScopeKey) {
      const active = document.activeElement;
      const ownedFocus = container.contains(active);
      const changedScope = scopeKey !== nextScopeKey;
      const previous = [...cards.keys()];
      const focusedId = active?.dataset?.artifactId;
      const focusedIndex = previous.indexOf(focusedId);

      if (changedScope) {
        clearCards();
        empty.remove();
        scopeKey = nextScopeKey;
      }

      const ids = new Set(artifacts.map(artifact => artifact.id));
      for (const [id, card] of cards) {
        if (!ids.has(id)) { card.remove(); cards.delete(id); }
      }
      if (artifacts.length) empty.remove();

      artifacts.forEach((artifact, index) => {
        let card = cards.get(artifact.id);
        if (!card) {
          card = document.createElement("button");
          card.type = "button";
          card.className = "artifact";
          card.dataset.artifactId = artifact.id;
          card.innerHTML = '<span class="artifact-icon"></span><span class="artifact-name"><strong></strong><span></span></span>';
          card.addEventListener("click", () => onSelect(card.dataset.artifactId));
          cards.set(artifact.id, card);
        }
        card.dataset.revision = String(artifact.revision ?? "");
        card.querySelector(".artifact-icon").textContent = (artifact.previewMode ?? "").slice(0, 4);
        card.querySelector(".artifact-name strong").textContent = artifact.name ?? "";
        card.querySelector(".artifact-name span").textContent =
          (artifact.relativePath ?? "") + " · " + formatBytes(artifact.size ?? 0);
        let live = card.querySelector(".live-dot");
        if (running && !live) {
          live = document.createElement("span");
          live.className = "live-dot";
          live.title = "Live artifact";
          card.append(live);
        } else if (!running) live?.remove();
        if (container.children[index] !== card) container.insertBefore(card, container.children[index] ?? null);
      });

      const ordered = artifacts.map(artifact => [artifact.id, cards.get(artifact.id)]);
      cards.clear();
      for (const [id, card] of ordered) cards.set(id, card);
      select(selectedId);

      if (!artifacts.length) {
        empty.textContent = running ? "Watching for output files…" : "No previewable output files were discovered.";
        if (!empty.isConnected) container.append(empty);
      }
      if (ownedFocus && (changedScope || document.activeElement !== active || !active.isConnected)) {
        const fallback = changedScope ? container : cards.get(focusedId) ??
          cards.get(artifacts[Math.min(Math.max(focusedIndex, 0), artifacts.length - 1)]?.id) ?? container;
        fallback.focus({ preventScroll: true });
      }
    },
    select,
    element(id) {
      return cards.get(id) ?? null;
    },
  };
}
