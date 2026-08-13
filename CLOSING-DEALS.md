# Closing deals — API and MCP server

Force take profit (close deal) for OpenTrader, exposed both as tRPC endpoints and
as an MCP server for Hermes.

---

## The gap this fills

Before this, the API could start and stop bots but **could not touch an individual
deal**. `smartTradeRouter` had three endpoints, all read-only queries, and of the
14 mutations in the whole API not one operated on a trade.

The thing that looked like it would work isn't a close. Internally `Trade.cancel()`
calls `cancelOrders()`, which cancels resting orders. If the entry has already
filled, that **kills the take-profit order and leaves the position open with
nothing managing it** — strictly worse than doing nothing.

A real close is three steps, and none of them existed:

1. Cancel the resting take-profit (and any stop loss) so nothing can double-sell
2. Place a **market exit** for the filled entry quantity
3. Let the trade complete so the bot moves on

---

## Semantics

`closeSmartTrade` decides what to do from the order states, not from a status flag:

| Situation | What happens | Outcome |
|---|---|---|
| Entry not filled | Cancels every resting order. **Never sells** — nothing was held. | `canceled_unfilled` |
| Entry filled, TP resting | Cancels the TP and stop loss, exits the entry quantity | `closed` |
| Entry filled, no TP order | Creates an exit order and places it | `closed` |
| Entry filled, TP already filled | Nothing. Safe to call twice. | `already_closed` |
| Entry cancelled | Nothing. | `already_closed` |

Two deliberate decisions worth knowing:

**A filled entry with no take-profit order still gets closed.** OpenTrader's
`TradeExecutor` reports that state as `Finished` — true from the strategy's point
of view (it bought and never intended to sell), but the account is holding
inventory with no exit. Short-circuiting on `Finished` would make exactly those
positions impossible to close, which is the case a force-close exists for.

**The live trade queue is stopped first.** A running bot has a `Trade` instance
reacting to ticker and order events and could place a take profit while we are
closing. The closer emits `cancelTrade` before touching the exchange; it is a
no-op when the bot is stopped, so closing works either way.

### market vs limit

`mode: "market"` (default) cancels the resting exit and sells immediately —
guaranteed exit, taker fee. `mode: "limit"` rests the exit on the passive side of
the book for the maker fee, but **may never fill**.

On OKX spot the difference is taker 0.10% vs maker 0.08% — about **2 basis
points, or $0.02 per $100 closed**. The spread is negligible on liquid pairs
(BTC/USDT quotes ~$0.01–0.10 wide on a $63k price). If the intent is to be *out*
of a position, take the market exit; 2bps is far cheaper than a limit order that
never fills during a move. If the ticker is unavailable, limit mode falls back to
market rather than failing.

---

## tRPC endpoints

Hermes already calls `https://ai.omniware.dk/api/trpc/bot.list` with an
`Authorization: <ADMIN_PASSWORD>` header. These work the same way, as **POST**
mutations.

| Endpoint | Input | Purpose |
|---|---|---|
| `smartTrade.close` | `{ smartTradeId, mode? }` | Force take profit on one deal |
| `smartTrade.closeBotTrades` | `{ botId, mode? }` | Close every open deal for a bot |
| `smartTrade.closeAll` | `{ confirm: true, mode? }` | Panic close everything |

`closeAll` requires `confirm: true` — enforced by the schema *and* re-checked in
the handler, so the guarantee doesn't depend on validation being wired correctly.

The batch endpoints return a per-deal result plus a summary, so a partial failure
is visible rather than silent:

```json
{ "ok": true, "total": 3, "closed": 1, "cancelled": 1, "alreadyClosed": 1,
  "results": [ { "smartTradeId": 11, "outcome": "closed", "message": "..." } ] }
```

```bash
# Close one deal (superjson wire format: input is wrapped in {"json": ...})
curl -X POST https://ai.omniware.dk/api/trpc/smartTrade.close \
  -H "Authorization: $ADMIN_PASSWORD" -H 'content-type: application/json' \
  -d '{"json":{"smartTradeId":42,"mode":"market"}}'
```

### How this avoids a dependency cycle

`packages/bot` imports `appRouter` from `@opentrader/trpc` in order to serve it,
so trpc cannot import bot back. The contract is declared in
`packages/trpc/src/services/trade-ops.registry.ts` and the daemon registers its
implementation during `Platform.bootstrap()`. If the API is somehow up without the
daemon, the endpoints fail loudly rather than pretending to close something.

---

## MCP server

`packages/mcp-server` is a stdio MCP server. Hermes launches it as a subprocess;
it talks to OpenTrader over loopback, so nothing new is exposed publicly.

### Tools

| Tool | Kind | Purpose |
|---|---|---|
| `list_bots` | read | Every bot with id, strategy, symbol, running state |
| `get_bot` | read | One bot's full config |
| `list_open_deals` | read | A bot's open deals — source of `smartTradeId` |
| `get_bot_logs` | read | Recent log lines for a bot |
| `start_bot` / `stop_bot` | write | Bot lifecycle |
| `close_deal` | **destructive** | Force take profit on one deal |
| `close_bot_deals` | **destructive** | Close every deal for one bot |
| `close_all_deals` | **destructive** | Panic close everything (needs `confirm: true`) |

The three closing tools carry `destructiveHint: true` and their descriptions
state plainly that they place real, irreversible orders. `stop_bot`'s description
says explicitly that stopping a bot does **not** close its positions — the single
most likely thing for an agent to get wrong.

### Setup

```bash
cd packages/mcp-server && npx tsup    # produces dist/cli.mjs (self-contained)
```

Register with Hermes:

```json
{
  "mcpServers": {
    "opentrader": {
      "command": "node",
      "args": ["/root/.hermes/opentrader/packages/mcp-server/dist/cli.mjs"],
      "env": {
        "OPENTRADER_ADMIN_PASSWORD": "<the admin password>",
        "OPENTRADER_URL": "http://127.0.0.1:8000"
      }
    }
  }
}
```

| Variable | Default | Purpose |
|---|---|---|
| `OPENTRADER_ADMIN_PASSWORD` | *(required)* | Sent as the `Authorization` header. Falls back to `ADMIN_PASSWORD`. |
| `OPENTRADER_URL` | `http://127.0.0.1:8000` | Daemon base URL — loopback by default |
| `OPENTRADER_TIMEOUT_MS` | `30000` | Per-request timeout |

The server refuses to start without a password rather than failing later on every
call. `stdout` is the MCP protocol channel, so all diagnostics go to `stderr`.

---

## Verification

- **13 unit tests** on the close state machine, covering the two ways this loses
  money: selling a position that was never opened, and double-selling one already
  closed.
- **11 unit tests** on the tRPC client (superjson envelope, auth header, error
  surfacing).
- **8 end-to-end tests** that spawn the built server over stdio, drive it with a
  real MCP client against a stub OpenTrader, and assert the exact HTTP calls —
  procedure, method, body, and auth header.
- Full suite: **251 passing**. The 2 pre-existing `@opentrader/bot` executor
  failures need a live database and are unrelated.

## Limitations

1. **Not exercised against a live exchange.** The state machine is unit-tested
   with a mocked `OrderExecutor`; no real order has been placed by this code.
   Close one small deal manually before letting Hermes use it.
2. **Fill confirmation is best-effort.** Market orders return `Placed`; the
   exchange decides when they fill. The result reports `filled: false` if the
   fill has not landed by the time the call returns — that is not a failure, and
   the normal order stream completes the trade.
3. **Long-only exit sizing.** The exit quantity is the entry order's quantity.
   Partial fills are not modelled, because OpenTrader's `Order` has no
   `filledQuantity` field.
