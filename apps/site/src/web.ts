// Browser bundle for the site's tools pages (public/tools/*.html), built to public/tools/tools.js
// by build.mjs. Exposes window.SubEthaTools.
import { TRANSPORTS, type RouteMode, type Transport } from "@subetha/sdk/protocol";
import { calculate, PRICES, RELAY_TRANSPORTS, simulate, usd, type CalcInput, type SimInput, type SimSubscription } from "./tools.ts";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const num = (el: HTMLInputElement | null) => (el && el.value.trim() !== "" ? Number(el.value) : 0);
const list = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);
const plural = (unit: string, n: number) => (n === 1 ? unit : unit.endsWith("y") ? `${unit.slice(0, -1)}ies` : `${unit}s`);
const fmtQty = (n: number) => (Number.isInteger(n) ? n.toLocaleString("en-US") : n.toLocaleString("en-US", { maximumFractionDigits: 2 }));

/** Shareable state in the URL hash (#k=v&…). */
function readHash(): URLSearchParams {
  return new URLSearchParams(location.hash.slice(1));
}
function writeHash(p: URLSearchParams) {
  history.replaceState(null, "", `#${p.toString()}`);
}

// ------------------------------------------------------------------ pricing calculator

const PRESETS: Record<string, { label: string; values: Record<string, number | string> }> = {
  doorbell: { label: "Doorbell (2 phones, push)", values: { messages: 300, ws: 2, webpush: 1, apns: 1, retention: 12, devices: 2, endpoints: 2, connections: 1 } },
  alarm: { label: "Alarm with SMS/voice escalation", values: { messages: 200, ws: 1, fcm: 1, sms: 0.2, voice: 0.05, retention: 24, endpoints: 3, devices: 1, connections: 1, title: "Alarm", message: "Motion detected in the garage" } },
  agents: { label: "Agent notifications (MCP + webhook)", values: { messages: 20000, mcp: 1, webhook: 1, retention: 12, endpoints: 1, api: 5000 } },
  email: { label: "Email + Slack digest", values: { messages: 3000, email: 1, slack: 1, retention: 72, endpoints: 2, inmail: 200 } },
  mesh: { label: "Reticulum bridge", values: { messages: 5000, lxmf: 1, ws: 1, retention: 168, endpoints: 5, connections: 1 } },
};

const CALC_FIELDS: [key: string, label: string, hint: string][] = [
  ["messages", "Messages per month", ""],
  ["retention", "Retention (hours)", "topic retention_s; default 12, max 720"],
  ["attachments", "Attachments per month", ""],
  ["attmb", "Average attachment (MB)", ""],
  ["connections", "Always-on live connections", "billed per connection-hour"],
  ["devices", "Enrolled devices", "billed per device-day"],
  ["endpoints", "Verified endpoints", "emails, phones, webhooks, push subscriptions"],
  ["api", "Other API requests per month", "polls, dry runs, downloads"],
  ["inmail", "Inbound emails per month", ""],
  ["insms", "Inbound SMS segments per month", ""],
  ["topups", "Top-ups in the last 12 months (USD)", "sets your price tier"],
];

export function mountPricing(root: HTMLElement) {
  const field = ([k, label, hint]: (typeof CALC_FIELDS)[number]) => `<div><label for="c_${k}">${esc(label)}</label><input id="c_${k}" data-k="${k}" type="number" min="0" step="any">${hint ? `<small class="muted">${esc(hint)}</small>` : ""}</div>`;
  root.innerHTML = `
  <div class="card">
    <h3>Presets</h3>
    <p class="row">${Object.entries(PRESETS).map(([id, p]) => `<button class="secondary" data-preset="${id}">${esc(p.label)}</button>`).join("")}</p>
  </div>
  <div class="grid">
    <div class="card">
      <h3>Usage</h3>
      <div class="formgrid">${CALC_FIELDS.map(field).join("")}</div>
      <label for="c_title">Typical message (sets SMS segments)</label>
      <div class="row"><input id="c_title" data-k="title" placeholder="Title"><input id="c_message" data-k="message" placeholder="Message"></div>
    </div>
    <div class="card">
      <h3>Deliveries per message</h3>
      <p class="muted">Average deliveries of each message by transport. Use fractions for escalations that usually don't fire: <code>0.1</code> SMS means one message in ten escalates to SMS. BLE, audio, QR, and LAN are free and not listed.</p>
      <div class="formgrid">${RELAY_TRANSPORTS.map((t) => `<div><label for="c_${t}">${esc(t)}</label><input id="c_${t}" data-k="${t}" type="number" min="0" step="any"></div>`).join("")}</div>
    </div>
  </div>
  <div class="card" aria-live="polite">
    <h3>Monthly estimate</h3>
    <div id="c_out"></div>
  </div>`;
  const inputs = [...root.querySelectorAll<HTMLInputElement>("[data-k]")];
  const byKey = (k: string) => root.querySelector<HTMLInputElement>(`[data-k="${k}"]`);

  const load = (values: Record<string, number | string>) => {
    for (const el of inputs) el.value = values[el.dataset.k!] !== undefined ? String(values[el.dataset.k!]) : "";
    render();
  };

  const render = () => {
    const deliveries: Partial<Record<Transport, number>> = {};
    for (const t of RELAY_TRANSPORTS) deliveries[t] = num(byKey(t));
    const input: CalcInput = {
      topupsUsd: num(byKey("topups")),
      messagesPerMonth: num(byKey("messages")),
      retentionS: byKey("retention")!.value.trim() === "" ? undefined : num(byKey("retention")) * 3600,
      sample: { title: byKey("title")!.value || undefined, message: byKey("message")!.value },
      deliveries,
      attachmentsPerMonth: num(byKey("attachments")),
      attachmentAvgMb: num(byKey("attmb")),
      connections: num(byKey("connections")),
      devices: num(byKey("devices")),
      endpoints: num(byKey("endpoints")),
      apiRequestsPerMonth: num(byKey("api")),
      inboundEmailsPerMonth: num(byKey("inmail")),
      inboundSmsSegmentsPerMonth: num(byKey("insms")),
    };
    const r = calculate(input);
    const p = new URLSearchParams();
    for (const el of inputs) if (el.value.trim() !== "") p.set(el.dataset.k!, el.value);
    writeHash(p);
    root.querySelector("#c_out")!.innerHTML = r.lines.length
      ? `<div class="scroll"><table><thead><tr><th>Item</th><th class="num">Quantity</th><th class="num">Cost</th></tr></thead><tbody>
        ${r.lines.map((l) => `<tr><td>${esc(l.label)} <span class="muted">${esc(l.sku)}</span></td><td class="num">${fmtQty(l.quantity)} ${esc(plural(l.unit, l.quantity))}</td><td class="num">${usd(l.micros)}</td></tr>`).join("")}
        </tbody><tfoot><tr><th>Total per month</th><th></th><th class="num">${usd(r.totalMicros)}</th></tr></tfoot></table></div>
        <p>Per message: <b>${usd(r.perMessageMicros)}</b> · price tier: <b>${esc(r.tier)}</b>${r.smsSegments > 1 ? ` · the typical message is <b>${r.smsSegments}</b> SMS segments` : ""}</p>
        <p>Top up <b>$${r.topupUsd.toFixed(2)}</b> to cover a month (includes a $${r.topupFeeUsd.toFixed(2)} top-up fee for card processing).${r.topupOverMax ? ` That's more than the largest single top-up: split it, or turn on auto-recharge.` : ""}</p>
        <p class="muted">Prices come from the same generated table the relay charges from. Retention, attachments, and rent are rounded up per message or per day the way the relay rounds them. Voice is reserved at the call time limit and settled to the real call length.</p>`
      : `<p class="muted">Enter some usage, or pick a preset.</p>`;
  };

  root.addEventListener("input", render);
  root.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((b) => (b.onclick = () => load(PRESETS[b.dataset.preset!]!.values)));
  const h = readHash();
  if ([...h.keys()].length) load(Object.fromEntries(h));
  else load(PRESETS.doorbell!.values);
}

// ------------------------------------------------------------------ route simulator

const MODES: RouteMode[] = ["any", "fast", "all", "cheap"];
const SIM_DEFAULT: { subs: SimSubscription[]; policy: string } = {
  subs: [
    { transport: "webpush", after_s: 0 },
    { transport: "sms", after_s: 60, min_priority: 4 },
    { transport: "voice", after_s: 180, min_priority: 5 },
  ],
  policy: '{\n  "retention_s": 43200,\n  "deny_transports": [],\n  "min_priority": { "sms": 4 }\n}',
};

export function mountSimulator(root: HTMLElement, opts: { consoleUrl?: string } = {}) {
  const transportOptions = (sel: string) => TRANSPORTS.map((t) => `<option${t === sel ? " selected" : ""}>${t}</option>`).join("");
  root.innerHTML = `
  <div class="grid">
    <div class="card">
      <h3>Message</h3>
      <div class="row"><div><label for="s_title">Title</label><input id="s_title" value="Front door"></div><div><label for="s_tags">Tags</label><input id="s_tags" placeholder="door,warning"></div></div>
      <label for="s_msg">Message</label><input id="s_msg" value="Opened">
      <label class="check"><input id="s_image" type="checkbox"> With a picture (SMS goes as one MMS to US numbers)</label>
      <div class="row">
        <div><label for="s_prio">Priority</label><select id="s_prio">${[1, 2, 3, 4, 5].map((p) => `<option${p === 5 ? " selected" : ""}>${p}</option>`).join("")}</select></div>
        <div><label for="s_mode">Route mode</label><select id="s_mode">${MODES.map((m) => `<option>${m}</option>`).join("")}</select></div>
        <div><label for="s_max">Max cost (USD)</label><input id="s_max" type="number" min="0" step="any" placeholder="none"></div>
      </div>
      <div class="row">
        <div><label for="s_allow">X-Allow</label><input id="s_allow" placeholder="all"></div>
        <div><label for="s_deny">X-Deny</label><input id="s_deny" placeholder="none"></div>
        <div><label for="s_tok">Token transports</label><input id="s_tok" placeholder="all"></div>
      </div>
      <div class="row">
        <div><label for="s_tier">Price tier</label><select id="s_tier">${PRICES.tiers.map((t) => `<option>${t.id}</option>`).join("")}</select></div>
        <div><label for="s_time">Time (UTC, for quiet hours)</label><input id="s_time" type="time" value="12:00"></div>
      </div>
    </div>
    <div class="card">
      <h3>Topic</h3>
      <label for="s_live">Live connections (WebSocket / SSE)</label><input id="s_live" type="number" min="0" value="1">
      <label>Subscriptions (escalation chain)</label>
      <table><thead><tr><th>Transport</th><th>After (s)</th><th>Min priority</th><th></th></tr></thead><tbody id="s_subs"></tbody></table>
      <p><button class="secondary" id="s_add">Add subscription</button></p>
      <label for="s_policy">Topic policy (JSON)</label><textarea id="s_policy" rows="7"></textarea>
      <small id="s_policyErr" class="bad"></small>
    </div>
  </div>
  <div class="card" aria-live="polite"><h3>Route plan</h3><div id="s_out"></div></div>`;
  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  let subs: SimSubscription[] = structuredClone(SIM_DEFAULT.subs);
  $<HTMLTextAreaElement>("s_policy").value = SIM_DEFAULT.policy;

  const drawSubs = () => {
    $("s_subs").innerHTML = subs.map((s, i) => `<tr data-i="${i}"><td><select data-f="transport">${transportOptions(s.transport)}</select></td><td><input data-f="after_s" type="number" min="0" value="${s.after_s ?? 0}"></td><td><input data-f="min_priority" type="number" min="1" max="5" value="${s.min_priority ?? ""}"></td><td><button class="secondary" data-del="${i}" aria-label="Remove">✕</button></td></tr>`).join("") || `<tr><td colspan="4" class="muted">No queued subscriptions.</td></tr>`;
  };

  const render = () => {
    let policy = {};
    try {
      policy = JSON.parse($<HTMLTextAreaElement>("s_policy").value || "{}");
      $("s_policyErr").textContent = "";
    } catch (e) {
      $("s_policyErr").textContent = `Invalid JSON: ${(e as Error).message}`;
    }
    const [hh, mm] = ($<HTMLInputElement>("s_time").value || "12:00").split(":").map(Number);
    const now = new Date();
    now.setUTCHours(hh ?? 12, mm ?? 0, 0, 0);
    const maxRaw = $<HTMLInputElement>("s_max").value.trim();
    const input: SimInput = {
      tier: $<HTMLSelectElement>("s_tier").value,
      mode: $<HTMLSelectElement>("s_mode").value as RouteMode,
      priority: Number($<HTMLSelectElement>("s_prio").value),
      title: $<HTMLInputElement>("s_title").value || undefined,
      message: $<HTMLInputElement>("s_msg").value,
      tags: list($<HTMLInputElement>("s_tags").value),
      image: $<HTMLInputElement>("s_image").checked,
      live: num($<HTMLInputElement>("s_live")),
      subscriptions: subs,
      policy,
      allow: list($<HTMLInputElement>("s_allow").value) as Transport[],
      deny: list($<HTMLInputElement>("s_deny").value) as Transport[],
      tokenTransports: list($<HTMLInputElement>("s_tok").value) as Transport[],
      maxCostUsd: maxRaw === "" ? undefined : Number(maxRaw),
      nowMs: now.getTime(),
    };
    const r = simulate(input);
    const steps = r.steps.length
      ? `<div class="scroll"><table><thead><tr><th>When</th><th>Transport</th><th>Subscriber</th><th class="num">Cost</th></tr></thead><tbody>${r.steps.map((s) => `<tr><td>${s.after_s ? `after ${s.after_s}s if unacked` : "immediately"}</td><td>${esc(s.transport === "sms" && s.sku === "deliver_mms_us" ? "sms (MMS)" : s.transport)}</td><td class="muted">${esc(s.subscriber)}</td><td class="num">${usd(s.cost_micros)}</td></tr>`).join("")}</tbody></table></div>`
      : `<p class="muted">Nothing would be delivered now: the message is stored until it expires, for subscribers who connect or poll later.</p>`;
    const dropped = r.plan.dropped.length
      ? `<h4>Not used</h4><div class="scroll"><table><thead><tr><th>Transport</th><th>Subscriber</th><th>Why</th></tr></thead><tbody>${r.plan.dropped.map((d) => `<tr><td>${esc(d.transport)}</td><td class="muted">${esc(d.subscriber)}</td><td>${esc(d.reason)}</td></tr>`).join("")}</tbody></table></div>`
      : "";
    const mode = input.mode;
    $("s_out").innerHTML = `${steps}${dropped}
      <table class="summary">
        <tr><td>Publish</td><td class="num">${usd(r.publishMicros)}</td></tr>
        <tr><td>Retention</td><td class="num">${usd(r.retentionMicros)}</td></tr>
        <tr><th>Reserved (worst case, what a dry run reports)</th><th class="num">${usd(r.worstCaseMicros)}</th></tr>
        ${mode === "all" ? "" : `<tr><td>If acked before the first escalation</td><td class="num">${usd(r.ackedMicros)}</td></tr>`}
      </table>
      ${r.smsSegments > 1 && !input.image ? `<p class="muted">This message is ${r.smsSegments} SMS segments.</p>` : ""}
      <p class="muted">Unused reservations are released when the message is acked. ${opts.consoleUrl ? `To run this against a real topic, use <a href="${esc(opts.consoleUrl)}">Simulate route &amp; cost</a> in the console (a dry run, charged as one API request).` : ""}</p>`;
  };

  root.addEventListener("input", (e) => {
    const t = e.target as HTMLElement;
    const row = t.closest<HTMLElement>("tr[data-i]");
    if (row && t.dataset.f) {
      const s = subs[Number(row.dataset.i)]!;
      const v = (t as HTMLInputElement).value;
      if (t.dataset.f === "transport") s.transport = v as Transport;
      else if (t.dataset.f === "after_s") s.after_s = Number(v) || 0;
      else s.min_priority = v === "" ? undefined : Number(v);
    }
    render();
  });
  root.addEventListener("click", (e) => {
    const del = (e.target as HTMLElement).closest<HTMLElement>("[data-del]");
    if (del) {
      subs.splice(Number(del.dataset.del), 1);
      drawSubs();
      render();
    }
  });
  $<HTMLButtonElement>("s_add").onclick = () => {
    subs.push({ transport: "email", after_s: 30 });
    drawSubs();
    render();
  };
  drawSubs();
  render();
}

export { calculate, simulate, usd, PRICES };
