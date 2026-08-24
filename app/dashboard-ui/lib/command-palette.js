/**
 * Fuzzy subsequence match. Returns a score, or -1 when the query does not match.
 *
 * Scoring favours matches at word starts and consecutive runs, which is what a
 * person typing "open pos" means when they want "Open positions". Pure and DOM
 * free so it tests in node.
 */
import { clear, el } from "./dom.js";


/**
 * @param {string} query
 * @param {string} target
 * @returns {number}
 */
export function fuzzyScore(query, target) {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (q === "") return 0;

  let score = 0;
  let ti = 0;
  let run = 0;

  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return -1;

    // Consecutive hits build a run; a gap resets it.
    run = found === ti ? run + 1 : 0;
    score += 10 + run * 4;
    // Matching at a word start (or the very beginning) is worth extra.
    if (found === 0 || /\W/.test(t[found - 1] ?? "")) score += 8;
    // Deep matches stretch the eye across the label; penalise them mildly.
    score -= Math.min(found - ti, 6);
    ti = found + 1;
  }

  // Shorter targets are more precise matches for the same query.
  score -= Math.floor(t.length / 12);

  return score;
}

/**
 * Rank actions against a query. Actions with no match are dropped; the rest
 * come back best-first. Ties keep their original order, so the catalogue's
 * curated order survives when everything scores equally (empty query).
 *
 * @template {{ label: string }} A
 * @param {string} query
 * @param {A[]} actions
 * @returns {A[]}
 */
export function rankActions(query, actions) {
  const scored = [];

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const haystacks = [action.label, ...(action.keywords ?? [])];
    let best = -1;

    for (const hay of haystacks) {
      const s = fuzzyScore(query, hay);
      if (s > best) best = s;
    }

    if (best >= 0) scored.push({ i, action, best });
  }

  return scored.sort((a, b) => b.best - a.best || a.i - b.i).map((entry) => entry.action);
}

/**
 * The command palette. One overlay, built lazily, driven entirely by the
 * keyboard: type to filter, arrows to move, Enter to run, Escape to leave.
 *
 * `buildActions` is called on every open so the list always reflects the board
 * as it is right now (which widgets are already placed, which drawers exist).
 *
 * @param {() => Array<{ label: string, hint?: string, section?: string, keywords?: string[], run: () => void }>} buildActions
 */
export function openCommandPalette(buildActions) {
  const existing = document.querySelector("[data-palette]");
  if (existing) existing.remove();

  const input = el("input", {
    class: "palette__input",
    type: "text",
    placeholder: "Type a command… add widget, switch view, toggle theme",
    "aria-label": "Command palette",
    autocomplete: "off",
    spellcheck: "false",
  });
  const list = el("div", { class: "palette__list", role: "listbox" });
  const panel = el("div", { class: "palette__panel", role: "dialog", "aria-label": "Commands" }, [input, list]);
  const root = el("div", { class: "palette", dataset: { palette: "" } }, [panel]);

  document.body.append(root);

  let matches = [];
  let selected = 0;

  const close = () => {
    root.remove();
    document.removeEventListener("keydown", onKeydown, true);
  };

  function renderList() {
    clear(list);

    if (matches.length === 0) {
      list.append(el("div", { class: "palette__empty", text: "Nothing matches." }));
      return;
    }

    let lastSection = null;

    matches.forEach((action, index) => {
      const section = action.section ?? "";
      if (section !== lastSection && section) {
        list.append(el("div", { class: "palette__section", text: section }));
        lastSection = section;
      }

      const row = el(
        "div",
        {
          class: `palette__item${index === selected ? " palette__item--active" : ""}`,
          role: "option",
          "aria-selected": index === selected ? "true" : "false",
          dataset: { index: String(index) },
        },
        [
          el("span", { class: "palette__label", text: action.label }),
          action.hint ? el("span", { class: "palette__hint", text: action.hint }) : null,
        ],
      );

      row.addEventListener("click", () => {
        close();
        action.run();
      });
      row.addEventListener("mousemove", () => {
        if (selected !== index) {
          selected = index;
          for (const node of list.querySelectorAll(".palette__item")) {
            node.classList.toggle("palette__item--active", Number(node.dataset.index) === selected);
            node.setAttribute("aria-selected", Number(node.dataset.index) === selected ? "true" : "false");
          }
        }
      });

      list.append(row);
    });

    const active = list.querySelector(".palette__item--active");
    active?.["scrollIntoView"]?.call(active, { block: "nearest" });
  }

  function refilter() {
    matches = rankActions(input.value.trim(), buildActions());
    selected = 0;
    renderList();
  }

  function runSelected() {
    const action = matches[selected];
    if (!action) return;
    close();
    action.run();
  }

  function onKeydown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      selected = Math.min(selected + 1, matches.length - 1);
      renderList();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      selected = Math.max(selected - 1, 0);
      renderList();
    } else if (event.key === "Enter") {
      event.preventDefault();
      runSelected();
    }
  }

  input.addEventListener("input", refilter);
  panel.addEventListener("click", (event) => {
    if (event.target === panel) close();
  });
  document.addEventListener("keydown", onKeydown, true);

  refilter();
  input.focus();
}

