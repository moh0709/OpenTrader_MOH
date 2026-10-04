/**
 * An "MCP" button in the top bar that opens a panel for connecting an AI agent.
 *
 * Injected rather than added to the app because the bundled frontend is a prebuilt
 * React build with no source here — the same trick `analytics-link.js` uses, and
 * for the same reason: its class names are regenerated on every upstream build,
 * but its routes are not.
 *
 * The panel is the whole point. A download link on its own is a dead end for most
 * people: the file is a server, not an app, and "now run it with these three
 * environment variables" is where setup usually stops. So the panel shows the
 * exact configuration for each client with copy buttons, and states plainly which
 * of them will work from this deployment — a ChatGPT connector needs a public
 * HTTPS URL, and telling someone to try that from a LAN address on their laptop
 * wastes their afternoon.
 */

const MARK = "data-opentrader-mcp";
const STYLE_ID = "opentrader-mcp-style";
const PANEL_ID = "opentrader-mcp-panel";

const SVG_NS = "http://www.w3.org/2000/svg";

// ---------- api ----------

function authHeaders() {
  const password = window.localStorage.getItem("ADMIN_PASSWORD");

  return password ? { authorization: password } : {};
}

async function loadInfo() {
  const response = await window.fetch("/api/dash/mcp", { headers: authHeaders() });
  const payload = await response.json().catch(() => null);

  if (!response.ok) throw new Error(payload?.message || `HTTP ${response.status}`);

  return payload;
}

// ---------- panel ----------

/** The connection config for each client, as the copy-able block it needs. */
export function configs(info) {
  const stdioPath = "/absolute/path/to/opentrader-mcp.mjs";

  return [
    {
      id: "chatgpt",
      name: "ChatGPT",
      // The mobile apps only speak remote HTTP, so this is the one that works on a
      // phone — which is why it is listed first rather than third.
      blurb: "Works in ChatGPT on web, desktop, iOS and Android. Settings → Connectors → Add a custom MCP server.",
      works: info.chatgptReady,
      caveat: info.chatgptReady
        ? "Paste the URL below, then authenticate when ChatGPT asks."
        : "This instance is not on HTTPS, so ChatGPT will refuse it. Put it behind a TLS proxy, or use the download below from a desktop client.",
      body: info.endpoint,
    },
    {
      id: "claude",
      name: "Claude Desktop",
      blurb: "Runs the download locally over stdio. Download the file, then point the config at it.",
      works: true,
      caveat: "Needs Node 22 on the machine running Claude.",
      body: JSON.stringify(
        {
          mcpServers: {
            opentrader: {
              command: "node",
              args: [stdioPath],
              env: { OPENTRADER_ADMIN_PASSWORD: "<your admin password>" },
            },
          },
        },
        null,
        2,
      ),
    },
    {
      id: "codex",
      name: "Codex / Hermes",
      blurb: "Any client that spawns a local server over stdio uses the same download.",
      works: true,
      caveat: null,
      body: JSON.stringify(
        {
          mcpServers: {
            opentrader: {
              command: "node",
              args: [stdioPath],
              env: {
                OPENTRADER_ADMIN_PASSWORD: "<your admin password>",
                OPENTRADER_URL: "https://your-opentrader-host",
              },
            },
          },
        },
        null,
        2,
      ),
    },
  ];
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props)) {
    if (key === "text") node.textContent = value;
    else if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }

  for (const child of [children].flat()) if (child) node.append(child);

  return node;
}

/**
 * A copy button that says what it copied.
 *
 * `navigator.clipboard` is unavailable on plain-HTTP origins, which is exactly
 * where someone will be reading this while setting up a proxy. Falling back to a
 * hidden textarea keeps the one action the panel exists for working in both cases.
 */
function copyButton(getText) {
  const button = el("button", { class: "ot-mcp__copy", type: "button", text: "Copy" });

  button.addEventListener("click", async () => {
    const text = getText();
    let done = false;

    try {
      await window.navigator.clipboard.writeText(text);
      done = true;
    } catch {
      const area = el("textarea", { class: "ot-mcp__fallback" });
      area.value = text;
      document.body.append(area);
      area.select();
      try {
        done = document.execCommand("copy");
      } catch {
        done = false;
      }
      area.remove();
    }

    button.textContent = done ? "Copied" : "Press Ctrl+C";
    window.setTimeout(() => (button.textContent = "Copy"), 1600);
  });

  return button;
}

function buildPanel(doc, info) {
  const panel = el("div", {
    class: "ot-mcp__panel",
    id: PANEL_ID,
    role: "dialog",
    "aria-label": "Connect an AI agent",
  });

  const close = () => panel.remove();
  const dismiss = el("button", { class: "ot-mcp__close", type: "button", "aria-label": "Close", text: "×" });

  dismiss.addEventListener("click", close);
  doc.addEventListener("keydown", function onEsc(event) {
    if (event.key !== "Escape") return;
    close();
    doc.removeEventListener("keydown", onEsc);
  });

  panel.append(
    el("h2", { class: "ot-mcp__title", text: "Connect an AI agent" }),
    el("p", {
      class: "ot-mcp__note",
      // `note` is the server's own explanation of why ChatGPT may or may not work
      // from here. Showing it verbatim is the difference between a working setup
      // and half an hour of debugging a URL that was never going to connect.
      text: info.note,
    }),
    info.chatgptReady
      ? el(
          "a",
          {
            class: "ot-mcp__cta",
            href: "https://chatgpt.com/#settings/Connectors",
            target: "_blank",
            rel: "noopener noreferrer",
          },
          "Open ChatGPT connectors →",
        )
      : null,
  );

  for (const spec of configs(info)) {
    panel.append(
      el("div", { class: "ot-mcp__client" }, [
        el("div", { class: "ot-mcp__client-head" }, [
          el("h3", { class: "ot-mcp__client-name", text: spec.name }),
          el("span", {
            class: `ot-mcp__badge ot-mcp__badge--${spec.works ? "ok" : "warn"}`,
            text: spec.works ? "Available" : "Needs setup",
          }),
        ]),
        el("p", { class: "ot-mcp__blurb", text: spec.blurb }),
        spec.caveat ? el("p", { class: "ot-mcp__caveat", text: spec.caveat }) : null,
        el("div", { class: "ot-mcp__code-row" }, [
          el("pre", { class: "ot-mcp__code", text: spec.body }),
          copyButton(() => spec.body),
        ]),
      ]),
    );
  }

  panel.append(
    el(
      "a",
      { class: "ot-mcp__download", href: "/api/dash/mcp/download", download: "opentrader-mcp.mjs" },
      "Download the MCP server (.mjs)",
    ),
    el("p", {
      class: "ot-mcp__fine",
      text: "One self-contained file, no dependencies. It exposes the same tools as the URL above, including ones that close real positions.",
    }),
    dismiss,
  );

  return panel;
}

/** Fetch the endpoint info, then show the panel once it arrives. */
async function openPanel(doc, anchor) {
  doc.getElementById(PANEL_ID)?.remove();

  const pending = el("div", { class: "ot-mcp__panel ot-mcp__panel--loading", text: "Loading…" });
  doc.body.append(pending);

  try {
    const panel = buildPanel(doc, await loadInfo());
    pending.remove();
    doc.body.append(panel);

    // Position beside the button. The panel is tall and phones are short, so it
    // flips up when there is not enough room below.
    const box = anchor.getBoundingClientRect();
    panel.style.top = `${Math.max(8, Math.min(box.bottom + 8, window.innerHeight - 460))}px`;
    panel.style.left =
      box.left > window.innerWidth - 400 ? `${Math.max(8, window.innerWidth - 400)}px` : `${Math.max(8, box.left)}px`;
  } catch (error) {
    pending.textContent = `Could not load the connection details: ${error.message}`;
  }
}

function installStyle(doc) {
  if (doc.getElementById(STYLE_ID)) return;

  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .ot-mcp__panel {
      position: fixed; z-index: 9999; width: min(460px, calc(100vw - 16px));
      max-height: min(78vh, 720px); overflow-y: auto; padding: 18px; border-radius: 14px;
      background: var(--joy-palette-background, #fff); color: var(--joy-palette-text-primary, #0b0b0b);
      border: 1px solid var(--joy-palette-divider, rgba(128,128,128,.3));
      box-shadow: 0 12px 40px rgba(0,0,0,.22); font-size: 14px; line-height: 1.45;
    }
    .ot-mcp__panel--loading { color: #666; }
    .ot-mcp__title { margin: 0 0 6px; font-size: 17px; }
    .ot-mcp__note { margin: 0 0 12px; color: var(--joy-palette-text-secondary, #52514e); }
    .ot-mcp__cta {
      display: inline-block; margin-bottom: 14px; padding: 9px 14px; border-radius: 9px;
      background: var(--joy-palette-primary, #0b6bcb); color: #fff;
      text-decoration: none; font-weight: 600;
    }
    .ot-mcp__client { padding: 12px 0; border-top: 1px solid var(--joy-palette-divider, rgba(128,128,128,.2)); }
    .ot-mcp__client-head { display: flex; align-items: center; gap: 8px; }
    .ot-mcp__client-name { margin: 0; font-size: 14px; }
    .ot-mcp__badge { margin-left: auto; font-size: 11px; padding: 2px 7px; border-radius: 999px; }
    .ot-mcp__badge--ok { background: rgba(28,140,74,.14); color: #1c7c46; }
    .ot-mcp__badge--warn { background: rgba(190,120,0,.16); color: #96600a; }
    .ot-mcp__blurb, .ot-mcp__caveat, .ot-mcp__fine { margin: 5px 0; font-size: 12.5px; color: var(--joy-palette-text-secondary, #52514e); }
    .ot-mcp__caveat { color: #96600a; }
    .ot-mcp__code-row { display: flex; gap: 8px; align-items: flex-start; margin-top: 8px; }
    .ot-mcp__code {
      flex: 1; margin: 0; padding: 9px; overflow-x: auto; border-radius: 8px;
      background: var(--joy-palette-neutral-plainHoverBg, rgba(128,128,128,.1));
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px;
    }
    .ot-mcp__copy {
      flex: none; padding: 7px 11px; border-radius: 8px; cursor: pointer;
      border: 1px solid var(--joy-palette-divider, rgba(128,128,128,.35));
      background: transparent; color: inherit; font-size: 12px; font-weight: 600;
    }
    .ot-mcp__download {
      display: inline-block; margin-top: 14px; padding: 10px 14px; border-radius: 9px;
      border: 1px solid var(--joy-palette-divider, rgba(128,128,128,.35));
      text-decoration: none; font-weight: 600; color: inherit;
    }
    .ot-mcp__close {
      position: absolute; top: 10px; right: 12px; border: 0; background: transparent;
      font-size: 22px; line-height: 1; cursor: pointer; color: inherit; opacity: .6;
    }
    .ot-mcp__fallback { position: fixed; left: -9999px; }
  `;
  doc.head.append(style);
}

/** The logo link in the top bar — the one element rendered in every layout. */
function logoLink(doc) {
  for (const anchor of doc.querySelectorAll('a[href="/#/"]')) {
    const box = anchor.getBoundingClientRect();
    if (box.top < 90 && box.width > 0) return anchor;
  }

  return null;
}

function attachButton(doc = document) {
  const logo = logoLink(doc);
  if (!logo) return false;
  if (doc.querySelector(`[${MARK}]`)) return false;

  installStyle(doc);

  const button = doc.createElement("button");
  button.setAttribute(MARK, "");
  button.type = "button";
  button.className = "ot-toplink";
  // The label doubles as the accessible name, so hiding it on a narrow bar leaves
  // the glyph still naming itself.
  button.setAttribute("aria-label", "Connect an AI agent");
  button.title = "Connect an AI agent";
  button.style.cssText = "cursor:pointer;background:transparent;font-family:inherit";

  const icon = doc.createElementNS(SVG_NS, "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("width", "18");
  icon.setAttribute("height", "18");
  icon.setAttribute("aria-hidden", "true");
  // A plug: the universal shorthand for "something connects here".
  for (const attrs of [
    { x1: 9, y1: 2, x2: 9, y2: 6 },
    { x1: 15, y1: 2, x2: 15, y2: 6 },
    { x1: 6, y1: 6, x2: 18, y2: 6 },
    { x1: 12, y1: 6, x2: 12, y2: 12 },
    { x1: 8, y1: 12, x2: 16, y2: 12 },
  ]) {
    const line = doc.createElementNS(SVG_NS, "line");
    for (const [k, v] of Object.entries(attrs)) line.setAttribute(k, String(v));
    line.setAttribute("stroke", "currentColor");
    line.setAttribute("stroke-width", "2.2");
    line.setAttribute("stroke-linecap", "round");
    icon.append(line);
  }

  const text = doc.createElement("span");
  text.className = "ot-toplink__label";
  text.textContent = "MCP";

  button.append(icon, text);
  button.addEventListener("click", () => openPanel(doc, button));

  logo.after(button);

  return true;
}

export function startMcpLink() {
  if (typeof window === "undefined" || window.__openTraderMcpLinkStarted) return;
  window.__openTraderMcpLinkStarted = true;

  let queued = false;

  const sync = () => {
    queued = false;
    attachButton();
  };

  // React rebuilds the header on navigation and drops the button, so a single pass
  // at load is not enough — the same reason analytics-link.js re-attaches.
  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    window.setTimeout(sync, 0);
  });

  observer.observe(document.getElementById("root") ?? document.body, { childList: true, subtree: true });

  attachButton();
}

if (typeof window !== "undefined") startMcpLink();
