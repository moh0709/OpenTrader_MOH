# The trading head

An AI that runs the desk rather than advising it. It watches a list of markets,
gathers evidence from inside and outside the system, convenes the council,
decides what a trader would actually do, and does it — opening positions,
taking profit, trailing winners, cutting losers, and standing down when a limit
trips. Continuously, on its own.

It ships **disarmed and in observe mode**. Arming it and letting it trade are two
separate, explicit decisions.

---

## What was missing

Everything in OpenTrader before this reacted to something.

| Component | What triggers it | What it decides |
|---|---|---|
| Grid / DCA / RSI bots | a candle closing | where to place the next rung |
| Hybrid Trader | a candle closing | buy, sell or hold *this bar* |
| Regime governor | a research conviction landing | how far to reduce a bot's capital cap |
| Learning loop | a losing streak appearing | a settings proposal for a human to apply |

None of them decides to trade. A strategy answers "given that it is my turn to
act, what do I do?" — the turn is handed to it. The regime governor is
[reduce-only by construction](packages/regime/src/governor.ts): it can throttle
capital and can never commit it. The learning loop writes proposals and waits.

The gap is the trader: something that decides *whether this is a moment worth
acting on*, manages positions across their whole life rather than one bar at a
time, and is answerable for the book rather than for a single signal.

---

## The pass

Once a minute, per symbol on the watchlist:

```
gather ──▶ deliberate ──▶ plan ──▶ act (or not) ──▶ write it down
```

**1. Gather** — four independent sources, none of which can block the others:

| Source | What it contributes | Where it lives |
|---|---|---|
| Exchange candles | price, trend, volatility | the venue the bot routes through |
| TradingView screener | an outside technical rating across 6 timeframes | `packages/market-intel/src/tradingview.ts` |
| Research council | the twice-daily TradingAgents conviction | mirrored in `RegimeConviction` |
| Fear & greed index | market-wide sentiment, as a brake | `packages/market-intel/src/sentiment.ts` |

The two public sources are cached at their own refresh rates — five minutes for
TradingView, thirty for sentiment — because neither recomputes at loop speed and
polling a free service every minute buys nothing. A reading that has gone stale
past a hard age limit is not served at all, so a vendor being down degrades the
council rather than misleading it.

**2. Deliberate** — the council votes on identical evidence. Three new seats join
the four that already existed:

| Agent | Question it answers | Weight |
|---|---|---|
| `market-analyst` | which way is this trending? | 1.0 |
| `quant-analyst` | is it stretched too far? | 1.0 |
| `arbitrage-scout` | is there a risk-free cross-venue edge? | 1.5 |
| **`technical-analyst`** | **what does an outside read say, across timeframes?** | **1.0** |
| **`research-council`** | **what did the deep research run conclude?** | **1.25** |
| **`sentiment-analyst`** | **is the crowd at an extreme worth fading?** | **0.5** |
| `llm-strategist` | what do the conflicting signals add up to? | 1.5 |
| `risk-analyst` | should we be trading at all? | advisory, can veto |

Each of the three new agents reports itself **unavailable** when its evidence is
missing or stale, and an unavailable agent is excluded from the tally entirely
rather than counted as a dissenting hold. That is what lets one council serve
both the Hybrid strategy — running on candles alone — and the head, running on
everything.

The technical analyst scores **alignment across timeframes**, not the headline
rating. A market rated "buy" only on the 5-minute is a different proposition from
one that is a buy out to the week, and sizing them the same is how a desk gets
caught by a pullback it could have seen.

The research analyst **decays its confidence with age**: yesterday's research is
worth something, but less than this morning's, and past 26 hours it leaves the
table.

The sentiment analyst **never votes with the crowd**, and only speaks at all when
the index is at an extreme.

**3. Plan** — `planPosition()` in
[`packages/ai-team/src/head.ts`](packages/ai-team/src/head.ts) is a pure function
from (snapshot, verdict, position, limits, book) to one action. Ordering is the
design:

```
portfolio halts        daily loss or losing streak → flatten the book
  ↓
manage what we hold    stop out · take profit · trail · time stop · council flip
  ↓
look for a new one     kill switch · veto · signal · confidence · cooldown ·
                       outside veto · position count · exposure · daily budget
```

A head that looks for entries before checking its exits is a head that adds to a
losing book.

**4. Act, or not.** In `live` mode the plan reaches the exchange through the same
[opener](packages/bot/src/trade-opener.ts) and
[closer](packages/bot/src/trade-closer.ts) an operator's own click uses — the
limits are re-checked there against the database, independently of the planner.
In `observe` mode nothing is placed and the decision is still written down.

**5. Write it down.** Every decision, including every "hold", lands in
`AutopilotJournal` with the council's opinions and the outside readings behind
it. A log that only records trades hides the reasoning that mattered most: why
the desk stood still while the market moved.

---

## What it can do

| Action | When |
|---|---|
| `open` | council is buy above the confidence floor, timing and budget allow |
| `add` | same, into an existing position — off unless `allowPyramiding` |
| `take_profit` | net profit reaches the target. Does not ask the council again |
| `trail_exit` | a winner gives back too much of its peak while still net positive |
| `stop_out` | net loss reaches the stop. Not subject to the minimum hold |
| `close` | the council turned, and the position has been held long enough |
| `close` (time stop) | open for days without working; the capital is released |
| `flatten` | a daily-loss or losing-streak limit tripped while holding |
| `hold` | most minutes |

Profit and loss is computed **net of fees** throughout — the entry fee actually
charged, plus an estimated exit fee from `roundTripFeeBps` — so a "1.5% target"
is 1.5% in the account, not 1.5% on the chart.

The trailing high-water mark is read off the candles rather than remembered
between passes. A peak held in memory is wrong after every restart, and one held
in a column is another thing to keep consistent with the exchange. It can never
be below the entry price, so a trail cannot fire on a position that only lost.

---

## Timing: why it mostly does nothing

Most minutes are not the minute to act, and the planner says so explicitly rather
than trading because it was asked to decide:

- **Confidence floor** on entries (`minConfidence`), and a separate, lower one on
  closing for a change of view (`minExitConfidence`).
- **Cooldown** after acting on a symbol (`cooldownMs`, default 10 min). Only
  *executed* decisions start one — a pass that decided to hold is not an action,
  and letting it start a cooldown would mean the head talks itself out of trading
  and then blocks itself from reconsidering.
- **Minimum hold** before a change of view may close a position (`minHoldMs`,
  default 15 min). A position closed on the first wobble never gets to be right.
  The stop is deliberately exempt.
- **Outside veto**: an entry into a market that a broad, aligned, multi-timeframe
  external read calls a sell is refused outright, whatever the vote was.
  Corroboration is optional; contradiction is disqualifying.

### A note on the confidence numbers

`minConfidence` defaults to **0.45**, not something that sounds more prudent, and
that is a considered choice. The council's confidence is not a probability:
`tallyVotes` multiplies how aligned the voting agents are by the square root of
how much of the council voted at all, so a verdict is discounted twice — once for
disagreement, once for silence. In practice a well-corroborated entry lands
around 0.5–0.6 and a decent-but-thin one around 0.3. A floor of 0.6 is not a
cautious head; it is a head that never trades, which is a different kind of
failure.

---

## Safety

The invariant is inherited from the two governors that came before it, not
reinvented:

> **The plan can only reduce or refuse relative to the operator's limits.**

- Every limit lives in the `AutopilotPolicy` table, set from the dashboard.
  Nothing a model returns can widen one.
- `saveAutopilotPolicy` **clamps** every number into bounds rather than refusing,
  so a fat-fingered limit becomes a sane one instead of a failed request that
  leaves the head silently on its old settings.
- Anything that is not exactly `"live"` in the `mode` column means observe. A typo
  must not be the thing that starts trading real money.
- The watchlist is the **allowlist**: the opener refuses a symbol the head was
  never pointed at.
- Orders go through two independent gates — the pure planner, and the opener's
  own limit check, which reads the database itself.
- The **kill switch** blocks new entries and *keeps managing open positions*. A
  position whose stop has been switched off is not paused, it is unmanaged.
- **Disarming stops it deciding. It closes nothing.** Open positions keep their
  resting exits.
- The chat assistant may propose `autopilot.disarm` and `autopilot.runNow` and
  nothing else. Arming it and changing its limits are not on the allowlist, and
  their absence is the point: a model that could widen its own risk budget or
  flip itself from observe to live would make every other guarantee conditional
  on its judgement.

Property tests sweep the full confidence range against a spread of portfolio
states and assert the size never exceeds the per-position cap, the exposure
headroom, or the day's opening budget.

---

## Operating it

Everything is one endpoint to read and four to change.

```bash
# What is it doing, what does it hold, and why?
curl -s -H "Authorization: $ADMIN_PASSWORD" http://localhost:4000/api/dash/autopilot | jq

# Point it at some markets and a bot to route through
curl -X POST http://localhost:4000/api/dash/actions/autopilot.setPolicy \
  -H "Authorization: $ADMIN_PASSWORD" -H 'content-type: application/json' \
  -d '{"symbols":["BTC/USDT","ETH/USDT"],"botId":17,"timeframe":"1h",
       "maxPositionQuote":50,"maxTotalExposureQuote":200,"maxDailyLossQuote":25}'

# Watch it think, without letting it trade
curl -X POST http://localhost:4000/api/dash/actions/autopilot.arm \
  -H "Authorization: $ADMIN_PASSWORD" -H 'content-type: application/json' -d '{"mode":"observe"}'

# Decide now instead of waiting for the interval, and see the outcome per symbol
curl -X POST http://localhost:4000/api/dash/actions/autopilot.runNow \
  -H "Authorization: $ADMIN_PASSWORD" -d '{}'

# Let it trade
curl -X POST http://localhost:4000/api/dash/actions/autopilot.arm \
  -H "Authorization: $ADMIN_PASSWORD" -H 'content-type: application/json' -d '{"mode":"live"}'

# Stop it deciding. Positions stay open, exits keep working.
curl -X POST http://localhost:4000/api/dash/actions/autopilot.disarm \
  -H "Authorization: $ADMIN_PASSWORD" -d '{}'
```

The `botId` supplies the exchange account, the credentials and the owner. Give
the head a **dedicated bot** where you can: it only ever manages deals tagged
into its own `auto:` lane, so a strategy running on the same bot is untouched —
but keeping them apart makes the book far easier to read.

### Recommended first week

1. `setPolicy` with your symbols, a small `maxPositionQuote`, and the default
   limits.
2. Arm in **observe**. Leave it a day or two.
3. Read `GET /api/dash/autopilot` — the `decisions` array is every call it would
   have made, with its reason. If those reads look wrong, the limits are wrong,
   not the market.
4. Go **live** with a `maxDailyOpenNotionalQuote` you would be relaxed about
   losing entirely.

### Install

Both tables are additive and applied the way `RegimePolicy`, `AiSettings` and
`AiAction` were:

```bash
npx prisma db push --schema packages/prisma/src/schema.prisma
```

Nothing breaks if they are absent — the head reports itself unconfigured and does
not run.

---

## Verification

All figures from real runs.

**879 tests pass across the monorepo**, up from 799 before this work — 80 new,
none failing. Two pre-existing `@opentrader/bot` executor tests remain skipped;
they need a live database and are unrelated.

The new coverage: 33 on the position planner (including a property sweep of the
whole confidence range against a spread of portfolio states), 17 on the three
outside agents, 18 on the intelligence sources, 12 on the policy reader and the
high-water mark.

**Live sources**, run 2026-09-04 against the real endpoints
(`INTEL_LIVE=1 npx vitest run --root packages/market-intel src/live.test.ts`):

```
BTC/USDT: 0.334 (buy), 6 timeframes, 100% aligned, RSI 73.2, ADX 45.2, close 81374.54
ETH/USDT: 0.263 (buy), 6 timeframes,  83% aligned, RSI 67.4, ADX 47.4, close 2505.25
sentiment: 65/100 — Greed
```

**End to end against a scratch database**, with the exchange stubbed and
TradingView live:

- Seeds a disarmed policy on first read, and reports precisely why it is idle at
  each stage — disarmed → no symbols → no bot → bot missing.
- Clamps a reckless policy: `maxPositionQuote: 999999999 → 100000`,
  `minConfidence: 5 → 1`, `intervalSec: 0 → 10`, `mode: "LIVE" → observe`,
  `timeframe: "7h" → 1h`.
- In live mode it opened a real deal: `auto:1788474107192`, Buy Market
  0.00050318 BTC, 37.15 quote — sized at exactly `maxPositionQuote × confidence`
  — journalled against its `smartTradeId`.
- Managing a filled position at three different prices: `hold` at −0.39%,
  `take_profit` at +1.85%, `stop_out` at −3.63%.

### What is not verified

1. **No live money has moved through it.** The opener and closer are the same
   code paths that have been exercised in production for manual trades, but the
   head has not itself placed an order at a real exchange.
2. **No demonstrated alpha.** The framework decides coherently and is risk-gated;
   whether this agent set makes money is an open question, and the honest answer
   is a month of observe mode on your own markets. The
   [Hybrid Trader paper results](HYBRID-TRADER.md#paper-trading) are the closest
   prior evidence, and they show capital preservation rather than edge.
3. **Long-only, spot.** There is no short side. A bearish council leads to not
   holding, not to being short.
4. **One position per symbol** is what the exit rules manage. With pyramiding on,
   additional entries are opened but the oldest is the one trailed and stopped.
5. **TradingView is a public, unauthenticated endpoint** that can change without
   notice. Every failure resolves to the council voting without it, and
   `src/live.test.ts` is how you find out that it has moved.
