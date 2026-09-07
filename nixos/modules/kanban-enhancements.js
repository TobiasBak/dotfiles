(() => {
  "use strict";

  const basePath = location.pathname.startsWith("/kanban") ? "/kanban" : "";
  const apiPath = `${basePath}/_api`;
  const blockedPattern = /<!--\s*blocked\s*:\s*([^|>\n]+?)\s*\|\s*([\s\S]*?)\s*-->/i;
  const blockedPatternGlobal = /<!--\s*blocked\s*:\s*([^|>\n]+?)\s*\|\s*([\s\S]*?)\s*-->/gi;
  let refreshTimer;
  let panState;

  function installStylesheet() {
    if (document.querySelector("link[data-kanban-enhancements]")) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `${basePath}/enhancements.css`;
    link.dataset.kanbanEnhancements = "";
    document.head.append(link);
  }

  function parseBlocked(content) {
    const match = content.match(blockedPattern);
    if (!match) return undefined;
    return { id: match[1].trim(), reason: match[2].trim() };
  }

  function cardFilesByLane(resources) {
    return new Map(
      resources.map((lane) => [
        lane.name,
        new Map(lane.files.map((file) => [file.name, file])),
      ]),
    );
  }

  function updateBlockedBadge(card, blocked) {
    let badge = card.querySelector(".kanban-blocked");
    if (!blocked) {
      badge?.remove();
      return;
    }

    let tags = card.querySelector(".card__tags");
    if (!tags) {
      tags = document.createElement("ul");
      tags.className = "card__tags";
      card.querySelector(".card__toolbar")?.after(tags);
    }

    if (!badge) {
      badge = document.createElement("li");
      badge.className = "tag kanban-blocked";
      badge.tabIndex = 0;
      badge.append(document.createElement("h5"));
      tags.append(badge);
    }

    const label = `${blocked.id} (!)`;
    const accessibleLabel = `Blocked by ${blocked.id}: ${blocked.reason}`;
    const badgeLabel = badge.querySelector("h5");
    if (badgeLabel.textContent !== label) badgeLabel.textContent = label;
    badge.title = blocked.reason;
    badge.setAttribute("aria-label", accessibleLabel);
  }

  function decorateCards(resources) {
    const files = cardFilesByLane(resources);
    document.querySelectorAll('.lanes > [id^="lane-"]').forEach((lane) => {
      const laneName = lane.id.slice("lane-".length);
      const laneFiles = files.get(laneName);
      lane.querySelectorAll('[id^="card-"]').forEach((card) => {
        const cardName = card.id.slice("card-".length);
        const file = laneFiles?.get(cardName);
        const content = file?.content ?? "";
        updateBlockedBadge(card, parseBlocked(content));

        const contentElement = card.querySelector(".card__content");
        if (contentElement?.textContent.includes("<!--")) {
          contentElement.textContent = contentElement.textContent
            .replace(blockedPatternGlobal, "")
            .trim();
        }
      });
    });
  }

  async function refreshCards() {
    try {
      const response = await fetch(`${apiPath}/resource`, { cache: "no-store" });
      if (!response.ok) throw new Error(`resource request returned ${response.status}`);
      decorateCards(await response.json());
    } catch (error) {
      console.error("Kanban enhancements could not refresh cards", error);
    }
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshCards, 100);
  }

  function laneNames() {
    return Array.from(document.querySelectorAll('.lanes > [id^="lane-"]'), (lane) =>
      lane.id.slice("lane-".length),
    );
  }

  function findSettingsControls() {
    const header = document.querySelector("body > div > div > header");
    if (!header) return {};
    const selects = Array.from(header.querySelectorAll("select"));
    const viewMode = selects.find((select) =>
      ["extended", "regular", "compact", "tight"].every((value) =>
        Array.from(select.options).some((option) => option.value === value),
      ),
    );
    const locale = selects.find((select) =>
      ["en", "es"].every((value) =>
        Array.from(select.options).some((option) => option.value === value),
      ),
    );
    const buttons = Array.from(
      header.querySelectorAll(":scope > button:not(.kanban-settings-button)"),
    );
    return {
      header,
      viewMode,
      locale,
      newLane: buttons[0],
      selection: buttons[1],
    };
  }

  function cloneSelect(source, id) {
    const select = document.createElement("select");
    select.id = id;
    for (const sourceOption of source.options) {
      const option = document.createElement("option");
      option.value = sourceOption.value;
      option.textContent = sourceOption.textContent;
      select.append(option);
    }
    select.value = source.value;
    return select;
  }

  function createField(labelText, control) {
    const field = document.createElement("label");
    field.className = "kanban-settings__field";
    const label = document.createElement("span");
    label.textContent = labelText;
    field.append(label, control);
    return field;
  }

  function validateLaneName(value, lanes) {
    const name = value.trim();
    if (!name) return "Enter a lane name";
    if (name.startsWith(".")) return "Lane names cannot start with a dot";
    if (name.toLowerCase() === "_api") return "That name is reserved";
    if (name.toLowerCase().endsWith(".md")) return "Lane names cannot end in .md";
    if (/[<>:%"/\\|?*]/.test(name)) return "Remove reserved filename characters";
    if (lanes.some((lane) => lane.name === name)) return "A lane with that name already exists";
    return "";
  }

  function previewCard(file) {
    const card = document.createElement("div");
    card.className = "kanban-preview__card";
    const name = document.createElement("strong");
    name.textContent = file.name;
    card.append(name);

    const tags = Array.from(file.content.matchAll(/\[tag:([^\]]+)\]/gi), (match) => match[1]);
    const blocked = parseBlocked(file.content);
    if (tags.length || blocked) {
      const metadata = document.createElement("div");
      metadata.className = "kanban-preview__metadata";
      if (tags[0]) {
        const tag = document.createElement("span");
        tag.textContent = tags[0];
        metadata.append(tag);
      }
      if (blocked) {
        const badge = document.createElement("span");
        badge.className = "kanban-preview__blocked";
        badge.textContent = `${blocked.id} (!)`;
        metadata.append(badge);
      }
      card.append(metadata);
    }
    return card;
  }

  function renderPreview(container, draft) {
    container.dataset.viewMode = draft.viewMode;
    const lanes = document.createElement("div");
    lanes.className = "kanban-preview__lanes";
    for (const lane of draft.lanes) {
      const column = document.createElement("article");
      column.className = "kanban-preview__lane";
      const header = document.createElement("header");
      const name = document.createElement("strong");
      name.textContent = lane.name;
      const count = document.createElement("span");
      count.textContent = String(lane.cards.length);
      header.append(name, count);
      const cards = document.createElement("div");
      cards.className = "kanban-preview__cards";
      if (lane.cards.length) {
        cards.append(...lane.cards.slice(0, 3).map(previewCard));
        if (lane.cards.length > 3) {
          const more = document.createElement("small");
          more.textContent = `+${lane.cards.length - 3} more`;
          cards.append(more);
        }
      } else {
        const empty = document.createElement("small");
        empty.textContent = "Empty";
        cards.append(empty);
      }
      column.append(header, cards);
      lanes.append(column);
    }
    container.replaceChildren(lanes);
  }

  function createOrderRow(lane, index, draft, render) {
    const item = document.createElement("li");
    item.className = "kanban-settings__lane";

    const identity = document.createElement("div");
    identity.className = "kanban-settings__lane-identity";
    const label = document.createElement("strong");
    label.textContent = lane.name;
    const detail = document.createElement("small");
    detail.textContent = lane.isNew
      ? "New lane"
      : `${lane.cards.length} ${lane.cards.length === 1 ? "card" : "cards"}`;
    identity.append(label, detail);
    item.append(identity);

    const controls = document.createElement("div");
    controls.className = "kanban-settings__lane-controls";
    const moves = [
      { label: `Move ${lane.name} left`, text: "←", offset: -1 },
      { label: `Move ${lane.name} right`, text: "→", offset: 1 },
    ];
    for (const move of moves) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "small";
      button.textContent = move.text;
      button.title = move.label;
      button.setAttribute("aria-label", move.label);
      button.disabled = index + move.offset < 0 || index + move.offset >= draft.lanes.length;
      button.addEventListener("click", () => {
        const destination = index + move.offset;
        [draft.lanes[index], draft.lanes[destination]] = [
          draft.lanes[destination],
          draft.lanes[index],
        ];
        render();
      });
      controls.append(button);
    }
    if (lane.isNew) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "small kanban-settings__remove-lane";
      remove.textContent = "×";
      remove.title = `Remove ${lane.name}`;
      remove.setAttribute("aria-label", `Remove ${lane.name}`);
      remove.addEventListener("click", () => {
        draft.lanes.splice(index, 1);
        render();
      });
      controls.append(remove);
    }
    item.append(controls);
    return item;
  }

  function applySelectValue(select, value) {
    if (!select || select.value === value) return;
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function saveSettings(draft, controls) {
    for (const lane of draft.lanes.filter((item) => item.isNew)) {
      const response = await fetch(`${apiPath}/resource/${encodeURIComponent(lane.name)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!response.ok) throw new Error(`Creating ${lane.name} returned ${response.status}`);
      lane.isNew = false;
    }

    const [sortResponse, resourceResponse] = await Promise.all([
      fetch(`${apiPath}/sort`, { cache: "no-store" }),
      fetch(`${apiPath}/resource`, { cache: "no-store" }),
    ]);
    if (!sortResponse.ok || !resourceResponse.ok) {
      throw new Error("Could not load the current board order");
    }
    const currentSort = await sortResponse.json();
    const resources = await resourceResponse.json();
    const cards = new Map(
      resources.map((lane) => [lane.name, lane.files.map((file) => file.name)]),
    );
    const nextSort = {};
    for (const lane of draft.lanes) {
      nextSort[lane.name] = Array.isArray(currentSort[lane.name])
        ? currentSort[lane.name]
        : cards.get(lane.name) ?? [];
    }
    const response = await fetch(`${apiPath}/sort`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(nextSort),
    });
    if (!response.ok) throw new Error(`Saving settings returned ${response.status}`);
    applySelectValue(controls.viewMode, draft.viewMode);
    applySelectValue(controls.locale, draft.locale);
  }

  async function openSettings() {
    const controls = findSettingsControls();
    if (!controls.viewMode || !controls.locale) return;
    controls.gear = controls.header.querySelector(".kanban-settings-button");
    controls.gear.disabled = true;
    let resources;
    try {
      const response = await fetch(`${apiPath}/resource`, { cache: "no-store" });
      if (!response.ok) throw new Error(`resource request returned ${response.status}`);
      resources = await response.json();
    } catch (error) {
      console.error("Kanban enhancements could not open settings", error);
      return;
    } finally {
      controls.gear.disabled = false;
    }

    document.querySelector("#kanban-settings")?.remove();
    const dialog = document.createElement("dialog");
    dialog.id = "kanban-settings";
    dialog.className = "kanban-settings";
    const closeDialog = () => {
      controls.gear.setAttribute("aria-expanded", "false");
      if (dialog.open) dialog.close();
      dialog.remove();
    };

    const title = document.createElement("h2");
    title.id = "kanban-settings-title";
    title.textContent = "Board settings";
    dialog.setAttribute("aria-labelledby", title.id);
    const subtitle = document.createElement("p");
    subtitle.textContent = "Changes stay in preview until you save.";
    const heading = document.createElement("div");
    heading.append(title, subtitle);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "kanban-settings__close";
    close.textContent = "×";
    close.title = "Close settings";
    close.setAttribute("aria-label", "Close settings");
    close.addEventListener("click", closeDialog);
    const dialogHeader = document.createElement("header");
    dialogHeader.className = "kanban-settings__header";
    dialogHeader.append(heading, close);

    const resourcesByName = new Map(resources.map((lane) => [lane.name, lane.files]));
    const draft = {
      viewMode: controls.viewMode.value,
      locale: controls.locale.value,
      lanes: laneNames().map((name) => ({
        name,
        isNew: false,
        cards: resourcesByName.get(name) ?? [],
      })),
    };

    const settingsPane = document.createElement("div");
    settingsPane.className = "kanban-settings__controls";

    const appearance = document.createElement("section");
    const appearanceTitle = document.createElement("h3");
    appearanceTitle.textContent = "Appearance";
    const viewMode = cloneSelect(controls.viewMode, "kanban-settings-view-mode");
    const locale = cloneSelect(controls.locale, "kanban-settings-language");
    appearance.append(
      appearanceTitle,
      createField("View mode", viewMode),
      createField("Language", locale),
    );

    const laneSection = document.createElement("section");
    const laneTitle = document.createElement("h3");
    laneTitle.textContent = "Lanes";
    const laneForm = document.createElement("form");
    laneForm.className = "kanban-settings__new-lane";
    const laneInput = document.createElement("input");
    laneInput.placeholder = "Lane name";
    laneInput.setAttribute("aria-label", "New lane name");
    const addLane = document.createElement("button");
    addLane.type = "submit";
    addLane.textContent = "Add";
    laneForm.append(laneInput, addLane);
    const laneError = document.createElement("p");
    laneError.className = "kanban-settings__error";
    laneError.setAttribute("aria-live", "polite");
    const list = document.createElement("ol");
    list.className = "kanban-settings__lanes";
    laneSection.append(laneTitle, laneForm, laneError, list);

    settingsPane.append(appearance, laneSection);

    const previewSection = document.createElement("section");
    previewSection.className = "kanban-settings__preview-section";
    const previewHeading = document.createElement("div");
    previewHeading.className = "kanban-settings__preview-heading";
    const previewTitle = document.createElement("h3");
    previewTitle.textContent = "Preview";
    const previewStatus = document.createElement("small");
    previewStatus.textContent = "Draft";
    previewHeading.append(previewTitle, previewStatus);
    const preview = document.createElement("div");
    preview.className = "kanban-preview";
    previewSection.append(previewHeading, preview);

    const layout = document.createElement("div");
    layout.className = "kanban-settings__layout";
    layout.append(settingsPane, previewSection);

    const actions = document.createElement("div");
    actions.className = "kanban-settings__actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", closeDialog);
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "Save settings";
    save.className = "kanban-settings__save";
    const saveError = document.createElement("p");
    saveError.className = "kanban-settings__save-error";
    saveError.setAttribute("role", "alert");
    actions.append(saveError, cancel, save);
    dialog.append(dialogHeader, layout, actions);
    document.body.append(dialog);

    const render = () => {
      list.replaceChildren(
        ...draft.lanes.map((lane, index) => createOrderRow(lane, index, draft, render)),
      );
      renderPreview(preview, draft);
    };
    render();

    viewMode.addEventListener("change", () => {
      draft.viewMode = viewMode.value;
      renderPreview(preview, draft);
    });
    locale.addEventListener("change", () => {
      draft.locale = locale.value;
    });
    laneForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const error = validateLaneName(laneInput.value, draft.lanes);
      laneError.textContent = error;
      if (error) return;
      draft.lanes.push({ name: laneInput.value.trim(), isNew: true, cards: [] });
      laneInput.value = "";
      render();
      laneInput.focus();
    });

    save.addEventListener("click", async () => {
      save.disabled = true;
      save.textContent = "Saving…";
      saveError.textContent = "";
      try {
        await saveSettings(draft, controls);
        location.reload();
      } catch (error) {
        console.error("Kanban enhancements could not save lane order", error);
        saveError.textContent = "Could not finish saving. Check the board and try again.";
        save.disabled = false;
        save.textContent = "Save settings";
      }
    });

    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) closeDialog();
    });
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeDialog();
    });
    dialog.addEventListener("close", closeDialog);
    controls.gear.setAttribute("aria-expanded", "true");
    dialog.showModal();
  }

  function ensureSettingsButton() {
    const controls = findSettingsControls();
    if (!controls.header) return;
    controls.viewMode?.closest("header > div")?.classList.add("kanban-header-control--settings");
    controls.locale?.closest("header > div")?.classList.add("kanban-header-control--settings");
    controls.newLane?.classList.add("kanban-header-control--settings");
    controls.selection?.classList.add("kanban-header-control--settings");

    let button = controls.header.querySelector(".kanban-settings-button");
    if (button) return;
    button = document.createElement("button");
    button.type = "button";
    button.className = "kanban-settings-button";
    button.innerHTML =
      '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 8.94 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3v-4h.08A1.7 1.7 0 0 0 4.6 8.94a1.7 1.7 0 0 0-.34-1.88L4.2 7l2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.56V3h4v.08A1.7 1.7 0 0 0 15.06 4.6a1.7 1.7 0 0 0 1.88-.34L17 4.2 19.83 7l-.06.06a1.7 1.7 0 0 0-.34 1.88A1.7 1.7 0 0 0 21 10h.08v4H21a1.7 1.7 0 0 0-1.6 1Z"/></svg>';
    button.title = "Board settings";
    button.setAttribute("aria-label", "Board settings");
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-expanded", "false");
    button.addEventListener("click", openSettings);
    controls.header.append(button);
  }

  function ensureSelectionExitButton() {
    const toolbar = document.querySelector(".bulk-operations-toolbar__content");
    if (!toolbar || toolbar.querySelector(".kanban-selection-exit")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className =
      "bulk-operations-toolbar__button bulk-operations-toolbar__button--secondary kanban-selection-exit";
    button.textContent = "Exit selection";
    button.addEventListener("click", () => findSettingsControls().selection?.click());
    toolbar.append(button);
  }

  function handleModifiedCardClick(event) {
    if (!(event.ctrlKey || event.metaKey) || event.button !== 0) return;
    if (event.target.closest("button, input, select, textarea, a")) return;
    const card = event.target.closest('[id^="card-"]');
    const lane = card?.closest('[id^="lane-"]');
    if (!card || !lane) return;

    const selectionToggle = findSettingsControls().selection;
    if (!selectionToggle) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const cardId = card.id;
    const laneId = lane.id;
    if (!document.querySelector(".bulk-operations-toolbar")) selectionToggle.click();
    setTimeout(() => {
      const currentLane = document.getElementById(laneId);
      const currentCard = Array.from(
        currentLane?.querySelectorAll('[id^="card-"]') ?? [],
      ).find((candidate) => candidate.id === cardId);
      currentCard?.click();
      ensureSelectionExitButton();
    }, 0);
  }

  function eventIsInteractive(target) {
    return Boolean(
      target.closest(
        '[id^="card-"], button, input, select, textarea, a, [contenteditable="true"], dialog',
      ),
    );
  }

  function startPan(event, x, y) {
    const lanes = event.target.closest(".lanes");
    if (!lanes) return;
    if (eventIsInteractive(event.target)) {
      if (!event.target.closest('[id^="card-"]')) event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    panState = {
      lanes,
      x,
      y,
      scrollLeft: lanes.scrollLeft,
      scrollTop: lanes.scrollTop,
    };
    lanes.classList.add("kanban-panning");
  }

  function movePan(event, x, y) {
    if (!panState) return;
    event.preventDefault();
    panState.lanes.scrollLeft = panState.scrollLeft - (x - panState.x);
    panState.lanes.scrollTop = panState.scrollTop - (y - panState.y);
  }

  function stopPan() {
    panState?.lanes.classList.remove("kanban-panning");
    panState = undefined;
  }

  document.addEventListener(
    "mousedown",
    (event) => {
      if (event.button === 0) startPan(event, event.clientX, event.clientY);
    },
    true,
  );
  document.addEventListener("mousemove", (event) => movePan(event, event.clientX, event.clientY), true);
  document.addEventListener("mouseup", stopPan, true);
  document.addEventListener(
    "touchstart",
    (event) => {
      if (event.touches.length === 1) {
        startPan(event, event.touches[0].clientX, event.touches[0].clientY);
      }
    },
    { capture: true, passive: false },
  );
  document.addEventListener(
    "touchmove",
    (event) => {
      if (event.touches.length === 1) {
        movePan(event, event.touches[0].clientX, event.touches[0].clientY);
      }
    },
    { capture: true, passive: false },
  );
  document.addEventListener("touchend", stopPan, true);
  document.addEventListener("touchcancel", stopPan, true);
  document.addEventListener("click", handleModifiedCardClick, true);
  document.addEventListener(
    "keydown",
    (event) => {
      if (
        event.key === "Escape" &&
        document.querySelector(".bulk-operations-toolbar") &&
        !document.querySelector("dialog[open], :popover-open")
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        findSettingsControls().selection?.click();
        return;
      }
      if (
        event.altKey &&
        (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
        event.target.closest?.('[id^="lane-"]')
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );

  installStylesheet();
  ensureSettingsButton();
  scheduleRefresh();
  new MutationObserver(() => {
    ensureSettingsButton();
    ensureSelectionExitButton();
    scheduleRefresh();
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
})();
