/**
 * The AI settings panel.
 *
 * Provider choice, API key, endpoint override and model selection for the AI
 * council. Saving applies live through the daemon's runtime override, so a
 * change takes effect on the next tick without restarting anything.
 *
 * The key is write-only from here: the backend reports only a mask, and a blank
 * field means "keep the stored key" rather than "clear it".
 *
 * The model picker is a real list rather than a `<datalist>`. OpenRouter alone
 * offers several hundred models and a datalist gives you no way to see what you
 * are choosing between, no way to narrow it, and no way to tell a free model
 * from one that bills per token — which is the single distinction most people
 * are actually trying to make.
 */
import { el, mount } from "./dom.js";
import { getPassword } from "./api.js";
import { toast } from "./toast.js";

/**
 * The providers on offer, and where each one lives.
 *
 * `baseUrl` mirrors `defaultBaseUrlFor` on the server and exists so that
 * changing the dropdown can reset the endpoint. Without it the field kept
 * whatever the *previous* provider used, and a saved configuration could name
 * one provider while pointing at another's URL — which is exactly how an
 * OpenCode key ended up being posted to openrouter.ai, failing every request
 * while the settings panel looked correctly filled in.
 *
 * `custom` has no default on purpose: its whole point is an endpoint we do not
 * know, so there is nothing to reset to and the operator's value stands.
 */
const PROVIDERS = [
  { value: "openrouter", label: "OpenRouter", needsKey: true, baseUrl: "https://openrouter.ai/api/v1" },
  { value: "anthropic", label: "Anthropic (Claude)", needsKey: true, baseUrl: "https://api.anthropic.com" },
  { value: "openai", label: "OpenAI", needsKey: true, baseUrl: "https://api.openai.com/v1" },
  { value: "gemini", label: "Google Gemini", needsKey: true, baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { value: "ollama", label: "Ollama (local)", needsKey: false, baseUrl: "http://127.0.0.1:11434/v1" },
  // One OpenCode entry, not two. Zen and Go are the same account and the same
  // key; offering both let a key be aimed at a tier it was not entitled to and
  // report back as a dead endpoint. Zen is the tier kept — see providers.ts.
  { value: "opencode-zen", label: "OpenCode", needsKey: true, baseUrl: "https://opencode.ai/zen/v1" },
  { value: "custom", label: "Custom endpoint", needsKey: false, baseUrl: "" },
];

/** The official endpoint for a provider, or "" when it has none to suggest. */
export function defaultBaseUrl(providerId) {
  return PROVIDERS.find((p) => p.value === providerId)?.baseUrl ?? "";
}

/** Longest list we will draw at once. Past this, narrow it with the search. */
const MAX_ROWS = 200;

async function dash(path, body) {
  const response = await fetch(`/api/dash/${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", authorization: getPassword() ?? "" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`);
  return payload;
}

/**
 * Models matching the current filters.
 *
 * Pure, and exported so the matching rules can be tested without a browser:
 * the search reads the id, the name and the description, because people look
 * for models by all three ("haiku", "Claude Haiku", "fast and cheap").
 */
export function filterModels(models, { search = "", freeOnly = false } = {}) {
  const needle = search.trim().toLowerCase();

  return models.filter((model) => {
    if (freeOnly && !model.free) return false;
    if (!needle) return true;

    return `${model.id} ${model.name} ${model.description}`.toLowerCase().includes(needle);
  });
}

/** "131072" -> "131K", so a row can carry the context length without shouting. */
export function shortContext(length) {
  if (!length || !Number.isFinite(length)) return "";
  if (length >= 1_000_000) return `${Math.round(length / 100_000) / 10}M`;

  return length >= 1000 ? `${Math.round(length / 1000)}K` : String(length);
}

export async function renderAiSettings(container) {
  let saved = null;
  try {
    saved = (await dash("ai-settings")).saved;
  } catch {
    // The form still works without a stored configuration.
  }

  const status = el("div", { class: "ais-status muted" });
  const providerSelect = el("select", { class: "input", "aria-label": "Provider" }, [
    el("option", { value: "", text: "Choose a provider…" }),
    ...PROVIDERS.map((p) => el("option", { value: p.value, text: p.label })),
  ]);
  const keyInput = el("input", {
    class: "input",
    type: "password",
    autocomplete: "off",
    placeholder: "API key",
    "aria-label": "API key",
  });
  const baseUrlInput = el("input", {
    class: "input",
    type: "text",
    autocomplete: "off",
    placeholder: "Base URL (optional — defaults to the official endpoint)",
    "aria-label": "Base URL",
  });
  const modelInput = el("input", {
    class: "input",
    type: "text",
    autocomplete: "off",
    role: "combobox",
    "aria-expanded": "false",
    "aria-controls": "ai-model-list",
    placeholder: "Model — fetch the list, or type an id",
    "aria-label": "Model",
  });
  const message = el("div", { class: "ais-message", role: "status" });

  // ---- Model picker state ----

  /** Everything the provider offers, as fetched. */
  let catalog = [];
  let freeOnly = false;
  let open = false;
  /** Keyboard cursor into the currently visible rows. -1 means "none". */
  let active = -1;

  const searchInput = el("input", {
    class: "input input--sm",
    type: "search",
    autocomplete: "off",
    placeholder: "Search models…",
    "aria-label": "Search models",
  });

  const freeChip = el("button", {
    class: "chip chip--filter",
    type: "button",
    "aria-pressed": "false",
    title: "Show only models that cost nothing",
  });

  const listNode = el("div", {
    class: "ais-list",
    id: "ai-model-list",
    role: "listbox",
    "aria-label": "Available models",
  });

  const picker = el("div", { class: "ais-picker", hidden: true }, [
    el("div", { class: "ais-filters" }, [searchInput, freeChip]),
    listNode,
  ]);

  const toggle = el("button", {
    class: "btn btn--icon ais-toggle",
    type: "button",
    title: "Show the model list",
    "aria-label": "Show the model list",
    text: "▾",
  });

  const say = (text, isError) => {
    message.textContent = text;
    message.classList.toggle("ais-message--error", Boolean(isError));
  };

  const visible = () => filterModels(catalog, { search: searchInput.value, freeOnly });

  const choose = (model) => {
    modelInput.value = model.id;
    setOpen(false);
    say(`${model.name}${model.free ? " — free" : ""}`);
  };

  function drawList() {
    const rows = visible();
    const freeCount = catalog.filter((model) => model.free).length;

    freeChip.textContent = catalog.length ? `Free · ${freeCount}` : "Free";
    freeChip.setAttribute("aria-pressed", String(freeOnly));
    freeChip.dataset.on = String(freeOnly);

    if (catalog.length === 0) {
      return mount(listNode, el("div", { class: "ais-empty", text: "Fetch models to pick from a list, or type an id." }));
    }

    if (rows.length === 0) {
      // Say which filter emptied it. "No results" leaves you guessing whether
      // the provider has none or your search was simply too narrow.
      const reason = freeOnly
        ? searchInput.value.trim()
          ? `No free model matches “${searchInput.value.trim()}”.`
          : "This provider offers no free models."
        : `No model matches “${searchInput.value.trim()}”.`;

      return mount(listNode, el("div", { class: "ais-empty", text: reason }));
    }

    const shown = rows.slice(0, MAX_ROWS);

    mount(
      listNode,
      ...shown.map((model, index) =>
        el(
          "button",
          {
            class: "ais-option",
            type: "button",
            role: "option",
            "aria-selected": String(index === active),
            dataset: { active: String(index === active) },
            onclick: () => choose(model),
          },
          [
            el("div", { class: "ais-option__main" }, [
              el("span", { class: "ais-option__name", text: model.name }),
              model.free ? el("span", { class: "chip chip--free", text: "Free" }) : null,
              model.contextLength ? el("span", { class: "ais-option__ctx", text: shortContext(model.contextLength) }) : null,
            ]),
            el("div", { class: "ais-option__id", text: model.id }),
          ],
        ),
      ),
      shown.length < rows.length
        ? el("div", { class: "ais-empty", text: `${rows.length - shown.length} more — narrow the search to see them.` })
        : null,
    );

    listNode.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }

  function setOpen(next) {
    open = next;
    picker.hidden = !next;
    toggle.textContent = next ? "▴" : "▾";
    modelInput.setAttribute("aria-expanded", String(next));
    if (next) drawList();
  }

  const move = (delta) => {
    const rows = visible();
    if (rows.length === 0) return;

    active = (active + delta + rows.length) % rows.length;
    drawList();
  };

  searchInput.addEventListener("input", () => {
    active = -1;
    drawList();
  });

  freeChip.addEventListener("click", () => {
    freeOnly = !freeOnly;
    active = -1;
    drawList();
  });

  toggle.addEventListener("click", () => setOpen(!open));

  // Typing in the model field is always allowed — an id the provider does not
  // list (a brand new model, a private deployment) must still be configurable.
  modelInput.addEventListener("focus", () => {
    if (catalog.length > 0) setOpen(true);
  });

  const onKeys = (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!open && catalog.length > 0) setOpen(true);
      event.preventDefault();
      move(event.key === "ArrowDown" ? 1 : -1);
      return;
    }

    if (event.key === "Enter" && open && active >= 0) {
      event.preventDefault();
      const rows = visible();
      if (rows[active]) choose(rows[active]);
      return;
    }

    // Escape closes the list without closing the drawer behind it.
    if (event.key === "Escape" && open) {
      event.stopPropagation();
      setOpen(false);
    }
  };

  modelInput.addEventListener("keydown", onKeys);
  searchInput.addEventListener("keydown", onKeys);

  // ---- Form actions ----

  const currentProvider = () => providerSelect.value;

  const payload = () => ({
    provider: currentProvider(),
    apiKey: keyInput.value.trim(),
    baseUrl: baseUrlInput.value.trim(),
  });

  // A different provider offers a different catalogue; keeping the old one on
  // screen would invite picking a model the new provider has never heard of.
  //
  // The endpoint and the model id go with it. Leaving either behind is how a
  // configuration ends up internally inconsistent — one provider's name, another
  // provider's URL — and the failure that produces is a flat refusal on every
  // completion with nothing on screen to suggest why.
  providerSelect.addEventListener("change", () => {
    catalog = [];
    active = -1;
    setOpen(false);
    drawList();

    baseUrlInput.value = defaultBaseUrl(currentProvider());
    modelInput.value = "";
  });

  // Reflect the saved configuration into the form.
  if (saved && saved.provider && saved.provider !== "none") {
    providerSelect.value = saved.provider;
    modelInput.value = saved.model ?? "";
    if (saved.baseUrl) baseUrlInput.value = saved.baseUrl;
    keyInput.placeholder = saved.keyMasked ? `Stored key: ${saved.keyMasked}` : "API key";
    status.textContent = `Current: ${saved.provider} · ${saved.model}`;
  } else if (saved && saved.provider === "none") {
    status.textContent = "The AI council is currently disabled.";
  } else {
    status.textContent = "No AI provider configured yet — the council runs deterministic-only.";
  }

  const busy = (button, label) => {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = label;
    return () => {
      button.disabled = false;
      button.textContent = original;
    };
  };

  const fetchModels = async (event) => {
    if (!currentProvider()) return say("Choose a provider first.", true);
    const done = busy(event.target, "Fetching…");
    try {
      const { models, freeCount } = await dash("actions/ai-models", payload());
      catalog = models;
      active = -1;
      setOpen(true);
      // Careful not to let a catalogue read as a verdict on the key: several
      // gateways list models to anyone who asks. Test is what proves it works.
      say(
        `${models.length} models available${freeCount ? `, ${freeCount} of them free` : ""}. Listing does not check your key — use Test once you have picked one.`,
      );
    } catch (error) {
      say(`Could not fetch models: ${error.message}`, true);
    }
    done();
  };

  // The test asks the model a question and waits for the answer, because the
  // cheaper check it replaced — "can we list models?" — passed on endpoints that
  // serve their catalogue without authentication, and so reported a healthy
  // connection for a key that had never worked.
  const testConnection = async (event) => {
    if (!currentProvider()) return say("Choose a provider first.", true);
    if (!modelInput.value.trim()) return say("Pick or type a model first — the test asks that model to answer.", true);

    const done = busy(event.target, "Asking the model…");
    try {
      const result = await dash("actions/ai-settings.test", { ...payload(), model: modelInput.value.trim() });
      say(result.message, !result.ok);
    } catch (error) {
      say(`Test failed: ${error.message}`, true);
    }
    done();
  };

  const save = async (event) => {
    if (!currentProvider()) return say("Choose a provider first.", true);
    if (!modelInput.value.trim()) return say("Pick or type a model first.", true);

    const done = busy(event.target, "Saving…");
    try {
      await dash("actions/ai-settings.save", { ...payload(), model: modelInput.value.trim() });
      toast({
        title: "AI settings saved",
        message: `${currentProvider()} · ${modelInput.value.trim()} — applied immediately.`,
        severity: "good",
      });
      container.closest("[data-ai-settings]").hidden = true;
    } catch (error) {
      say(`Save failed: ${error.message}`, true);
      done();
    }
  };

  const disableButton = el("button", { class: "btn btn--block", type: "button", text: "Disable the AI council" });
  disableButton.addEventListener("click", async () => {
    try {
      await dash("actions/ai-settings.save", { provider: "none" });
      toast({ title: "AI council disabled", message: "It will trade deterministic-only until re-enabled.", severity: "info" });
      container.closest("[data-ai-settings]").hidden = true;
    } catch (error) {
      say(`Could not disable: ${error.message}`, true);
    }
  });

  drawList();

  mount(
    container,
    status,
    el("label", { class: "ais-label", text: "Provider" }),
    providerSelect,
    el("label", { class: "ais-label", text: "API key" }),
    keyInput,
    el("label", { class: "ais-label", text: "Base URL" }),
    baseUrlInput,
    el("div", { class: "ais-row" }, [
      el("button", { class: "btn", type: "button", text: "Fetch models", onclick: fetchModels }),
      el("button", { class: "btn", type: "button", text: "Test connection", onclick: testConnection }),
    ]),
    el("label", { class: "ais-label", text: "Model" }),
    el("div", { class: "ais-combo" }, [modelInput, toggle]),
    picker,
    message,
    el("button", { class: "btn btn--primary btn--block", type: "button", text: "Save and apply now", onclick: save }),
    disableButton,
  );
}
