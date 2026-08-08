const MONITOR_ID = "opentrader-rsi-monitor";
const STYLE_ID = "opentrader-rsi-monitor-style";
const POLL_INTERVAL_MS = 15000;
const STALE_AFTER_MS = 120000;

export function parseBotId(hash) {
  const match = /^#\/dashboard\/(?:dca-)?bot\/(\d+)$/.exec(hash);
  return match ? Number(match[1]) : null;
}

export function findRsiRule(settings) {
  function visit(node) {
    if (!node || typeof node !== "object") return null;
    if (node.field === "RSI" && node.value?.timeframe && node.value?.periods) return node;

    for (const child of node.rules ?? []) {
      const match = visit(child);
      if (match) return match;
    }

    return null;
  }

  return visit(settings?.entry?.conditions);
}

export function readRsiSnapshot(bot, rule) {
  const periods = Number(rule?.value?.periods);
  const timeframe = rule?.value?.timeframe;
  const key = JSON.stringify({ periods });
  const value = bot?.state?.indicatorSnapshot?.values?.RSI?.[timeframe]?.[key];
  const numericValue = Number(value);

  return Number.isFinite(numericValue) ? numericValue : null;
}

export function evaluateOperator(value, operator, threshold) {
  switch (operator) {
    case "<":
      return value < threshold;
    case "<=":
      return value <= threshold;
    case ">":
      return value > threshold;
    case ">=":
      return value >= threshold;
    case "==":
    case "===":
      return value === threshold;
    case "!=":
    case "!==":
      return value !== threshold;
    default:
      return false;
  }
}

export function buildRsiViewModel(bot, now = Date.now()) {
  const rule = findRsiRule(bot?.settings);
  if (!rule) return null;

  const periods = Number(rule.value.periods);
  const timeframe = rule.value.timeframe;
  const threshold = Number(rule.value.indicatorValue);
  const value = readRsiSnapshot(bot, rule);
  const updatedAt = Number(bot?.state?.indicatorSnapshot?.updatedAt);
  const hasSnapshot = value !== null && Number.isFinite(updatedAt);
  const ageSeconds = hasSnapshot ? Math.max(0, Math.floor((now - updatedAt) / 1000)) : null;

  let status = "unavailable";
  if (hasSnapshot && now - updatedAt > STALE_AFTER_MS) {
    status = "stale";
  } else if (hasSnapshot) {
    status = evaluateOperator(value, rule.operator, threshold) ? "met" : "waiting";
  }

  return {
    label: `RSI(${periods}) - ${timeframe}`,
    value,
    condition: `${rule.operator}${threshold}`,
    status,
    updatedAt: hasSnapshot ? updatedAt : null,
    ageSeconds,
  };
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #${MONITOR_ID} {
      border-top: 1px solid var(--joy-palette-divider, rgba(128, 128, 128, 0.25));
      margin-top: 12px;
      padding-top: 14px;
    }
    #${MONITOR_ID} .ot-rsi-heading,
    #${MONITOR_ID} .ot-rsi-detail {
      align-items: center;
      display: flex;
      justify-content: space-between;
      gap: 12px;
    }
    #${MONITOR_ID} .ot-rsi-label {
      align-items: center;
      display: flex;
      font-size: 0.95rem;
      gap: 10px;
    }
    #${MONITOR_ID} .ot-rsi-icon {
      align-items: center;
      background: var(--joy-palette-primary-softBg, rgba(24, 119, 242, 0.15));
      border-radius: 50%;
      color: var(--joy-palette-primary-plainColor, #4da3ff);
      display: inline-flex;
      font-size: 0.7rem;
      font-weight: 700;
      height: 24px;
      justify-content: center;
      width: 24px;
    }
    #${MONITOR_ID} .ot-rsi-value {
      color: var(--joy-palette-text-tertiary, #a8b0ba);
      font-size: 1rem;
      font-weight: 700;
    }
    #${MONITOR_ID} .ot-rsi-detail {
      color: var(--joy-palette-text-tertiary, #a8b0ba);
      font-size: 0.75rem;
      margin-left: 34px;
      margin-top: 5px;
    }
    #${MONITOR_ID}[data-status="met"] .ot-rsi-status {
      color: var(--joy-palette-success-plainColor, #61d978);
    }
    #${MONITOR_ID}[data-status="waiting"] .ot-rsi-status {
      color: var(--joy-palette-warning-plainColor, #f4b860);
    }
    #${MONITOR_ID}[data-status="stale"] .ot-rsi-status,
    #${MONITOR_ID}[data-status="unavailable"] .ot-rsi-status {
      color: var(--joy-palette-danger-plainColor, #ff6b6b);
    }
  `;
  document.head.append(style);
}

function findTimeframeRow() {
  return (
    [...document.querySelectorAll("*")].find(
      (element) => element.children.length === 0 && element.textContent?.trim() === "Timeframe",
    )?.parentElement ?? null
  );
}

function formatCondition(condition) {
  return condition.replace(/^([<>=!]+)(.*)$/, "$1 $2");
}

function renderModel(model) {
  if (!model) {
    document.getElementById(MONITOR_ID)?.remove();
    return;
  }

  const timeframeRow = findTimeframeRow();
  if (!timeframeRow?.parentElement) return;

  ensureStyles();

  let monitor = document.getElementById(MONITOR_ID);
  if (!monitor) {
    monitor = document.createElement("div");
    monitor.id = MONITOR_ID;
    monitor.innerHTML = `
      <div class="ot-rsi-heading">
        <span class="ot-rsi-label"><span class="ot-rsi-icon">R</span><span data-rsi-label></span></span>
        <span class="ot-rsi-value" data-rsi-value></span>
      </div>
      <div class="ot-rsi-detail">
        <span class="ot-rsi-status" data-rsi-status></span>
        <span data-rsi-updated></span>
      </div>
    `;
    timeframeRow.insertAdjacentElement("afterend", monitor);
  } else if (monitor.previousElementSibling !== timeframeRow) {
    timeframeRow.insertAdjacentElement("afterend", monitor);
  }

  const statusText = {
    met: `Condition met ${formatCondition(model.condition)}`,
    waiting: `Waiting for ${formatCondition(model.condition)}`,
    stale: "Stale value",
    unavailable: "Waiting for live data",
  };

  monitor.dataset.status = model.status;
  monitor.querySelector("[data-rsi-label]").textContent = model.label;
  monitor.querySelector("[data-rsi-value]").textContent = model.value === null ? "--" : model.value.toFixed(2);
  monitor.querySelector("[data-rsi-status]").textContent = statusText[model.status];
  monitor.querySelector("[data-rsi-updated]").textContent =
    model.ageSeconds === null ? "Not updated yet" : `Updated ${model.ageSeconds}s ago`;
}

async function fetchBot(botId) {
  const password = window.localStorage.getItem("ADMIN_PASSWORD");
  if (!password) throw new Error("OpenTrader login is required");

  const input = encodeURIComponent(JSON.stringify({ json: botId }));
  const response = await window.fetch(`/api/trpc/bot.getOne?input=${input}`, {
    headers: { authorization: password },
  });

  if (!response.ok) throw new Error(`Bot request failed with HTTP ${response.status}`);

  const payload = await response.json();
  const bot = payload?.result?.data?.json;
  if (!bot) throw new Error("Bot response did not contain data");

  return bot;
}

export function startRsiMonitor() {
  if (typeof window === "undefined" || window.__openTraderRsiMonitorStarted) return;
  window.__openTraderRsiMonitorStarted = true;

  let intervalId = null;
  let lastBot = null;
  let refreshInFlight = false;
  let renderQueued = false;

  const stopPolling = () => {
    if (intervalId !== null) {
      window.clearInterval(intervalId);
      intervalId = null;
    }
  };

  const renderLastBot = () => {
    const botId = parseBotId(window.location.hash);
    if (botId === null || lastBot?.id !== botId) {
      renderModel(null);
      return;
    }
    renderModel(buildRsiViewModel(lastBot));
  };

  const refresh = async () => {
    const botId = parseBotId(window.location.hash);
    if (botId === null || document.visibilityState !== "visible" || refreshInFlight) return;

    refreshInFlight = true;
    try {
      lastBot = await fetchBot(botId);
      renderLastBot();
    } catch {
      renderLastBot();
    } finally {
      refreshInFlight = false;
    }
  };

  const startPolling = () => {
    stopPolling();
    if (parseBotId(window.location.hash) === null || document.visibilityState !== "visible") return;

    void refresh();
    intervalId = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
  };

  const syncRoute = () => {
    const botId = parseBotId(window.location.hash);
    if (lastBot?.id !== botId) lastBot = null;
    renderLastBot();
    startPolling();
  };

  const observer = new MutationObserver(() => {
    if (
      !renderQueued &&
      lastBot &&
      parseBotId(window.location.hash) === lastBot.id &&
      !document.getElementById(MONITOR_ID)
    ) {
      renderQueued = true;
      window.setTimeout(() => {
        renderQueued = false;
        renderLastBot();
      }, 0);
    }
  });

  observer.observe(document.getElementById("root") ?? document.body, {
    childList: true,
    subtree: true,
  });

  window.addEventListener("hashchange", syncRoute);
  window.addEventListener("popstate", syncRoute);
  document.addEventListener("visibilitychange", startPolling);
  syncRoute();
}

if (typeof window !== "undefined") {
  startRsiMonitor();
}
