# SOL Paper Bot Design

Status: Approved on 2026-08-08

## Objective

Create an OpenTrader bot named `SOL` that trades `SOL/USD` on the existing
Coinbase paper account. The design prioritizes bounded downside, fee awareness,
and repeatable validation. It does not promise profit or authorize live trading.

## Scope and safeguards

- Use exchange account ID 1 only after re-verifying that it is a paper account.
- Limit modeled capital, including estimated trading fees, to USD 1,000.
- Do not create, modify, or start any bot connected to real funds.
- Create no duplicate if a bot named `SOL` already exists.
- Keep the bot stopped if historical validation fails or data is inadequate.
- Require a separate explicit decision before any future live deployment.

## Market and strategy selection

### Market

Use `SOL/USD`. It is active on Coinbase and had materially higher observed
volume than the available `SOL/USDT` market during design research.

### Strategy

Use OpenTrader's RSI-filtered DCA template.

The alternatives were rejected for this deployment:

- The plain RSI template has no stop-loss or firm cumulative exposure control.
- The grid template has no hard downside exit and is vulnerable when price
  trends beyond its configured range.

The DCA template provides an entry filter, staged entries, take profit, and stop
loss within one managed smart trade.

## Configuration

- Bot name: `SOL`
- Symbol: `SOL/USD`
- Template: `dca`
- Entry condition: RSI(14) on 4-hour candles less than or equal to 28
- Entry order: market
- Safety-order deviations: 5%, 10%, and 15% below initial entry
- Take profit: 4% above the strategy's managed entry basis
- Stop loss: 20% below initial entry
- Logging: enabled

OpenTrader schedules the DCA template on its one-minute processing loop. The
entry indicator itself remains a 4-hour RSI.

### Position sizing

At creation time, fetch the current `SOL/USD` price and market precision. Set
the entry and each of the three safety orders to the same SOL quantity:

`floor_to_market_precision(1000 / (4 * 1.006 * current_price))`

The 0.6% allowance is Coinbase's published maximum taker fee for the lowest
volume tier. Safety orders execute below the initial price, so this sizing keeps
their modeled aggregate cost within the USD 1,000 ceiling before slippage. The
historical simulation additionally applies conservative slippage.

## Historical validation

OpenTrader's built-in backtest handler is disabled, so validation will use an
independent, read-only simulator that mirrors the approved rules.

- Source at least 18 months of Coinbase `SOL/USD` 4-hour candles.
- Use chronological data only, without future-candle access.
- Reserve the final 30% of candles as an untouched validation segment.
- Apply 0.6% fee per fill and exit plus 0.1% slippage to market and stop fills.
- Model the initial order, all safety orders, average entry, take profit, and
  stop loss exactly as configured.
- Report completed trades, net return, maximum drawdown, win rate, profit
  factor, worst trade, and time in market.

The bot may start only when the validation segment meets all of these gates:

- Positive net return after fees and slippage
- Maximum drawdown no greater than 15% of allocated capital
- Profit factor at least 1.15
- At least 10 completed validation trades
- No incomplete or invalid market-data intervals that affect a trade

Failure of any gate leaves the bot unstarted and is reported to the operator.

## Creation and runtime flow

1. Re-check the exchange account is paper-only and not expired.
2. Confirm `SOL/USD` remains active and fetch current price and precision.
3. Run the historical simulation and evaluate every gate.
4. If all gates pass, create one bot named `SOL` with the approved settings.
5. Read the saved bot back through the authenticated API and compare every
   field with the approved configuration.
6. Start the paper bot.
7. Monitor startup, indicator warm-up, candle polling, and service health for
   at least 60 seconds.

## Failure handling

- API, authentication, exchange, candle, or simulation errors stop the flow.
- Insufficient history is a validation failure, not permission to extrapolate.
- A partial bot record is left stopped and reported; settings are not silently
  relaxed to force a passing result.
- Runtime errors cause the bot to be stopped while the OpenTrader service
  remains available for diagnosis.

## Success criteria

The task is complete when the paper-only configuration passes historical
validation, the `SOL` bot is created exactly once, its saved settings match
this design, it starts successfully, and the monitored runtime contains no
strategy, candle, order, or service errors.
