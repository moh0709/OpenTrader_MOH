# AI Cockpit — implementation plan

**Goal:** Turn the analytics dashboard from a board that *reports* what happened into a
cockpit that shows what the AI is *doing, while it does it* — a tabbed board with a
dedicated AI tab (chat + live action window), on-board highlights with short explanations,
and a bottom bar split between live trades and AI news.

**Date:** 2026-08-25 · **Branch:** `dev` · **Surface:** `app/dashboard-ui`, `packages/ai-team`,
`packages/bot`, `packages/bot-templates`

**Status: all eight phases implemented, 2026-08-26.** 730 tests pass across the monorepo,
up from 677 — 53 new. The three failing suites are the same three that failed before this
work: `@opentrader/regime` (its `node_modules` was never installed) and the two
`@opentrader/bot` executor suites that need a live database.

Two verification limits worth stating plainly rather than glossing:

- **The repo-wide `tsc` cannot run**, before or after this work. It stops at
  `TS6306: Referenced project 'packages/regime' must have setting "composite": true` —
  one error on the clean baseline and one error now, the same one. Fixing that config
  belongs to whoever owns `packages/regime`. New TypeScript was checked standalone
  instead, and is exercised by tests.
- **The generated Prisma client in this checkout is stale** — it predates `RegimePolicy`,
  `RegimeConviction`, `LearningJournal` and `AiSettings`, so the editor reports those as
  missing on lines this work did not touch. `prisma generate` clears it.

---

## What exists today (verified, not assumed)

| Thing | Where | State |
|---|---|---|
| Model list | `packages/ai-team/src/providers.ts` `listModels()` | Returns `string[]` — **ids only, no names, no descriptions, no pricing** |
| Model picker | `app/dashboard-ui/lib/ai-settings.js:63` | A `<datalist>` on a text input. No dropdown, no filter |
| Board | `app/dashboard-ui/lib/layout.js` | One flat 12-column grid, all widgets at once. `PRESETS` replace the whole board |
| Widget groups | Overview, Trades, Grid & market, Arbitrage, Research, Analytics, Operations | Only used by the Add-widget drawer and `#hash` deep links |
| Bottom bar | `lib/ticker.js` + `.ticker` in `index.html:141` | One lane, live trades, own 5s poll |
| AI actions | — | **Does not exist as a stream.** Scattered: hybrid strategy `logger.info` only; regime cap changes logged only; learning journal in DB; dash control actions in a 200-entry memory ring (`packages/trpc/src/services/agent-access.ts:104`) |
| DOM anchors | — | **Do not exist.** No widget row carries `data-bot-id` or `data-trade-id`. Nothing on the board can currently be pointed at |
| Chat | — | Does not exist. `chatCompletion()` in providers.ts is the only wire |
| Process topology | `app/src/standalone.ts` | Server **and** bot manager in one process — a module singleton is visible to both |

Two facts drive the whole plan: **there is no AI action stream**, and **there is nothing on
the board to highlight**. Phases 3 and 7 build those; everything else consumes them.

---

## Decisions taken

1. **Chat is propose-and-confirm by default, with an Autopilot switch** for full autonomous
   control (operator's choice, 2026-08-25). Both paths execute through the *same* guarded
   endpoint, so autopilot can never do more than a confirm click could.
2. **AI action feed is an in-process ring buffer** (500 entries), no Prisma migration.
   The live feed starts empty after a daemon restart; durable history stays reachable
   through trades, the learning journal and convictions.
3. **REST, not tRPC.** The AI surface joins `/api/dash/*` where regime, learning and
   ai-settings already live, and where the research widgets already fetch directly.
   Avoids adding `@opentrader/ai-team` to the tRPC dependency graph.
4. **Presets survive**, scoped to the active tab.

## Global constraints

- The governor invariant holds unchanged: **nothing here can raise a cap, enlarge a
  position, or lift a halt.** New code proposes; existing guards dispose.
- Every executed action goes through the existing `control()` guard in
  `packages/bot/src/rest/dashboard-routes.ts:449` — scope check, freeze switch, rate limit,
  audit record. No new privileged path.
- `bot.purgeTrades`, `freeze`, and every share/token action are **never** available to
  chat or autopilot. Destructive and irreversible stays human-only.
- Bubble text is capped at 140 characters server-side. Short is a data constraint, not a
  UI hope.
- All model output reaches the page through `el({ text })` → `textContent`. Never `html`.
- The API key is never echoed, logged, or sent to the browser — mask only, as today.
- A shared feed (`?share=` token) gets no AI lane and no AI tab: it has no `/api/dash` auth.
- Nothing may break the board of an existing user: layout v1 must migrate, not reset.

---

# Phase 1 — Model dropdown with a "Free" filter

**Files**
- Modify: `packages/ai-team/src/providers.ts`
- Modify: `packages/ai-team/src/providers.test.ts`
- Modify: `packages/bot/src/rest/dashboard-routes.ts` (`/actions/ai-models`, ~line 773)
- Modify: `app/dashboard-ui/lib/ai-settings.js`
- Modify: `app/dashboard-ui/styles.css`
- Modify: `scripts/check-history.py` (asserts the `models` shape)

- [x] **1.1 `listModelCatalog()`** — new export returning
  `{ id, name, description, free, contextLength? }[]`. Handles the three real wire shapes:
  OpenAI/Ollama `{data:[{id}]}`, OpenRouter `{data:[{id,name,description,pricing:{prompt,completion}}]}`,
  Anthropic `{data:[{id,display_name}]}`.
  `listModels()` stays, reimplemented as `(await listModelCatalog(p)).map(m => m.id)`, so
  `checkProvider()` and `/actions/ai-settings.test` are untouched.

- [x] **1.2 Free detection.** `free` is true when `/free/i` matches the id, name **or**
  description — the rule as stated — **or** pricing is present and prompt+completion are
  both zero. The price rule is additive: it catches genuinely-free models whose name never
  says so. OpenRouter's `:free` id suffix is caught by the text rule.

- [x] **1.3 Tests** (RED first) in `providers.test.ts`: one fixture per wire shape;
  free-by-name, free-by-description, free-by-zero-price, and a paid model that merely
  mentions "freeform" in its description **is still paid** (word-boundary check).

- [x] **1.4 Endpoint** returns `{ ok: true, models: ModelInfo[] }`. Breaking shape change,
  single consumer, changed in the same phase.

- [x] **1.5 The picker.** Replace the datalist with a real combobox in `ai-settings.js`:
  a search input, a **Free** filter chip (toggle, shows the count), a scrollable listbox of
  `name · id` rows with a `Free` badge, keyboard nav (↑/↓/Enter/Esc), and a free-text escape
  hatch so an unlisted id can still be typed. Selecting writes the id.
  Empty-after-filter says *"No free models from this provider"* rather than going blank.

**Verify:** `pnpm exec vitest run packages/ai-team` · open AI settings against OpenRouter,
confirm the Free chip narrows a ~300-model list to the `:free` set and the count matches.

---

# Phase 2 — The board becomes tabs

**Files**
- Create: `app/dashboard-ui/lib/board.js`, `app/dashboard-ui/lib/board.test.js`
- Modify: `app/dashboard-ui/lib/layout.js`, `lib/store.js`, `app.js`, `index.html`, `styles.css`

- [x] **2.1 Board model.** `board.js` owns
  `{ activeTab, tabs: [{ id, name, slug, widgets: [instance] }] }` under a new key
  `otAnalytics.board.v2`. API: `tabs()`, `active()`, `setActive(id)`, `addTab()`,
  `renameTab()`, `removeTab()`, `widgets()`, `setWidgets()`.

- [x] **2.2 Migration.** On first load, if `otAnalytics.layout.v1` exists, its widgets become
  the **first tab, active**, named *Overview* — the user's board is preserved exactly. The
  remaining default tabs are then appended:
  `Trades · Analytics · Research · Operations · Arbitrage · AI`, seeded from the existing
  `PRESETS` plus the new AI set `["aiChat","aiActions","convictionBoard","learningJournal"]`.
  v1 is left in place (not deleted) for one release, as a rollback.

- [x] **2.3 Layout scoping.** `layout.js` reads and writes the active tab's widget list
  instead of a module-level `instances`. `addWidget`, `removeWidget`, `updateConfig`,
  `applyPreset`, `resetLayout` all become active-tab operations. Only the active tab renders
  — `destroyAll()` on switch, which already exists and disposes chart controllers.

- [x] **2.4 Tab bar** in `index.html` between `<header>` and `<main class="grid">`:
  `role="tablist"`, arrow-key navigation, a `+` to add a tab, right-click / long-press for
  rename and remove. The AI tab carries a live dot when unseen AI actions have arrived since
  it was last opened.

- [x] **2.5 Routing.** `#<tab-slug>` selects a tab; the existing `#arbitrage` group deep link
  resolves **tab first, then group**, so the main app's Arbitrage button now lands on the
  Arbitrage tab instead of appending widgets to whatever board was open. `focusGroup()` keeps
  its add-and-scroll behaviour only when no tab owns that group.

- [x] **2.6 Palette.** Add a `Go to <tab>` section; `Add <widget>` targets the active tab and
  says which tab it landed on.

- [x] **2.7 Tests** (`board.test.js`, node env, no DOM): v1→v2 migration preserves order and
  config; unknown widget types are dropped; the last tab cannot be removed; active tab
  survives a reload; slug collisions are de-duplicated.

**Verify:** `pnpm exec vitest run app/dashboard-ui` · load with an existing v1 layout in
localStorage and confirm the board is unchanged on tab 1.

---

# Phase 3 — The AI activity journal (the spine)

Everything visible in phases 4, 7 and 8 reads from this one stream.

**Files**
- Create: `packages/ai-team/src/activity.ts`, `packages/ai-team/src/activity.test.ts`
- Modify: `packages/ai-team/src/index.ts`
- Modify: `packages/bot-templates/src/templates/hybrid.ts` (~lines 129–165)
- Modify: `packages/bot/src/regime/regime.service.ts`, `packages/bot/src/learning/learning.service.ts`
- Modify: `packages/bot/src/rest/dashboard-routes.ts`

- [x] **3.1 The record.**

```ts
type AiActionChip =
  | "analysis" | "decision" | "open" | "close" | "take-profit"
  | "adjust" | "risk" | "cap" | "learning" | "settings" | "denied";

type AiActionRecord = {
  id: string; at: number;
  chip: AiActionChip;
  severity: "info" | "success" | "warning" | "danger";
  botId: number | null; botName: string | null; symbol: string | null;
  smartTradeId: number | null;
  title: string;            // <= 48 chars - the bubble headline
  detail: string;           // <= 140 chars - one sentence, why
  target: { botId?: number; smartTradeId?: number; symbol?: string; widget?: string };
  autonomous: boolean;      // true = autopilot did this unattended
};
```

  `concise(text, max)` truncates on a word boundary with an ellipsis. **The cap is enforced
  at write time**, so a verbose model cannot produce a bubble that outlives its welcome.

- [x] **3.2 The journal.** `AiActivityJournal` — a 500-entry ring, `record()` / `since(cursor)`,
  singleton pinned on `globalThis` exactly as `agentAccess` is, so HMR and duplicate module
  instances share one buffer.

- [x] **3.3 Writers.** Every place the AI actually acts:

| Site | Chip | Example detail |
|---|---|---|
| `hybrid.ts` council verdict | `analysis` | "4 of 5 agents agree: buy BTC/USDT at 0.71 confidence" |
| `hybrid.ts` governor clamp | `risk` | "Size cut to $100 — daily loss budget 62% used" |
| `hybrid.ts` `buy()` | `open` | "Opened $100 BTC/USDT at market" |
| `hybrid.ts` `sell()` | `close` / `take-profit` | "Closed BTC/USDT, +$3.40 (+3.4%)" |
| `hybrid.ts` liquidate | `risk` | "Force-exited — consecutive loss limit hit" |
| `regime.service.ts` cap change | `cap` | "Cap on Grid-BTC cut to $60 — council turned bearish" |
| `learning.service.ts` new entry | `learning` | "3 losses in a row on Grid-ETH — proposal written" |
| `dashboard-routes.ts` control | `adjust` / `settings` / `denied` | "Stopped Grid-ETH at your request" |

- [x] **3.4 Endpoint.** `GET /api/dash/ai/actions?since=&limit=` → `{ actions, cursor }`,
  newest last (so the client appends). Registered in `/manifest`. Read scope, not control.

- [x] **3.5 Tests** (`activity.test.ts`): ring evicts oldest at 501; `since()` is strictly
  greater-than so nothing replays; `concise()` never splits a word and never exceeds max;
  a record with no target still resolves to `{ widget: "aiActions" }`.

**Verify:** `pnpm exec vitest run packages/ai-team packages/bot-templates` ·
`curl -H "Authorization: $ADMIN_PASSWORD" localhost:4000/api/dash/ai/actions` returns records
while a hybrid bot ticks.

---

# Phase 4 — The AI tab: action window + chat shell

**Files**
- Create: `app/dashboard-ui/widgets/ai.js`, `app/dashboard-ui/lib/ai-feed.js`
- Create: `app/dashboard-ui/widgets/ai.render.test.js`
- Modify: `app/dashboard-ui/widgets/index.js`, `app.js`, `styles.css`

- [x] **4.1 One poller, three consumers.** `ai-feed.js` holds the cursor, polls
  `/api/dash/ai/actions` every 3s while visible, and fans out to subscribers — the action
  widget, the spotlight, and the AI news lane. Mirrors the existing `pollTicker` /
  `pollWatchers` pattern in `app.js` rather than adding three timers. Pauses on hidden tab;
  keeps the last good set on a failed poll.

- [x] **4.2 AI Action widget** (`aiActions`, singleton, group `AI`): a live list, newest
  first, each row `[chip] title · bot · symbol · timeAgo`, detail on a second line.
  Filter chips across the top: **All · Trades · Risk · Learning · Settings**. Hovering pauses
  the auto-scroll. Clicking a row spotlights its target on the board. Header meta reads
  "N in the last hour". Empty state names the reason — *"No AI configured"* vs
  *"AI configured, nothing yet"* — because those are different problems.

- [x] **4.3 AI Chat widget** (`aiChat`, singleton, group `AI`): message list, composer
  (Enter sends, Shift+Enter newline), a status line showing `provider · model`, and a
  transcript kept per-instance in localStorage, capped at 50 turns. Backend arrives in
  Phase 5; this phase renders against a stub so the layout is settled first.

- [x] **4.4 Chips are one vocabulary.** `.chip[data-chip="open"]` etc. defined once in
  `styles.css`, reused by the widget, the bubbles and the news lane. Colour never carries
  meaning alone — every chip has its word.

**Verify:** `pnpm exec vitest run app/dashboard-ui` (structure test, following the
`research.render.test.js` shim convention) · AI tab shows live rows while a hybrid bot ticks.

---

# Phase 5 — Chat backend, propose-and-confirm

**Files**
- Modify: `packages/bot/src/rest/dashboard-routes.ts`
- Create: `packages/bot/src/rest/ai-chat.ts` (prompt, context builder, proposal parser)
- Create: `packages/bot/src/rest/ai-chat.test.ts`
- Modify: `app/dashboard-ui/widgets/ai.js`

- [x] **5.1 `POST /api/dash/actions/ai-chat`** — body `{ messages }`. Builds a compact
  context block (fleet totals, per-bot state, open positions, health status, latest
  convictions) from `dashboardService`, calls `chatCompletion(resolveProvider(), …)`.
  Returns `{ reply, proposals, model }`. **Never executes anything.** Own rate limiter,
  20/min. 503 with a plain message when no provider is configured.

- [x] **5.2 The reply contract.** The system prompt asks for prose plus an optional fenced
  JSON block `{"proposals":[{"action","params","why"}]}`. The parser strips the block from
  the displayed prose, so a model that ignores the contract degrades to a chat message
  rather than an error.

- [x] **5.3 The allowlist** — server-side, authoritative:
  `bot.start`, `bot.stop`, `bot.restart`, `bot.setLimits`, `position.recoverStranded`,
  `regime.setPolicy`, `regime.unmanage`, `regime.disarm`, `regime.sync`, `regime.runNow`,
  `learning.evaluate`, `learning.apply`, `learning.revert`, `learning.dismiss`.
  Anything else is dropped and reported to the user as *"the model proposed an action it is
  not allowed to take"*. `bot.purgeTrades` and `freeze` are absent by design.

- [x] **5.4 `POST /api/dash/actions/ai-execute`** — executes exactly one validated proposal
  by dispatching into the **existing** handler for that action, through the existing
  `control()` guard. Records to the AI journal with `autonomous: false`. Returns
  `{ ok, result }` or the same 4xx the underlying action would have returned.

- [x] **5.5 Proposal UI.** Each proposal renders as a card in the reply: the action, its
  parameters in plain words, the model's *why*, and **Do it** / **Dismiss**. `bot.stop`
  carries the same stranded-position warning the fleet widget already shows — the warning
  belongs to the action, not to the button that triggers it.

- [x] **5.6 Tests** (`ai-chat.test.ts`): proposal extraction from well-formed, malformed and
  absent JSON blocks; allowlist rejection; the context builder includes no API key; prose
  survives block-stripping intact.

**Verify:** `pnpm exec vitest run packages/bot` · ask the chat "which bot is losing money?"
then "stop it" — confirm a proposal card appears and **nothing happens until clicked**.

---

# Phase 6 — Autopilot

- [x] **6.1 The switch** lives in the chat widget header, default **off**, **session-scoped**
  — a reload disarms it. Never persisted to localStorage.

- [x] **6.2 Arming** requires an explicit confirmation naming what it may do, that orders are
  real, and that they cannot be undone. Not a silent toggle.

- [x] **6.3 While armed**, proposals execute immediately via the *same* `ai-execute` endpoint
  with `autonomous: true` — every guard, rate limit and audit record still applies. A
  persistent topbar banner reads **AUTOPILOT ARMED — disarm**, and each action gets a
  `danger`-toned chip in the feed and a bubble on the board, so unattended never means
  invisible.

- [x] **6.4 Auto-disarm** on any of: 20 executed actions, 30 minutes, one failed action, a
  server freeze (`/actions/freeze`), or losing the session. Disarming is one click and one
  keystroke (`Esc` on the banner).

- [x] **6.5 It cannot exceed propose-confirm.** Autopilot uses the same allowlist and the
  same endpoint. There is no capability that exists only in autonomous mode — that is what
  makes the switch reviewable.

**Verify:** arm it, ask for a stop on a paper bot, confirm the action lands, the banner
shows, the feed marks it autonomous, and the 20-action counter decrements.

---

# Phase 7 — Highlight the board, explain in a bubble

**Files**
- Create: `app/dashboard-ui/lib/spotlight.js`, `app/dashboard-ui/lib/spotlight.test.js`
- Modify: `widgets/overview.js`, `widgets/trades.js`, `widgets/market.js`,
  `widgets/research.js`, `widgets/learning.js` (anchors only)
- Modify: `app.js`, `styles.css`

- [x] **7.1 Anchors first.** Nothing on the board is addressable today. Add `data-bot-id` to
  fleet rows (`widgets/overview.js:262`) and leaderboard rows, `data-trade-id` + `data-bot-id`
  to open-position and closed-trade rows (`widgets/trades.js`), `data-bot-id` to the grid
  ladder, `data-symbol` to conviction cards, `data-bot-id` to learning entries.
  Attributes only — no behaviour change, no visual change.

- [x] **7.2 Target resolution**, in priority order:
  `[data-trade-id]` → `[data-bot-id]` → `[data-symbol]` → the owning widget card
  `[data-type]` → the AI tab button. Something is always highlightable, so an action is never
  silently unexplained.

- [x] **7.3 The bubble.** A `position: fixed` element anchored to the target's rect, flipping
  side when it would leave the viewport. Contents: the chip, the title, the one-sentence
  detail. **Dwell = `clamp(2000, chars × 45, 4000)` ms** — 2s for *"Closed BTC/USDT, +$3.40"*,
  4s for a full sentence. That is the 2–4s band requested, derived rather than guessed.

- [x] **7.4 The queue.** One bubble at a time; the rest wait. Records older than 30s are
  dropped rather than replayed — a tab returning from the background must not fire a
  40-bubble backlog. Paused while hidden. Reduced motion drops the movement, keeps the bubble.

- [x] **7.5 Ring the element** with the existing `.widget--focus` vocabulary extended to rows,
  so the highlight looks like the deep-link ring the board already uses.

- [x] **7.6 Setting.** *"Highlight AI actions on the board"* in the Board section of the
  settings drawer, on by default. Duration stays derived — it is a legibility property, not
  a preference.

- [x] **7.7 Tests** (`spotlight.test.js`, pure functions only, node env): the dwell formula at
  both clamps; target-selector priority; queue ordering; the 30s stale drop.

**Verify:** trigger a bot stop from chat and watch the fleet row ring and a bubble read
*"Stopped Grid-ETH — you asked me to"* for ~2.4s.

---

# Phase 8 — Split the bottom bar

**Files**
- Modify: `app/dashboard-ui/index.html`, `lib/ticker.js`, `lib/ticker.test.js`, `styles.css`
- Modify: `lib/share.js` (hide the AI lane on shared feeds)

- [x] **8.1 Extract the engine.** `mountTicker()` becomes `mountLane(node, getItems, opts)` —
  the cycling, hold-on-manual-press and visibility logic is already generic and is lifted
  unchanged. `toTickerItems()` and `markRising()` are untouched.

- [x] **8.2 Two lanes.** Left keeps `LIVE TRADES` exactly as it is today. Right is `AI NEWS`,
  fed from the AI action stream filtered to trade-affecting chips (`open`, `close`,
  `take-profit`, `risk`, `cap`, `adjust`), formatted
  `[chip] BOT · SYMBOL · one short sentence · timeAgo`. Its own cycle timer, its own
  prev/next, its own count.

- [x] **8.3 Proportions.** 55/45 with a divider. Under 900px the AI lane collapses to a
  chip-and-count that expands on tap; under 600px it hides, as the trade lane's meta already
  does.

- [x] **8.4 Absent states are honest.** No AI configured → the lane reads *"AI council off"*
  rather than sitting blank. Shared feed → the lane is not mounted at all.

- [x] **8.5 Tests**: extend `ticker.test.js` for `toNewsItems()` — filtering, ordering
  (newest first, unlike the trade lane's worst-first), and the empty case.

**Verify:** `pnpm exec vitest run app/dashboard-ui` · both lanes cycle independently; a hybrid
bot opening a position appears in the right lane within one poll.

---

## Verification gate (all phases)

```bash
pnpm exec vitest run                       # whole monorepo
pnpm typecheck                             # moon run :typecheck
pnpm lint                                  # oxlint
python scripts/check-history.py            # AI endpoint contract
```

Two pre-existing `@opentrader/bot` failures (`trade-executor`, `order-executor`) need a live
database and are unrelated — they must fail *the same way* after this work, not differently.

## Risks

| Risk | Mitigation |
|---|---|
| Tab migration wipes someone's board | v1 key is read, migrated, and **left in place**; migration is unit-tested before anything renders |
| Autopilot acts on a hallucinated bot id | Server-side allowlist + the existing `control()` guard validate every id; a bad id returns 409, which auto-disarms |
| Bubble storm during a volatile hour | One at a time, 30s staleness drop, queue capped, pause on hidden tab |
| Ring buffer empties on restart | Accepted (decision 2). The widget says *"feed starts at daemon start"* rather than implying nothing happened |
| Model list shape change breaks the picker | `listModels()` kept as a thin wrapper; per-wire-shape fixtures in tests |
| Chat leaks the API key into a transcript | Key never leaves the server; the context builder has an explicit deny-list test |

## Out of scope (called out, not silently skipped)

- Streaming chat responses (SSE). Phase 5 is request/response with a thinking state;
  streaming is a clean follow-up once the shape is settled.
- Durable AI action history and charts over time — deferred with decision 2.
- A tool-calling loop (the model calling tools itself). Proposals are a single round trip.
- AI features on shared read-only feeds.
