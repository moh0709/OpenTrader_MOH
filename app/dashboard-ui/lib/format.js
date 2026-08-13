/** Formatting helpers. Every money and percent value on the dashboard goes through here. */

const QUOTE_SYMBOLS = { USD: "$", USDT: "$", USDC: "$", EUR: "€", GBP: "£" };

/** The quote currency of a pair, which is what profit is denominated in. */
export function quoteCurrency(symbol) {
  if (typeof symbol !== "string") return "";

  return symbol.split("/")[1] ?? "";
}

export function currencySymbol(symbol) {
  return QUOTE_SYMBOLS[quoteCurrency(symbol)] ?? "";
}

/**
 * Money, with enough precision to be useful.
 *
 * Grid bots earn cents per trade, so rounding to two decimals would show a
 * genuine profit as 0.00. Small values keep more decimals.
 */
export function money(value, { symbol = "$", signed = false, compact = false } = {}) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";

  const abs = Math.abs(value);

  if (compact && abs >= 1000) {
    const units = [
      [1e9, "B"],
      [1e6, "M"],
      [1e3, "K"],
    ];
    for (const [size, suffix] of units) {
      if (abs >= size) {
        const scaled = value / size;
        return `${sign(value, signed)}${symbol}${Math.abs(scaled).toFixed(Math.abs(scaled) >= 100 ? 0 : 1)}${suffix}`;
      }
    }
  }

  const decimals = abs >= 1000 ? 2 : abs >= 1 ? 2 : abs >= 0.01 ? 3 : 4;
  const body = Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });

  return `${sign(value, signed)}${symbol}${body}`;
}

function sign(value, signed) {
  if (value < 0) return "-";

  return signed ? "+" : "";
}

export function percent(value, { signed = true, decimals = 2 } = {}) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";

  return `${sign(value, signed)}${Math.abs(value).toFixed(decimals)}%`;
}

/** Prices need more precision for cheap assets than for BTC. */
export function price(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";

  const abs = Math.abs(value);
  const decimals = abs >= 1000 ? 2 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;

  return value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function quantity(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";

  const abs = Math.abs(value);
  if (abs === 0) return "0";
  if (abs < 0.0001) return value.toExponential(2);

  return value.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

export function count(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";

  return value.toLocaleString("en-US");
}

/** A duration as the largest two units that matter, e.g. "1h 12m". */
export function duration(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return "—";

  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ${hours % 24}h`;

  return `${Math.floor(days / 30)}mo ${days % 30}d`;
}

/** "3m ago". Used for the closed-trades column. */
export function timeAgo(timestamp, now = Date.now()) {
  if (!timestamp) return "—";

  const delta = now - timestamp;
  if (delta < 0) return "just now";
  if (delta < 45_000) return `${Math.max(1, Math.floor(delta / 1000))}s ago`;

  return `${duration(delta)} ago`;
}

export function dateTime(timestamp) {
  if (!timestamp) return "—";

  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function timeOnly(timestamp) {
  if (!timestamp) return "—";

  return new Date(timestamp).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function bytes(value) {
  if (value === null || value === undefined) return "—";
  if (value >= 1_073_741_824) return `${(value / 1_073_741_824).toFixed(2)} GB`;
  if (value >= 1_048_576) return `${(value / 1_048_576).toFixed(0)} MB`;

  return `${(value / 1024).toFixed(0)} KB`;
}

/** The CSS class carrying profit direction. Always paired with a sign in the text. */
export function pnlClass(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "flat";
  if (value > 0) return "pos";
  if (value < 0) return "neg";

  return "flat";
}
