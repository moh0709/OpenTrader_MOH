# Live RSI Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display the exact RSI value used by a DCA bot on its details page and refresh the read-only display every 15 seconds.

**Architecture:** The DCA strategy persists the already-calculated indicator result in its existing JSON state after every candle evaluation. A standalone browser ES module reads the bot through the existing authenticated tRPC endpoint and injects a scoped RSI block below the Timeframe row without modifying the compiled React bundle.

**Tech Stack:** TypeScript, Vitest, generator-based bot templates, browser ES modules, Node test runner, tRPC, systemd, nginx.

## Global Constraints

- The displayed value must be the exact value used by the DCA strategy, not a browser recalculation.
- The UI must not start, stop, edit, or otherwise mutate a bot.
- Refresh immediately on page load/navigation and every 15 seconds while the tab is visible.
- Mark snapshots older than 120 seconds as stale.
- Support DCA bots with an RSI entry rule; leave all other pages unchanged.
- Do not add a database table, dependency, or API endpoint.
- Never log or copy the `ADMIN_PASSWORD` value.
- Preserve the existing uncommitted candle-channel fix.

---

### Task 1: Persist the DCA indicator snapshot

**Files:**
- Create: `packages/bot-templates/src/templates/dca.test.ts`
- Modify: `packages/bot-templates/src/templates/dca.ts`

**Interfaces:**
- Consumes: the existing `IndicatorsValues` returned by `useIndicators`.
- Produces: `ctx.state.indicatorSnapshot: { values: IndicatorsValues; updatedAt: number }`.

- [ ] **Step 1: Write the failing generator test**

Create a Vitest test that freezes time, starts the DCA generator in process mode, supplies this result to the yielded `useIndicators` effect, and verifies state:

```ts
const indicators = {
  RSI: { "4h": { '{"periods":14}': 56.22 } },
};

const iterator = dca(context);
iterator.next();
iterator.next(indicators);

expect(context.state.indicatorSnapshot).toEqual({
  values: indicators,
  updatedAt: 1786149000000,
});
```

Use an entry rule of `RSI <= 28` so the generator finishes without producing a trade effect. Restore real timers after the test.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm exec vitest run packages/bot-templates/src/templates/dca.test.ts
```

Expected: FAIL because `context.state.indicatorSnapshot` is undefined.

- [ ] **Step 3: Persist the exact calculation result**

In `dca.ts`, include `state` from the context and add this immediately after `useIndicators` returns:

```ts
const { config, onStart, onStop, state } = ctx;
// ...
const indicators: IndicatorsValues = yield useIndicators(extractIndicators(settings.entry.conditions));
state.indicatorSnapshot = {
  values: indicators,
  updatedAt: Date.now(),
};
```

Do not change `shouldEntry`, the order options, or any trading branch.

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```bash
pnpm exec vitest run packages/bot-templates/src/templates/dca.test.ts
pnpm exec moon run bot-templates:typecheck
```

Expected: the new test passes and typecheck exits 0.

- [ ] **Step 5: Commit the engine snapshot**

```bash
git add packages/bot-templates/src/templates/dca.ts packages/bot-templates/src/templates/dca.test.ts
git commit -m "feat(dca): persist live indicator snapshot"
```

### Task 2: Build the read-only RSI monitor module

**Files:**
- Create: `app/frontend/rsi-monitor.js`
- Create: `app/frontend/rsi-monitor.test.mjs`

**Interfaces:**
- Consumes: bot JSON returned by `GET /api/trpc/bot.getOne?input=...`, including `settings.entry.conditions`, `state.indicatorSnapshot`, and `enabled`.
- Produces: exported pure helpers `parseBotId`, `findRsiRule`, `readRsiSnapshot`, `evaluateOperator`, and `buildRsiViewModel`; browser bootstrap `startRsiMonitor()`.

- [ ] **Step 1: Write failing pure-function tests**

Use `node:test` and `node:assert/strict`. Cover:

```js
assert.equal(parseBotId("#/dashboard/bot/6"), 6);
assert.equal(parseBotId("#/dashboard/dca-bot/6"), 6);
assert.equal(parseBotId("#/dashboard/bot"), null);

assert.deepEqual(findRsiRule(bot.settings), {
  field: "RSI",
  operator: "<=",
  value: { indicatorValue: "28", timeframe: "4h", periods: "14" },
  id: "sol-rsi-entry",
});

assert.equal(readRsiSnapshot(bot, rule), 56.22);
assert.equal(evaluateOperator(28, "<=", 28), true);
assert.equal(evaluateOperator(56.22, "<=", 28), false);
assert.equal(buildRsiViewModel(bot, now).status, "waiting");
assert.equal(buildRsiViewModel(staleBot, now).status, "stale");
assert.equal(buildRsiViewModel(noSnapshotBot, now).status, "unavailable");
```

- [ ] **Step 2: Run the frontend test and verify RED**

Run:

```bash
node --test app/frontend/rsi-monitor.test.mjs
```

Expected: FAIL with module-not-found for `rsi-monitor.js`.

- [ ] **Step 3: Implement the pure data model**

Implement the exported helpers. Recursively traverse condition groups to find the first rule whose `field === "RSI"`. Read the engine value from:

```js
bot.state.indicatorSnapshot.values.RSI[timeframe][
  JSON.stringify({ periods: Number(periods) })
]
```

Return a view model with `label`, `value`, `condition`, `status`, `updatedAt`, and `ageSeconds`. Support `<`, `<=`, `>`, `>=`, `==`, `===`, `!=`, and `!==`.

- [ ] **Step 4: Implement authenticated polling and rendering**

Add browser-only startup guarded by `typeof window !== "undefined"`. The monitor must:

1. read the bot ID from `location.hash`;
2. read `ADMIN_PASSWORD` from local storage without logging it;
3. call same-origin `bot.getOne` with `authorization`;
4. find the exact element whose trimmed text is `Timeframe`, use its parent row as the anchor, and inject one `#opentrader-rsi-monitor` block after it;
5. display `RSI(periods) - timeframe`, the value to two decimals, the configured condition, freshness, and status;
6. retain the last successful model during transient fetch failures and show it as stale after 120 seconds;
7. poll every 15 seconds only while `document.visibilityState === "visible"`;
8. refresh on `hashchange`, `popstate`, and `visibilitychange`;
9. use a debounced `MutationObserver` to restore the block after React rerenders;
10. remove the block and stop route-specific polling outside supported bot detail routes.

Use only scoped inline styles or a scoped `<style id="opentrader-rsi-monitor-style">` element. Never monkey-patch `fetch` or modify React-owned nodes.

- [ ] **Step 5: Run the frontend unit tests**

Run:

```bash
node --test app/frontend/rsi-monitor.test.mjs
```

Expected: all helper tests pass with zero failures.

- [ ] **Step 6: Commit the isolated monitor**

```bash
git add app/frontend/rsi-monitor.js app/frontend/rsi-monitor.test.mjs
git commit -m "feat(ui): add live RSI monitor"
```

### Task 3: Load, build, deploy, and verify the monitor

**Files:**
- Modify: `app/frontend/index.html`

**Interfaces:**
- Consumes: `/rsi-monitor.js`.
- Produces: the monitor loaded after the existing compiled frontend module.

- [ ] **Step 1: Write the failing bootstrap assertion**

Before changing `index.html`, run:

```bash
rg -n 'src="/rsi-monitor.js"' app/frontend/index.html
```

Expected: exit 1 because the module is not loaded.

- [ ] **Step 2: Load the monitor module**

Add this after the existing compiled module script:

```html
<script type="module" src="/rsi-monitor.js"></script>
```

- [ ] **Step 3: Verify tests, formatting, types, and production build**

Run:

```bash
node --test app/frontend/rsi-monitor.test.mjs
pnpm exec vitest run packages/bot-templates/src/templates/dca.test.ts
pnpm exec moon run bot-templates:typecheck
pnpm exec moon run app:build
git diff --check
```

Expected: all tests pass, typecheck/build exit 0, and diff check is silent.

- [ ] **Step 4: Commit the bootstrap**

```bash
git add app/frontend/index.html
git commit -m "feat(ui): load live RSI monitor"
```

- [ ] **Step 5: Deploy and capture exact engine data**

Restart the existing service and wait for one DCA processing cycle:

```bash
sudo systemctl restart opentrader
systemctl is-active opentrader
journalctl -u opentrader --since "2 minutes ago" --no-pager
```

Expected: service is active, SOL subscribes successfully, REST fallback remains operational, and DCA strategy execution has no error.

- [ ] **Step 6: Verify HTTP and persisted snapshot**

Without printing the credential, source `/etc/opentrader/admin-password.env` and verify:

```bash
curl -fsS https://ai.omniware.dk/rsi-monitor.js >/dev/null
curl -fsS https://ai.omniware.dk/ | rg 'src="/rsi-monitor.js"'
curl -fsS -H "authorization: $ADMIN_PASSWORD"   'http://[::1]:8000/api/trpc/bot.getOne?input=%7B%22json%22%3A6%7D' |
  jq '.result.data.json.state.indicatorSnapshot'
```

Expected: both assets return successfully and the snapshot contains a finite RSI value plus a recent `updatedAt`.

- [ ] **Step 7: Verify visually and behaviorally**

Open `https://ai.omniware.dk/#/dashboard/bot/6` in the signed-in browser. Confirm:

- exactly one RSI block appears below Timeframe;
- its value equals the authenticated API snapshot to two decimals;
- condition and waiting/met state match the configured rule;
- the update age changes and a new snapshot appears after a processing cycle;
- browser refresh and route-away/route-back retain correct behavior;
- there are no console errors;
- bot settings, enabled state, SmartTrade count, and Order count are unchanged by viewing the page.

- [ ] **Step 8: Final repository and service verification**

Run:

```bash
git status --short
git log -4 --oneline
systemctl is-active opentrader
curl -fsS https://ai.omniware.dk/ >/dev/null
```

Report the focused test counts, build result, service state, live RSI value, snapshot time, and any unrelated pre-existing worktree changes separately.
