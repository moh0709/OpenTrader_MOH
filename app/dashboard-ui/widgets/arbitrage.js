/**
 * Cross-venue arbitrage widgets.
 *
 * This is the capability the Cortex AI arbitrage project advertised, built for
 * real. The difference that matters is the two spread columns: the top-of-book
 * number every naive scanner reports, and the number left after walking real
 * order-book depth to a tradable size and paying both taker fees.
 *
 * On liquid pairs the second number is almost always negative. Showing them side
 * by side is the point — an arbitrage screen that only prints the first one is
 * how a bot ends up confidently losing money.
 */
import { badge, el, emptyState, mount, note, select } from "../lib/dom.js";
import { query } from "../lib/api.js";

const SYMBOLS = ["BTC/USDT", "ETH/USDT", "SOL/USDT", "XRP/USDT", "PAXG/USDT"];
const SIZES = ["0.001", "0.01", "0.1", "1"];

function bps(value) {
  const n = Number(value ?? 0);
  return `${n >= 0 ? "" : ""}${n.toFixed(2)} bps`;
}

/** Green only when an edge survives every cost; red when the costed number is negative. */
function spreadTone(netBps, executable) {
  if (executable) return "pos";
  return netBps > 0 ? "" : "neg";
}

export const arbitrageScannerWidget = {
  id: "arbitrageScanner",
  name: "Cross-venue spreads",
  group: "Arbitrage",
  description:
    "Live spreads between exchanges, showing the top-of-book number next to what survives depth and fees.",
  defaultSpan: 8,
  defaultRows: 5,
  defaultConfig: { symbol: "BTC/USDT", tradeQty: "0.01" },

  tools(instance, ctx) {
    return [
      select(
        SYMBOLS.map((s) => ({ value: s, label: s })),
        instance.config.symbol || "BTC/USDT",
        (value) => ctx.setConfig({ symbol: value }),
        "Symbol",
      ),
      select(
        SIZES.map((s) => ({ value: s, label: s })),
        instance.config.tradeQty || "0.01",
        (value) => ctx.setConfig({ tradeQty: value }),
        "Size",
      ),
    ];
  },

  render(ctx) {
    const load = async () => {
      const symbol = ctx.config.symbol || "BTC/USDT";
      const tradeQty = Number(ctx.config.tradeQty || 0.01);

      try {
        const scan = await query("arbitrage.scan", { symbol, tradeQty });
        draw(scan);
      } catch (error) {
        mount(ctx.body, emptyState(`Could not scan: ${error.message}`));
      }
    };

    const draw = (scan) => {
      if (!scan.venuesQuoted.length) {
        return mount(ctx.body, emptyState("No venue returned an order book for this symbol."));
      }

      if (scan.venuesQuoted.length < 2) {
        return mount(
          ctx.body,
          emptyState(`Only ${scan.venuesQuoted[0].venue} quoted ${scan.symbol}. Two venues are needed to compare.`),
        );
      }

      const rows = scan.evaluations.slice(0, 12).map((e) =>
        el("tr", {}, [
          el("td", { text: `${e.buyVenue} → ${e.sellVenue}` }),
          el("td", { class: "num", text: bps(e.topOfBookSpreadBps) }),
          el("td", { class: `num ${spreadTone(e.netSpreadBps, e.executable)}`, text: bps(e.netSpreadBps) }),
          el("td", { class: "num", text: bps(e.buySlippageBps + e.sellSlippageBps) }),
          el(
            "td",
            {},
            [
              e.executable
                ? badge("EXECUTABLE", "win")
                : badge(e.rejections[0] ?? "no edge", "info"),
            ],
          ),
        ]),
      );

      const table = el("table", { class: "table" }, [
        el("thead", {}, [
          el("tr", {}, [
            el("th", { text: "Route" }),
            el("th", { class: "num", text: "Top of book" }),
            el("th", { class: "num", text: "After costs" }),
            el("th", { class: "num", text: "Slippage" }),
            el("th", { text: "Verdict" }),
          ]),
        ]),
        el("tbody", {}, rows),
      ]);

      const { pairsEvaluated, overstatedByTopOfBook, executable } = scan.summary;

      const summary = note(
        executable > 0
          ? `${executable} of ${pairsEvaluated} routes are executable at ${scan.tradeQty} ${scan.symbol.split("/")[0]}.`
          : `No executable edge. ${overstatedByTopOfBook} of ${pairsEvaluated} routes look profitable at the top of ` +
            `book but are not once depth and fees are paid.`,
      );

      const venues = note(
        `Quoted: ${scan.venuesQuoted.map((v) => v.venue).join(", ")}` +
          (scan.venuesFailed.length ? ` · unavailable: ${scan.venuesFailed.map((v) => v.venue).join(", ")}` : ""),
      );

      mount(ctx.body, el("div", { class: "stack" }, [summary, table, venues]));
    };

    void load();

    return { dispose: ctx.store.subscribe((reason) => reason === "snapshot" && void load()) };
  },
};

export const arbitrageVenuesWidget = {
  id: "arbitrageVenues",
  name: "Venue prices",
  group: "Arbitrage",
  description: "Best bid and ask for one symbol across every exchange, with book depth and staleness.",
  defaultSpan: 4,
  defaultRows: 4,
  defaultConfig: { symbol: "BTC/USDT" },

  tools(instance, ctx) {
    return [
      select(
        SYMBOLS.map((s) => ({ value: s, label: s })),
        instance.config.symbol || "BTC/USDT",
        (value) => ctx.setConfig({ symbol: value }),
        "Symbol",
      ),
    ];
  },

  render(ctx) {
    const load = async () => {
      const symbol = ctx.config.symbol || "BTC/USDT";

      try {
        const scan = await query("arbitrage.scan", { symbol });
        draw(scan);
      } catch (error) {
        mount(ctx.body, emptyState(`Could not read prices: ${error.message}`));
      }
    };

    const draw = (scan) => {
      if (!scan.venuesQuoted.length) return mount(ctx.body, emptyState("No venue quoted this symbol."));

      const best = {
        bid: Math.max(...scan.venuesQuoted.map((v) => v.bid)),
        ask: Math.min(...scan.venuesQuoted.map((v) => v.ask)),
      };

      const rows = scan.venuesQuoted.map((v) =>
        el("tr", {}, [
          el("td", { text: v.venue }),
          el("td", { class: `num ${v.bid === best.bid ? "pos" : ""}`, text: v.bid.toFixed(2) }),
          el("td", { class: `num ${v.ask === best.ask ? "pos" : ""}`, text: v.ask.toFixed(2) }),
          el("td", { class: "num", text: `${v.bidLevels}×${v.askLevels}` }),
        ]),
      );

      const table = el("table", { class: "table" }, [
        el("thead", {}, [
          el("tr", {}, [
            el("th", { text: "Venue" }),
            el("th", { class: "num", text: "Bid" }),
            el("th", { class: "num", text: "Ask" }),
            el("th", { class: "num", text: "Depth" }),
          ]),
        ]),
        el("tbody", {}, rows),
      ]);

      // The widest theoretical gap, before any cost is applied. Shown so the
      // contrast with the scanner's costed figure is obvious.
      const gapBps = best.ask > 0 ? ((best.bid - best.ask) / best.ask) * 10_000 : 0;

      mount(
        ctx.body,
        el("div", { class: "stack" }, [
          table,
          note(`Best bid minus best ask across venues: ${gapBps.toFixed(2)} bps, before fees and depth.`),
        ]),
      );
    };

    void load();

    return { dispose: ctx.store.subscribe((reason) => reason === "snapshot" && void load()) };
  },
};

export const arbitrageWidgets = [arbitrageScannerWidget, arbitrageVenuesWidget];
