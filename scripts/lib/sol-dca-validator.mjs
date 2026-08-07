export function calculateRsi(candles, periods = 14) {
  if (!Number.isInteger(periods) || periods <= 0) {
    throw new Error("RSI periods must be a positive integer");
  }

  const values = Array(candles.length).fill(undefined);
  if (candles.length <= periods) return values;

  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= periods; index += 1) {
    const change = candles[index].close - candles[index - 1].close;
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }

  let averageGain = gains / periods;
  let averageLoss = losses / periods;
  values[periods] = rsiFromAverages(averageGain, averageLoss);

  for (let index = periods + 1; index < candles.length; index += 1) {
    const change = candles[index].close - candles[index - 1].close;
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    averageGain = (averageGain * (periods - 1) + gain) / periods;
    averageLoss = (averageLoss * (periods - 1) + loss) / periods;
    values[index] = rsiFromAverages(averageGain, averageLoss);
  }

  return values;
}

function rsiFromAverages(averageGain, averageLoss) {
  if (averageGain === 0 && averageLoss === 0) return 50;
  if (averageLoss === 0) return 100;
  if (averageGain === 0) return 0;
  return 100 - 100 / (1 + averageGain / averageLoss);
}

export function simulateDca(
  candles,
  {
    tradeStartIndex,
    rsiThreshold = 28,
    quantity,
    safetyDeviations = [0.05, 0.1, 0.15],
    takeProfit = 0.04,
    stopLoss = 0.2,
    feeRate = 0.006,
    slippageRate = 0.001,
    initialCapital = 1000,
    rsiPeriods = 14,
  },
) {
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error("quantity must be positive");
  }
  if (!Number.isInteger(tradeStartIndex) || tradeStartIndex < 0) {
    throw new Error("tradeStartIndex must be a non-negative integer");
  }

  const rsiValues = calculateRsi(candles, rsiPeriods);
  const trades = [];
  let trade;
  let realizedEquity = initialCapital;
  let endingEquity = initialCapital;
  let peakEquity = initialCapital;
  let maxDrawdownPct = 0;
  let candlesInMarket = 0;

  for (let index = 0; index < candles.length; index += 1) {
    const current = candles[index];
    let closedThisCandle = false;

    if (trade) {
      candlesInMarket += 1;
      const stopPrice = trade.initialEntry * (1 - stopLoss);

      if (current.low <= stopPrice) {
        closeTrade(trade, stopPrice * (1 - slippageRate), feeRate, current.timestamp, "stop-loss");
        realizedEquity += trade.netPnl;
        trades.push(trade);
        trade = undefined;
        closedThisCandle = true;
      } else {
        for (const safety of trade.safetyOrders) {
          if (!safety.filled && current.low <= safety.price) {
            addFill(trade, safety.price, quantity, feeRate, current.timestamp, "safety");
            safety.filled = true;
          }
        }

        const takeProfitPrice = trade.averageEntry * (1 + takeProfit);
        if (current.high >= takeProfitPrice) {
          closeTrade(trade, takeProfitPrice, feeRate, current.timestamp, "take-profit");
          realizedEquity += trade.netPnl;
          trades.push(trade);
          trade = undefined;
          closedThisCandle = true;
        }
      }
    }

    if (
      !trade &&
      !closedThisCandle &&
      index >= tradeStartIndex &&
      rsiValues[index] !== undefined &&
      rsiValues[index] <= rsiThreshold
    ) {
      const entryPrice = current.close * (1 + slippageRate);
      trade = {
        entryTimestamp: current.timestamp,
        initialEntry: entryPrice,
        fills: [],
        safetyOrders: safetyDeviations.map((deviation) => ({
          deviation,
          price: entryPrice * (1 - deviation),
          filled: false,
        })),
        averageEntry: entryPrice,
        totalQuantity: 0,
        totalEntryCost: 0,
        entryFees: 0,
      };
      addFill(trade, entryPrice, quantity, feeRate, current.timestamp, "entry");
    }

    endingEquity = markEquity(realizedEquity, trade, current.close, feeRate);
    peakEquity = Math.max(peakEquity, endingEquity);
    if (peakEquity > 0) {
      maxDrawdownPct = Math.max(maxDrawdownPct, (peakEquity - endingEquity) / peakEquity);
    }
  }

  const winningProfit = trades.filter((item) => item.netPnl > 0).reduce((total, item) => total + item.netPnl, 0);
  const losingProfit = trades
    .filter((item) => item.netPnl < 0)
    .reduce((total, item) => total + Math.abs(item.netPnl), 0);
  const completedTrades = trades.length;

  return {
    trades,
    completedTrades,
    openTrade: Boolean(trade),
    endingEquity,
    netReturn: (endingEquity - initialCapital) / initialCapital,
    maxDrawdownPct,
    winRate: completedTrades ? trades.filter((item) => item.netPnl > 0).length / completedTrades : 0,
    profitFactor: losingProfit > 0 ? winningProfit / losingProfit : winningProfit > 0 ? Number.POSITIVE_INFINITY : 0,
    worstTrade: completedTrades ? Math.min(...trades.map((item) => item.netPnl)) : 0,
    timeInMarket: candles.length > tradeStartIndex ? candlesInMarket / (candles.length - tradeStartIndex) : 0,
    dataValid: true,
  };
}

function addFill(trade, price, quantity, feeRate, timestamp, type) {
  const cost = price * quantity;
  const fee = cost * feeRate;
  trade.fills.push({ timestamp, type, price, quantity, cost, fee });
  trade.totalQuantity += quantity;
  trade.totalEntryCost += cost;
  trade.entryFees += fee;
  trade.averageEntry = trade.totalEntryCost / trade.totalQuantity;
}

function closeTrade(trade, price, feeRate, timestamp, exitReason) {
  const proceeds = price * trade.totalQuantity;
  const exitFee = proceeds * feeRate;
  trade.exitTimestamp = timestamp;
  trade.exitReason = exitReason;
  trade.exitPrice = price;
  trade.exitFee = exitFee;
  trade.netPnl = proceeds - exitFee - trade.totalEntryCost - trade.entryFees;
}

function markEquity(realizedEquity, trade, price, feeRate) {
  if (!trade) return realizedEquity;
  const markedProceeds = price * trade.totalQuantity * (1 - feeRate);
  return realizedEquity - trade.totalEntryCost - trade.entryFees + markedProceeds;
}

export function evaluateGates(report, { maxDrawdown = 0.15, minProfitFactor = 1.15, minCompletedTrades = 10 } = {}) {
  const failures = [];

  if (!(report.netReturn > 0)) {
    failures.push("net return must be positive");
  }
  if (!(report.maxDrawdownPct <= maxDrawdown)) {
    failures.push(`maximum drawdown exceeds ${(maxDrawdown * 100).toFixed(2)}%`);
  }
  if (!(report.profitFactor >= minProfitFactor)) {
    failures.push(`profit factor is below ${minProfitFactor}`);
  }
  if (!(report.completedTrades >= minCompletedTrades)) {
    failures.push(`completed trades are below ${minCompletedTrades}`);
  }
  if (!report.dataValid) {
    failures.push("market data is incomplete or invalid");
  }

  return {
    passed: failures.length === 0,
    failures,
  };
}

export async function fetchCoinbaseCandles({
  productId,
  granularity,
  start,
  end,
  fetchImpl = fetch,
  requestDelayMs = 125,
}) {
  if (!(end > start)) {
    throw new Error("Candle end time must be after start time");
  }
  if (!Number.isInteger(granularity) || granularity <= 0) {
    throw new Error("Candle granularity must be a positive integer");
  }

  const maximumWindow = granularity * 1000 * 300;
  const candlesByTimestamp = new Map();

  for (let cursor = start; cursor < end; ) {
    const windowEnd = Math.min(cursor + maximumWindow, end);
    const url = new URL(`https://api.exchange.coinbase.com/products/${encodeURIComponent(productId)}/candles`);
    url.searchParams.set("granularity", String(granularity));
    url.searchParams.set("start", new Date(cursor).toISOString());
    url.searchParams.set("end", new Date(windowEnd).toISOString());

    const response = await fetchImpl(url);
    if (!response.ok) {
      throw new Error(`Coinbase candles request failed with HTTP ${response.status}`);
    }

    const rows = await response.json();
    if (!Array.isArray(rows)) {
      throw new Error("Coinbase candles response must be an array");
    }

    for (const row of rows) {
      const candle = normalizeCoinbaseCandle(row);
      if (candle.timestamp >= start && candle.timestamp <= end) {
        candlesByTimestamp.set(candle.timestamp, candle);
      }
    }

    cursor = windowEnd;
    if (cursor < end && requestDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, requestDelayMs));
    }
  }

  return [...candlesByTimestamp.values()].sort((left, right) => left.timestamp - right.timestamp);
}

function normalizeCoinbaseCandle(row) {
  if (!Array.isArray(row) || row.length < 6) {
    throw new Error("Invalid Coinbase candle row");
  }

  const [seconds, low, high, open, close, volume] = row.map(Number);
  const values = [seconds, low, high, open, close, volume];
  const valid =
    values.every(Number.isFinite) &&
    seconds > 0 &&
    low > 0 &&
    low <= high &&
    open >= low &&
    open <= high &&
    close >= low &&
    close <= high &&
    volume >= 0;

  if (!valid) {
    throw new Error(`Invalid Coinbase candle: ${JSON.stringify(row)}`);
  }

  return {
    timestamp: seconds * 1000,
    open,
    high,
    low,
    close,
    volume,
  };
}

export function findCandleGaps(candles, expectedInterval) {
  const gaps = [];
  for (let index = 1; index < candles.length; index += 1) {
    const after = candles[index - 1].timestamp;
    const before = candles[index].timestamp;
    const difference = before - after;
    if (difference !== expectedInterval) {
      gaps.push({
        after,
        before,
        missingCandles: Math.max(1, Math.round(difference / expectedInterval) - 1),
      });
    }
  }
  return gaps;
}

export function floorToIncrement(value, increment) {
  if (!(value > 0) || !(increment > 0)) {
    throw new Error("Value and increment must be positive");
  }
  const decimalPlaces = decimals(increment);
  const rounded = Math.floor(value / increment + Number.EPSILON) * increment;
  return Number(rounded.toFixed(decimalPlaces));
}

function decimals(value) {
  const text = String(value).toLowerCase();
  if (text.includes("e-")) return Number(text.split("e-")[1]);
  return text.includes(".") ? text.split(".")[1].length : 0;
}

export function buildValidationReport({ candles, currentPrice, baseIncrement, capital = 1000 }) {
  if (!Array.isArray(candles) || candles.length < 15) {
    throw new Error("At least 15 candles are required for validation");
  }

  const feeRate = 0.006;
  const slippageRate = 0.001;
  const expectedInterval = 4 * 60 * 60 * 1000;
  const validationIndex = Math.floor(candles.length * 0.7);
  const quantity = floorToIncrement(capital / (4 * (1 + feeRate) * currentPrice), baseIncrement);
  const gaps = findCandleGaps(candles, expectedInterval);
  const simulation = simulateDca(candles, {
    tradeStartIndex: validationIndex,
    rsiThreshold: 28,
    quantity,
    safetyDeviations: [0.05, 0.1, 0.15],
    takeProfit: 0.04,
    stopLoss: 0.2,
    feeRate,
    slippageRate,
    initialCapital: capital,
    rsiPeriods: 14,
  });
  simulation.dataValid = gaps.length === 0;
  const gates = evaluateGates(simulation);

  return {
    generatedAt: new Date().toISOString(),
    productId: "SOL-USD",
    capital,
    currentPrice,
    baseIncrement,
    quantity,
    configuration: {
      rsiPeriods: 14,
      rsiTimeframe: "4h",
      rsiThreshold: 28,
      safetyDeviations: [0.05, 0.1, 0.15],
      takeProfit: 0.04,
      stopLoss: 0.2,
      feeRate,
      slippageRate,
    },
    data: {
      candleCount: candles.length,
      start: new Date(candles[0].timestamp).toISOString(),
      end: new Date(candles[candles.length - 1].timestamp).toISOString(),
      gaps,
    },
    split: {
      trainingCandles: validationIndex,
      validationCandles: candles.length - validationIndex,
      validationIndex,
      validationStart: new Date(candles[validationIndex].timestamp).toISOString(),
    },
    metrics: simulation,
    gates,
    passed: gates.passed,
  };
}

export function aggregateCandles(candles, sourceInterval, targetInterval) {
  if (!(sourceInterval > 0) || !(targetInterval > sourceInterval) || targetInterval % sourceInterval !== 0) {
    throw new Error("Target interval must be a multiple of source interval");
  }

  const expectedCount = targetInterval / sourceInterval;
  const groups = new Map();
  for (const item of candles) {
    const timestamp = Math.floor(item.timestamp / targetInterval) * targetInterval;
    const group = groups.get(timestamp) ?? [];
    group.push(item);
    groups.set(timestamp, group);
  }

  const aggregated = [];
  for (const [timestamp, group] of groups) {
    group.sort((left, right) => left.timestamp - right.timestamp);
    const complete =
      group.length === expectedCount &&
      group.every((item, index) => item.timestamp === timestamp + index * sourceInterval);
    if (!complete) continue;

    aggregated.push({
      timestamp,
      open: group[0].open,
      high: Math.max(...group.map((item) => item.high)),
      low: Math.min(...group.map((item) => item.low)),
      close: group[group.length - 1].close,
      volume: group.reduce((total, item) => total + item.volume, 0),
    });
  }

  return aggregated.sort((left, right) => left.timestamp - right.timestamp);
}
