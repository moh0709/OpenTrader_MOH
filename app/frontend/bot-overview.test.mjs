import assert from "node:assert/strict";
import test from "node:test";

import { botIdFrom, isBotsRoute, money, quoteOf, readSnapshot, tone } from "./bot-overview.js";

/**
 * The nav chevron hangs off whichever anchor points at the bot list, so the
 * route test has to accept both forms the router emits and reject the bot
 * detail pages - a chevron on "#/dashboard/bot/20" would be a second menu on
 * the page it navigates to.
 */
test("isBotsRoute matches the list route and nothing below it", () => {
  assert.equal(isBotsRoute("/#/dashboard/bot"), true);
  assert.equal(isBotsRoute("/#/dashboard/bot/"), true);
  assert.equal(isBotsRoute("#/dashboard/bot"), true);
  assert.equal(isBotsRoute("/dashboard/bot"), true);

  assert.equal(isBotsRoute("/#/dashboard/bot/20"), false);
  assert.equal(isBotsRoute("/#/dashboard/bot/create"), false);
  assert.equal(isBotsRoute("/#/dashboard/dca-bot"), false);
  assert.equal(isBotsRoute("/#/dashboard/strategies"), false);
  assert.equal(isBotsRoute("/#/"), false);
  assert.equal(isBotsRoute(null), false);
});

test("botIdFrom reads the id out of a card title link", () => {
  const link = { getAttribute: () => "/#/dashboard/bot/20" };
  assert.equal(botIdFrom(link), 20);

  assert.equal(botIdFrom({ getAttribute: () => "/#/dashboard/bot" }), null);
  assert.equal(botIdFrom({ getAttribute: () => null }), null);
});

/** A PAXG bot must not have its floating figure labelled in ETH. */
test("quoteOf takes the settlement asset, not the base", () => {
  assert.equal(quoteOf("ETH/USDT"), "USDT");
  assert.equal(quoteOf("PAXG/USDT"), "USDT");
  assert.equal(quoteOf("BTC"), "");
  assert.equal(quoteOf(undefined), "");
});

test("money signs a gain, a loss and nothing at all", () => {
  assert.equal(money(0), "0.00");
  assert.equal(money(4.6), "+4.60");
  assert.equal(money(-20.153), "-20.15");
  // Capital at work is a quantity, not a result, so it carries no plus sign.
  assert.equal(money(1520.4, { signed: false }), "1,520.40");
  assert.equal(money(null), "—");
  assert.equal(money(Number.NaN), "—");
});

test("tone colours a result only when there is one", () => {
  assert.equal(tone(12), "up");
  assert.equal(tone(-12), "down");
  assert.equal(tone(0), "flat");
  assert.equal(tone(null), "flat");
});

/**
 * Read against the shape the live daemon returns, so a field renamed upstream
 * shows up here rather than as a card quietly reading zero.
 */
test("readSnapshot keeps the position figures the cards show", () => {
  const bots = readSnapshot({
    bots: [
      {
        botId: 20,
        name: "Hermes Bot",
        symbol: "ETH/USDT",
        enabled: true,
        positions: { open: 2, underwater: 2, floatingPnl: -20.15, costBasis: 1520.4 },
      },
    ],
  });

  assert.deepEqual(bots, [
    {
      id: 20,
      name: "Hermes Bot",
      symbol: "ETH/USDT",
      enabled: true,
      open: 2,
      underwater: 2,
      floating: -20.15,
      costBasis: 1520.4,
    },
  ]);
});

/**
 * A missing figure has to stay missing. Defaulting an absent floatingPnl to
 * zero would render a confident "0.00" for a number nobody knows.
 */
test("readSnapshot distinguishes an absent figure from a zero one", () => {
  const [absent, zero] = readSnapshot({
    bots: [
      { botId: 1, name: "", symbol: "BTC/USDT", positions: {} },
      { botId: 2, name: "Flat", symbol: "BTC/USDT", positions: { open: 0, floatingPnl: 0, costBasis: 0 } },
    ],
  });

  assert.equal(absent.floating, null);
  assert.equal(absent.costBasis, null);
  assert.equal(absent.open, 0);
  assert.equal(absent.name, "Bot 1", "an unnamed bot still needs something to click");
  assert.equal(absent.enabled, false);

  assert.equal(zero.floating, 0);
  assert.equal(zero.costBasis, 0);
});

test("readSnapshot survives an empty or malformed payload", () => {
  assert.deepEqual(readSnapshot({}), []);
  assert.deepEqual(readSnapshot(null), []);
  assert.deepEqual(readSnapshot({ bots: [] }), []);
});
