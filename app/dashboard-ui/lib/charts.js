/**
 * SVG chart primitives.
 *
 * Hand-rolled rather than pulled from a library, so the dashboard stays a set of
 * static files with no bundler and no external requests.
 *
 * The marks follow one fixed spec: 2px lines with round joins, bars capped at
 * 24px with a 4px rounded data-end and a square baseline end, markers at least
 * 8px across carrying a 2px surface ring, area fills at ~10% opacity, and
 * hairline solid gridlines a single step off the surface. Text always wears a
 * text token - never a series colour - so identity comes from the mark beside
 * the label rather than from coloured type.
 */
import { el, svg } from "./dom.js";

const SERIES = ["var(--series-1)", "var(--series-2)", "var(--series-3)"];
const SEQ = ["var(--seq-100)", "var(--seq-250)", "var(--seq-400)", "var(--seq-550)", "var(--seq-700)"];

export const seriesColor = (index) => SERIES[index % SERIES.length];

/** A step of the single-hue ramp for a 0..1 magnitude. */
export function sequentialColor(t) {
  if (!Number.isFinite(t)) return SEQ[0];

  return SEQ[Math.min(SEQ.length - 1, Math.max(0, Math.round(t * (SEQ.length - 1))))];
}

// ---------- Tooltip ----------

let tooltipNode = null;

function tooltipEl() {
  if (!tooltipNode) {
    tooltipNode = el("div", { class: "tooltip", role: "tooltip" });
    tooltipNode.style.display = "none";
    document.body.append(tooltipNode);
  }

  return tooltipNode;
}

/** `rows` is `[{ label, value, color }]`; label and value are set as text. */
export function showTooltip(event, title, rows) {
  const node = tooltipEl();
  node.replaceChildren();

  if (title) node.append(el("div", { class: "tooltip__title", text: title }));

  for (const row of rows) {
    node.append(
      el("div", { class: "tooltip__row" }, [
        el("span", { class: "tooltip__key" }, [
          row.color ? el("span", { class: "legend__line", style: { background: row.color } }) : null,
          // Series names come from the database: text only, never markup.
          el("span", { text: row.label }),
        ]),
        el("span", { class: "tooltip__value", text: row.value }),
      ]),
    );
  }

  node.style.display = "block";

  // Keep the tooltip inside the viewport rather than letting it clip at an edge.
  const rect = node.getBoundingClientRect();
  const x = Math.min(event.clientX + 12, window.innerWidth - rect.width - 8);
  const y = Math.max(8, Math.min(event.clientY - rect.height - 12, window.innerHeight - rect.height - 8));

  node.style.left = `${Math.max(8, x)}px`;
  node.style.top = `${y}px`;
}

export function hideTooltip() {
  if (tooltipNode) tooltipNode.style.display = "none";
}

document.addEventListener("scroll", hideTooltip, true);

// ---------- Legend ----------

/** A legend is always present for two or more series; one series needs none. */
export function legend(items, { keyShape = "swatch" } = {}) {
  if (items.length < 2) return null;

  return el(
    "div",
    { class: "legend" },
    items.map((item) =>
      el("span", { class: "legend__item" }, [
        el("span", {
          class: keyShape === "line" ? "legend__line" : "legend__swatch",
          style: { background: item.color },
        }),
        el("span", { text: item.label }),
      ]),
    ),
  );
}

// ---------- Sparkline ----------

/** A bare trend line for a stat tile. No axes, no hover - the tile carries the value. */
export function sparkline(values, { width = 120, height = 24, color = "var(--series-1)" } = {}) {
  const node = svg("svg", {
    class: "chart",
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: "none",
    height,
    "aria-hidden": "true",
  });

  if (!values || values.length < 2) return node;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const stepX = width / (values.length - 1);
  const y = (value) => height - 2 - ((value - min) / span) * (height - 4);

  const points = values.map((value, index) => `${index * stepX},${y(value)}`).join(" L ");

  node.append(
    svg("path", {
      d: `M ${points}`,
      fill: "none",
      stroke: color,
      "stroke-width": 2,
      "stroke-linejoin": "round",
      "stroke-linecap": "round",
      "vector-effect": "non-scaling-stroke",
    }),
  );

  return node;
}

// ---------- Axis helpers ----------

/** Round an axis maximum up to a clean number, so ticks read 0 / 1,000 / 2,000. */
function niceCeil(value) {
  if (value <= 0) return 1;

  const exponent = Math.floor(Math.log10(value));
  const magnitude = 10 ** exponent;
  const normalised = value / magnitude;
  const step = normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10;

  return step * magnitude;
}

function ticks(min, max, count = 4) {
  const values = [];
  for (let i = 0; i <= count; i += 1) values.push(min + ((max - min) * i) / count);

  return values;
}

// ---------- Line / area chart ----------

/**
 * A time series with a crosshair that snaps to the nearest point.
 *
 * `series` is `[{ label, color, points: [{ x, y }] }]`. The reader aims at a
 * date, never at a 2px line, so the hit layer spans the full plot height.
 */
export function lineChart(series, options = {}) {
  const {
    width = 640,
    height = 200,
    padding = { top: 12, right: 14, bottom: 22, left: 52 },
    formatY = (value) => String(Math.round(value)),
    formatX = (value) => String(value),
    area = false,
    zeroLine = false,
  } = options;

  const node = svg("svg", { class: "chart", viewBox: `0 0 ${width} ${height}`, role: "img" });
  const withPoints = series.filter((s) => s.points.length > 0);
  if (withPoints.length === 0) return node;

  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  const allX = withPoints.flatMap((s) => s.points.map((p) => p.x));
  const allY = withPoints.flatMap((s) => s.points.map((p) => p.y));
  const minX = Math.min(...allX);
  const maxX = Math.max(...allX) || minX + 1;
  let minY = Math.min(...allY, zeroLine ? 0 : Infinity);
  let maxY = Math.max(...allY, zeroLine ? 0 : -Infinity);

  if (maxY === minY) {
    maxY += Math.abs(maxY || 1) * 0.1;
    minY -= Math.abs(minY || 1) * 0.1;
  }

  const sx = (x) => padding.left + (maxX === minX ? plotW / 2 : ((x - minX) / (maxX - minX)) * plotW);
  const sy = (y) => padding.top + plotH - ((y - minY) / (maxY - minY)) * plotH;

  // Recessive hairline grid, solid, one step off the surface.
  const grid = svg("g", { class: "chart__grid" });
  for (const value of ticks(minY, maxY, 4)) {
    const y = sy(value);
    grid.append(svg("line", { x1: padding.left, x2: width - padding.right, y1: y, y2: y }));
    node.append(
      svg("text", {
        class: "chart__tick",
        x: padding.left - 7,
        y: y + 3,
        "text-anchor": "end",
        text: formatY(value),
      }),
    );
  }
  node.prepend(grid);

  if (zeroLine && minY < 0 && maxY > 0) {
    node.append(
      svg("line", {
        class: "chart__axis",
        x1: padding.left,
        x2: width - padding.right,
        y1: sy(0),
        y2: sy(0),
      }),
    );
  }

  for (const [index, s] of withPoints.entries()) {
    const color = s.color ?? seriesColor(index);
    const path = s.points.map((p, i) => `${i === 0 ? "M" : "L"} ${sx(p.x)} ${sy(p.y)}`).join(" ");

    if (area && withPoints.length === 1) {
      const baseline = sy(Math.max(minY, 0));
      node.append(
        svg("path", {
          d: `${path} L ${sx(s.points[s.points.length - 1].x)} ${baseline} L ${sx(s.points[0].x)} ${baseline} Z`,
          fill: color,
          "fill-opacity": 0.1,
          stroke: "none",
        }),
      );
    }

    node.append(
      svg("path", {
        d: path,
        fill: "none",
        stroke: color,
        "stroke-width": 2,
        "stroke-linejoin": "round",
        "stroke-linecap": "round",
      }),
    );

    // End marker, with a surface ring so it stays legible where lines overlap.
    const last = s.points[s.points.length - 1];
    node.append(svg("circle", { cx: sx(last.x), cy: sy(last.y), r: 4, fill: color, stroke: "var(--surface-1)", "stroke-width": 2 }));
  }

  // X ticks at the ends only - the crosshair carries everything in between.
  node.append(
    svg("text", { class: "chart__tick", x: padding.left, y: height - 6, "text-anchor": "start", text: formatX(minX) }),
    svg("text", { class: "chart__tick", x: width - padding.right, y: height - 6, "text-anchor": "end", text: formatX(maxX) }),
  );

  // Crosshair: snaps to the nearest x, reports every series at that x.
  const crosshair = svg("line", { class: "chart__crosshair", y1: padding.top, y2: padding.top + plotH, opacity: 0 });
  const dots = svg("g", { opacity: 0 });
  node.append(crosshair, dots);

  const hit = svg("rect", {
    class: "chart__hit",
    x: padding.left,
    y: padding.top,
    width: plotW,
    height: plotH,
  });

  hit.addEventListener("pointermove", (event) => {
    const box = node.getBoundingClientRect();
    const localX = ((event.clientX - box.left) / box.width) * width;
    const dataX = minX + ((localX - padding.left) / plotW) * (maxX - minX);

    const rows = [];
    dots.replaceChildren();
    let snappedX = null;

    for (const [index, s] of withPoints.entries()) {
      const color = s.color ?? seriesColor(index);
      let nearest = s.points[0];
      for (const point of s.points) {
        if (Math.abs(point.x - dataX) < Math.abs(nearest.x - dataX)) nearest = point;
      }

      snappedX = snappedX ?? nearest.x;
      rows.push({ label: s.label, value: formatY(nearest.y), color });
      dots.append(
        svg("circle", { cx: sx(nearest.x), cy: sy(nearest.y), r: 4, fill: color, stroke: "var(--surface-1)", "stroke-width": 2 }),
      );
    }

    crosshair.setAttribute("x1", sx(snappedX));
    crosshair.setAttribute("x2", sx(snappedX));
    crosshair.setAttribute("opacity", 1);
    dots.setAttribute("opacity", 1);

    showTooltip(event, formatX(snappedX), rows);
  });

  hit.addEventListener("pointerleave", () => {
    crosshair.setAttribute("opacity", 0);
    dots.setAttribute("opacity", 0);
    hideTooltip();
  });

  node.append(hit);

  return node;
}

// ---------- Bar chart ----------

/**
 * Horizontal bars. `items` is `[{ label, value, color, meta }]`.
 *
 * The mark is the hit target - no crosshair - and a value label rides the bar
 * tip only when it fits outside the bar, so text is never clipped by its mark.
 */
export function barChart(items, options = {}) {
  const {
    width = 620,
    rowHeight = 26,
    labelWidth = 130,
    valueWidth = 88,
    formatValue = (value) => String(value),
    color = "var(--series-1)",
    diverging = false,
    onSelect = null,
  } = options;

  const height = Math.max(rowHeight, items.length * rowHeight);
  const node = svg("svg", { class: "chart", viewBox: `0 0 ${width} ${height}`, height, role: "img" });
  if (items.length === 0) return node;

  const plotLeft = labelWidth + 8;
  const plotW = width - plotLeft - valueWidth;
  const values = items.map((item) => item.value);
  const maxAbs = niceCeil(Math.max(...values.map(Math.abs), 0.0000001));
  // Diverging bars grow both ways from a centre baseline; ordinary bars from the left.
  const zeroX = diverging ? plotLeft + plotW / 2 : plotLeft;
  const scale = diverging ? plotW / 2 / maxAbs : plotW / maxAbs;

  // Bars are capped at 24px and never fill their slot: the leftover is air.
  const barH = Math.min(24, rowHeight - 10);

  for (const [index, item] of items.entries()) {
    const y = index * rowHeight + (rowHeight - barH) / 2;
    const length = Math.abs(item.value) * scale;
    const negative = item.value < 0;
    const x = negative ? zeroX - length : zeroX;
    const fill = item.color ?? color;
    const r = 4;

    const group = svg("g", { class: "chart__mark", style: onSelect ? "cursor:pointer" : "" });

    // 4px rounded data-end, square at the baseline.
    if (length > r) {
      const d = negative
        ? `M ${x + length} ${y} H ${x + r} A ${r} ${r} 0 0 0 ${x} ${y + r} V ${y + barH - r} A ${r} ${r} 0 0 0 ${x + r} ${y + barH} H ${x + length} Z`
        : `M ${x} ${y} H ${x + length - r} A ${r} ${r} 0 0 1 ${x + length} ${y + r} V ${y + barH - r} A ${r} ${r} 0 0 1 ${x + length - r} ${y + barH} H ${x} Z`;
      group.append(svg("path", { d, fill }));
    } else if (length > 0) {
      group.append(svg("rect", { x, y, width: Math.max(length, 1), height: barH, fill }));
    }

    // Category label in a text token, never the series colour.
    group.append(
      svg("text", {
        class: "chart__label",
        x: labelWidth,
        y: y + barH / 2 + 4,
        "text-anchor": "end",
        text: item.label,
      }),
    );

    // Value outside the bar end, where it can never be clipped by the mark.
    group.append(
      svg("text", {
        class: "chart__label",
        x: negative ? zeroX + 6 : Math.min(zeroX + length + 6, width - 4),
        y: y + barH / 2 + 4,
        "text-anchor": "start",
        text: formatValue(item.value),
      }),
    );

    // Hit target spans the whole row, comfortably larger than the mark.
    const hit = svg("rect", { class: "chart__hit", x: 0, y: index * rowHeight, width, height: rowHeight });
    hit.addEventListener("pointermove", (event) =>
      showTooltip(event, item.label, [
        { label: item.metaLabel ?? "Value", value: formatValue(item.value), color: fill },
        ...(item.meta ? [{ label: item.meta.label, value: item.meta.value }] : []),
      ]),
    );
    hit.addEventListener("pointerleave", hideTooltip);
    if (onSelect) hit.addEventListener("click", () => onSelect(item));

    group.append(hit);
    node.append(group);
  }

  if (diverging) {
    node.append(svg("line", { class: "chart__axis", x1: zeroX, x2: zeroX, y1: 0, y2: height }));
  }

  return node;
}

// ---------- Column chart (distributions) ----------

export function columnChart(items, options = {}) {
  const {
    width = 620,
    height = 170,
    padding = { top: 12, right: 10, bottom: 30, left: 44 },
    formatValue = (value) => String(value),
    color = "var(--series-1)",
    colorFor = null,
  } = options;

  const node = svg("svg", { class: "chart", viewBox: `0 0 ${width} ${height}`, role: "img" });
  if (items.length === 0) return node;

  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;
  const maxValue = niceCeil(Math.max(...items.map((item) => item.value), 1));
  const slot = plotW / items.length;
  // Cap the bar and leave the rest of the slot as air; the 2px gap separates neighbours.
  const barW = Math.min(24, Math.max(4, slot - 6));

  const grid = svg("g", { class: "chart__grid" });
  for (const value of ticks(0, maxValue, 3)) {
    const y = padding.top + plotH - (value / maxValue) * plotH;
    grid.append(svg("line", { x1: padding.left, x2: width - padding.right, y1: y, y2: y }));
    node.append(
      svg("text", { class: "chart__tick", x: padding.left - 6, y: y + 3, "text-anchor": "end", text: formatValue(value) }),
    );
  }
  node.prepend(grid);

  for (const [index, item] of items.entries()) {
    const barH = (item.value / maxValue) * plotH;
    const x = padding.left + index * slot + (slot - barW) / 2;
    const y = padding.top + plotH - barH;
    const fill = colorFor ? colorFor(item, index) : color;
    const r = 4;

    const group = svg("g", { class: "chart__mark" });

    if (barH > r) {
      group.append(
        svg("path", {
          d: `M ${x} ${y + barH} V ${y + r} A ${r} ${r} 0 0 1 ${x + r} ${y} H ${x + barW - r} A ${r} ${r} 0 0 1 ${x + barW} ${y + r} V ${y + barH} Z`,
          fill,
        }),
      );
    } else if (item.value > 0) {
      group.append(svg("rect", { x, y: padding.top + plotH - 2, width: barW, height: 2, fill }));
    }

    group.append(
      svg("text", {
        class: "chart__tick",
        x: x + barW / 2,
        y: height - 16,
        "text-anchor": "middle",
        text: item.label,
      }),
    );

    const hit = svg("rect", { class: "chart__hit", x: padding.left + index * slot, y: padding.top, width: slot, height: plotH });
    hit.addEventListener("pointermove", (event) =>
      showTooltip(event, item.label, [
        { label: item.metaLabel ?? "Count", value: formatValue(item.value), color: fill },
        ...(item.meta ? [{ label: item.meta.label, value: item.meta.value }] : []),
      ]),
    );
    hit.addEventListener("pointerleave", hideTooltip);

    group.append(hit);
    node.append(group);
  }

  return node;
}

// ---------- Donut ----------

/** Part-to-whole at a glance. Segments are separated by a 2px surface gap. */
export function donut(segments, options = {}) {
  const { size = 132, thickness = 18, centerLabel = "", centerValue = "" } = options;

  const node = svg("svg", { class: "chart", viewBox: `0 0 ${size} ${size}`, width: size, height: size, role: "img" });
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  const radius = (size - thickness) / 2;
  const cx = size / 2;
  const cy = size / 2;

  if (total <= 0) {
    node.append(svg("circle", { cx, cy, r: radius, fill: "none", stroke: "var(--gridline)", "stroke-width": thickness }));
  } else {
    const circumference = 2 * Math.PI * radius;
    // A 2px gap in the surface colour does the separating, not a stroke.
    const gap = segments.length > 1 ? 2 : 0;
    let offset = 0;

    for (const segment of segments) {
      const length = Math.max(0, (segment.value / total) * circumference - gap);
      const arc = svg("circle", {
        class: "chart__mark",
        cx,
        cy,
        r: radius,
        fill: "none",
        stroke: segment.color,
        "stroke-width": thickness,
        "stroke-dasharray": `${length} ${circumference - length}`,
        "stroke-dashoffset": -offset,
        transform: `rotate(-90 ${cx} ${cy})`,
      });

      arc.addEventListener("pointermove", (event) =>
        showTooltip(event, segment.label, [
          { label: "Count", value: String(segment.value), color: segment.color },
          { label: "Share", value: `${((segment.value / total) * 100).toFixed(1)}%` },
        ]),
      );
      arc.addEventListener("pointerleave", hideTooltip);

      node.append(arc);
      offset += (segment.value / total) * circumference;
    }
  }

  if (centerValue) {
    node.append(
      svg("text", {
        x: cx,
        y: cy + 2,
        "text-anchor": "middle",
        fill: "var(--text-primary)",
        "font-size": 20,
        "font-weight": 600,
        text: centerValue,
      }),
    );
  }
  if (centerLabel) {
    node.append(
      svg("text", {
        x: cx,
        y: cy + 18,
        "text-anchor": "middle",
        fill: "var(--text-muted)",
        "font-size": 10,
        text: centerLabel,
      }),
    );
  }

  return node;
}

// ---------- Heatmap ----------

/** A grid of cells on the single-hue ramp. Magnitude is the only colour job here. */
export function heatmap(cells, options = {}) {
  const {
    columns = 24,
    rows = 7,
    rowLabels = [],
    columnLabels = [],
    cellSize = 15,
    gap = 2,
    formatValue = (value) => String(value),
    tooltipFor = null,
  } = options;

  const labelW = 30;
  const labelH = 14;
  const width = labelW + columns * (cellSize + gap);
  const height = labelH + rows * (cellSize + gap);
  const node = svg("svg", { class: "chart", viewBox: `0 0 ${width} ${height}`, height, role: "img" });

  const max = Math.max(...cells.map((cell) => cell.value), 0);

  for (const [index, label] of rowLabels.entries()) {
    node.append(
      svg("text", {
        class: "chart__tick",
        x: labelW - 6,
        y: labelH + index * (cellSize + gap) + cellSize / 2 + 3,
        "text-anchor": "end",
        text: label,
      }),
    );
  }

  for (const [index, label] of columnLabels.entries()) {
    if (!label) continue;
    node.append(
      svg("text", {
        class: "chart__tick",
        x: labelW + index * (cellSize + gap) + cellSize / 2,
        y: 9,
        "text-anchor": "middle",
        text: label,
      }),
    );
  }

  for (const cell of cells) {
    const x = labelW + cell.column * (cellSize + gap);
    const y = labelH + cell.row * (cellSize + gap);
    const fill = cell.value > 0 ? sequentialColor(max > 0 ? cell.value / max : 0) : "var(--surface-2)";

    const rect = svg("rect", { class: "chart__mark", x, y, width: cellSize, height: cellSize, rx: 3, fill });

    rect.addEventListener("pointermove", (event) =>
      showTooltip(
        event,
        cell.label,
        tooltipFor ? tooltipFor(cell) : [{ label: "Value", value: formatValue(cell.value), color: fill }],
      ),
    );
    rect.addEventListener("pointerleave", hideTooltip);

    node.append(rect);
  }

  return node;
}

/** A scale legend, required whenever colour carries a continuous value. */
export function sequentialLegend(minLabel, maxLabel) {
  return el("div", { class: "legend" }, [
    el("span", { class: "legend__item" }, [
      el("span", { class: "small muted", text: minLabel }),
      ...SEQ.map((step) => el("span", { class: "legend__swatch", style: { background: step, borderRadius: "2px" } })),
      el("span", { class: "small muted", text: maxLabel }),
    ]),
  ]);
}
