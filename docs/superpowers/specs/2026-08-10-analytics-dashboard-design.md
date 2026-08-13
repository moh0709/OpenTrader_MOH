# Analytics dashboard

A widget-based analytics dashboard served by OpenTrader itself at `/analytics/`,
backed by new aggregation endpoints, live health checks, closed-deal toasts and a
REST control API for external automation.

## Why

The stock UI lists bots and their status. It shows no profit anywhere, so there
is no way to tell from the application whether the fleet is making money.

Reading the database directly told a story the UI hides completely. At the time
this was built the install had 24 closed round trips worth **+$10.03** — and
**159 open positions holding roughly $44,600**, of which the majority had had
their exit order cancelled. The profit abandoned that way came to **~$38.96,
close to four times everything the fleet had ever earned.**

Three findings shaped the whole design.

### 1. A win rate is meaningless here on its own

A grid bot places its take profit above its entry by construction, so a closed
trade is a win almost by definition. Every trade this install has ever closed was
a win, and it always will be. A dashboard leading with "100% win rate" would be
worse than useless — it would be actively reassuring while the fleet bled.

So profit is reported through three separate lenses, and the UI says as much in
plain language whenever the win rate is a tautology:

| Lens | What it means | Where red appears |
|---|---|---|
| **Realised** | closed round trips | almost never, for a grid |
| **Floating** | entry filled, exit still resting, marked to live price | market moves against an open position |
| **Abandoned** | entry filled, exit cancelled or revoked | a bot was stopped while holding stock |

### 2. "Best bot" depends entirely on the metric

Ranked by total profit the winner was Hermes mini; by trade count it was Bronze
Dud Bolt; by profit per trade, Hermes mini again. Asserting one winner would be a
lie of omission, so the leaderboard ranks by a metric you choose.

### 3. Stopping a bot strands capital

OpenTrader cancels resting take-profit orders when a bot stops, but a position
already bought stays bought. Nothing sells it until a bot covers that price level
again. This is the mechanism behind the abandoned book, and it is why the
dashboard's stop button spells out the consequence before you confirm.

## Architecture

```
Browser  ──/analytics/──────────>  Fastify static root #2   (app/dashboard-ui/)
         ──/api/trpc/dashboard.*─>  tRPC dashboard router    (the dashboard UI)
         ──/api/dash/*───────────>  REST plugin              (external automation)
                                            │
                            services/dashboard-views  (payload assembly)
                                            │
                            services/analytics/*      (pure, unit tested)
                                            │
                                        xprisma  ──>  opentrader.db
```

Both surfaces call the same builders, so the numbers an agent reads are by
construction the numbers on screen. No nginx change was needed: everything sits
under the existing proxy.

### Layout

| Path | Purpose |
|---|---|
| `packages/trpc/src/services/analytics/` | Pure analytics: round trips, positions, bot stats, grid ladder, history, health, events, ticker cache. No I/O, fully unit tested. |
| `packages/trpc/src/services/dashboard.service.ts` | All database and exchange I/O, plus four caches. |
| `packages/trpc/src/services/dashboard-views.ts` | Payload assembly shared by both surfaces. |
| `packages/trpc/src/services/agent-access.ts` | Agent tokens, scopes, rate limiting, audit trail. |
| `packages/trpc/src/routers/private/dashboard/` | tRPC procedures. |
| `packages/bot/src/rest/dashboard-routes.ts` | REST plugin for automation. |
| `app/dashboard-ui/` | The dashboard: vanilla ES modules and CSS, no build step, no external requests. |
| `app/frontend/analytics-link.js` | Injects the nav link into the prebuilt React UI. |

`app/dashboard-ui/` is deliberately **not** inside `app/frontend/`, because
`pnpm ui:sync` runs `rm -rf app/frontend`.

### Caching

Four caches keep a five-second refresh cheap regardless of how many clients watch:

| Cache | TTL | Why |
|---|---|---|
| Analytics context | 2 s | Concurrent clients share one query pass. |
| Tickers | 10 s | One exchange call per symbol. **Non-blocking** after the first load. |
| Bot logs | 10 s | See below. |
| Bot activity | 30 s | Same reason. |
| Database size | 10 min | `dbstat` scans the whole file (~5 s). |

Bot log reads are cached hard because `BotLog` stores a full market-data context
per row, has no index on `botId` or `createdAt`, and is currently **over 700 MB**.
A single `GROUP BY` against it measured ~360 ms and was the dominant cost of a
dashboard poll. Caching took a typical poll from ~1 s to **0.17–0.56 s**.

The table is append-only, so a slightly old view is safe: it delays a bot
start/stop/error notification by at most the TTL. Closed-deal toasts are derived
from order fills, not from `BotLog`, so the notification that matters is immediate.

## The dashboard

19 widgets across five groups, added from a toolbar, dragged to reorder, resized
by a corner handle that snaps to grid columns. Layout, widget set and settings
persist to `localStorage`.

**Overview** — KPI strip (pinned), bot leaderboard, bot fleet
**Trades** — closed trades, open positions, abandoned positions, resting buy orders
**Grid & market** — grid ladder, grid coverage, market prices
**Analytics** — equity curve, win/loss, profit distribution, hold time, activity heatmap, fee impact
**Operations** — health, live events, bot logs

The **grid ladder** is the centrepiece: a vertical price ladder where each rung
shows what it holds, what it is waiting to buy, what it has earned, and where the
live price sits among them. Bots get reconfigured, so orders that match no current
level are reported as off-grid rather than silently dropped from the totals.

### Refresh and toasts

Default 5 s, settable 1 s–60 s or paused. One batched request per tick feeds every
widget. Polling pauses on tab hide and fires immediately on return; widgets hold
their previous render at reduced opacity while refetching rather than flashing a
skeleton.

`dashboard.events` is stateless — it derives events from order fill times rather
than keeping a server buffer, so nothing is missed across a restart and nothing is
replayed after a reload. A cursor of `0` initialises without returning events, so a
first load never dumps the whole history as toasts.

### Colour

Charts follow the validated data-visualisation palette: categorical slots 1–3
(blue, orange, aqua), which clear every all-pairs colourblind gate in both light
and dark modes; a single-hue blue ramp for magnitude; and the reserved status
palette for good/warning/critical. Profit and loss are always accompanied by a
sign or a word, so meaning never rests on hue alone.

## Health checks

Fifteen checks across Daemon, API, Host, Database, Exchange, Bots, Orders and
Integrity, rolled up to OK / WARN / CRIT in the header.

The **paper fill fix** check deserves note. The paper exchange only fills a limit
order by comparing against a bid and ask that the Coinbase feed never sends; the
fallback to last-traded price is what makes limit orders fill at all. That fix has
previously been applied by hand to a built bundle, where any rebuild silently
reverts it. The check inspects the running build rather than trusting it, because
without the fix every other panel would quietly show a fleet that had stopped.

Two checks were corrected after their first live run, both false alarms:

- **Orders awaiting placement** counted every idle order, including take profits
  waiting behind an unfilled entry — which is simply how OpenTrader holds an exit
  until it is needed. It reported 17 stuck orders on a healthy install. It now
  counts an idle order only when it was actually due to be placed.
- **Market data freshness** conflated "we have stopped fetching" with "this pair
  trades quietly". A thinly traded pair sitting a minute between trades tripped a
  warning while polling was perfectly healthy. The two are now measured separately.

A check that cries wolf is worse than no check, so both have regression tests.

## Agent control API

Read-only by default in the UI, with a settings toggle for start/stop behind a
confirmation — plus a machine-facing surface so an external agent can drive it.

```
GET  /api/dash/manifest                 self-describing catalogue of everything callable
GET  /api/dash/snapshot | health | trades | positions | grid | history | events | logs
GET  /api/dash/actions/log              audit trail
POST /api/dash/actions/bot.start        {"botId": 5}
POST /api/dash/actions/bot.stop | bot.restart
POST /api/dash/actions/freeze           {"frozen": true}   (admin only)
```

Auth is the existing admin password, **or** a scoped agent token so automation
never holds it:

```
DASHBOARD_AGENT_TOKENS="research:tok_abc:read,trader:tok_def:control"
DASHBOARD_AGENT_CONTROL=off        # optional: disable all control at boot
```

A `read` token cannot act. Control is rate limited to 30 actions a minute, can be
frozen at runtime without a restart (and an agent cannot unfreeze itself), and
**every attempt — allowed, denied or failed — is recorded and surfaces in the
event feed and as a toast**, so you see it when the agent touches a bot.

## Build and deploy

The build ran in an isolated git worktree, because the running `dist` is **not**
reproducible from `HEAD`:

- the paper-fill fix is staged but uncommitted in `paper-exchange.ts`;
- `candles.channel.ts` carries ~92 lines of uncommitted work — a REST polling
  fallback for exchanges that do not support candle streaming — which **is** in
  the running daemon.

A reproducibility gate built that combination first and diffed the output against
the running bundle. It matched byte for byte except two log-format strings, where
the source build is strictly more correct than the hand-patched original. That
gate is what caught the candles dependency: a build from `HEAD` alone would have
silently removed working code from a live trading daemon.

**Restarting the daemon disables every bot** — expected OpenTrader behaviour — so
the deploy records bot state first and restores it afterwards. Each restart also
cancels resting take profits, which adds to the abandoned book; that cost is
inherent to any restart and is exactly what the abandoned widget exists to show.

Rollback is `app/dist.bak-<timestamp>` plus a restart.

## Out of scope

Flagged, not changed:

1. **`BotLog` retention.** Over 700 MB, effectively the entire database, growing
   without limit on a disk at 81%. It also slows every query touching it.
2. **Missing indexes** on `BotLog(botId)`, `BotLog(createdAt)`,
   `Order(smartTradeId)` and `SmartTrade(botId)`; and `journal_mode=delete`
   rather than WAL. An index on `BotLog` would remove the need for the caching
   above.
3. **The abandoned-exit behaviour itself.** Leaving a bought position with no
   sell order when a bot stops is arguably a bug in bot lifecycle handling, not
   just a reporting gap.
