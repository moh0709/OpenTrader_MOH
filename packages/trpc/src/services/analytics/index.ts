/**
 * Analytics services for the OpenTrader dashboard.
 *
 * These modules are pure: they take plain row shapes and return plain data, with
 * every database and exchange call left to the tRPC handlers. That keeps the P&L
 * maths, the health thresholds and the event logic unit testable without a
 * running daemon.
 */
export * from "./types.js";
export * from "./round-trips.js";
export * from "./positions.js";
export * from "./bot-stats.js";
export * from "./grid.js";
export * from "./history.js";
export * from "./health.js";
export * from "./events.js";
export * from "./ticker-cache.js";
