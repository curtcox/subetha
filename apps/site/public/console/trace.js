// Structured message trace renderer (PLAN §3, §10, §11). Pure: takes a GET /v1/traces/:id JSON
// payload and returns HTML showing the summary, cost breakdown, delivery plan, dropped steps,
// delivery events timeline, and collapsible raw JSON.

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const usd = (micros) => `$${(Number(micros || 0) / 1e6).toFixed(6)}`;
const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString() : "—");

/** @param {Record<string, any>} t */
export function renderTrace(t) {
  const cost = t.cost_micros ?? {};
  const publish = Number(cost.publish ?? 0);
  const live = Number(cost.live ?? 0);
  const queued = Number(cost.queued ?? 0);
  const retMicros = Math.ceil(Number(cost.retention_nanos ?? 0) / 1000);
  const total = publish + live + queued + retMicros;

  const ackHtml = t.ack
    ? `<span class="ok">acked</span> via <code>${esc(t.ack.via ?? "unknown")}</code> at ${esc(fmtTime(t.ack.time))}`
    : `<span class="muted">not acked</span>`;

  const plan = Array.isArray(t.plan) ? t.plan : [];
  const dropped = Array.isArray(t.dropped) ? t.dropped : [];
  const events = Array.isArray(t.events) ? t.events : [];

  const summary = `
    <p><b>Message</b> <code>${esc(t.id)}</code> · <b>Published</b> ${esc(fmtTime(t.published))} · <b>Publisher</b> <code>${esc(t.publisher ?? "—")}</code> · <b>Ack</b> ${ackHtml}</p>
    <div class="scroll"><table>
      <thead><tr><th>Publish</th><th>Live</th><th>Queued (reserved)</th><th>Retention</th><th>Total</th></tr></thead>
      <tbody><tr>
        <td>${esc(usd(publish))}</td>
        <td>${esc(usd(live))}</td>
        <td>${esc(usd(queued))}</td>
        <td>${esc(usd(retMicros))}</td>
        <td><b>${esc(usd(total))}</b></td>
      </tr></tbody>
    </table></div>`;

  const planHtml = plan.length
    ? `<h4>Delivery plan</h4><div class="scroll"><table>
        <thead><tr><th>Transport</th><th>Subscriber</th><th>When</th><th>SKU</th><th>Cost</th></tr></thead>
        <tbody>${plan.map((d) => `<tr>
          <td><code>${esc(d.transport)}</code></td>
          <td class="muted"><code>${esc(d.subscriber)}</code></td>
          <td>${d.after_s ? `after ${esc(d.after_s)}s if unacked` : "immediately"}</td>
          <td><code>${esc(d.sku ?? "—")}</code></td>
          <td>${esc(usd(d.cost_micros))}</td>
        </tr>`).join("")}</tbody>
      </table></div>`
    : `<p class="muted">No subscribers matched at publish time (stored for later).</p>`;

  const droppedHtml = dropped.length
    ? `<h4>Dropped steps</h4><div class="scroll"><table>
        <thead><tr><th>Transport</th><th>Subscriber</th><th>Reason</th></tr></thead>
        <tbody>${dropped.map((d) => `<tr>
          <td><code>${esc(d.transport)}</code></td>
          <td class="muted"><code>${esc(d.subscriber)}</code></td>
          <td>${esc(d.reason)}</td>
        </tr>`).join("")}</tbody>
      </table></div>`
    : "";

  const eventsHtml = events.length
    ? `<h4>Delivery events</h4><div class="scroll"><table>
        <thead><tr><th>Time</th><th>Transport</th><th>Subscriber</th><th>Result</th><th>Detail</th></tr></thead>
        <tbody>${events.map((e) => {
          const ok = e.result === "delivered" || e.result === "sent" || e.result === "skipped_acked";
          const detail = [
            e.charged_micros !== undefined ? `charged ${usd(e.charged_micros)}` : "",
            e.cost_micros !== undefined ? `cost ${usd(e.cost_micros)}` : "",
            e.error ? String(e.error) : "",
          ].filter(Boolean).join(" · ");
          return `<tr>
            <td>${esc(fmtTime(e.at))}</td>
            <td><code>${esc(e.transport ?? "—")}</code></td>
            <td class="muted"><code>${esc(e.sub ?? e.subscriber ?? "—")}</code></td>
            <td class="${ok ? "ok" : "bad"}">${esc(e.result ?? "—")}</td>
            <td>${esc(detail)}</td>
          </tr>`;
        }).join("")}</tbody>
      </table></div>`
    : "";

  const rawHtml = `<details><summary>Raw JSON</summary><pre>${esc(JSON.stringify(t, null, 2))}</pre></details>`;
  return `${summary}${planHtml}${droppedHtml}${eventsHtml}${rawHtml}`;
}
