// Spend-by-category chart for the console's Billing tab (PLAN §11), from GET /v1/usage.
// Stacked columns per UTC day in a fixed category order (colors --series-1…5 in style.css,
// validated for both themes), a legend, a hover tooltip per day, and a table view.

const ORDER = ["publish", "deliveries", "live", "rent", "other"];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function money(micros) {
  if (!micros) return "$0";
  const d = micros / 1e6;
  if (d >= 1) return `$${d.toFixed(2)}`;
  if (d >= 0.01) return `$${d.toFixed(4).replace(/0+$/, "")}`;
  return `$${d.toFixed(6).replace(/0+$/, "")}`;
}

/** A "nice" axis maximum and step (1, 2, 2.5, 5 × 10^n) for a data maximum. */
export function niceScale(max, ticks = 3) {
  if (!(max > 0)) return { max: 1, step: 1 };
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  return { max: step * Math.ceil(max / step), step };
}

/** Column path with a 4px rounded top and a square bottom. */
function column(x, y, w, h, r) {
  if (h <= 0) return "";
  r = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

export function renderUsageChart(root, usage) {
  const labels = usage.categories ?? {};
  const days = usage.days ?? [];
  const W = 720, H = 220, padL = 52, padR = 8, padT = 10, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const { max, step } = niceScale(Math.max(0, ...days.map((d) => d.total)));
  const slot = plotW / Math.max(1, days.length);
  const bw = Math.max(2, Math.min(24, slot * 0.62));
  const y = (v) => padT + plotH - (v / max) * plotH;
  const GAP = 2;

  let grid = "";
  for (let v = 0; v <= max + 1e-9; v += step) {
    grid += `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${padL - 6}" y="${y(v) + 4}" text-anchor="end" class="tick">${money(Math.round(v))}</text>`;
  }
  let bars = "", hits = "";
  days.forEach((d, i) => {
    const x = padL + i * slot + (slot - bw) / 2;
    let base = 0;
    const present = ORDER.filter((c) => d.micros[c] > 0);
    present.forEach((c, j) => {
      const v = d.micros[c];
      const top = y(base + v), bottom = y(base);
      // 2px surface gap between stacked segments; the topmost segment gets the rounded end.
      const h = Math.max(1, bottom - top - (j > 0 ? GAP : 0));
      const isTop = j === present.length - 1;
      bars += isTop
        ? `<path d="${column(x, top, bw, h, 4)}" fill="var(--series-${ORDER.indexOf(c) + 1})"/>`
        : `<rect x="${x}" y="${top}" width="${bw}" height="${h}" fill="var(--series-${ORDER.indexOf(c) + 1})"/>`;
      base += v;
    });
    hits += `<rect class="hit" data-i="${i}" x="${padL + i * slot}" y="${padT}" width="${slot}" height="${plotH}" fill="transparent"/>`;
  });
  const xl = (i) => `<text x="${padL + i * slot + slot / 2}" y="${H - 8}" text-anchor="middle" class="tick">${esc(days[i].day.slice(5))}</text>`;
  const xLabels = days.length ? [0, Math.floor((days.length - 1) / 2), days.length - 1].filter((v, i, a) => a.indexOf(v) === i).map(xl).join("") : "";

  const legend = ORDER.map((c, i) => `<span class="key"><i style="background:var(--series-${i + 1})"></i>${esc(labels[c] ?? c)}</span>`).join("");
  const rows = ORDER.map((c, i) => `<tr><td><i class="swatch" style="background:var(--series-${i + 1})"></i>${esc(labels[c] ?? c)}</td><td class="num">${money(usage.totals?.[c] ?? 0)}</td></tr>`).join("");
  const topics = (usage.live_by_topic ?? []).map((t) => `<tr><td><code>${esc(t.topic)}</code></td><td class="num">${money(t.micros)}</td></tr>`).join("");

  root.innerHTML = `
    <div class="usage-head"><span class="usage-total">${money(usage.total_micros)}</span><span class="muted"> in the last ${days.length} days${usage.pending_micros ? ` · ${money(usage.pending_micros)} pending` : ""}</span></div>
    <div class="legend">${legend}</div>
    <div class="usage-plot">
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily spend by category">${grid}<line x1="${padL}" x2="${W - padR}" y1="${y(0)}" y2="${y(0)}" class="axis"/>${bars}${xLabels}${hits}</svg>
      <div class="tip" hidden></div>
    </div>
    <details><summary>Table</summary>
      <table><thead><tr><th>Category</th><th class="num">Spend</th></tr></thead><tbody>${rows}</tbody><tfoot><tr><th>Total</th><th class="num">${money(usage.total_micros)}</th></tr></tfoot></table>
      ${topics ? `<table><thead><tr><th>Live delivery & storage by topic</th><th class="num">Spend</th></tr></thead><tbody>${topics}</tbody></table>` : ""}
      <table><thead><tr><th>Day</th>${ORDER.map((c) => `<th class="num">${esc(labels[c] ?? c)}</th>`).join("")}<th class="num">Total</th></tr></thead><tbody>${days.filter((d) => d.total).map((d) => `<tr><td>${esc(d.day)}</td>${ORDER.map((c) => `<td class="num">${money(d.micros[c])}</td>`).join("")}<td class="num">${money(d.total)}</td></tr>`).join("") || `<tr><td colspan="${ORDER.length + 2}" class="muted">No spend in this period.</td></tr>`}</tbody></table>
    </details>`;

  const plot = root.querySelector(".usage-plot");
  const tip = root.querySelector(".tip");
  const svg = root.querySelector("svg");
  const show = (i, clientX) => {
    const d = days[i];
    tip.innerHTML = `<b>${esc(d.day)}</b>${ORDER.filter((c) => d.micros[c]).reverse().map((c) => `<div><i class="swatch" style="background:var(--series-${ORDER.indexOf(c) + 1})"></i>${esc(labels[c] ?? c)} <span class="num">${money(d.micros[c])}</span></div>`).join("")}<div class="tip-total">Total <span class="num">${money(d.total)}</span></div>`;
    tip.hidden = false;
    const box = plot.getBoundingClientRect();
    const left = Math.min(Math.max(0, clientX - box.left + 12), box.width - tip.offsetWidth);
    tip.style.left = `${left}px`;
  };
  svg.querySelectorAll(".hit").forEach((r) => {
    r.addEventListener("pointermove", (e) => show(Number(r.dataset.i), e.clientX));
    r.addEventListener("pointerleave", () => { tip.hidden = true; });
  });
}
