/**
 * Toast notifications.
 *
 * The headline case is a closed deal: win or loss, the amount and the percent,
 * which is what you want to know without watching the screen. Severity is shown
 * by a coloured bar AND stated in the title, so the meaning never rests on hue.
 */
import { el } from "./dom.js";
import { store } from "./store.js";

const MAX_VISIBLE = 5;
const LIFETIME_MS = 8000;

let container = null;

export function initToasts(node) {
  container = node;
}

/** A short two-tone chime. Uses WebAudio, so there is no asset to load. */
function playChime(severity) {
  try {
    const AudioCtx = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    const gain = ctx.createGain();
    gain.gain.value = 0.05;
    gain.connect(ctx.destination);

    const frequencies = severity === "danger" ? [420, 300] : [660, 880];
    frequencies.forEach((frequency, index) => {
      const oscillator = ctx.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      oscillator.connect(gain);
      oscillator.start(ctx.currentTime + index * 0.09);
      oscillator.stop(ctx.currentTime + index * 0.09 + 0.09);
    });

    setTimeout(() => ctx.close(), 600);
  } catch {
    // Audio is a nicety; never let it surface as an error.
  }
}

export function toast({ title, message, severity = "info", onClick = null, silent = false }) {
  if (!container) return;

  const node = el("div", { class: "toast", dataset: { severity }, role: "status" }, [
    el("div", { class: "toast__bar" }),
    el("div", {}, [
      el("div", { class: "toast__title", text: title }),
      message ? el("div", { class: "toast__msg", text: message }) : null,
    ]),
    el("button", {
      class: "toast__close",
      type: "button",
      "aria-label": "Dismiss",
      text: "✕",
      onclick: (event) => {
        event.stopPropagation();
        dismiss(node);
      },
    }),
  ]);

  if (onClick) {
    node.style.cursor = "pointer";
    node.addEventListener("click", () => {
      onClick();
      dismiss(node);
    });
  }

  container.append(node);

  while (container.children.length > MAX_VISIBLE) dismiss(container.firstElementChild);

  if (!silent && store.settings.toastSound) playChime(severity);

  setTimeout(() => dismiss(node), LIFETIME_MS);
}

function dismiss(node) {
  if (!node || node.dataset.dismissed) return;

  node.dataset.dismissed = "true";
  node.classList.add("toast--out");
  setTimeout(() => node.remove(), 200);
}

/**
 * Turn a server event into a toast.
 *
 * The scope setting decides how noisy this is: "trades" shows only closed deals,
 * which is the default because a bot restart is not something you need to be
 * interrupted for.
 */
export function toastForEvent(event, onFocus) {
  const { toastsEnabled, toastScope } = store.settings;
  if (!toastsEnabled) return;
  if (toastScope === "trades" && event.type !== "tradeClosed") return;
  if (toastScope === "important" && !["tradeClosed", "botError", "agentAction"].includes(event.type)) return;

  toast({
    title: event.title,
    message: event.message,
    severity: event.severity,
    onClick: event.smartTradeId && onFocus ? () => onFocus(event) : null,
  });
}
