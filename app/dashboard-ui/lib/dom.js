/**
 * DOM helpers.
 *
 * Everything here sets text through `textContent`. Bot names, symbols and error
 * strings come from the database and the exchange, so they are untrusted input
 * and must never reach the page as HTML.
 */

/** Create an element. Children may be nodes or strings; strings become text nodes. */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;

    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = String(value);
    else if (key === "html") node.innerHTML = value; // only ever called with literal markup
    else if (key === "style" && typeof value === "object") applyStyle(node, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (key === "dataset") for (const [d, v] of Object.entries(value)) node.dataset[d] = v;
    else node.setAttribute(key, value === true ? "" : String(value));
  }

  append(node, children);

  return node;
}

/**
 * Apply a style object.
 *
 * Custom properties have to go through `setProperty`: assigning `style["--w"]`
 * silently does nothing, which previously left every widget at its fallback
 * column span.
 */
function applyStyle(node, style) {
  for (const [property, value] of Object.entries(style)) {
    if (property.startsWith("--")) node.style.setProperty(property, String(value));
    else node.style[property] = value;
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";

export function svg(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;

    if (key === "text") node.textContent = String(value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (key === "dataset") for (const [d, v] of Object.entries(value)) node.dataset[d] = v;
    else node.setAttribute(key, String(value));
  }

  append(node, children);

  return node;
}

function append(node, children) {
  const list = Array.isArray(children) ? children : [children];

  for (const child of list) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
  }
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);

  return node;
}

export function mount(container, ...children) {
  clear(container);
  append(container, children);

  return container;
}

/** A centred placeholder for a widget with nothing to show. */
export function emptyState(message) {
  return el("div", { class: "empty", text: message });
}

/** A short explanatory note above a widget body. */
export function note(text, variant) {
  return el("div", { class: variant ? `note note--${variant}` : "note", text });
}

export function badge(text, variant) {
  return el("span", { class: variant ? `badge badge--${variant}` : "badge", text });
}

/** A labelled select that calls back with the new value. */
export function select(options, value, onChange, ariaLabel) {
  const node = el("select", { class: "select select--compact", "aria-label": ariaLabel ?? "Option" });

  for (const option of options) {
    node.append(el("option", { value: option.value, text: option.label, selected: option.value === value }));
  }

  node.addEventListener("change", () => onChange(node.value));

  return node;
}

/** Save `rows` as a CSV download. Values are quoted, so commas are safe. */
export function downloadCsv(filename, headers, rows) {
  const escape = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const csv = [headers.map(escape).join(","), ...rows.map((row) => row.map(escape).join(","))].join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = el("a", { href: url, download: filename });

  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
