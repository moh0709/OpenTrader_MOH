/**
 * The AI tab: what the council is doing, and a way to talk to it.
 *
 * Both widgets read the same stream. The action window is the record — every
 * council call, order, risk block, cap change and settings change, newest
 * first. The chat is the conversation, and anything it proposes executes
 * through exactly the same guarded endpoints an operator would have used, so a
 * proposal it carries out lands back in the action window like any other.
 */
import { el, emptyState, mount } from "../lib/dom.js";
import { getPassword } from "../lib/api.js";
import { dateTime, timeAgo } from "../lib/format.js";
import { actions as aiActions, isConfigured, subscribe } from "../lib/ai-feed.js";
import { toast } from "../lib/toast.js";

/**
 * The filters across the top of the action window.
 *
 * Grouped by the question being asked rather than by chip: "what did it trade",
 * "what stopped it", "what is it thinking", "what did it change". Five buttons
 * is already the most a single row can carry without wrapping.
 */
const FILTERS = [
  { id: "all", label: "All", chips: null },
  { id: "trades", label: "Trades", chips: ["open", "close", "take-profit"] },
  { id: "risk", label: "Risk", chips: ["risk", "cap", "denied"] },
  { id: "thinking", label: "Thinking", chips: ["analysis", "decision"] },
  { id: "changes", label: "Changes", chips: ["adjust", "settings", "learning"] },
];

/** Chip label text. The chip id is a slug; this is what a person reads. */
const CHIP_LABEL = {
  analysis: "Read",
  decision: "Decision",
  open: "Opened",
  close: "Closed",
  "take-profit": "Take profit",
  adjust: "Changed",
  risk: "Risk",
  cap: "Cap",
  learning: "Lesson",
  settings: "Settings",
  denied: "Refused",
};

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

export function chip(kind) {
  return el("span", { class: "chip", dataset: { chip: kind }, text: CHIP_LABEL[kind] ?? kind });
}

/** Actions matching a filter id. Pure, so the grouping can be tested. */
export function filterActions(list, filterId) {
  const filter = FILTERS.find((entry) => entry.id === filterId);
  if (!filter || !filter.chips) return list;

  return list.filter((action) => filter.chips.includes(action.chip));
}

/** How many of these happened in the last hour — the header's one figure. */
export function countRecent(list, now = Date.now(), windowMs = 3_600_000) {
  return list.filter((action) => now - action.at <= windowMs).length;
}

// --- Action window ----------------------------------------------------------

export const aiActionsWidget = {
  id: "aiActions",
  name: "AI actions",
  group: "AI",
  description: "Everything the AI does as it does it — council calls, orders, risk blocks, cap and settings changes.",
  defaultSpan: 6,
  defaultRows: 4,
  singleton: true,

  render(ctx) {
    let filter = ctx.config.filter ?? "all";

    const list = el("div", { class: "aia-list" });

    const draw = () => {
      const all = aiActions();
      const rows = filterActions(all, filter);

      ctx.setMeta(all.length === 0 ? "" : `${countRecent(all)} in the last hour`);

      if (rows.length === 0) {
        // Three different empty states, because they are three different
        // problems and only one of them is the user's to fix.
        const message =
          isConfigured() === false
            ? "No AI provider configured. Open AI settings in the top bar to switch the council on."
            : all.length === 0
              ? "Nothing yet. The feed starts when the daemon does, and fills as the council works."
              : "Nothing under this filter.";

        return mount(list, emptyState(message));
      }

      const now = Date.now();

      mount(
        list,
        ...rows.map((action) =>
          el(
            "button",
            {
              class: "aia-row",
              type: "button",
              dataset: { severity: action.severity, autonomous: String(action.autonomous) },
              title: `${dateTime(action.at)} — click to show this on the board`,
              // Phase-independent: the board listens for this and rings whatever
              // the action touched. Nothing breaks if nothing is listening.
              onclick: () =>
                document.dispatchEvent(new CustomEvent("opentrader:spotlight", { detail: { action } })),
            },
            [
              el("div", { class: "aia-row__head" }, [
                chip(action.chip),
                el("span", { class: "aia-row__title", text: action.title }),
                action.autonomous ? el("span", { class: "chip chip--auto", text: "Auto" }) : null,
                el("span", { class: "aia-row__time", text: timeAgo(action.at, now) }),
              ]),
              action.detail ? el("div", { class: "aia-row__detail", text: action.detail }) : null,
              action.botName || action.symbol
                ? el("div", {
                    class: "aia-row__who",
                    text: [action.botName, action.symbol].filter(Boolean).join(" · "),
                  })
                : null,
            ],
          ),
        ),
      );
    };

    const filters = el(
      "div",
      { class: "aia-filters" },
      FILTERS.map((entry) =>
        el("button", {
          class: "chip chip--filter",
          type: "button",
          text: entry.label,
          "aria-pressed": String(entry.id === filter),
          dataset: { on: String(entry.id === filter) },
          onclick: (event) => {
            filter = entry.id;
            ctx.setConfig({ filter });
            for (const node of event.currentTarget.parentElement.children) {
              node.dataset.on = String(node.textContent === entry.label);
              node.setAttribute("aria-pressed", node.dataset.on);
            }
            draw();
          },
        }),
      ),
    );

    mount(ctx.body, el("div", { class: "aia" }, [filters, list]));
    draw();

    /*
     * New rows arrive at the top, which would push whatever you were reading
     * down the page. Holding the scroll position by the height that was added
     * keeps the line under your eye where it was — unless you are already at the
     * top, where following the newest row is the point.
     */
    const unsubscribe = subscribe(() => {
      const before = { top: list.scrollTop, height: list.scrollHeight };
      draw();
      if (before.top > 2) list.scrollTop = before.top + (list.scrollHeight - before.height);
    });

    return { dispose: unsubscribe };
  },
};

// --- Chat -------------------------------------------------------------------

/**
 * How far autopilot is allowed to run before it disarms itself.
 *
 * Both limits exist because the two ways this goes wrong are different. A wrong
 * belief about the fleet burns through actions quickly, which the count catches;
 * a tab left armed and forgotten burns through time, which the clock catches.
 */
const AUTOPILOT_ACTIONS = 20;
const AUTOPILOT_MS = 30 * 60 * 1000;

/** Transcripts are per widget instance, so two chats do not overwrite one another. */
const transcriptKey = (uid) => `otAnalytics.chat.${uid}`;

function loadTranscript(uid) {
  try {
    const raw = window.localStorage.getItem(transcriptKey(uid));
    const parsed = raw ? JSON.parse(raw) : null;

    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveTranscript(uid, messages) {
  try {
    window.localStorage.setItem(transcriptKey(uid), JSON.stringify(messages.slice(-50)));
  } catch {
    // A full localStorage costs you the history, not the conversation.
  }
}

/** A proposal in the words an operator needs before agreeing to it. */
export function describeProposal(proposal) {
  const params = Object.entries(proposal.params ?? {})
    .map(([key, value]) => `${key} ${value}`)
    .join(", ");

  return params ? `${proposal.action} — ${params}` : proposal.action;
}

export const aiChatWidget = {
  id: "aiChat",
  name: "Ask the AI",
  group: "AI",
  description: "Talk to the configured model about the fleet. It can propose actions; you decide whether they run.",
  defaultSpan: 6,
  defaultRows: 4,
  singleton: true,

  render(ctx) {
    const uid = ctx.instance.uid;
    let messages = loadTranscript(uid);
    let sending = false;

    /**
     * Autopilot is deliberately not persisted.
     *
     * It is armed for this page, in this tab, until you reload — because the one
     * failure mode that matters is coming back to a browser tab you left open
     * yesterday and not knowing it can still act.
     */
    let autopilot = false;
    let autoRemaining = 0;

    const thread = el("div", { class: "chat__thread" });
    const status = el("div", { class: "chat__status" });
    const input = el("textarea", {
      class: "input chat__input",
      rows: "2",
      placeholder: "Ask about the fleet — “which bot is losing money?”",
      "aria-label": "Message",
    });

    const autoSwitch = el("button", {
      class: "chip chip--filter chat__auto",
      type: "button",
      text: "Autopilot",
      "aria-pressed": "false",
      title: "Let approved proposals run without asking each time",
    });

    const sendButton = el("button", { class: "btn btn--primary btn--sm", type: "button", text: "Send" });

    const say = (text, tone) => {
      status.textContent = text;
      status.dataset.tone = tone ?? "";
    };

    const setAutopilot = (on) => {
      autopilot = on;
      autoRemaining = on ? AUTOPILOT_ACTIONS : 0;
      autoSwitch.dataset.on = String(on);
      autoSwitch.setAttribute("aria-pressed", String(on));
      autoSwitch.textContent = on ? `Autopilot · ${autoRemaining}` : "Autopilot";
      document.dispatchEvent(new CustomEvent("opentrader:autopilot", { detail: { armed: on } }));
    };

    // The page-wide banner's Disarm button, and Escape while it is showing.
    // Routed as an event because the banner outlives this widget: leaving the
    // AI tab destroys the chat, and the banner has to keep working.
    const onDisarmRequest = () => {
      if (!autopilot) return;

      setAutopilot(false);
      say("Autopilot off. Proposals wait for you again.");
    };

    document.addEventListener("opentrader:autopilot-disarm", onDisarmRequest);

    autoSwitch.addEventListener("click", () => {
      if (autopilot) {
        setAutopilot(false);
        say("Autopilot off. Proposals wait for you again.");
        return;
      }

      const agreed = window.confirm(
        [
          "Arm autopilot?",
          "",
          "Anything the model proposes will run immediately, without asking you first — starting and stopping bots, changing capital limits, replacing exit orders, applying learning proposals.",
          "",
          "These are real orders on a live exchange and they cannot be undone.",
          "",
          `It disarms itself after ${AUTOPILOT_ACTIONS} actions, after ${AUTOPILOT_MS / 60000} minutes, on the first failure, if you leave this tab, or when you reload the page.`,
        ].join("\n"),
      );

      if (!agreed) return;

      setAutopilot(true);
      say("Autopilot armed. Everything it does appears in the AI actions window.", "danger");

      window.setTimeout(() => {
        if (!autopilot) return;

        setAutopilot(false);
        say(`Autopilot disarmed itself after ${AUTOPILOT_MS / 60000} minutes.`);
      }, AUTOPILOT_MS);
    });

    const execute = async (proposal, node, unattended) => {
      node.querySelectorAll("button").forEach((button) => (button.disabled = true));

      try {
        const outcome = await dash("actions/ai-execute", { proposal, autonomous: Boolean(unattended) });
        mount(node, el("div", { class: "chat__done", text: `Done — ${describeProposal(proposal)}` }));

        if (unattended) {
          // The server keeps the real allowance; this counter only reports it.
          // Trusting the browser's own subtraction would let a reload hand the
          // AI twenty fresh actions it had already spent.
          autoRemaining = typeof outcome.autonomyRemaining === "number" ? outcome.autonomyRemaining : autoRemaining - 1;
          autoSwitch.textContent = `Autopilot · ${autoRemaining}`;

          if (autoRemaining <= 0) {
            setAutopilot(false);
            say("Autopilot has used its allowance of unattended actions and disarmed.");
          }
        }
      } catch (error) {
        mount(node, el("div", { class: "chat__failed", text: `Refused — ${error.message}` }));

        // One failure disarms. Whatever the model believed about the fleet was
        // wrong enough to be rejected, and the rest of its plan rests on the
        // same belief.
        if (autopilot) {
          setAutopilot(false);
          say(`Autopilot disarmed: ${error.message}`, "danger");
        }

        toast({ title: "Action refused", message: error.message, severity: "danger" });
      }
    };

    const proposalCard = (proposal) => {
      const card = el("div", { class: "chat__proposal" });

      mount(
        card,
        el("div", { class: "chat__proposal-head" }, [
          chip("adjust"),
          el("span", { class: "chat__proposal-what", text: describeProposal(proposal) }),
        ]),
        proposal.why ? el("div", { class: "chat__proposal-why", text: proposal.why }) : null,
        // Stopping a bot cancels its resting exit, which is how a fleet ends up
        // holding stock with nothing to sell it. The warning belongs to the
        // action, not to the button.
        proposal.action === "bot.stop"
          ? el("div", { class: "chat__warn", text: "Stopping cancels the bot's resting exit orders, leaving any open position without a sell order." })
          : null,
        el("div", { class: "chat__proposal-row" }, [
          el("button", { class: "btn btn--sm btn--primary", type: "button", text: "Do it", onclick: () => void execute(proposal, card, false) }),
          el("button", { class: "btn btn--sm", type: "button", text: "Dismiss", onclick: () => card.remove() }),
        ]),
      );

      return card;
    };

    const draw = () => {
      if (messages.length === 0) {
        mount(
          thread,
          emptyState(
            isConfigured() === false
              ? "No AI provider configured. Open AI settings in the top bar first."
              : "Ask anything about the fleet. It sees the same numbers this dashboard does.",
          ),
        );
        return;
      }

      mount(
        thread,
        ...messages.map((message) =>
          el("div", { class: "chat__msg", dataset: { role: message.role } }, [
            el("div", { class: "chat__msg-text", text: message.content }),
            ...(message.proposals ?? []).map((proposal) => proposalCard(proposal)),
          ]),
        ),
      );

      thread.scrollTop = thread.scrollHeight;
    };

    const send = async () => {
      const text = input.value.trim();
      if (!text || sending) return;

      sending = true;
      input.value = "";
      messages = [...messages, { role: "user", content: text }];
      saveTranscript(uid, messages);
      draw();
      say("Thinking…");
      sendButton.disabled = true;

      try {
        const reply = await dash("actions/ai-chat", {
          messages: messages.map(({ role, content }) => ({ role, content })),
        });

        messages = [...messages, { role: "assistant", content: reply.reply, proposals: reply.proposals ?? [] }];
        saveTranscript(uid, messages);
        say(reply.model ? `via ${reply.model}` : "");
        draw();

        // Armed: carry them out rather than waiting to be asked. Same endpoint,
        // same guards — the switch changes who presses the button, nothing else.
        if (autopilot) {
          for (const [index, proposal] of (reply.proposals ?? []).entries()) {
            const card = thread.querySelectorAll(".chat__proposal")[index];
            if (card && autopilot) await execute(proposal, card, true);
          }
        }
      } catch (error) {
        say(error.message, "danger");
      }

      sending = false;
      sendButton.disabled = false;
      input.focus();
    };

    sendButton.addEventListener("click", () => void send());
    input.addEventListener("keydown", (event) => {
      // Enter sends, Shift+Enter starts a line. The opposite of a code editor,
      // and the right way round for something you type one sentence into.
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void send();
      }
    });

    mount(
      ctx.body,
      el("div", { class: "chat" }, [
        thread,
        status,
        el("div", { class: "chat__composer" }, [
          input,
          el("div", { class: "chat__composer-side" }, [
            sendButton,
            autoSwitch,
            el("button", {
              class: "btn btn--sm",
              type: "button",
              text: "Clear",
              title: "Forget this conversation",
              onclick: () => {
                messages = [];
                saveTranscript(uid, messages);
                say("");
                draw();
              },
            }),
          ]),
        ]),
      ]),
    );

    draw();

    return {
      /*
       * Leaving the tab disarms.
       *
       * Only the active tab is built, so navigating away destroys this widget —
       * and the chat is the only thing that produces proposals, so an armed
       * autopilot with no chat behind it can do nothing except leave a banner
       * on screen claiming otherwise. Disarming here keeps the banner honest.
       */
      dispose: () => {
        document.removeEventListener("opentrader:autopilot-disarm", onDisarmRequest);
        if (autopilot) setAutopilot(false);
      },
    };
  },
};

export const aiWidgets = [aiChatWidget, aiActionsWidget];
