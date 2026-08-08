import assert from "node:assert/strict";
import test from "node:test";

import { buildRsiViewModel, evaluateOperator, findRsiRule, parseBotId, readRsiSnapshot } from "./rsi-monitor.js";

const now = 1786149000000;

const rule = {
  field: "RSI",
  operator: "<=",
  value: {
    indicatorValue: "28",
    timeframe: "4h",
    periods: "14",
  },
  id: "sol-rsi-entry",
};

function createBot({ value = 56.22, updatedAt = now - 15000 } = {}) {
  return {
    id: 6,
    enabled: true,
    settings: {
      entry: {
        conditions: {
          combinator: "and",
          rules: [rule],
          id: "sol-entry",
        },
      },
    },
    state: {
      indicatorSnapshot: {
        values: {
          RSI: {
            "4h": {
              '{"periods":14}': value,
            },
          },
        },
        updatedAt,
      },
    },
  };
}

test("parseBotId accepts supported bot detail routes", () => {
  assert.equal(parseBotId("#/dashboard/bot/6"), 6);
  assert.equal(parseBotId("#/dashboard/dca-bot/42"), 42);
  assert.equal(parseBotId("#/dashboard/bot"), null);
  assert.equal(parseBotId("#/dashboard/bot/6/edit"), null);
});

test("findRsiRule returns the configured RSI entry rule", () => {
  assert.deepEqual(findRsiRule(createBot().settings), rule);
});

test("readRsiSnapshot returns the exact engine value", () => {
  assert.equal(readRsiSnapshot(createBot(), rule), 56.22);
});

test("evaluateOperator supports the entry comparison operators", () => {
  assert.equal(evaluateOperator(28, "<=", 28), true);
  assert.equal(evaluateOperator(56.22, "<=", 28), false);
  assert.equal(evaluateOperator(29, ">", 28), true);
  assert.equal(evaluateOperator(28, "===", 28), true);
  assert.equal(evaluateOperator(28, "!==", 29), true);
});

test("buildRsiViewModel describes a current waiting condition", () => {
  assert.deepEqual(buildRsiViewModel(createBot(), now), {
    label: "RSI(14) - 4h",
    value: 56.22,
    condition: "<=28",
    status: "waiting",
    updatedAt: now - 15000,
    ageSeconds: 15,
  });
});

test("buildRsiViewModel marks old snapshots stale", () => {
  assert.equal(buildRsiViewModel(createBot({ updatedAt: now - 121000 }), now).status, "stale");
});

test("buildRsiViewModel reports unavailable data", () => {
  const bot = createBot();
  bot.state = {};

  assert.deepEqual(buildRsiViewModel(bot, now), {
    label: "RSI(14) - 4h",
    value: null,
    condition: "<=28",
    status: "unavailable",
    updatedAt: null,
    ageSeconds: null,
  });
});
