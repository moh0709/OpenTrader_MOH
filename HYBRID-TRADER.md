# Hybrid Trader

An AI team of specialist agents that decide trades together, running on OpenTrader's
execution engine.

Five agents examine each market independently and vote. A deterministic risk governor
then runs *after* the vote and decides what actually reaches the exchange.

---

## Why this is not a merge of the Cortex repo

The brief was to merge OpenTrader with
[`Cortex-AI-Quant/crypto-arbitrage-bot-automated-trading`](https://github.com/Cortex-AI-Quant/crypto-arbitrage-bot-automated-trading).
That repository has no working code to merge. Its entire `src/` is 53 lines:

- `scanner.py` — "price retrieval from a DEX" is `return random.uniform(140, 145)`.
  A random number generator. Its own comment says *"In the actual code, this is a call
  to Web3"*.
- `executor.py` — `execute_arbitrage()` logs a line and returns a hardcoded
  `{"status": "success", "tx_hash": "0x..."}`. It never signs or sends anything. Its
  comment says *"Here is the logic behind signing a transaction with a private key"*.

The rest is an 11MB demo GIF, screenshots, one commit, and a `SKILL.md` ending in a block
of SEO keywords. Merging it would have added an executor that reports `success` without
trading — the worst possible failure mode in a live system.

So Hybrid Trader implements what that README *claims*, for real: cross-venue spread
scanning, depth-aware "fake spread" rejection, fee- and slippage-adjusted execution, and
an AI decision layer — on top of OpenTrader's proven engine.

---

## Architecture

```
packages/arbitrage/     Depth-aware cross-venue spread engine (pure, no I/O)
packages/ai-team/       The agent council, LLM layer, and risk governor
  └── paper/            Paper-trading simulator + live verification harness
packages/bot-templates/src/templates/hybrid.ts   Strategy wired into OpenTrader
```

### The council

| Agent | Question it answers | Backing |
|---|---|---|
| `market-analyst` | Which way is this trending? | SMA separation, normalised by ATR |
| `quant-analyst` | Is this stretched too far? | Wilder's RSI at extremes |
| `arbitrage-scout` | Is there a risk-free cross-venue edge? | Depth-walked order books |
| `llm-strategist` | What do the conflicting signals add up to? | Claude (`claude-opus-5`) |
| `risk-analyst` | Should we be trading at all right now? | Volatility, exposure, loss state |

Votes are confidence-weighted. Confidence combines **agreement** (how aligned the agents
that voted are) with **coverage** (how much of the council weighed in), so a split council
produces a weak signal rather than an arbitrary winner.

An agent that had no data to work with is marked unavailable and excluded entirely —
distinct from an agent that looked and saw nothing. This matters: the arbitrage scout
answers a different question from the directional agents, so its silence must not be
counted as directional dissent.

### The safety invariant

**The risk governor runs after the vote and can only reduce or refuse.**

Nothing an agent returns — however confident, however well argued, LLM or otherwise —
can raise a limit, enlarge a position, or lift a halt. This is what makes an LLM safe to
have in the loop, and it is enforced by property tests that sweep the full confidence
range against a spread of portfolio states.

The LLM is optional in the strongest sense: every failure path (no credentials, timeout,
rate limit, safety refusal, malformed output) returns `null` and the council proceeds
with its deterministic members. Trading never blocks on an external API.

### Auto-liquidation on a tripped loss limit

A loss limit that only blocks *new* trades leaves the position it was meant to protect
against still riding. When the daily loss budget or the consecutive-loss limit trips and
the bot is holding something, the governor sets `liquidate` and the strategy force-exits
at market on that tick.

The governor decides but does not act — it stays a pure function so the whole rule set
can be exhaustively tested; executing the exit is the strategy's job. The exit reuses the
bot's own smart trade via `sell()`, which is a no-op when an exit is already working, so
repeating it on later ticks cannot stack duplicate orders.

Two deliberate boundaries:

- **The kill switch is a pause, not a liquidation.** It blocks new trades and leaves
  positions alone. Forcing an operator out of the market because they wanted the bot to
  stop thinking would be its own kind of disaster.
- **A flat bot never emits an exit**, however bad the risk state is.

Set `liquidateOnBreach: false` to go back to block-only behaviour.

For closing deals from outside the strategy — Hermes, the API, or an MCP client — see
[CLOSING-DEALS.md](CLOSING-DEALS.md).

---

## Verification

All figures below are from real runs, not estimates.

### Tests

**264 pass across the monorepo.**

Two pre-existing failures remain in `@opentrader/bot`
(`trade-executor`, `order-executor`) — they need a live database
(`PrismaClientInitializationError`) and are unrelated to this work. They failed the same
way before any change here.

### Live market data

Run 2026-08-12 against public endpoints — no API keys, no orders placed.

Five venues returned real order books (Binance, OKX, Kraken, Bybit, Gate.io). Across all
20 directional venue pairs:

**20/20 pairs had a top-of-book spread wider than their true net spread.** The best-looking
pair showed **+1.09 bps** at top of book and **−18.92 bps** after walking real depth and
paying real fees.

Every "opportunity" a naive scanner would have reported was a loser. That gap is the
entire thesis of the arbitrage engine, and it reproduces on live data.

### Paper trading

Full pipeline replayed over real candles, no look-ahead (at step *i* the council sees only
candles `0..i`). Fills charged 10 bps fee + 5 bps adverse slippage. Deterministic council
(no Anthropic credentials were present in this environment).

| Market | Window | Strategy | Buy & hold | Fills | W/L |
|---|---|---|---|---|---|
| BTC/USDT 1h | ~11 days | −0.24% | +0.24% | 8 | 1W / 3L |
| BTC/USDT 4h | ~83 days | −0.14% | −13.49% | 11 | 2W / 5L |
| BTC/USDT 1d | ~400 days | −1.23% | −45.29% | 10 | 1W / 4L |
| ETH/USDT 4h | ~83 days | −0.01% | −5.23% | 13 | 5W / 3L |

**Read this honestly.** The system trades — decisions are coherent, auditable, and
risk-gated. Capital preservation is genuinely strong: −1.23% where holding lost 45.29%.

But it does **not** demonstrate positive alpha in any window tested. Returns cluster just
below zero. On the flat 1h window it underperformed simply holding. The risk limits cap
exposure at 10% of equity, which is what produces both the small losses and the small
gains. Treat the current agent set as a working, safe framework — not a proven edge.

---

## Running it

```bash
pnpm install
npx prisma generate --schema packages/prisma/src/schema.prisma

# Unit tests
npx vitest run --exclude "**/live.test.ts"

# Live verification against real exchanges (public data, no orders)
cd packages/ai-team
HYBRID_LIVE=1 npx vitest run src/paper/live.test.ts

# Other markets and timeframes
HYBRID_LIVE=1 HYBRID_SYMBOL=ETH/USDT HYBRID_BAR=4h HYBRID_CANDLES=500 \
  npx vitest run src/paper/live.test.ts
```

### Enabling the LLM strategist

Set `ANTHROPIC_API_KEY` (or run `ant auth login` and set `HYBRID_LLM=1`). Or point
the council at any other backend — OpenAI, OpenRouter, Google Gemini, a local
Ollama, or an OpenCode gateway. All non-Anthropic backends speak the OpenAI wire
format and are reached through one adapter.

| Variable | Default | Purpose |
|---|---|---|
| `AI_PROVIDER` | auto | `anthropic` `openai` `openrouter` `gemini` `ollama` `opencode-zen` `custom` |
| `AI_MODEL` | per provider | Model id, e.g. `qwen3:14b`, `gpt-5`, `gemini-2.5-pro` |
| `AI_API_KEY` | – | Generic key; provider-specific keys below also work |
| `AI_BASE_URL` | per provider | Override the endpoint (required for `custom`) |

Provider-specific keys recognised by auto-detection: `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY` / `GOOGLE_API_KEY`,
`OPENCODE_ZEN_API_KEY`, `OPENCODE_GO_API_KEY`. Ollama needs no key; set
`OLLAMA_BASE_URL` (e.g. `http://127.0.0.1:11434/v1`) to use it.

Auto-detection picks the first configured provider; an explicit `AI_PROVIDER`
always wins. With nothing configured the council runs deterministic-only.

Anthropic-specific tuning:

| Variable | Default | Purpose |
|---|---|---|
| `HYBRID_LLM` | auto | `1` forces on, `0` forces off |
| `HYBRID_LLM_MODEL` | `claude-opus-5` | Model id |
| `HYBRID_LLM_EFFORT` | `medium` | `low` … `max` |
| `HYBRID_LLM_TIMEOUT_MS` | `12000` | Per-request timeout |
| `HYBRID_LLM_MAX_RETRIES` | `1` | Worst-case wall time is timeout × (retries + 1) |

The strategy loop awaits this call, so the timeout and retry count are deliberately tight.
The system prompt is stable and sits behind a cache breakpoint; only the market snapshot
below it changes per tick.

### Running as a bot

`hybrid` is registered as a standard OpenTrader template ("Hybrid Trader (AI Team)") and
appears alongside the existing strategies. Cross-venue scanning uses the watcher-populated
`ctx.markets`, so additional venues are configured per bot rather than hardcoded.

---

## Migrating an existing OpenTrader install

Hybrid Trader is **additive, not a fork or a replacement**. It is a new strategy plus two
new packages alongside the existing ones.

**No database migration is required.** The prisma schema is untouched. A Hybrid bot is an
ordinary `Bot` row with `template = "hybrid"`; its per-tick state lives in the existing
`Bot.state` JSON column. Existing grid, DCA, and RSI bots are unaffected and keep running.

Only three existing files changed, each by a line or two:

| File | Change |
|---|---|
| `packages/bot-templates/src/templates/index.ts` | one `export` line |
| `packages/bot-templates/package.json` | two workspace deps |
| `packages/bot-templates/tsconfig.json` | two path mappings + refs |

Everything else is new files. Build verified: `tsup` bundles cleanly and the Anthropic SDK
is **inlined into `dist`**, so there is no new runtime dependency to install on the server.
Node 22.12 on the VPS already matches `engines`.

### ⚠️ Do this before merging

`vps2` has **uncommitted production changes that are not in git**, and they do not overlap
my files — but a careless deploy would discard them:

- `packages/prisma/src/schema.prisma` — adds `Bot.maxCapital` and `Bot.minProfit` columns
  plus four indexes on `SmartTrade`/`Order`. **These columns exist in the live database but
  not in git.** Regenerating the Prisma client from the git schema, or running a migration
  against it, risks dropping them.
- `packages/bot/src/channels/candles/candles.channel.ts` — ~92 uncommitted lines.
- `packages/exchanges/src/exchanges/ccxt/paper-exchange.ts`, and frontend assets.

Commit those on the VPS (or cherry-pick them into the branch) **first**. Then the merge is
clean: `git diff` shows zero overlap between that set and anything here.

### Deploy sequence

```bash
# 1. On the VPS — preserve the live-only work first
ssh vps2 'cd /root/.hermes/opentrader && git add -A && git commit -m "chore: capture live changes"'

# 2. Merge hybrid-trader, then build and verify before restarting anything
pnpm install
npx vitest run --exclude "**/live.test.ts"
cd app && npx tsup

# 3. Restart only after the build succeeds
systemctl restart opentrader
```

The kill switch (`killSwitch: true`) blocks all trading at the governor, so a Hybrid bot
can be created and observed in the UI before it is ever allowed to place an order.

## Known limitations

These are real and worth stating plainly.

1. **No demonstrated alpha.** See the table above. The framework is sound; the current
   agent set does not beat its costs.
2. **Cross-venue arbitrage is scanned, not executed.** Capturing a genuine cross-venue
   edge requires pre-funded inventory on both venues simultaneously. The engine prices
   opportunities correctly and the scout votes on them, but execution goes through a
   single venue.
3. **Portfolio state is tracked in strategy state**, not reconciled against actual fills
   from the exchange. The paper simulator tracks it exactly; the live strategy
   approximates it. Wiring `onTradeCompleted` into realised-PnL tracking is the next step
   before any live deployment.
4. **The live arbitrage lane replays one book snapshot** across the backtest window rather
   than historical books, so treat it as a live-scan smoke test rather than a backtested
   result.
5. **Paper-only.** Nothing here has traded real money, and the production bot on `vps2`
   was not touched.
