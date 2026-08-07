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
