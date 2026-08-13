# Operating OpenTrader — a manual for AI agents

You are controlling a system that trades real money on a live exchange. Every
order you place or cancel is real and cannot be undone. Read the **Rules** and
**Traps** sections before you act; they exist because each one has already
caused a real problem.

---

## 1. What you are controlling

**Bots** run trading strategies (grid, DCA, RSI, Hybrid). Each bot belongs to an
exchange account, trades one symbol, and decides its own entries and exits by its
strategy. Bots are autonomous — you do not need to drive them.

**Deals** (called *smart trades* in the API) are individual positions. A deal has
an **entry order** and usually a **take-profit order**. When the entry fills you
are holding inventory; when the take profit fills the deal is finished.

Your job is normally to **observe** and to **intervene when asked**. The bots do
not need your help to trade.

### Two lanes, and the difference matters

| | Strategy lane | Manual lane |
|---|---|---|
| Who opens | The bot, by its own rules | You, via `open_deal` |
| Who exits | The bot's strategy | **Nobody, unless you set a take profit** |
| Deal `ref` | Set by the strategy | Starts with `manual:` |
| Counts against manual budget | No | Yes |

A deal you open is *attached* to a bot (it borrows that bot's exchange account and
symbol) but is **not managed by that bot's strategy**. The strategy only ever
touches deals it created itself. This has one consequence you must not forget:

> **A manual deal opened without `takeProfitPrice` has no automatic exit. It will
> sit open until you close it.**

---

## 2. Connecting

Two equivalent routes. Prefer MCP if it is available to you.

**MCP (stdio).** Tools are listed in section 4. Configuration:

```json
{
  "mcpServers": {
    "opentrader": {
      "command": "node",
      "args": ["/root/.hermes/opentrader/packages/mcp-server/dist/cli.mjs"],
      "env": {
        "OPENTRADER_ADMIN_PASSWORD": "<admin password>",
        "OPENTRADER_URL": "http://[::1]:8000"
      }
    }
  }
}
```

**REST (tRPC over HTTP).** Base URL `https://ai.omniware.dk/api/trpc`.
Authentication is the admin password in an `Authorization` header — no `Bearer`
prefix.

Input is wrapped in a superjson envelope, `{"json": ...}`, in both directions.
Queries are GET with the input URL-encoded; mutations are POST.

```bash
# Query
curl -H "Authorization: $ADMIN_PASSWORD" \
  "https://ai.omniware.dk/api/trpc/bot.list?input=%7B%22json%22%3Anull%7D"

# Mutation
curl -X POST -H "Authorization: $ADMIN_PASSWORD" -H 'content-type: application/json' \
  -d '{"json":{"smartTradeId":649,"mode":"market"}}' \
  "https://ai.omniware.dk/api/trpc/smartTrade.close"
```

Results come back as `result.data.json`. Errors come back as `error.json.message`.

> **On the host itself use `http://[::1]:8000`, not `127.0.0.1:8000`.** The daemon
> binds IPv6 loopback and a different application holds the IPv4 address on the
> same port. Pointing at IPv4 reaches the wrong service entirely.

---

## 3. Rules

These are not suggestions. Each one prevents a specific, expensive mistake.

1. **Never open or close a position that the user did not ask for.** You may
   observe, summarise and recommend freely. Acting on your own reading of the
   market is out of scope, always.

2. **Look before you act.** Call `list_open_deals` before closing anything. Use
   the `smartTradeId` you actually saw; never guess an ID.

3. **Closing is immediate, not profitable.** A force close exits at the current
   price. If the market is below entry you are realising a loss. Say so before
   doing it, and do not close several deals to "clean up".

4. **Stopping a bot does not close its positions.** `stop_bot` stops the bot from
   *deciding*; everything it already holds stays on the exchange. To exit
   positions you must close them.

5. **A refusal is an answer.** If a request is refused for exceeding a limit, do
   not retry with a smaller size unless the user asks. Report the refusal and its
   reason.

6. **Never call `close_all_deals` on your own initiative.** It closes every
   position on every bot and account. Only when the user has unambiguously asked
   to exit everything.

7. **Report what happened, including losses.** If a close realised −$4.23, say
   −$4.23. Do not round it away or describe a loss as "completed successfully"
   without the number.

---

## 4. Tools

### Reading — always safe

| Tool | REST | Input | Returns |
|---|---|---|---|
| `list_bots` | `bot.list` | – | Every bot: id, name, template, symbol, enabled |
| `get_bot` | `bot.getOne` | `botId` (bare number) | One bot's full configuration |
| `list_open_deals` | `bot.openSmartTrades` | `{botId}` | That bot's open deals, with `smartTradeId` |
| `get_bot_logs` | `bot.getBotLogs` | `{botId, limit, cursor:null}` | Recent log lines |

### Bot lifecycle — reversible

| Tool | REST | Input | Effect |
|---|---|---|---|
| `start_bot` | `bot.start` | `{botId}` | Bot resumes evaluating its strategy |
| `stop_bot` | `bot.stop` | `{botId}` | Bot stops evaluating. **Positions stay open.** |

### Closing — real orders, irreversible

| Tool | REST | Input |
|---|---|---|
| `close_deal` | `smartTrade.close` | `{smartTradeId, mode?}` |
| `close_bot_deals` | `smartTrade.closeBotTrades` | `{botId, mode?}` |
| `close_all_deals` | `smartTrade.closeAll` | `{confirm: true, mode?}` |

`mode` is `"market"` (default) or `"limit"`.

- **`market`** — cancels the resting exit and sells now. Guaranteed exit, taker
  fee. Use this whenever the point is to be *out*.
- **`limit`** — rests the exit on the passive side of the book. Cheaper, but
  **may never fill**. Only when there is no urgency.

Measured on this account: maker **0.20%**, taker **0.35%** — a 15bps difference,
about $0.15 per $100 closed. Worth considering on a large position; not worth
delaying an urgent exit over.

What closing does, decided from the order state:

| Situation | Result | Outcome |
|---|---|---|
| Entry not filled | Cancels resting orders. **Never sells** — nothing was held | `canceled_unfilled` |
| Entry filled, exit resting | Cancels the exit, sells at market | `closed` |
| Entry filled, no exit order | Creates an exit and places it | `closed` |
| Already closed | Nothing. Safe to call twice | `already_closed` |

### Opening — real orders, irreversible

| Tool | REST | Input |
|---|---|---|
| `open_deal` | `smartTrade.open` | `{botId, side, quantity｜quoteAmount, orderType?, price?, takeProfitPrice?, symbol?}` |

- `botId` — supplies the exchange account and default symbol
- `side` — `"buy"` or `"sell"`
- Size — give **either** `quoteAmount` (spend N of the quote currency, e.g. 50
  USDT) **or** `quantity` (N of the base currency, e.g. 0.001 BTC)
- `orderType` — `"market"` (default) or `"limit"`; a limit needs `price`
- `takeProfitPrice` — **strongly recommended.** Without it the position has no
  automatic exit

Hard limits, enforced before anything reaches the exchange. You cannot widen them:

| Limit | Default |
|---|---|
| Per-order notional | 100 quote |
| Concurrent manual positions | 5 |
| Daily manual notional | 1000 quote |
| Symbol allowlist | unrestricted |

**It refuses rather than resizes.** An over-limit request returns `ok: false`
with the reasons; nothing is opened.

---

## 5. Recipes

**Report on the desk**
```
list_bots → for each enabled bot: list_open_deals
```
Summarise: how many bots, how many open positions, which symbols. Do not act.

**Close one deal the user named**
```
list_open_deals(botId)        → confirm the deal exists, note entry price
                              → tell the user the likely P&L at current price
close_deal(smartTradeId)      → only after they confirm
list_open_deals(botId)        → verify it is gone
```

**Exit a whole strategy**
```
close_bot_deals(botId)   → exits the positions
stop_bot(botId)          → stops it opening new ones
```
Both are needed. Either alone leaves the job half done. Note that
`close_bot_deals` also closes any manual deals attached to that bot.

**Open a position the user asked for**
```
open_deal({botId, side, quoteAmount, takeProfitPrice})
```
Include `takeProfitPrice` unless the user explicitly wants to manage the exit
themselves. Report the deal id and the filled size.

**Explain why a bot is not trading**
```
get_bot(botId) → is it enabled?
get_bot_logs(botId) → what is the strategy saying?
```
A bot that is disabled after a restart is normal (see Traps).

---

## 6. Traps

Things that have actually gone wrong, or will.

**A restart disables every bot.** After the daemon restarts, all bots come back
`enabled: false` and must be started again with `start_bot`. This is the system's
own orphan-cleanup behaviour, not a fault. If several bots are unexpectedly
disabled, check whether the service restarted before concluding anything is
broken.

**`stop_bot` does not close positions.** The most common and most expensive
misunderstanding. Stopping a bot leaves everything it holds on the exchange with
nothing managing it.

**Manual deals have no automatic exit.** Covered above; it bears repeating because
the position will sit there indefinitely.

**A close that reports `filled: false` is not a failure.** Market orders return
`Placed`; the exchange decides when they fill. The order stream completes the
trade shortly after. Check the deal again rather than closing it a second time.

**`already_closed` means the work was already done.** Not an error. Do not retry.

**Cancelling is not closing.** If you see any tool or endpoint described as
cancelling a trade, it cancels resting *orders*. On a filled entry that leaves the
position open and unmanaged — worse than doing nothing.

**Deal IDs are not bot IDs.** `close_deal` takes a `smartTradeId` from
`list_open_deals`. Passing a bot id will close an unrelated deal or fail.

---

## 7. When something looks wrong

Prefer reading over acting. In order:

1. `get_bot` — is the bot enabled?
2. `get_bot_logs` — what does the strategy say about itself?
3. `list_open_deals` — what is actually held?

Then **report to the user with the numbers you found**. Do not attempt repairs by
opening or closing positions. If you believe an intervention is needed, say what
you would do and why, and wait for an answer.

The one exception is an explicit standing instruction from the user, such as a
loss limit they have told you to enforce. Even then, state what you are doing and
why before you do it.

---

## 8. Honest limitations

Know these so you do not misreport what the system can do.

- **You cannot re-enter a closed position automatically.** Closing and opening are
  separate lanes. A closed grid level is replaced only when the grid's own
  conditions trigger.
- **Cross-venue arbitrage is scanned, not executed.** The engine prices real
  opportunities across venues, but execution goes through a single venue.
- **Manual position sizing is long-only in effect.** Exit quantity equals entry
  quantity; partial fills are not modelled.
- **Opening has not yet been exercised on a live exchange.** Closing has (deal
  #649, filled, −$4.23 realised). Treat the first live open as a test.
