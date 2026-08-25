/**
 * The learning journal widget.
 *
 * One card per self-improvement cycle: what went wrong, what the analyser
 * concluded, and the bounded adjustment awaiting a decision. Apply / Revert /
 * Dismiss call the REST actions directly - this is operator control, not a
 * read-only view.
 */
import { badge, el, emptyState, mount } from "../lib/dom.js";
import { getPassword } from "../lib/api.js";
import { timeAgo } from "../lib/format.js";
import { toast } from "../lib/toast.js";

const STATUS_BADGE = {
  proposed: ["Awaiting decision", "info"],
  applied: ["Applied", "win"],
  reverted: ["Reverted", "warn"],
  dismissed: ["Dismissed", ""],
};

async function post(path, body) {
  const password = getPassword();
  const response = await fetch(`/api/dash/actions/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: password ?? "" },
    body: JSON.stringify(body ?? {}),
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ message: `HTTP ${response.status}` }));
    throw new Error(payload.message ?? `HTTP ${response.status}`);
  }

  return response.json();
}

export const learningJournalWidget = {
  id: "learningJournal",
  name: "Learning journal",
  group: "Research",
  description:
    "Loss-streak post-mortems per bot, with bounded adjustment proposals you can apply, revert or dismiss.",
  defaultSpan: 6,
  defaultRows: 4,
  defaultConfig: {},

  render(ctx) {
    const load = async () => {
      let payload;
      try {
        const password = getPassword();
        const response = await fetch("/api/dash/learning?limit=30", { headers: { authorization: password ?? "" } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        payload = await response.json();
      } catch (error) {
        return mount(ctx.body, emptyState(`Could not load the journal — ${error.message}`));
      }

      const entries = payload.entries ?? [];
      if (entries.length === 0) {
        return mount(
          ctx.body,
          emptyState("No entries yet. When a bot loses several trades in a row, the post-mortem lands here."),
        );
      }

      const act = (action, entry, button) => {
        button.disabled = true;
        post(`learning.${action}`, { id: entry.id })
          .then(() => {
            toast({ title: `Entry ${action}ed`, severity: "good" });
            return load();
          })
          .catch((error) => {
            button.disabled = false;
            toast({ title: `Could not ${action}`, message: error.message, severity: "danger" });
          });
      };

      const cards = entries.map((entry) => {
        const [label, variant] = STATUS_BADGE[entry.status] ?? [entry.status, ""];
        const proposal = entry.proposal ?? {};

        const buttons = el("div", { class: "lrn-actions" });
        if (entry.status === "proposed") {
          buttons.append(
            el("button", { class: "btn btn--sm btn--primary", type: "button", text: "Apply", onclick: (e) => act("apply", entry, e.target) }),
            el("button", { class: "btn btn--sm", type: "button", text: "Dismiss", onclick: (e) => act("dismiss", entry, e.target) }),
          );
        } else if (entry.status === "applied") {
          buttons.append(
            el("button", { class: "btn btn--sm", type: "button", text: "Revert", onclick: (e) => act("revert", entry, e.target) }),
          );
        }

        return el("div", { class: "cv-card" }, [
          el("div", { class: "cv-card__head" }, [
            el("span", { class: "cv-card__symbol", text: `${entry.botName} · ${entry.symbol}` }),
            badge(label, variant || undefined),
          ]),
          el("div", { class: "muted", text: `${entry.lossStreak} losses in a row — ${timeAgo(entry.createdAt)}${entry.model ? ` · analysed by ${entry.model}` : ""}` }),
          el("p", { class: "cv-card__summary", style: { "-webkit-line-clamp": "none" }, text: entry.analysis }),
          Object.keys(proposal).length > 0
            ? el("div", { class: "lrn-proposal" }, [
                el("span", { class: "muted", text: "Proposed:" }),
                ...Object.entries(proposal).map(([key, value]) =>
                  el("code", { class: "rsrch-mono lrn-chip", text: `${key} → ${value}` }),
                ),
              ])
            : null,
          el("div", { class: "cv-card__foot" }, [el("span"), buttons]),
        ]);
      });

      mount(ctx.body, el("div", { class: "rsrch-stack" }, [el("div", { class: "cv-grid" }, cards)]));
    };

    void load();

    return { dispose: ctx.store.subscribe((reason) => reason === "snapshot" && void load()) };
  },
};
