# Live RSI Display Design

## Goal

Show the RSI value that a DCA bot actually used for its entry decision on the bot details page. The display must update without reloading the page, explain the configured entry condition, and remain read-only so a UI failure cannot affect trading.

## User experience

For a DCA bot with an RSI entry rule, add a row directly below **Timeframe** in the right-hand bot summary:

```text
RSI(14) · 4h     56.22
Waiting for <=28  Updated 12s ago
```

The row uses three states:

- **Condition met** when the current value satisfies the configured operator and threshold.
- **Waiting** when the value is current but the condition is not met.
- **Unavailable** when the bot has not produced a value yet; **Stale** when the last value is more than two minutes old.

The page checks for a new snapshot every 15 seconds. The value changes whenever the running bot processes a new one-minute candle and recalculates its configured indicator. A browser refresh and client-side route navigation both trigger an immediate refresh.

## Approaches considered

### 1. Persist the engine's indicator snapshot and render it (recommended)

After the DCA strategy calls `useIndicators`, store the returned values and timestamp in the bot's existing JSON state. A small, isolated frontend module reads `bot.getOne` and renders the matching configured RSI rule.

This guarantees the displayed number is the exact number used by the strategy. It adds no market-data requests and does not duplicate candle aggregation or RSI calculations in the browser.

### 2. Recalculate RSI in the browser

The browser could call the existing candle API, aggregate candles, and calculate RSI itself. This avoids changing strategy state but can disagree with the engine because the engine aggregates its warmed one-minute candle stream from its own bucket boundary. It also creates unnecessary exchange requests.

### 3. Patch the compiled React bundle

The production package contains a compiled 8.7 MB frontend bundle but not its original source. Editing that generated bundle would make the change tightly coupled to minified identifiers and difficult to test or maintain.

## Architecture and data flow

1. The existing DCA strategy evaluates its configured indicators.
2. It stores an `indicatorSnapshot` in `ctx.state`:
   - `values`: the existing `IndicatorsValues` result;
   - `updatedAt`: the timestamp of the strategy evaluation.
3. The existing bot processing layer persists `ctx.state` after the strategy completes. No new database table or API endpoint is required.
4. A standalone ES module, `app/frontend/rsi-monitor.js`, loads from `index.html`.
5. On a bot details route, the module extracts the bot ID, calls the existing authenticated `bot.getOne` tRPC query, finds the first configured RSI entry rule, and selects the matching snapshot value.
6. The module inserts or updates one scoped DOM block below the Timeframe row. A route listener and mutation observer restore the block after React navigation or rerendering.

The module uses the same-origin backend URL and the existing `ADMIN_PASSWORD` stored by OpenTrader. It never prints, persists, or transmits the credential anywhere else.

## Scope

The first version supports DCA bots with an RSI entry rule because that is the configuration used by SOL and the planned SOL FAST bot. Pages without such a rule remain unchanged. Trading thresholds and order behavior are not modified.

## Error handling and safety

- Indicator persistence happens only after a successful calculation.
- Persisting the snapshot is passive; entry evaluation continues to use the local `indicators` result exactly as before.
- A missing rule, missing snapshot, stopped bot, authorization failure, or network failure cannot start, stop, or update a bot.
- The UI retains the last successful value during a temporary fetch failure and marks it stale after two minutes.
- Polling pauses when the browser tab is hidden and resumes immediately when visible.
- Only one poll and one injected block may exist per page.

## Testing and verification

- Add a failing unit test proving the DCA strategy records the exact RSI value and timestamp after indicator evaluation, then implement the smallest state update that passes.
- Add standalone frontend unit tests for route parsing, RSI rule extraction, snapshot lookup, operator evaluation, display state, and stale handling.
- Run the focused bot-template and frontend module tests.
- Build the production application and restart the service.
- Verify the service, authenticated `bot.getOne`, the new static module, and the public page return successfully.
- Open bot #6 in a browser and confirm the displayed value matches the persisted `indicatorSnapshot`, updates after a processing cycle, survives page refresh/navigation, and does not create an order or change bot settings.
