/**
 * The AI settings panel.
 *
 * Provider choice, API key, endpoint override and model selection for the AI
 * council. Saving applies live through the daemon's runtime override, so a
 * change takes effect on the next tick without restarting anything.
 *
 * The key is write-only from here: the backend reports only a mask, and a blank
 * field means "keep the stored key" rather than "clear it".
 */
import { el, mount } from "./dom.js";
import { getPassword } from "./api.js";
import { toast } from "./toast.js";

const PROVIDERS = [
  { value: "openrouter", label: "OpenRouter", needsKey: true },
  { value: "anthropic", label: "Anthropic (Claude)", needsKey: true },
  { value: "openai", label: "OpenAI", needsKey: true },
  { value: "gemini", label: "Google Gemini", needsKey: true },
  { value: "ollama", label: "Ollama (local)", needsKey: false },
  { value: "opencode-zen", label: "OpenCode Zen", needsKey: true },
  { value: "opencode-go", label: "OpenCode Go", needsKey: true },
  { value: "custom", label: "Custom endpoint", needsKey: false },
];

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
    list: "ai-models-list",
    autocomplete: "off",
    placeholder: "Model — pick after fetching, or type an id",
    "aria-label": "Model",
  });
  const datalist = el("datalist", { id: "ai-models-list" });
  const message = el("div", { class: "ais-message", role: "status" });

  const say = (text, isError) => {
    message.textContent = text;
    message.classList.toggle("ais-message--error", Boolean(isError));
  };

  const currentProvider = () => providerSelect.value;

  const payload = () => ({
    provider: currentProvider(),
    apiKey: keyInput.value.trim(),
    baseUrl: baseUrlInput.value.trim(),
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
      const { models } = await dash("actions/ai-models", payload());
      mount(datalist, ...models.map((id) => el("option", { value: id })));
      say(`${models.length} models available — click the model field to pick one.`);
    } catch (error) {
      say(`Could not fetch models: ${error.message}`, true);
    }
    done();
  };

  const testConnection = async (event) => {
    if (!currentProvider()) return say("Choose a provider first.", true);
    const done = busy(event.target, "Testing…");
    try {
      const result = await dash("actions/ai-settings.test", payload());
      say(result.ok ? `Connection OK — ${result.count} models reachable.` : "The provider did not answer. Check the key and base URL.", !result.ok);
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
    modelInput,
    datalist,
    message,
    el("button", { class: "btn btn--primary btn--block", type: "button", text: "Save and apply now", onclick: save }),
    disableButton,
  );
}

