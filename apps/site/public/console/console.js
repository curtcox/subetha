// The console is an ordinary SDK client (PLAN §11).
import { LANGUAGES, LANGUAGE_NAMES, snippet } from "./snippets.js";
import { buildRequest, operations, toCurl } from "./explorer.js";
import { renderUsageChart } from "./usage-chart.js";

const $ = (id) => document.getElementById(id);
const usd = (micros) => `$${(micros / 1e6).toFixed(micros < 10000 ? 6 : 2)}`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
let client = null;
let me = null;
let sub = null;
let clerk = null;

function store(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} }
function load(k) { try { return localStorage.getItem(k); } catch { return null; } }

async function getToken() {
  if (clerk?.session) return clerk.session.getToken();
  return load("subetha.token");
}

async function makeClient() {
  const token = await getToken();
  return token ? new SubEtha({ baseUrl: location.origin, token }) : null;
}

async function init() {
  const cfg = await fetch("/v1/config").then((r) => r.json()).catch(() => ({}));
  if (cfg.clerk_publishable_key) {
    await new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/@clerk/clerk-js@5.99.0/dist/clerk.browser.js";
      s.setAttribute("data-clerk-publishable-key", cfg.clerk_publishable_key);
      s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    }).catch(() => {});
    if (window.Clerk) {
      clerk = window.Clerk;
      await clerk.load();
    }
  }
  await refresh();
}

async function refresh() {
  client = await makeClient();
  $("signin").hidden = !!client;
  $("signout").hidden = !client;
  if (!client) {
    if (clerk) clerk.mountSignIn($("clerk-signin"));
    return;
  }
  try {
    me = await client.account();
  } catch (e) {
    if (e.code === "not_found") { $("create").hidden = false; return; }
    if (e.code === "unauthorized") { store("subetha.token", null); return refresh(); }
    throw e;
  }
  $("create").hidden = true;
  $("app").hidden = false;
  $("who").textContent = me.handle ? `@${me.handle}` : me.id;
  showBalance(me);
  const h = me.handle ? `@${me.handle}/` : "";
  $("pubTopic").value ||= `${h}test`;
  $("subTopic").value ||= `${h}test`;
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get("topic")) { $("subTopic").value = hash.get("topic"); subscribe(); }
  routeHash(hash);
}

// Available balance, plus what's held: open reservations and the credit leases topics draw on (PLAN §7).
function showBalance(a) {
  $("bal").textContent = usd(a.balance_usd_micros);
  const held = a.reserved_usd_micros ?? 0;
  $("held").hidden = !held;
  $("held").textContent = held ? ` + ${usd(held)} held` : "";
}

$("tokenBtn").onclick = () => { store("subetha.token", $("tokenInput").value.trim()); refresh(); };
$("signout").onclick = async () => { store("subetha.token", null); if (clerk) await clerk.signOut(); location.reload(); };
$("createBtn").onclick = async () => {
  await client.request("POST", "/v1/account", { handle: $("handleInput").value.trim() || undefined }).catch((e) => alert(e.message));
  refresh();
};

/** Deep links: #tab=…, #topic=…, #device[=CODE] (device flow), #slack=installed (Slack OAuth), #topup=ok (Stripe). */
function routeHash(hash) {
  if (hash.has("device")) {
    showTab("devices");
    if (hash.get("device")) $("devCode").value = hash.get("device");
    $("devCode").focus();
    return;
  }
  if (hash.get("slack") === "installed") {
    $("epNotice").hidden = false;
    $("epNotice").textContent = `Slack is installed in ${hash.get("team") || "your workspace"}. Bind a channel below.`;
    slackTeamHint = hash.get("team_id");
  }
  if (hash.get("topup") === "ok") {
    $("billNotice").hidden = false;
    $("billNotice").textContent = "Payment received. Your balance updates as soon as Stripe confirms it.";
  }
  if (hash.get("tab")) showTab(hash.get("tab"));
}
let slackTeamHint = null;

function showTab(name) {
  const b = document.querySelector(`#tabs button[data-tab="${name}"]`);
  if (!b) return;
  document.querySelectorAll("#tabs button").forEach((x) => x.classList.toggle("active", x === b));
  document.querySelectorAll("[data-panel]").forEach((p) => p.hidden = p.dataset.panel !== name);
  ({ topics: loadTopics, endpoints: loadEndpoints, devices: loadDevices, tokens: loadTokens, billing: loadBilling, audit: () => loadAudit(true), explorer: loadExplorer })[name]?.();
}
document.querySelectorAll("#tabs button").forEach((b) => b.onclick = () => {
  showTab(b.dataset.tab);
  const hash = new URLSearchParams(location.hash.slice(1));
  hash.set("tab", b.dataset.tab);
  history.replaceState(null, "", `#${hash}`);
});

function pubOpts() {
  const tags = $("pubTags").value.split(",").map((s) => s.trim()).filter(Boolean);
  return { title: $("pubTitle").value || undefined, priority: Number($("pubPrio").value), tags, route: { mode: $("pubMode").value } };
}

$("pubBtn").onclick = async () => {
  const out = $("pubOut"); out.hidden = false;
  try {
    const m = await client.publish($("pubTopic").value.trim(), $("pubMsg").value || "triggered", pubOpts());
    out.textContent = JSON.stringify(m, null, 2);
    $("traceTopic").value = m.topic; $("traceId").value = m.id;
    me = await client.account(); showBalance(me);
  } catch (e) { out.textContent = `${e.code}: ${e.message}`; }
};

$("dryBtn").onclick = async () => {
  const out = $("pubOut"); out.hidden = false;
  try {
    const e = await client.estimate($("pubTopic").value.trim(), $("pubMsg").value || "test", pubOpts());
    out.textContent = `Estimated cost: ${usd(e.estimate_usd_micros)}\n\n` + (e.plan.length ? e.plan.map((d) => `${d.transport.padEnd(8)} ${usd(d.cost_micros)}${d.after_s ? `  (after ${d.after_s}s if unacked)` : ""}`).join("\n") : "No subscribers right now: the message would be stored for later.");
  } catch (e) { out.textContent = `${e.code}: ${e.message}`; }
};

$("copyLang").innerHTML = LANGUAGES.map((l) => `<option value="${l}">${LANGUAGE_NAMES[l]}</option>`).join("");
$("copyLang").value = load("subetha.copyLang") || "curl";
$("copyLang").onchange = () => store("subetha.copyLang", $("copyLang").value);
$("curlBtn").onclick = async () => {
  const o = pubOpts();
  const text = snippet($("copyLang").value, { baseUrl: location.origin, topic: $("pubTopic").value.trim(), message: $("pubMsg").value || "triggered", title: o.title, priority: o.priority, tags: o.tags, mode: o.route.mode });
  $("pubOut").hidden = false; $("pubOut").textContent = text;
  await navigator.clipboard?.writeText(text).catch(() => {});
};

function subscribe() {
  sub?.close();
  $("inbox").replaceChildren();
  const topics = $("subTopic").value.split(",").map((s) => s.trim()).filter(Boolean);
  sub = client.subscribe(topics, (m) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="muted">${new Date(m.time * 1000).toLocaleTimeString()} ${esc(m.topic)} p${m.priority ?? 3}</span><br>${m.title ? `<b>${esc(m.title)}</b> ` : ""}${esc(m.message)}`;
    $("inbox").prepend(li);
  }, { since: "1h", onError: (e) => console.warn(e) });
}
$("subBtn").onclick = subscribe;

$("pushBtn").onclick = async () => {
  const say = (t) => { $("pushMsg").textContent = t; };
  try {
    const cfg = await fetch("/v1/config").then((r) => r.json());
    if (!cfg.vapid_public_key) return say("Web Push isn't configured on this server.");
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return say("This browser doesn't support Web Push.");
    if ((await Notification.requestPermission()) !== "granted") return say("Notification permission was not granted.");
    const reg = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    const address = await SubEtha.subscribeWebPush(reg, cfg.vapid_public_key);
    const ep = await client.request("POST", "/v1/endpoints", { kind: "webpush", address, name: navigator.userAgent.slice(0, 60) });
    const topics = $("subTopic").value.split(",").map((s) => s.trim()).filter(Boolean);
    for (const topic of topics) await client.request("POST", "/v1/subscriptions", { topic, endpoint_id: ep.id });
    say(`This browser will get push notifications for ${topics.join(", ")}.`);
  } catch (e) { say(`${e.code ?? "error"}: ${e.message}`); }
};

async function loadTopics() {
  const { topics } = await client.topics();
  $("topicRows").innerHTML = topics.map((t) => `<tr><td><code>${esc(t.name)}</code></td><td><code>${esc(JSON.stringify(t.policy))}</code></td><td><button class="secondary" data-edit="${esc(t.name)}">Edit</button></td></tr>`).join("") || `<tr><td colspan=3 class="muted">No topics yet. Publishing to @${esc(me.handle)}/anything creates one.</td></tr>`;
  document.querySelectorAll("[data-edit]").forEach((b) => b.onclick = () => {
    const t = topics.find((x) => x.name === b.dataset.edit);
    $("topicName").value = t.name; $("topicPolicy").value = JSON.stringify(t.policy, null, 2);
  });
}
$("genSecret").onclick = () => { $("topicName").value = SubEtha.protocol.secretTopic(); };
$("topicSave").onclick = async () => {
  try {
    await client.configureTopic($("topicName").value.trim(), JSON.parse($("topicPolicy").value || "{}"));
    $("topicMsg").textContent = "Saved."; loadTopics();
  } catch (e) { $("topicMsg").textContent = `${e.code ?? "error"}: ${e.message}`; }
};

async function loadTokens() {
  const { tokens } = await client.listTokens();
  $("tokenRows").innerHTML = tokens.map((t) => `<tr><td>${esc(t.name || t.id)}</td><td><code>${esc(t.scopes.join(" "))}</code></td><td>${t.daily_cap_micros != null ? usd(t.daily_cap_micros) + "/day" : ""}</td><td>${t.revoked_at ? '<span class="bad">revoked</span>' : '<span class="ok">active</span>'}</td><td>${t.revoked_at ? "" : `<button class="secondary" data-revoke="${esc(t.id)}">Revoke</button>`}</td></tr>`).join("");
  document.querySelectorAll("[data-revoke]").forEach((b) => b.onclick = async () => { await client.revokeToken(b.dataset.revoke); loadTokens(); });
}
$("tokCreate").onclick = async () => {
  const list = (v) => v.split(",").map((s) => s.trim()).filter(Boolean);
  const out = $("tokOut"); out.hidden = false;
  try {
    const t = await client.createToken({
      name: $("tokName").value || undefined,
      scopes: list($("tokScopes").value),
      daily_cap_usd: $("tokDaily").value ? Number($("tokDaily").value) : undefined,
      transports: $("tokTransports").value ? list($("tokTransports").value) : undefined,
      origins: $("tokOrigins").value ? list($("tokOrigins").value) : undefined,
    });
    out.textContent = `${t.token}\n\nShown once. Example:\ncurl -H "Authorization: Bearer ${t.token}" -d hi ${location.origin}/<topic>`;
    loadTokens();
  } catch (e) { out.textContent = `${e.code}: ${e.message}`; }
};

const toUsdInput = (micros) => (micros == null ? "" : String(micros / 1e6));
const fromUsdInput = (v) => (v.trim() === "" ? null : Math.round(Number(v) * 1e6));
$("capSave").onclick = async () => {
  try {
    await client.request("PATCH", "/v1/account", { daily_cap_micros: fromUsdInput($("capDaily").value), oauth_daily_cap_micros: fromUsdInput($("capOauth").value), paused: $("capPaused").checked });
    me = await client.account();
    $("capMsg").textContent = "Saved.";
  } catch (e) { $("capMsg").textContent = `${e.code}: ${e.message}`; }
};

async function loadBilling() {
  client.request("GET", "/v1/usage?days=30").then((u) => renderUsageChart($("usageChart"), u)).catch((e) => { $("usageChart").textContent = `${e.code ?? "error"}: ${e.message}`; });
  $("capDaily").value = toUsdInput(me.daily_cap_micros);
  $("capOauth").value = toUsdInput(me.oauth_daily_cap_micros);
  $("capPaused").checked = !!me.paused;
  const [{ entries }, prices] = await Promise.all([client.ledger(), client.prices()]);
  $("ledgerRows").innerHTML = entries.slice().reverse().map((e) => `<tr><td>${e.seq}</td><td>${e.kind}</td><td>${usd(e.amount)}</td><td>${usd(e.available_after)}</td><td><code>${esc(e.ref)}</code></td><td>${new Date(e.time).toLocaleString()}</td></tr>`).join("");
  $("priceTable").innerHTML = `<table>${Object.entries(prices.skus).map(([id, s]) => `<tr><td>${esc(s.description)}</td><td>$${(s.price_nanos.standard / 1e9).toPrecision(3)} / ${esc(s.unit)}</td></tr>`).join("")}</table>`;
}
$("topupBtn").onclick = async () => {
  try { location.href = (await client.checkout(Number($("topupAmt").value))).url; } catch (e) { alert(`${e.code}: ${e.message}`); }
};

$("traceBtn").onclick = async () => {
  const out = $("traceOut"); out.hidden = false;
  try { out.textContent = JSON.stringify(await client.trace($("traceTopic").value.trim(), $("traceId").value.trim()), null, 2); }
  catch (e) { out.textContent = `${e.code}: ${e.message}`; }
};

// ---------- endpoints, subscriptions, Slack ----------
const when = (ms) => (ms ? new Date(ms).toLocaleString() : "");
const PLACEHOLDER = { email: "you@example.com", sms: "+15551234567", voice: "+15551234567", webhook: "https://example.com/hook", lxmf: "32 hex characters", fcm: "FCM registration token", apns: "APNs device token (hex)" };
$("epKind").onchange = () => { $("epAddr").placeholder = PLACEHOLDER[$("epKind").value] ?? ""; };
let endpoints = [];
async function loadEndpoints() {
  const [eps, subs, teams] = await Promise.all([
    client.request("GET", "/v1/endpoints"),
    client.request("GET", "/v1/subscriptions"),
    client.request("GET", "/v1/slack/teams").catch(() => ({ teams: [] })),
  ]);
  endpoints = eps.endpoints;
  $("epRows").innerHTML = endpoints.map((e) => `<tr><td>${esc(e.kind)}</td><td><code>${esc(e.address)}</code>${e.name ? ` <span class="muted">${esc(e.name)}</span>` : ""}</td><td>${e.verified ? '<span class="ok">verified</span>' : `<span class="row"><input data-code="${esc(e.id)}" placeholder="6-digit code" inputmode="numeric" maxlength="6" aria-label="Verification code"><button class="secondary" data-verify="${esc(e.id)}">Verify</button></span>`}</td><td><button class="secondary" data-epdel="${esc(e.id)}">Delete</button></td></tr>`).join("") || `<tr><td colspan="4" class="muted">No endpoints yet. "Notify this browser" on Send / receive adds a Web Push one.</td></tr>`;
  const label = (id) => { const e = endpoints.find((x) => x.id === id); return e ? `${e.kind} ${e.address}` : id; };
  $("subEp").innerHTML = endpoints.filter((e) => e.verified).map((e) => `<option value="${esc(e.id)}">${esc(label(e.id))}</option>`).join("") || `<option value="">No verified endpoints</option>`;
  $("subRows").innerHTML = subs.subscriptions.map((s) => `<tr><td><code>${esc(s.topic)}</code></td><td>${esc(label(s.endpoint_id))}</td><td>${s.after_s ? `${s.after_s}s` : "now"}</td><td>${s.min_priority ?? ""}</td><td><code>${esc([s.filter?.tags?.length ? `tags ${s.filter.tags.join(",")}` : "", s.filter?.priority?.length ? `priority ${s.filter.priority.join(",")}` : ""].filter(Boolean).join("; "))}</code></td><td><button class="secondary" data-subdel="${esc(s.id)}">Remove</button></td></tr>`).join("") || `<tr><td colspan="6" class="muted">No endpoint subscriptions.</td></tr>`;
  $("slackTeam").innerHTML = teams.teams.map((t) => `<option value="${esc(t.team_id)}">${esc(t.team_name || t.team_id)}</option>`).join("") || `<option value="">Install the app first</option>`;
  if (slackTeamHint && teams.teams.some((t) => t.team_id === slackTeamHint)) $("slackTeam").value = slackTeamHint;
  const h = me?.handle ? `@${me.handle}/` : "";
  $("subTopicNew").value ||= $("pubTopic").value || `${h}alerts`;
  $("slackTopic").value ||= $("subTopicNew").value;
  document.querySelectorAll("[data-verify]").forEach((b) => b.onclick = async () => {
    const id = b.dataset.verify;
    const code = document.querySelector(`[data-code="${CSS.escape(id)}"]`).value.trim();
    try { await client.request("POST", `/v1/endpoints/${encodeURIComponent(id)}/verify`, { code }); loadEndpoints(); }
    catch (e) { alert(`${e.code}: ${e.message}`); }
  });
  document.querySelectorAll("[data-epdel]").forEach((b) => b.onclick = async () => {
    if (!confirm("Delete this endpoint and its subscriptions?")) return;
    await client.request("DELETE", `/v1/endpoints/${encodeURIComponent(b.dataset.epdel)}`).catch((e) => alert(e.message));
    loadEndpoints();
  });
  document.querySelectorAll("[data-subdel]").forEach((b) => b.onclick = async () => {
    await client.request("DELETE", `/v1/subscriptions/${encodeURIComponent(b.dataset.subdel)}`).catch((e) => alert(e.message));
    loadEndpoints();
  });
}
$("epAdd").onclick = async () => {
  const out = $("epOut"); out.hidden = false;
  try {
    const e = await client.request("POST", "/v1/endpoints", { kind: $("epKind").value, address: $("epAddr").value.trim(), name: $("epName").value.trim() || undefined });
    out.textContent = [e.secret ? `Signing secret (shown once): ${e.secret}` : "", e.note ?? "", e.verified ? "Verified." : "We sent a 6-digit code to the address: enter it in the table above."].filter(Boolean).join("\n");
    $("epAddr").value = "";
    loadEndpoints();
  } catch (e) { out.textContent = `${e.code}: ${e.message}`; }
};
$("subAdd").onclick = async () => {
  const say = (t) => { $("subMsg").textContent = t; };
  const tags = $("subTags").value.split(",").map((x) => x.trim()).filter(Boolean);
  try {
    await client.request("POST", "/v1/subscriptions", {
      topic: $("subTopicNew").value.trim(),
      endpoint_id: $("subEp").value,
      after_s: Number($("subAfter").value) || 0,
      min_priority: $("subMinPrio").value ? Number($("subMinPrio").value) : undefined,
      filter: tags.length ? { tags } : undefined,
    });
    say("Added."); loadEndpoints();
  } catch (e) { say(`${e.code}: ${e.message}`); }
};
$("slackInstall").onclick = async () => {
  try { location.href = (await client.request("GET", "/v1/slack/install")).url; }
  catch (e) { $("slackMsg").textContent = `${e.code}: ${e.message}`; }
};
$("slackBind").onclick = async () => {
  try {
    await client.request("POST", "/v1/slack/bindings", { team_id: $("slackTeam").value, channel: $("slackChannel").value.trim(), topic: $("slackTopic").value.trim() });
    $("slackMsg").textContent = "Bound."; loadEndpoints();
  } catch (e) { $("slackMsg").textContent = `${e.code}: ${e.message}`; }
};

// ---------- devices ----------
async function loadDevices() {
  const { devices } = await client.request("GET", "/v1/devices");
  $("devRows").innerHTML = devices.map((d) => `<tr><td>${esc(d.name || "")}</td><td><code title="${esc(d.id)}">${esc(d.id.slice(0, 14))}…</code></td><td>${esc((d.capabilities ?? []).join(", "))}</td><td>${esc(when(d.last_seen_at))}</td><td>${d.revoked_at ? '<span class="bad">revoked</span>' : '<span class="ok">active</span>'}</td><td>${d.revoked_at ? "" : `<button class="secondary" data-devrevoke="${esc(d.id)}">Revoke</button>`}</td></tr>`).join("") || `<tr><td colspan="6" class="muted">No devices yet.</td></tr>`;
  document.querySelectorAll("[data-devrevoke]").forEach((b) => b.onclick = async () => {
    if (!confirm("Revoke this device? It can no longer sign requests.")) return;
    await client.request("DELETE", `/v1/devices/${encodeURIComponent(b.dataset.devrevoke)}`).catch((e) => alert(e.message));
    loadDevices();
  });
}
$("devApprove").onclick = async () => {
  const say = (t) => { $("devMsg").textContent = t; };
  try {
    const r = await client.request("POST", "/v1/device/approve", { user_code: $("devCode").value.trim() });
    say(`Enrolled ${r.name || r.device_id}. The device will finish signing in by itself.`);
    $("devCode").value = "";
    if (new URLSearchParams(location.hash.slice(1)).has("device")) history.replaceState(null, "", "#tab=devices");
    loadDevices();
  } catch (e) { say(e.code === "not_found" ? "That code is unknown or expired. Ask the device for a new one." : `${e.code}: ${e.message}`); }
};
$("devEnroll").onclick = async () => {
  try {
    await client.request("POST", "/v1/devices", { device_id: $("devId").value.trim(), name: $("devName").value.trim() || undefined });
    $("devEnrollMsg").textContent = "Enrolled."; loadDevices();
  } catch (e) { $("devEnrollMsg").textContent = `${e.code}: ${e.message}`; }
};

// ---------- audit log ----------
let auditBefore = null;
async function loadAudit(reset) {
  if (reset) { auditBefore = null; $("auditRows").innerHTML = ""; }
  const r = await client.request("GET", `/v1/audit?limit=50${auditBefore ? `&before=${auditBefore}` : ""}`);
  $("auditRows").insertAdjacentHTML("beforeend", r.entries.map((e) => `<tr><td>${esc(when(e.time))}</td><td><code>${esc(e.action)}</code></td><td>${esc(e.actor)}</td><td><code>${esc(e.detail == null ? "" : typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail))}</code></td></tr>`).join(""));
  if (reset && !r.entries.length) $("auditRows").innerHTML = `<tr><td colspan="4" class="muted">Nothing yet.</td></tr>`;
  auditBefore = r.next_before;
  $("auditMore").hidden = !auditBefore;
}
$("auditMore").onclick = () => loadAudit(false);

// ---------- API explorer ----------
let exOps = null;
async function loadExplorer() {
  if (exOps) return;
  try {
    const spec = await fetch("/openapi.json").then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
    exOps = operations(spec);
  } catch (e) { $("exDesc").textContent = `Couldn't load the OpenAPI document: ${e.message}`; return; }
  drawOps();
}
function drawOps() {
  const f = $("exFilter").value.trim().toLowerCase();
  const shown = exOps.filter((o) => !f || `${o.method} ${o.path} ${o.summary} ${o.tag} ${o.id}`.toLowerCase().includes(f));
  const prev = $("exOp").value;
  const tags = [...new Set(shown.map((o) => o.tag))];
  $("exOp").innerHTML = tags.map((t) => `<optgroup label="${esc(t)}">${shown.filter((o) => o.tag === t).map((o) => `<option value="${esc(o.id)}"${o.unsupported ? " disabled" : ""}>${o.method} ${esc(o.path)}${o.summary ? ` — ${esc(o.summary)}` : ""}</option>`).join("")}</optgroup>`).join("");
  const keep = shown.find((o) => o.id === prev && !o.unsupported) ?? shown.find((o) => !o.unsupported);
  if (keep) $("exOp").value = keep.id;
  drawOp();
}
function currentOp() { return exOps?.find((o) => o.id === $("exOp").value); }
function drawOp() {
  const op = currentOp();
  $("exOut").hidden = true; $("exStatus").textContent = "";
  if (!op) { $("exParams").innerHTML = ""; $("exDesc").textContent = "No matching operations."; $("exBodyWrap").hidden = true; return; }
  $("exDesc").textContent = (op.description || op.summary || "").replace(/`/g, "").split("\n\n")[0] + (op.stream ? " (Streams: the explorer reads for up to 10 seconds; add poll=1 to return at once.)" : "");
  const h = me?.handle ? `@${me.handle}/test` : "";
  const guess = (p) => (/topic/i.test(p.name) ? h : p.example ?? p.schema?.example ?? p.schema?.default ?? "");
  $("exParams").innerHTML = op.params.map((p, i) => `<div><label for="exP${i}">${esc(p.name)} <span class="muted">${p.in}${p.required ? ", required" : ""}</span></label><input id="exP${i}" data-in="${p.in}" data-name="${esc(p.name)}" value="${esc(p.in === "path" ? guess(p) : "")}" placeholder="${esc(p.schema?.enum?.join(" | ") ?? p.schema?.type ?? "")}" title="${esc(p.description ?? "")}"></div>`).join("");
  $("exBodyWrap").hidden = !op.body;
  if (op.body) {
    $("exBodyType").textContent = op.body.type;
    const text = typeof op.body.example === "string" ? op.body.example : op.body.example == null ? "" : JSON.stringify(op.body.example, null, 2);
    $("exBody").value = me?.handle ? text.replaceAll("@alice/", `@${me.handle}/`) : text;
  }
}
function exRequest() {
  const op = currentOp();
  const values = { path: {}, query: {}, header: {}, body: op.body ? $("exBody").value : undefined };
  document.querySelectorAll("#exParams input").forEach((el) => { values[el.dataset.in][el.dataset.name] = el.value.trim(); });
  return { op, req: buildRequest(location.origin, op, values) };
}
$("exFilter").oninput = () => exOps && drawOps();
$("exOp").onchange = drawOp;
$("exCurl").onclick = async () => {
  try {
    const { op, req } = exRequest();
    const text = toCurl(req, { auth: op.auth });
    $("exOut").hidden = false; $("exOut").textContent = text;
    await navigator.clipboard?.writeText(text).catch(() => {});
  } catch (e) { $("exStatus").textContent = e.message; }
};
$("exSend").onclick = async () => {
  let built;
  try { built = exRequest(); } catch (e) { $("exStatus").textContent = e.message; return; }
  const { op, req } = built;
  const headers = { ...req.headers };
  const token = op.auth ? await getToken() : null;
  if (token) headers.Authorization = `Bearer ${token}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), op.stream ? 10_000 : 30_000);
  const t0 = performance.now();
  $("exStatus").textContent = "Sending…"; $("exOut").hidden = false; $("exOut").textContent = "";
  try {
    const r = await fetch(req.url, { method: req.method, headers, body: req.body, signal: ctrl.signal, redirect: "manual" });
    const head = `HTTP ${r.status} ${r.statusText}\n${[...r.headers].filter(([k]) => /^(content-type|retry-after|location|x-|idempotency)/i.test(k)).map(([k, v]) => `${k}: ${v}`).join("\n")}\n\n`;
    $("exOut").textContent = head;
    if (op.stream && r.body) {
      const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
      try { for (;;) { const { value, done } = await reader.read(); if (done) break; $("exOut").textContent += value; } } catch (e) { if (e.name !== "AbortError") throw e; }
    } else {
      const text = await r.text();
      let pretty = text;
      try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch {}
      $("exOut").textContent += pretty;
    }
    $("exStatus").textContent = `${r.status} in ${Math.round(performance.now() - t0)} ms`;
    if (r.ok && me) client.account().then((a) => { me = a; showBalance(a); }).catch(() => {});
  } catch (e) {
    $("exStatus").textContent = e.name === "AbortError" ? `Stopped after ${Math.round((performance.now() - t0) / 1000)} s` : `Failed: ${e.message}`;
  } finally { clearTimeout(timer); }
};

init().catch((e) => { console.error(e); });
