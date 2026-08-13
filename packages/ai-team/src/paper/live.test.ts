import { evaluatePair, DEFAULT_ARBITRAGE_CONFIG, type ArbEvaluation, type VenueQuote } from "@opentrader/arbitrage";
import { exchangeProvider } from "@opentrader/exchanges";
import { BarSize, ExchangeCode, type ICandlestick } from "@opentrader/types";
import { describe, expect, it } from "vitest";
import { createLlmAnalyst, llmConfigFromEnv } from "../llm.js";
import { DEFAULT_RISK_LIMITS, type Candle } from "../types.js";
import { DEFAULT_PAPER_CONFIG, replay } from "./simulator.js";

/**
 * Live verification against real exchanges.
 *
 * Opt in with HYBRID_LIVE=1 — it makes real network calls, so it is not part of
 * the normal suite. Public endpoints only; no API keys and no orders are placed.
 * Set HYBRID_LLM=1 (with credentials) to include the LLM strategist.
 */
const LIVE = process.env.HYBRID_LIVE === "1";
const SYMBOL = process.env.HYBRID_SYMBOL || "BTC/USDT";
const BAR = (process.env.HYBRID_BAR as BarSize) || BarSize.ONE_HOUR;
const CANDLE_LIMIT = Number(process.env.HYBRID_CANDLES) || 300;
const VENUES = [ExchangeCode.BINANCE, ExchangeCode.OKX, ExchangeCode.KRAKEN, ExchangeCode.BYBIT, ExchangeCode.GATEIO];

function fmt(n: number, digits = 2): string {
  return n.toFixed(digits);
}

describe.runIf(LIVE)("Hybrid Trader — live market verification", () => {
  it(
    "scans real order books, replays real candles, and reports what it did",
    async () => {
      console.log(`\n${"=".repeat(78)}\nHYBRID TRADER — LIVE PAPER VERIFICATION\nSymbol: ${SYMBOL}\n${"=".repeat(78)}`);

      // --- 1. Real order books across venues -------------------------------
      const bookResults = await Promise.allSettled(
        VENUES.map(async (code) => {
          const exchange = exchangeProvider.fromCode(code, false);
          const book = await exchange.getOrderbook(SYMBOL);
          return { code, book };
        }),
      );

      const quotes: VenueQuote[] = [];
      console.log("\n--- Venue order books ---");
      bookResults.forEach((result, i) => {
        const code = VENUES[i];
        if (result.status === "rejected") {
          console.log(`  ${code.padEnd(10)} unavailable (${String(result.reason?.message ?? result.reason).slice(0, 60)})`);
          return;
        }
        const { book } = result.value;
        if (!book?.asks?.length || !book?.bids?.length) {
          console.log(`  ${code.padEnd(10)} empty book`);
          return;
        }
        console.log(`  ${code.padEnd(10)} bid ${fmt(book.bids[0].price)} / ask ${fmt(book.asks[0].price)}  (${book.bids.length}x${book.asks.length} levels)`);
        quotes.push({ venue: code, symbol: SYMBOL, book, takerFeeBps: 10 });
      });

      expect(quotes.length, "at least one venue must respond").toBeGreaterThan(0);

      // --- 2. Depth-aware cross-venue evaluation ---------------------------
      let bestArb: ArbEvaluation | null = null;
      if (quotes.length >= 2) {
        const config = { ...DEFAULT_ARBITRAGE_CONFIG, tradeQty: 0.01, minNetSpreadBps: 8 };
        const evaluations: ArbEvaluation[] = [];
        for (let i = 0; i < quotes.length; i++) {
          for (let j = i + 1; j < quotes.length; j++) {
            evaluations.push(...evaluatePair(quotes[i], quotes[j], config, Date.now()));
          }
        }
        evaluations.sort((a, b) => b.netSpreadBps - a.netSpreadBps);
        bestArb = evaluations.find((e) => e.executable) ?? evaluations[0] ?? null;

        console.log("\n--- Cross-venue spreads (best 5, top-of-book vs reality) ---");
        for (const e of evaluations.slice(0, 5)) {
          console.log(
            `  ${e.buyVenue.padEnd(8)} -> ${e.sellVenue.padEnd(8)} ` +
              `top-of-book ${fmt(e.topOfBookSpreadBps).padStart(8)}bps | ` +
              `net after costs ${fmt(e.netSpreadBps).padStart(9)}bps | ` +
              `${e.executable ? "EXECUTABLE" : `rejected: ${e.rejections.join(",")}`}`,
          );
        }

        // The headline claim of the arbitrage engine: top-of-book spreads
        // systematically overstate what is actually tradable.
        const overstated = evaluations.filter((e) => e.topOfBookSpreadBps > e.netSpreadBps).length;
        console.log(`\n  ${overstated}/${evaluations.length} pairs had a top-of-book spread wider than the real net spread.`);
      }

      // --- 3. Real candle history ------------------------------------------
      let candles: Candle[] = [];
      let candleVenue = "";
      for (const code of VENUES) {
        try {
          const exchange = exchangeProvider.fromCode(code, false);
          const raw = await exchange.getCandlesticks({ symbol: SYMBOL, bar: BAR, limit: CANDLE_LIMIT });
          if (raw.length > 100) {
            candles = raw.map((c: ICandlestick) => ({
              open: c.open,
              high: c.high,
              low: c.low,
              close: c.close,
              volume: c.volume,
              timestamp: c.timestamp,
            }));
            candleVenue = code;
            break;
          }
        } catch {
          // Try the next venue.
        }
      }

      expect(candles.length, "need candle history from at least one venue").toBeGreaterThan(100);
      const first = candles[0];
      const last = candles[candles.length - 1];
      console.log(
        `\n--- Candles ---\n  ${candles.length} x 1h from ${candleVenue}\n` +
          `  ${new Date(first.timestamp).toISOString()} @ ${fmt(first.close)}\n` +
          `  ${new Date(last.timestamp).toISOString()} @ ${fmt(last.close)}`,
      );

      // --- 4. Replay through the full decision pipeline ---------------------
      const llmConfig = llmConfigFromEnv();
      console.log(`\n--- Council ---\n  LLM strategist: ${llmConfig.enabled ? `${llmConfig.model} (effort=${llmConfig.effort})` : "disabled — deterministic council only"}`);

      const limits = { ...DEFAULT_RISK_LIMITS, maxDailyLossQuote: 100, maxConsecutiveLosses: 5 };
      const paper = { ...DEFAULT_PAPER_CONFIG, startingCashQuote: 1000 };

      const result = await replay(SYMBOL, candles, {
        limits,
        paper,
        council: llmConfig.enabled ? { llmAnalyst: createLlmAnalyst(llmConfig) } : {},
        warmup: 40,
        // Replay the live book snapshot at every step. It is the same book each
        // time rather than a historical one, so treat the arbitrage lane here as
        // a live-scan smoke test, not a backtested edge.
        arbForStep: () => bestArb,
      });

      // --- 5. Report --------------------------------------------------------
      console.log(`\n--- Decisions ---`);
      console.log(`  Ticks evaluated:        ${result.decisionsConsidered}`);
      console.log(`  Directional consensus:  ${result.steps.filter((s) => s.decision.verdict.signal !== "hold").length}`);
      console.log(`  Approved by governor:   ${result.steps.filter((s) => s.decision.approved).length}`);
      console.log(`  Blocked by risk limits: ${result.tradesRejectedByRisk}`);

      // Confidence distribution — the number the minConfidence floor is set
      // against. Printed so the floor can be calibrated from observed data
      // rather than guessed at.
      const directional = result.steps.filter((s) => s.decision.verdict.signal !== "hold").map((s) => s.decision.verdict.confidence);
      if (directional.length > 0) {
        const sorted = [...directional].sort((a, b) => a - b);
        const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
        console.log(
          `\n  Council confidence on directional ticks: ` +
            `p50=${fmt(pct(50), 3)} p75=${fmt(pct(75), 3)} p90=${fmt(pct(90), 3)} max=${fmt(sorted[sorted.length - 1], 3)} ` +
            `(floor=${limits.minConfidence})`,
        );
      }

      const sample = result.steps.filter((s) => s.decision.approved).slice(0, 5);
      if (sample.length > 0) {
        console.log(`\n--- Sample approved trades ---`);
        for (const step of sample) {
          console.log(`  ${new Date(step.timestamp).toISOString()} ${step.decision.signal.toUpperCase().padEnd(4)} @ ${fmt(step.price)}`);
          console.log(`      ${step.decision.verdict.rationale}`);
          for (const o of step.decision.verdict.opinions.filter((x) => x.signal !== "hold")) {
            console.log(`        - ${o.agent} (${o.source}): ${o.rationale}`);
          }
        }
      }

      const blocked = result.steps.find((s) => !s.decision.approved && s.decision.riskNotes.length > 0);
      if (blocked) {
        console.log(`\n--- Sample blocked decision ---\n  ${blocked.decision.verdict.rationale}\n  risk: ${blocked.decision.riskNotes.join("; ")}`);
      }

      console.log(`\n--- Paper result ---`);
      console.log(`  Starting equity:  ${fmt(result.startingEquity)}`);
      console.log(`  Final equity:     ${fmt(result.finalEquity)}`);
      console.log(`  Strategy return:  ${fmt(result.returnPct)}%`);
      console.log(`  Buy & hold:       ${fmt(result.buyHoldReturnPct)}%`);
      console.log(`  Fills:            ${result.trades} (${result.wins}W / ${result.losses}L)`);
      console.log(`  Realised PnL:     ${fmt(result.account.realizedPnl)}`);
      console.log(`${"=".repeat(78)}\n`);

      // --- 6. Invariants that must hold on real data -----------------------
      expect(result.decisionsConsidered).toBeGreaterThan(0);
      expect(result.account.cashQuote).toBeGreaterThanOrEqual(-1e-9);
      expect(result.account.positionBase).toBeGreaterThanOrEqual(-1e-9);
      expect(result.finalEquity).toBeGreaterThan(0);

      for (const step of result.steps) {
        expect(step.decision.sizeQuote).toBeLessThanOrEqual(limits.maxPositionQuote + 1e-9);
        if (!step.decision.approved) expect(step.decision.sizeQuote).toBe(0);
      }

      // Every tick must be explainable — a silent decision is a broken audit trail.
      for (const step of result.steps) {
        expect(step.decision.verdict.rationale.length).toBeGreaterThan(0);
      }
    },
    { timeout: 300_000 },
  );
});
