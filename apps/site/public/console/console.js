// The console is an ordinary SDK client (PLAN §11).
import { LANGUAGES, LANGUAGE_NAMES, snippet } from "./snippets.js";
import { buildRequest, operations, toCurl } from "./explorer.js";
import { renderUsageChart } from "./usage-chart.js";
import { renderInspection, verifyWebhookSignature } from "./inspector.js";
import { renderTrace } from "./trace.js";

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

// E2EE topic keys this console uses: topic → { kid, key (base64url) }. Kept in memory, and in
// local storage only when "Remember keys in this browser" is ticked.
const KEYRING = "subetha.topicKeys";
let keyring = (() => { try { return JSON.parse(load(KEYRING) || "{}"); } catch { return {}; } })();
const rememberKeys = () => load(KEYRING) !== null;
function saveKeyring(remember = rememberKeys()) { store(KEYRING, remember ? JSON.stringify(keyring) : null); }
const topicKeysFor = () => Object.fromEntries(Object.entries(keyring).map(([t, k]) => [t, { kid: k.kid, key: SubEtha.protocol.base64urlDecode(k.key) }]));

// "This browser" as a device (PLAN §11): an Ed25519 seed in local storage.
const BROWSER_SEED = "subetha.browserDeviceSeed";
let browserDeviceKey = null;
async function loadBrowserDeviceKey() {
  const raw = load(BROWSER_SEED);
  if (!raw) return (browserDeviceKey = null);
  try {
    const seed = SubEtha.protocol.base64urlDecode(raw);
    if (seed.length !== 32) return (browserDeviceKey = null);
    return (browserDeviceKey = await SubEtha.protocol.deviceKeyFromSeed(seed));
  } catch {
    return (browserDeviceKey = null);
  }
}
function browserCapabilities() {
  const caps = ["ws"];
  if ("PushManager" in window) caps.push("webpush");
  if ("AudioContext" in window || "webkitAudioContext" in window) caps.push("audio");
  if (navigator.mediaDevices) caps.push("qr");
  if ("bluetooth" in navigator) caps.push("ble");
  return caps;
}
function syncBrowserDeviceControls() {
  $("pubSignWrap").hidden = !browserDeviceKey;
  if (!browserDeviceKey) $("pubSign").checked = false;
  $("keyLoadBrowser").hidden = !browserDeviceKey;
}

async function makeClient() {
  const token = await getToken();
  await loadBrowserDeviceKey();
  syncBrowserDeviceControls();
  // Pass getToken as a dynamic provider so short-lived Clerk session JWTs refresh on every request & WS reconnect.
  return token ? new SubEtha({ baseUrl: location.origin, token: getToken, deviceKey: browserDeviceKey ?? undefined, topicKeys: topicKeysFor() }) : null;
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

/** Deep links: #tab=…, #topic=…, #dba-callback (devicebasedauth.org linking), #device, #slack=installed (Slack OAuth), #topup=ok (Stripe). */
function routeHash(hash) {
  if (hash.has("dba-callback")) {
    showTab("devices");
    // The one-time code leaves the address bar (and history) before anything else happens.
    history.replaceState(null, "", "#tab=devices");
    finishDbaLink(hash.get("code"), hash.get("state"), hash.get("error"));
    return;
  }
  if (hash.has("device")) { showTab("devices"); return; }
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

const safeHref = (u) => {
  if (typeof u !== "string") return null;
  if (u.startsWith("/file/")) return u;
  try {
    const p = new URL(u);
    return p.protocol === "https:" || p.protocol === "http:" ? p.toString() : null;
  } catch { return null; }
};
function parseActionsInput(raw) {
  const t = raw.trim();
  if (!t) return undefined;
  if (t.startsWith("[")) return JSON.parse(t);
  return t.split(";").map((part) => {
    const [action, label, url, ...rest] = part.split(",").map((f) => f.trim());
    if (!action || !label) throw { code: "bad_request", message: "actions look like: view, Open, https://example.com" };
    const a = { action, label };
    if (url) a.url = url;
    for (const kv of rest) {
      const [k, v] = kv.split("=", 2);
      if (k && v !== undefined) a[k] = v === "true" ? true : v === "false" ? false : v;
    }
    return a;
  });
}
function pubOpts() {
  const tags = $("pubTags").value.split(",").map((s) => s.trim()).filter(Boolean);
  const deny = $("pubDeny").value.split(",").map((s) => s.trim()).filter(Boolean);
  const allow = $("pubAllow").value.split(",").map((s) => s.trim()).filter(Boolean);
  const maxRaw = $("pubMaxCost").value.trim();
  const deadlineRaw = $("pubDeadline").value.trim();
  const route = { mode: $("pubMode").value };
  if (maxRaw !== "") route.maxCostUsd = Number(maxRaw);
  if (deadlineRaw !== "") route.deadlineS = Math.floor(Number(deadlineRaw));
  if (deny.length) route.deny = deny;
  if (allow.length) route.allow = allow;
  const o = {
    title: $("pubTitle").value || undefined,
    priority: Number($("pubPrio").value),
    tags,
    click: $("pubClick").value.trim() || undefined,
    icon: $("pubIcon").value.trim() || undefined,
    actions: parseActionsInput($("pubActions").value),
    contentType: $("pubMarkdown").checked ? "text/markdown" : undefined,
    idempotencyKey: $("pubIdem").value.trim() || undefined,
    route,
    sign: !!(browserDeviceKey && $("pubSign").checked),
  };
  return o;
}
$("pubFile").onchange = () => { $("pubFileClear").hidden = !$("pubFile").files?.length; };
$("pubFileClear").onclick = () => { $("pubFile").value = ""; $("pubFileClear").hidden = true; };

$("pubBtn").onclick = async () => {
  const out = $("pubOut"); out.hidden = false;
  try {
    const topic = $("pubTopic").value.trim();
    const o = pubOpts();
    const file = $("pubFile").files?.[0];
    const m = file
      ? await client.publishFile(topic, { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), type: file.type || "application/octet-stream" }, { ...o, message: $("pubMsg").value || undefined })
      : await client.publish(topic, $("pubMsg").value || "triggered", o);
    if (file) { $("pubFile").value = ""; $("pubFileClear").hidden = true; }
    out.textContent = JSON.stringify(m, null, 2);
    rememberRecentMessage(m);
    $("traceTopic").value = m.topic; $("traceId").value = m.id;
    me = await client.account(); showBalance(me);
  } catch (e) { out.textContent = `${e.code ?? "error"}: ${e.message}`; }
};

$("dryBtn").onclick = async () => {
  const out = $("pubOut"); out.hidden = false;
  try {
    const topic = $("pubTopic").value.trim();
    const o = pubOpts();
    const file = $("pubFile").files?.[0];
    const e = file
      ? await client.estimateFile(topic, { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), type: file.type || "application/octet-stream" }, { ...o, message: $("pubMsg").value || undefined })
      : await client.estimate(topic, $("pubMsg").value || "test", o);
    out.textContent = `Estimated cost: ${usd(e.estimate_usd_micros)}\n\n` + (e.plan.length ? e.plan.map((d) => `${d.transport.padEnd(8)} ${usd(d.cost_micros)}${d.after_s ? `  (after ${d.after_s}s if unacked)` : ""}`).join("\n") : "No subscribers right now: the message would be stored for later.");
  } catch (e) { out.textContent = `${e.code ?? "error"}: ${e.message}`; }
};

$("copyLang").innerHTML = LANGUAGES.map((l) => `<option value="${l}">${LANGUAGE_NAMES[l]}</option>`).join("");
$("copyLang").value = load("subetha.copyLang") || "curl";
$("copyLang").onchange = () => store("subetha.copyLang", $("copyLang").value);
$("curlBtn").onclick = async () => {
  try {
    const o = pubOpts();
    const file = $("pubFile").files?.[0];
    const text = snippet($("copyLang").value, {
      baseUrl: location.origin, topic: $("pubTopic").value.trim(), message: $("pubMsg").value || "triggered",
      title: o.title, priority: o.priority, tags: o.tags, click: o.click, icon: o.icon,
      actions: o.actions, file: file ? { name: file.name, type: file.type || "application/octet-stream" } : undefined,
      sign: o.sign, markdown: o.contentType === "text/markdown", idempotencyKey: o.idempotencyKey,
      mode: o.route.mode, maxCostUsd: o.route.maxCostUsd, deadlineS: o.route.deadlineS, deny: o.route.deny, allow: o.route.allow,
    });
    $("pubOut").hidden = false; $("pubOut").textContent = text;
    await navigator.clipboard?.writeText(text).catch(() => {});
  } catch (e) { $("pubOut").hidden = false; $("pubOut").textContent = `${e.code ?? "error"}: ${e.message}`; }
};

function renderMarkdown(raw) {
  let s = esc(raw ?? "");
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  return s.replace(/\n/g, "<br>");
}

const recentMessages = [];
function rememberRecentMessage(m) {
  if (!m?.id || !m?.topic) return;
  const idx = recentMessages.findIndex((x) => x.id === m.id);
  if (idx >= 0) recentMessages.splice(idx, 1);
  recentMessages.unshift({ id: m.id, topic: m.topic, label: `${m.topic} · ${m.title || (m.message || "").slice(0, 40) || m.id}` });
  if (recentMessages.length > 20) recentMessages.length = 20;
  const sel = $("traceRecent");
  if (!sel) return;
  sel.hidden = !recentMessages.length;
  sel.innerHTML = `<option value="">Pick a recent message…</option>` + recentMessages.map((x) => `<option value="${esc(x.topic)}|${esc(x.id)}">${esc(x.label)}</option>`).join("");
}

function renderInboxItem(m) {
  rememberRecentMessage(m);
  const li = document.createElement("li");
  const tags = m.tags?.length ? ` · ${m.tags.map((t) => `<code>${esc(t)}</code>`).join(" ")}` : "";
  const sender = m.sender ? ` · <code title="${esc(m.sender)}">${esc(m.sender.slice(0, 12))}…</code>` : "";
  const traceBtn = m.id ? ` <button type="button" class="secondary" style="padding:1px 6px;font-size:12px" data-trace-topic="${esc(m.topic)}" data-trace-id="${esc(m.id)}">Trace</button>` : "";
  const msgHtml = m.content_type === "text/markdown" ? renderMarkdown(m.message) : esc(m.message);
  const body = m.enc ? `<span class="muted">🔒 Encrypted with key <code>${esc(m.enc.kid)}</code>, which isn't in this browser (Topics → End-to-end encryption keys).</span>` : `${m.title ? `<b>${esc(m.title)}</b> ` : ""}${msgHtml}`;
  const extras = [];
  const clickUrl = !m.enc && safeHref(m.click);
  if (clickUrl) extras.push(`<a href="${esc(clickUrl)}" target="_blank" rel="noopener noreferrer">${esc(clickUrl)}</a>`);
  const attUrl = !m.enc && m.attachment && safeHref(m.attachment.url);
  if (attUrl) {
    const size = typeof m.attachment.size === "number" ? ` (${m.attachment.size.toLocaleString()} B)` : "";
    const img = /^image\//.test(m.attachment.type ?? "") ? `<br><img src="${esc(attUrl)}" alt="${esc(m.attachment.name)}" style="max-width:220px;max-height:140px;border-radius:4px;margin-top:4px">` : "";
    extras.push(`📎 <a href="${esc(attUrl)}" target="_blank" rel="noopener noreferrer">${esc(m.attachment.name || "attachment")}</a>${esc(size)}${img}`);
  }
  if (!m.enc && Array.isArray(m.actions) && m.actions.length) {
    const links = m.actions.map((a) => {
      const u = a.action === "view" ? safeHref(a.url) : null;
      return u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">[${esc(a.label)}]</a>` : `<span class="muted">[${esc(a.label)}]</span>`;
    });
    extras.push(links.join(" "));
  }
  li.innerHTML = `<span class="muted">${new Date(m.time * 1000).toLocaleTimeString()} ${esc(m.topic)} p${m.priority ?? 3}${tags}${sender}</span>${traceBtn}<br>${body}${extras.length ? `<br><small>${extras.join(" · ")}</small>` : ""}`;
  li.querySelector("[data-trace-id]")?.addEventListener("click", (ev) => {
    const btn = ev.currentTarget;
    $("traceTopic").value = btn.dataset.traceTopic;
    $("traceId").value = btn.dataset.traceId;
    showTab("traces");
    $("traceBtn").click();
  });
  return li;
}

const MAX_INBOX_ITEMS = 200;
function subscribe() {
  sub?.close();
  $("inbox").replaceChildren();
  const topics = $("subTopic").value.split(",").map((s) => s.trim()).filter(Boolean);
  const priority = $("inboxPrio").value.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n >= 1 && n <= 5);
  const tags = $("inboxTags").value.split(",").map((s) => s.trim()).filter(Boolean);
  const sinceVal = $("inboxSince")?.value;
  $("subStop").hidden = false;
  sub = client.subscribe(topics, (m) => {
    const list = $("inbox");
    list.prepend(renderInboxItem(m));
    while (list.children.length > MAX_INBOX_ITEMS) list.lastElementChild?.remove();
  }, { ...(sinceVal ? { since: sinceVal } : {}), ...(priority.length ? { priority } : {}), ...(tags.length ? { tags } : {}), onError: (e) => console.warn(e) });
}
$("subBtn").onclick = subscribe;
$("subStop").onclick = () => { sub?.close(); sub = null; $("subStop").hidden = true; };
$("inboxClear").onclick = () => { $("inbox").replaceChildren(); };

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

function syncFormFromPolicy(p) {
  $("polPub").checked = !!p.public_publish;
  $("polRead").checked = !!p.public_read;
  $("polSig").checked = !!p.require_signature;
  $("polPaused").checked = !!p.paused;
  $("polRetentionH").value = p.retention_s != null ? String(Math.round((p.retention_s / 3600) * 100) / 100) : "";
  $("polDailyCap").value = p.daily_cap_micros != null ? String(p.daily_cap_micros / 1e6) : "";
  $("polMonthlyCap").value = p.monthly_cap_micros != null ? String(p.monthly_cap_micros / 1e6) : "";
  $("polMaxMsg").value = p.max_cost_per_message_micros != null ? String(p.max_cost_per_message_micros / 1e6) : "";
  $("polQuietStart").value = p.quiet_hours?.start ?? "";
  $("polQuietEnd").value = p.quiet_hours?.end ?? "";
  $("polQuietTz").value = p.quiet_hours?.tz ?? "";
  $("polAllow").value = (p.allow_transports ?? []).join(", ");
  $("polDeny").value = (p.deny_transports ?? []).join(", ");
  $("polRate").value = p.rate_per_min != null ? String(p.rate_per_min) : "";
  $("polBurst").value = p.burst != null ? String(p.burst) : "";
  $("polAnonRate").value = p.anon_rate_per_min != null ? String(p.anon_rate_per_min) : "";
  $("polAnonCap").value = p.anon_daily_cap_micros != null ? String(p.anon_daily_cap_micros / 1e6) : "";
  $("polMinPrio").value = p.min_priority ? Object.entries(p.min_priority).map(([k, v]) => `${k}:${v}`).join(", ") : "";
  $("polPublishers").value = (p.allowed_publishers ?? []).join(", ");
  $("polReaders").value = (p.allowed_readers ?? []).join(", ");
  $("polEmailSenders").value = (p.email_senders ?? []).join(", ");
}
function syncPolicyFromForm() {
  let base = {};
  try { base = JSON.parse($("topicPolicy").value || "{}"); } catch {}
  const p = { ...base };
  const setBool = (k, v) => { if (v) p[k] = true; else delete p[k]; };
  const setList = (k, raw) => { const xs = raw.split(",").map((s) => s.trim()).filter(Boolean); if (xs.length) p[k] = xs; else delete p[k]; };
  setBool("public_publish", $("polPub").checked);
  setBool("public_read", $("polRead").checked);
  setBool("require_signature", $("polSig").checked);
  setBool("paused", $("polPaused").checked);
  const ret = $("polRetentionH").value.trim();
  if (ret !== "") p.retention_s = Math.round(Number(ret) * 3600); else delete p.retention_s;
  const daily = $("polDailyCap").value.trim();
  if (daily !== "") p.daily_cap_micros = Math.round(Number(daily) * 1e6); else delete p.daily_cap_micros;
  const monthly = $("polMonthlyCap").value.trim();
  if (monthly !== "") p.monthly_cap_micros = Math.round(Number(monthly) * 1e6); else delete p.monthly_cap_micros;
  const maxm = $("polMaxMsg").value.trim();
  if (maxm !== "") p.max_cost_per_message_micros = Math.round(Number(maxm) * 1e6); else delete p.max_cost_per_message_micros;
  const qs = $("polQuietStart").value.trim(), qe = $("polQuietEnd").value.trim(), qtz = $("polQuietTz").value.trim();
  if (qs && qe) p.quiet_hours = qtz ? { start: qs, end: qe, tz: qtz } : { start: qs, end: qe }; else delete p.quiet_hours;
  setList("allow_transports", $("polAllow").value);
  setList("deny_transports", $("polDeny").value);
  const rate = $("polRate").value.trim();
  if (rate !== "") p.rate_per_min = Math.round(Number(rate)); else delete p.rate_per_min;
  const burst = $("polBurst").value.trim();
  if (burst !== "") p.burst = Math.round(Number(burst)); else delete p.burst;
  const anonRate = $("polAnonRate").value.trim();
  if (anonRate !== "") p.anon_rate_per_min = Math.round(Number(anonRate)); else delete p.anon_rate_per_min;
  const anonCap = $("polAnonCap").value.trim();
  if (anonCap !== "") p.anon_daily_cap_micros = Math.round(Number(anonCap) * 1e6); else delete p.anon_daily_cap_micros;
  const minPrioRaw = $("polMinPrio").value.trim();
  if (minPrioRaw) {
    const mp = {};
    for (const part of minPrioRaw.split(",")) {
      const [k, v] = part.split(":").map((s) => s.trim());
      const n = Number(v);
      if (k && Number.isInteger(n) && n >= 1 && n <= 5) mp[k] = n;
    }
    if (Object.keys(mp).length) p.min_priority = mp; else delete p.min_priority;
  } else delete p.min_priority;
  setList("allowed_publishers", $("polPublishers").value);
  setList("allowed_readers", $("polReaders").value);
  setList("email_senders", $("polEmailSenders").value);
  $("topicPolicy").value = JSON.stringify(p, null, 2);
}
$("polForm").addEventListener("input", syncPolicyFromForm);
$("polForm").addEventListener("change", syncPolicyFromForm);
$("topicPolicy").addEventListener("input", () => { try { syncFormFromPolicy(JSON.parse($("topicPolicy").value || "{}")); } catch {} });

async function loadTopics() {
  const { topics } = await client.topics();
  loadKeys(topics).catch((e) => { $("keyMsg").textContent = `${e.code ?? "error"}: ${e.message}`; });
  $("topicRows").innerHTML = topics.map((t) => `<tr><td><code>${esc(t.name)}</code></td><td>${esc(t.endpoint_subscriptions ?? 0)}</td><td><code>${esc(JSON.stringify(t.policy))}</code></td><td><button class="secondary" data-edit="${esc(t.name)}">Edit</button> <button class="secondary" data-topicdel="${esc(t.name)}">Delete</button></td></tr>`).join("") || `<tr><td colspan=4 class="muted">No topics yet. Publishing to @${esc(me.handle)}/anything creates one.</td></tr>`;
  document.querySelectorAll("[data-topicdel]").forEach((b) => b.onclick = async () => {
    const name = b.dataset.topicdel;
    if (!confirm(`Delete topic ${name}? This closes live connections and deletes its retained messages, subscriptions, and wrapped keys.`)) return;
    try { await client.deleteTopic(name); loadTopics(); } catch (e) { alert(`${e.code ?? "error"}: ${e.message}`); }
  });
  document.querySelectorAll("[data-edit]").forEach((b) => b.onclick = async () => {
    const t = topics.find((x) => x.name === b.dataset.edit);
    $("topicName").value = t.name;
    $("topicPolicy").value = JSON.stringify(t.policy, null, 2);
    syncFormFromPolicy(t.policy);
    $("topicSubs").hidden = true;
    try {
      const detail = await client.request("GET", `/v1/topics/${t.name}`);
      if (detail.subscribers) {
        $("topicSubs").hidden = false;
        $("topicSubs").textContent = `Subscribers right now: ${detail.subscribers.live} live connection${detail.subscribers.live === 1 ? "" : "s"}, ${detail.subscribers.queued} verified endpoint${detail.subscribers.queued === 1 ? "" : "s"}.`;
      }
    } catch {}
  });
}
// ---------- E2EE topic keys (spec §5.1) ----------
const newKid = () => `k${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${SubEtha.protocol.base64urlEncode(crypto.getRandomValues(new Uint8Array(3)))}`;
let keyDevices = [];
async function loadKeys(topics) {
  const sel = $("keyTopic");
  const current = sel.value;
  sel.innerHTML = topics.map((t) => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join("") || `<option value="">No topics yet</option>`;
  if (topics.some((t) => t.name === current)) sel.value = current;
  const { devices } = await client.request("GET", "/v1/devices");
  // Only signing keys (dev_…) can receive wrapped keys; devicebasedauth.org devices (dba:…) attach one first.
  keyDevices = devices.filter((d) => !d.revoked_at && d.id.startsWith("dev_"));
  $("keyDevices").innerHTML = `<legend>Wrap new keys for these devices</legend>` + (keyDevices.map((d) => `<label class="check"><input type="checkbox" data-keydev="${esc(d.id)}" checked> ${esc(d.name || d.id.slice(0, 14) + "…")}</label>`).join("") || `<span class="muted">No devices with a signing key: the key can only be shared by hand.</span>`);
  await loadKeyRows();
  renderLocalKeys();
}
async function loadKeyRows() {
  const topic = $("keyTopic").value;
  if (!topic) { $("keyRows").innerHTML = ""; return; }
  const { keys } = await client.listWrappedKeys(topic);
  const name = (id) => keyDevices.find((d) => d.id === id)?.name || `${id.slice(0, 14)}…`;
  $("keyRows").innerHTML = keys.map((k) => `<tr><td><code>${esc(k.kid)}</code></td><td>${esc(name(k.to))}</td><td>${esc(when(k.created_at))}</td><td><button class="secondary" data-keydel="${esc(k.kid)}" data-keydevice="${esc(k.to)}">Remove</button></td></tr>`).join("") || `<tr><td colspan="4" class="muted">No wrapped keys for this topic.</td></tr>`;
  document.querySelectorAll("[data-keydel]").forEach((b) => b.onclick = async () => {
    if (!confirm("Remove this wrapped key? That device won't be able to fetch it again (it keeps any copy it already has).")) return;
    await client.deleteWrappedKeys(topic, { kid: b.dataset.keydel, device: b.dataset.keydevice }).catch((e) => alert(e.message));
    loadKeyRows();
  });
}
function renderQrInto(el, text, caption) {
  const edge = window.SubEthaEdge;
  if (!edge?.encodeQr || !edge?.qrSvg) { el.hidden = true; return; }
  const svg = edge.qrSvg(edge.encodeQr(text, { ecl: "M" }), 3);
  el.hidden = false;
  el.innerHTML = `<div style="background:#fff;padding:6px;border-radius:6px;border:1px solid var(--border,#ddd)">${svg}</div>${caption ? `<small class="muted" style="display:block;margin-top:.35rem;word-break:break-all">${esc(caption)}</small>` : ""}`;
}
const keyShareUri = (topic, kid, key) => `subetha://key?topic=${encodeURIComponent(topic)}&kid=${encodeURIComponent(kid)}&key=${encodeURIComponent(key)}`;
function parseKeyShare(text) {
  const s = text.trim();
  if (s.startsWith("subetha://key?")) {
    const q = new URLSearchParams(s.slice("subetha://key?".length));
    const topic = q.get("topic"), kid = q.get("kid"), key = q.get("key");
    if (topic && kid && key) return { topic, kid, key };
  }
  if (s.startsWith("{")) {
    try {
      const o = JSON.parse(s);
      if (o?.topic && o?.kid && o?.key) return { topic: String(o.topic), kid: String(o.kid), key: String(o.key) };
    } catch { /* ignore */ }
  }
  return null;
}
function renderLocalKeys() {
  $("keyRemember").checked = rememberKeys();
  syncBrowserDeviceControls();
  $("localKeyRows").innerHTML = Object.entries(keyring).map(([t, k]) => `<tr><td><code>${esc(t)}</code></td><td><code>${esc(k.kid)}</code></td><td><button class="secondary" data-keyqr="${esc(t)}">QR</button> <button class="secondary" data-keyforget="${esc(t)}">Forget</button></td></tr>`).join("") || `<tr><td class="muted">No keys in this browser.</td></tr>`;
  document.querySelectorAll("[data-keyqr]").forEach((b) => b.onclick = () => {
    const t = b.dataset.keyqr, k = keyring[t];
    if (!k) return;
    const uri = keyShareUri(t, k.kid, k.key);
    $("keyOut").hidden = false;
    $("keyOut").textContent = `Topic: ${t}\nKey id: ${k.kid}\nKey: ${k.key}\nShare URI: ${uri}`;
    renderQrInto($("keyQr"), uri, `Scan to import E2EE key for ${t}`);
  });
  document.querySelectorAll("[data-keyforget]").forEach((b) => b.onclick = () => useKey(b.dataset.keyforget, null));
}
/** Adds (or with null, forgets) a topic key for this console, then re-subscribes so the inbox decrypts. */
function useKey(topic, k) {
  if (k) keyring[topic] = k; else delete keyring[topic];
  saveKeyring();
  client.setTopicKey(topic, k ? { kid: k.kid, key: SubEtha.protocol.base64urlDecode(k.key) } : null);
  renderLocalKeys();
  if (sub) subscribe();
}
$("keyTopic").onchange = () => loadKeyRows().catch((e) => { $("keyMsg").textContent = e.message; });
$("keyRemember").onchange = () => saveKeyring($("keyRemember").checked);
$("keyNew").onclick = async () => {
  const topic = $("keyTopic").value;
  const say = (t) => { $("keyMsg").textContent = t; };
  if (!topic) return say("Pick a topic first.");
  const devices = [...document.querySelectorAll("[data-keydev]:checked")].map((i) => i.dataset.keydev);
  const key = crypto.getRandomValues(new Uint8Array(32));
  const kid = newKid();
  try {
    if (devices.length) await client.shareTopicKey(topic, kid, key, devices);
    const k = { kid, key: SubEtha.protocol.base64urlEncode(key) };
    useKey(topic, k);
    const uri = keyShareUri(topic, kid, k.key);
    $("keyOut").hidden = false;
    $("keyOut").textContent = `Topic: ${topic}\nKey id: ${kid}\nKey: ${k.key}\nShare URI: ${uri}\n\nThis browser now encrypts to ${topic} with it. To share it out of band, scan the QR code or copy it now: SubEtha can't show it again.`;
    renderQrInto($("keyQr"), uri, `Scan to import E2EE key for ${topic}`);
    say(devices.length ? `Wrapped for ${devices.length} device${devices.length > 1 ? "s" : ""}.` : "Not wrapped for any device.");
    loadKeyRows();
  } catch (e) { say(`${e.code ?? "error"}: ${e.message}`); }
};
for (const id of ["keyAddTopic", "keyAddKey"]) {
  $(id).addEventListener("input", () => {
    const parsed = parseKeyShare($(id).value);
    if (!parsed) return;
    $("keyAddTopic").value = parsed.topic;
    $("keyAddKid").value = parsed.kid;
    $("keyAddKey").value = parsed.key;
  });
}
$("keyAdd").onclick = () => {
  const topic = $("keyAddTopic").value.trim(), kid = $("keyAddKid").value.trim(), key = $("keyAddKey").value.trim();
  try {
    if (!SubEtha.protocol.isTopic(topic)) throw new Error("not a topic name");
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(kid)) throw new Error("key ids are 1–64 characters of A–Z a–z 0–9 _ . -");
    if (SubEtha.protocol.base64urlDecode(key).length !== 32) throw new Error("a key is 32 bytes (43 base64url characters)");
    useKey(topic, { kid, key });
    $("keyAddKey").value = "";
    $("keyMsg").textContent = `Added a key for ${topic}.`;
  } catch (e) { $("keyMsg").textContent = e.message; }
};

$("genSecret").onclick = () => { $("topicName").value = SubEtha.protocol.secretTopic(); };
$("topicSave").onclick = async () => {
  try {
    await client.configureTopic($("topicName").value.trim(), JSON.parse($("topicPolicy").value || "{}"));
    $("topicMsg").textContent = "Saved."; loadTopics();
  } catch (e) { $("topicMsg").textContent = `${e.code ?? "error"}: ${e.message}`; }
};

async function loadTokens() {
  const { tokens } = await client.listTokens();
  const capsOf = (t) => [
    t.daily_cap_micros != null ? `${usd(t.daily_cap_micros)}/day` : "",
    t.total_cap_micros != null ? `${usd(t.total_cap_micros)} total` : "",
    t.transports?.length ? `allow: ${t.transports.join(",")}` : "",
    t.deny_transports?.length ? `deny: ${t.deny_transports.join(",")}` : "",
    t.origins?.length ? `origins: ${t.origins.join(",")}` : "",
    t.ips?.length ? `ips: ${t.ips.join(",")}` : "",
  ].filter(Boolean).join(" · ");
  const statusOf = (t) => t.revoked_at ? '<span class="bad">revoked</span>' : (t.expires_at && t.expires_at < Date.now() ? '<span class="bad">expired</span>' : '<span class="ok">active</span>');
  $("tokenRows").innerHTML = tokens.map((t) => `<tr><td>${esc(t.name || t.id)}</td><td><code>${esc(t.scopes.join(" "))}</code></td><td>${esc(capsOf(t))}</td><td>${esc(t.expires_at ? when(t.expires_at) : "never")}</td><td>${statusOf(t)}</td><td>${t.revoked_at ? "" : `<button class="secondary" data-revoke="${esc(t.id)}">Revoke</button>`}</td></tr>`).join("") || `<tr><td colspan="6" class="muted">No API tokens yet.</td></tr>`;
  document.querySelectorAll("[data-revoke]").forEach((b) => b.onclick = async () => { await client.revokeToken(b.dataset.revoke); loadTokens(); });
}
$("tokCreate").onclick = async () => {
  const list = (v) => v.split(",").map((s) => s.trim()).filter(Boolean);
  const out = $("tokOut"); out.hidden = false;
  try {
    const expHours = $("tokExpires").value.trim();
    const t = await client.createToken({
      name: $("tokName").value || undefined,
      scopes: list($("tokScopes").value),
      daily_cap_usd: $("tokDaily").value ? Number($("tokDaily").value) : undefined,
      total_cap_usd: $("tokTotal").value ? Number($("tokTotal").value) : undefined,
      expires_in_s: expHours ? Math.round(Number(expHours) * 3600) : undefined,
      transports: $("tokTransports").value ? list($("tokTransports").value) : undefined,
      deny_transports: $("tokDenyTransports").value ? list($("tokDenyTransports").value) : undefined,
      origins: $("tokOrigins").value ? list($("tokOrigins").value) : undefined,
      ips: $("tokIps").value ? list($("tokIps").value) : undefined,
    });
    const topicHint = t.scopes[0]?.includes(":") ? t.scopes[0].split(":").slice(1).join(":").replace(/\*$/, "test") : "<topic>";
    const origins = list($("tokOrigins").value);
    const embed = origins.length
      ? `\n\nWeb embed (publishable token for ${origins.join(", ")}):\n<script src="${location.origin}/sdk.js"></script>\n<${t.scopes[0]?.startsWith("subscribe:") ? "subetha-feed" : "subetha-send"} topic="${topicHint}" token="${t.token}"></${t.scopes[0]?.startsWith("subscribe:") ? "subetha-feed" : "subetha-send"}>`
      : "";
    const sdkJs = `\n\nJavaScript:\nimport { SubEtha } from "@subetha/sdk";\nconst se = new SubEtha({ baseUrl: ${JSON.stringify(location.origin)}, token: ${JSON.stringify(t.token)} });\nawait se.publish(${JSON.stringify(topicHint)}, "hi");`;
    out.textContent = `${t.token}\n\nShown once. Example:\ncurl -H "Authorization: Bearer ${t.token}" -d hi ${location.origin}/${topicHint}${sdkJs}${embed}`;
    loadTokens();
  } catch (e) { out.textContent = `${e.code}: ${e.message}`; }
};

const toUsdInput = (micros) => (micros == null ? "" : String(micros / 1e6));
const fromUsdInput = (v) => (v.trim() === "" ? null : Math.round(Number(v) * 1e6));
const listOrNull = (v) => { const xs = v.split(",").map((s) => s.trim()).filter(Boolean); return xs.length ? xs : null; };
$("capSave").onclick = async () => {
  try {
    await client.updateAccount({
      daily_cap_micros: fromUsdInput($("capDaily").value),
      monthly_cap_micros: fromUsdInput($("capMonthly").value),
      allow_transports: listOrNull($("capAllow").value),
      deny_transports: listOrNull($("capDeny").value),
      oauth_daily_cap_micros: fromUsdInput($("capOauth").value),
      paused: $("capPaused").checked,
    });
    me = await client.account();
    $("capMsg").textContent = "Saved.";
  } catch (e) { $("capMsg").textContent = `${e.code}: ${e.message}`; }
};

const perUnit = (p, tier) => (p ? `$${((p[tier] ?? p.standard) / 1e6).toFixed(4)}` : "—");
async function loadTelephonyCountries() {
  const box = $("telCountries");
  try {
    const { countries, updated_at } = await client.destinationPrices();
    const on = new Set(me.telephony_countries ?? []);
    box.innerHTML = `<table><thead><tr><th></th><th>Country</th><th>SMS / segment</th><th>Voice / min</th></tr></thead><tbody>${Object.entries(countries).map(([iso, c]) =>
      `<tr><td><input type="checkbox" data-country="${esc(iso)}" style="width:auto" ${on.has(iso) ? "checked" : ""} aria-label="${esc(c.name)}"></td><td>${esc(c.name)} <small class="muted">${esc(c.calling_code)}</small></td><td>${perUnit(c.sms_usd_micros, me.tier)}</td><td>${perUnit(c.voice_usd_micros_per_minute, me.tier)}</td></tr>`).join("")}</tbody></table>` +
      `<small class="muted">${updated_at ? `Prices updated ${new Date(updated_at * 1000).toLocaleString()} (${esc(me.tier)} tier).` : "No prices yet today."}</small>`;
  } catch (e) { box.textContent = `${e.code ?? "error"}: ${e.message}`; }
}
$("telSave").onclick = async () => {
  try {
    const list = [...document.querySelectorAll("[data-country]")].filter((x) => x.checked).map((x) => x.dataset.country);
    await client.updateAccount({ telephony_countries: list });
    me = await client.account();
    $("telMsg").textContent = "Saved.";
  } catch (e) { $("telMsg").textContent = `${e.code}: ${e.message}`; }
};

function renderAutoRecharge() {
  const hasCard = !!me.has_saved_card;
  const cfg = me.auto_recharge ?? null;
  $("arForm").hidden = !hasCard;
  $("arOff").hidden = !cfg;
  if (!hasCard) {
    $("arStatus").textContent = "Top up once with \"Save card\" checked to enable optional auto-recharge (not a subscription; stops if a card declines).";
    return;
  }
  const errNote = me.auto_recharge_last_error ? ` Last attempt failed: ${me.auto_recharge_last_error}.` : "";
  $("arStatus").textContent = cfg
    ? `Active: tops up ${usd(cfg.amount_micros)} when available balance drops below ${usd(cfg.threshold_micros)}.`
    : `Card saved on file. Auto-recharge is off.${errNote}`;
  if (cfg) {
    $("arThreshold").value = toUsdInput(cfg.threshold_micros);
    $("arAmount").value = toUsdInput(cfg.amount_micros);
  }
}
$("arSave").onclick = async () => {
  try {
    await client.updateAccount({ auto_recharge: { threshold_usd: Number($("arThreshold").value), amount_usd: Number($("arAmount").value) } });
    me = await client.account();
    renderAutoRecharge();
    $("arMsg").textContent = "Saved.";
  } catch (e) { $("arMsg").textContent = `${e.code ?? "error"}: ${e.message}`; }
};
$("arOff").onclick = async () => {
  try {
    await client.updateAccount({ auto_recharge: null });
    me = await client.account();
    renderAutoRecharge();
    $("arMsg").textContent = "Turned off.";
  } catch (e) { $("arMsg").textContent = `${e.code ?? "error"}: ${e.message}`; }
};

let limitsDirty = false;
for (const id of ["capDaily", "capMonthly", "capAllow", "capDeny", "capOauth", "capPaused"]) {
  $(id).addEventListener("input", () => { limitsDirty = true; });
  $(id).addEventListener("change", () => { limitsDirty = true; });
}
function renderLimits(a) {
  $("capDaily").value = toUsdInput(a.daily_cap_micros);
  $("capMonthly").value = toUsdInput(a.monthly_cap_micros);
  $("capAllow").value = (a.allow_transports ?? []).join(", ");
  $("capDeny").value = (a.deny_transports ?? []).join(", ");
  $("capOauth").value = toUsdInput(a.oauth_daily_cap_micros);
  $("capPaused").checked = !!a.paused;
}

let ledgerNextAfter = 0;
function loadUsage() {
  const days = Number($("usageDays")?.value || 30);
  client.usage(days).then((u) => renderUsageChart($("usageChart"), u)).catch((e) => { $("usageChart").textContent = `${e.code ?? "error"}: ${e.message}`; });
}
$("usageDays").onchange = loadUsage;
async function loadLedgerPage(reset) {
  if (reset) { ledgerNextAfter = 0; $("ledgerRows").innerHTML = ""; }
  const { entries } = await client.ledger(ledgerNextAfter, 100);
  const rowsHtml = entries.slice().reverse().map((e) => `<tr><td>${e.seq}</td><td>${e.kind}</td><td>${usd(e.amount)}</td><td>${usd(e.available_after)}</td><td><code>${esc(e.ref)}</code></td><td>${new Date(e.time).toLocaleString()}</td></tr>`).join("");
  if (reset) $("ledgerRows").innerHTML = rowsHtml;
  else $("ledgerRows").insertAdjacentHTML("afterbegin", rowsHtml);
  ledgerNextAfter = entries.length ? entries[entries.length - 1].seq : ledgerNextAfter;
  $("ledgerMore").hidden = entries.length < 100;
}
$("ledgerMore").onclick = () => loadLedgerPage(false);

async function loadBilling() {
  limitsDirty = false;
  if (me) renderLimits(me);
  me = await client.account();
  showBalance(me);
  renderAutoRecharge();
  loadTelephonyCountries();
  loadUsage();
  if (!limitsDirty) renderLimits(me);
  loadPayments();
  const [, prices] = await Promise.all([loadLedgerPage(true), client.prices()]);
  const tier = me.tier || "standard";
  $("priceTable").innerHTML = `<p class="muted" style="margin-top:0">Current volume tier: <strong>${esc(tier)}</strong></p><table>${Object.entries(prices.skus).map(([id, s]) => `<tr><td>${esc(s.description)}</td><td>$${((s.price_nanos[tier] ?? s.price_nanos.standard) / 1e9).toPrecision(3)} / ${esc(s.unit)}</td></tr>`).join("")}</table>`;
}
async function loadPayments() {
  try {
    const { payments } = await client.payments();
    $("paymentsEmpty").hidden = payments.length > 0;
    $("paymentRows").innerHTML = payments.map((p) => {
      const status = p.disputed ? '<span class="bad">disputed</span>' : p.refunded_micros ? `refunded ${usd(p.refunded_micros)}` : p.kind === "auto_recharge" ? "auto-recharge" : "paid";
      return `<tr><td>${new Date(p.created_at).toLocaleDateString()}</td><td>${usd(p.amount_micros)}</td><td>${usd(p.fee_micros)}</td><td>${usd(p.credit_micros)}</td><td>${status}</td><td><button class="secondary" data-receipt="${esc(p.id)}">Receipt</button></td></tr>`;
    }).join("");
    document.querySelectorAll("[data-receipt]").forEach((b) => b.onclick = async () => {
      // The receipt needs the bearer token, so fetch it and open it from a blob URL.
      const win = window.open("", "_blank");
      try {
        const url = URL.createObjectURL(new Blob([await client.receipt(b.dataset.receipt)], { type: "text/html" }));
        if (win) win.location.href = url; else location.href = url;
      } catch (e) { if (win) win.close(); alert(`receipt: ${e.code ?? "error"}: ${e.message}`); }
    });
  } catch (e) { $("paymentRows").innerHTML = `<tr><td colspan="6">${esc(e.code ?? "error")}: ${esc(e.message)}</td></tr>`; }
}
$("topupBtn").onclick = async () => {
  try { location.href = (await client.checkout(Number($("topupAmt").value), { saveCard: $("topupSaveCard").checked })).url; } catch (e) { alert(`${e.code}: ${e.message}`); }
};

$("traceRecent").onchange = () => {
  const v = $("traceRecent").value;
  if (!v) return;
  const i = v.lastIndexOf("|");
  $("traceTopic").value = v.slice(0, i);
  $("traceId").value = v.slice(i + 1);
  $("traceBtn").click();
};
$("traceBtn").onclick = async () => {
  const out = $("traceOut"); out.hidden = false;
  try { out.innerHTML = renderTrace(await client.trace($("traceTopic").value.trim(), $("traceId").value.trim())); }
  catch (e) { out.innerHTML = `<p class="bad">${esc(e.code ?? "error")}: ${esc(e.message)}</p>`; }
};

// ---------- endpoints, subscriptions, Slack ----------
const when = (ms) => (ms ? new Date(ms).toLocaleString() : "");
const PLACEHOLDER = { email: "you@example.com", sms: "+15551234567", voice: "+15551234567", whatsapp: "+15551234567", webhook: "https://example.com/hook", lxmf: "32 hex characters", fcm: "FCM registration token", apns: "APNs device token (hex)" };
$("epKind").onchange = () => { $("epAddr").placeholder = PLACEHOLDER[$("epKind").value] ?? ""; };
let endpoints = [];
async function loadEndpoints() {
  const [eps, subs, teams, bindings, pcreds] = await Promise.all([
    client.listEndpoints(),
    client.listSubscriptions(),
    client.listSlackTeams().catch(() => ({ teams: [] })),
    client.listSlackBindings().catch(() => ({ bindings: [] })),
    client.listPushCredentials().catch(() => ({ credentials: [] })),
  ]);
  endpoints = eps.endpoints;
  $("epRows").innerHTML = endpoints.map((e) => `<tr><td>${esc(e.kind)}</td><td><code>${esc(e.address)}</code>${e.name ? ` <span class="muted">${esc(e.name)}</span>` : ""}${e.inbound_topic ? `<br><span class="muted">texts in → <code>${esc(e.inbound_topic)}</code></span>` : ""}</td><td>${e.verified ? '<span class="ok">verified</span>' : `<span class="row"><input data-code="${esc(e.id)}" placeholder="6-digit code" inputmode="numeric" maxlength="6" aria-label="Verification code"><button class="secondary" data-verify="${esc(e.id)}">Verify</button></span>`}</td><td>${e.verified ? `<button class="secondary" data-eptest="${esc(e.id)}">Test</button> ` : ""}${e.verified && (e.kind === "sms" || e.kind === "whatsapp") ? `<button class="secondary" data-epinbound="${esc(e.id)}">Texts in…</button> ` : ""}<button class="secondary" data-epdel="${esc(e.id)}">Delete</button></td></tr>`).join("") || `<tr><td colspan="4" class="muted">No endpoints yet. "Notify this browser" on Send / receive adds a Web Push one.</td></tr>`;
  const label = (id) => { const e = endpoints.find((x) => x.id === id); return e ? `${e.kind} ${e.address}` : id; };
  $("subEp").innerHTML = endpoints.filter((e) => e.verified).map((e) => `<option value="${esc(e.id)}">${esc(label(e.id))}</option>`).join("") || `<option value="">No verified endpoints</option>`;
  $("subRows").innerHTML = subs.subscriptions.map((s) => `<tr><td><code>${esc(s.topic)}</code>${s.paused ? ' <span class="bad">paused</span>' : ""}</td><td>${esc(label(s.endpoint_id))}</td><td>${s.after_s ? `${s.after_s}s` : "now"}</td><td>${s.min_priority ?? ""}</td><td><code>${esc([s.filter?.tags?.length ? `tags ${s.filter.tags.join(",")}` : "", s.filter?.priority?.length ? `priority ${s.filter.priority.join(",")}` : ""].filter(Boolean).join("; "))}</code></td><td><button class="secondary" data-subedit="${esc(s.id)}">Edit…</button> <button class="secondary" data-subtoggle="${esc(s.id)}" data-subpaused="${s.paused ? "1" : ""}">${s.paused ? "Resume" : "Pause"}</button> <button class="secondary" data-subdel="${esc(s.id)}">Remove</button></td></tr>`).join("") || `<tr><td colspan="6" class="muted">No endpoint subscriptions.</td></tr>`;
  $("pushCredRows").innerHTML = (pcreds.credentials ?? []).map((c) => {
    const info = c.kind === "apns" ? `${c.topic}${c.sandbox ? " (sandbox)" : ""} · ${c.team_id}/${c.key_id}` : `${c.project_id} · ${c.client_email}`;
    return `<tr><td>${esc(c.kind)}</td><td>${esc(c.name || "—")}</td><td><code>${esc(info)}</code></td><td>${c.is_default ? '<span class="ok">default</span>' : ""}</td><td><button class="secondary" data-pcdel="${esc(c.id)}">Delete</button></td></tr>`;
  }).join("") || `<tr><td colspan="5" class="muted">No BYO push credentials configured (using relay defaults if any).</td></tr>`;
  document.querySelectorAll("[data-pcdel]").forEach((b) => b.onclick = async () => {
    if (!confirm("Delete this push credential?")) return;
    await client.deletePushCredential(b.dataset.pcdel).catch((e) => alert(e.message));
    loadEndpoints();
  });
  $("slackTeam").innerHTML = teams.teams.map((t) => `<option value="${esc(t.team_id)}">${esc(t.team_name || t.team_id)}</option>`).join("") || `<option value="">Install the app first</option>`;
  if (slackTeamHint && teams.teams.some((t) => t.team_id === slackTeamHint)) $("slackTeam").value = slackTeamHint;
  $("slackBindingRows").innerHTML = (bindings.bindings ?? []).map((b) => `<tr><td>${esc(b.team_name || b.team_id)}</td><td><code>${esc(b.channel)}</code></td><td><code>${esc(b.topic)}</code></td><td><button class="secondary" data-slackunbind-team="${esc(b.team_id)}" data-slackunbind-ch="${esc(b.channel)}">Unbind</button></td></tr>`).join("") || `<tr><td colspan="4" class="muted">No bound channels.</td></tr>`;
  document.querySelectorAll("[data-slackunbind-ch]").forEach((b) => b.onclick = async () => {
    if (!confirm("Unbind this Slack channel?")) return;
    await client.deleteSlackBinding(b.dataset.slackunbindTeam, b.dataset.slackunbindCh).catch((e) => alert(e.message));
    loadEndpoints();
  });
  const h = me?.handle ? `@${me.handle}/` : "";
  $("subTopicNew").value ||= $("pubTopic").value || `${h}alerts`;
  $("slackTopic").value ||= $("subTopicNew").value;
  document.querySelectorAll("[data-verify]").forEach((b) => b.onclick = async () => {
    const id = b.dataset.verify;
    const code = document.querySelector(`[data-code="${CSS.escape(id)}"]`).value.trim();
    try { await client.verifyEndpoint(id, code); loadEndpoints(); }
    catch (e) { alert(`${e.code}: ${e.message}`); }
  });
  document.querySelectorAll("[data-epinbound]").forEach((b) => b.onclick = async () => {
    const e = endpoints.find((x) => x.id === b.dataset.epinbound);
    const topic = prompt("Topic that texts from this number publish to (one you own). Leave empty to turn texting in off.", e?.inbound_topic ?? $("subTopicNew").value);
    if (topic === null) return;
    try { await client.updateEndpoint(b.dataset.epinbound, { inbound_topic: topic.trim() || null }); loadEndpoints(); }
    catch (err) { alert(`${err.code}: ${err.message}`); }
  });
  document.querySelectorAll("[data-epdel]").forEach((b) => b.onclick = async () => {
    if (!confirm("Delete this endpoint and its subscriptions?")) return;
    await client.deleteEndpoint(b.dataset.epdel).catch((e) => alert(e.message));
    loadEndpoints();
  });
  document.querySelectorAll("[data-eptest]").forEach((b) => b.onclick = async () => {
    const out = $("insOut");
    b.disabled = true;
    out.innerHTML = '<p class="muted">Sending…</p>';
    try {
      const r = await client.testEndpoint(b.dataset.eptest, { title: $("insTitle").value, message: $("insMessage").value, priority: Number($("insPriority").value) });
      out.innerHTML = renderInspection(r);
      if (r.request) { $("sigHeader").value = r.request.headers["x-subetha-signature"] ?? ""; $("sigBody").value = r.request.body; }
      client.account().then((a) => { me = a; showBalance(a); }).catch(() => {});
    } catch (e) { out.innerHTML = `<p class="bad">${esc(e.code)}: ${esc(e.message)}</p>`; }
    finally { b.disabled = false; $("inspector").scrollIntoView({ block: "nearest" }); }
  });
  document.querySelectorAll("[data-subedit]").forEach((b) => b.onclick = async () => {
    const s = subs.subscriptions.find((x) => x.id === b.dataset.subedit);
    if (!s) return;
    const afterRaw = prompt("Escalate after seconds (0..3600):", String(s.after_s ?? 0));
    if (afterRaw === null) return;
    const prioRaw = prompt("Minimum priority (1..5, blank = none):", s.min_priority == null ? "" : String(s.min_priority));
    if (prioRaw === null) return;
    const tagsRaw = prompt("Required tags (comma-separated, blank = any):", (s.filter?.tags ?? []).join(","));
    if (tagsRaw === null) return;
    const tags = tagsRaw.split(",").map((x) => x.trim()).filter(Boolean);
    const filter = { ...(s.filter?.priority?.length ? { priority: s.filter.priority } : {}), ...(tags.length ? { tags } : {}) };
    try {
      await client.updateSubscription(s.id, {
        after_s: Number(afterRaw) || 0,
        min_priority: prioRaw.trim() === "" ? null : Number(prioRaw),
        filter,
      });
      loadEndpoints();
    } catch (e) { alert(`${e.code ?? "error"}: ${e.message}`); }
  });
  document.querySelectorAll("[data-subtoggle]").forEach((b) => b.onclick = async () => {
    try { await client.updateSubscription(b.dataset.subtoggle, { paused: !b.dataset.subpaused }); loadEndpoints(); }
    catch (e) { alert(`${e.code ?? "error"}: ${e.message}`); }
  });
  document.querySelectorAll("[data-subdel]").forEach((b) => b.onclick = async () => {
    await client.deleteSubscription(b.dataset.subdel).catch((e) => alert(e.message));
    loadEndpoints();
  });
}
$("pcKind").onchange = () => {
  const apns = $("pcKind").value === "apns";
  $("pcApnsFields").hidden = !apns;
  $("pcFcmFields").hidden = apns;
};
$("pcAdd").onclick = async () => {
  const say = (t) => { $("pcMsg").textContent = t; };
  try {
    const kind = $("pcKind").value;
    const body = kind === "apns"
      ? { kind, name: $("pcName").value.trim(), is_default: $("pcDefault").checked, key_id: $("pcKeyId").value.trim(), team_id: $("pcTeamId").value.trim(), topic: $("pcTopic").value.trim(), key_p8: $("pcKeyP8").value.trim(), sandbox: $("pcSandbox").checked }
      : { kind, name: $("pcName").value.trim(), is_default: $("pcDefault").checked, service_account: $("pcServiceAccount").value.trim() };
    await client.createPushCredential(body);
    $("pcKeyP8").value = "";
    $("pcServiceAccount").value = "";
    say("Saved.");
    loadEndpoints();
  } catch (e) { say(`${e.code ?? "error"}: ${e.message}`); }
};
$("sigCheck").onclick = async () => {
  const r = await verifyWebhookSignature($("sigSecret").value.trim(), $("sigHeader").value.trim(), $("sigBody").value, { toleranceS: null });
  $("sigOut").innerHTML = `<span class="${r.valid ? "ok" : "bad"}">${esc(r.reason)}</span>${r.age_s !== undefined ? ` <span class="muted">(signed ${esc(r.age_s)}s ago)</span>` : ""}`;
};
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
function renderThisBrowser(devices) {
  syncBrowserDeviceControls();
  const mine = browserDeviceKey ? devices.find((d) => d.id === browserDeviceKey.deviceId && !d.revoked_at) : null;
  if (mine) {
    $("thisDevStatus").innerHTML = `<span class="ok">Enrolled</span> as <b>${esc(mine.name || "This browser")}</b> (<code>${esc(mine.id)}</code>) · capabilities: <code>${esc((mine.capabilities ?? []).join(", "))}</code>`;
    $("thisDevSetup").hidden = true;
    $("thisDevActions").hidden = false;
  } else {
    $("thisDevStatus").textContent = browserDeviceKey
      ? "This browser has a local key, but it isn't active on this account (it may have been revoked)."
      : `Not enrolled yet. Detected capabilities: ${browserCapabilities().join(", ")}.`;
    $("thisDevSetup").hidden = false;
    $("thisDevActions").hidden = true;
  }
}
async function loadWrappedKeysForBrowser(say) {
  if (!browserDeviceKey) return say("Enroll this browser as a device first.");
  try {
    const devClient = new SubEtha({ baseUrl: location.origin, deviceKey: browserDeviceKey, signRequests: true });
    const loaded = await devClient.loadTopicKeys();
    const topics = Object.keys(loaded);
    for (const [t, k] of Object.entries(loaded)) {
      useKey(t, { kid: k.kid, key: SubEtha.protocol.base64urlEncode(k.key) });
    }
    say(topics.length ? `Loaded ${topics.length} topic key${topics.length > 1 ? "s" : ""}: ${topics.join(", ")}.` : "No wrapped keys are addressed to this browser.");
  } catch (e) { say(`${e.code ?? "error"}: ${e.message}`); }
}
// ---------- devicebasedauth.org ----------
const BROWSER_DBA = "subetha.browserDbaDevice";
const DBA_SDK_VERSION = "v1.4.0";
let dbaLinkState = null;
async function loadDbaLink() {
  try { dbaLinkState = await client.dbaLink(); } catch (e) { $("dbaStatus").textContent = `${e.code ?? "error"}: ${e.message}`; return null; }
  $("dbaStatus").textContent = dbaLinkState.linked
    ? `Linked to devicebasedauth.org account ${dbaLinkState.dba_account} since ${when(dbaLinkState.linked_at)}.`
    : "Not linked yet. Devices enrolled at devicebasedauth.org can't use this account until you link it.";
  $("dbaLink").textContent = dbaLinkState.linked ? "Link another devicebasedauth.org account" : "Link devicebasedauth.org";
  $("dbaUnlink").hidden = !dbaLinkState.linked;
  return dbaLinkState;
}
async function finishDbaLink(code, state, error) {
  const say = (t) => { $("dbaMsg").textContent = t; };
  try {
    if (!client) client = await makeClient();
    const r = error ? await client.request("POST", "/v1/dba/link/finish", { state, error }) : await client.finishDbaLink(code ?? "", state ?? "");
    say(`Linked devicebasedauth.org account ${r.dba_account}.`);
  } catch (e) { say(`${e.code ?? "error"}: ${e.message}`); }
  loadDevices();
}
$("dbaLink").onclick = async () => {
  try { location.assign((await client.startDbaLink()).url); } catch (e) { $("dbaMsg").textContent = `${e.code ?? "error"}: ${e.message}`; }
};
$("dbaUnlink").onclick = async () => {
  if (!confirm("Unlink devicebasedauth.org? Its devices stop working here until you link it again.")) return;
  try { await client.unlinkDba(); $("dbaMsg").textContent = "Unlinked."; } catch (e) { $("dbaMsg").textContent = `${e.code ?? "error"}: ${e.message}`; }
  loadDevices();
};
/** This browser's devicebasedauth.org device (the DBA browser SDK, loaded from the issuer). */
async function browserDba() {
  const link = dbaLinkState ?? (await loadDbaLink());
  if (!link?.linked) throw { code: "not_linked", message: "Link devicebasedauth.org first (above)." };
  const { DBA } = await import(`${link.issuer}/sdk/${DBA_SDK_VERSION}/dba.js`);
  const dba = new DBA({ origin: link.issuer, name: "subetha" });
  await dba.ready();
  return { dba, link };
}

$("thisDevEnroll").onclick = async () => {
  const say = (t) => { $("thisDevMsg").textContent = t; };
  try {
    const name = $("thisDevName").value.trim() || "This browser";
    const { dba, link } = await browserDba();
    if (!dba.credential || dba.expiresIn() <= 0) {
      say("Approve this browser in the devicebasedauth.org window…");
      await dba.enroll({ aud: [link.audience], grants: [{ actions: ["subetha:publish", "subetha:subscribe"] }], device: { name } });
    }
    const key = await SubEtha.protocol.generateDeviceKey();
    const r = await new SubEtha({ baseUrl: location.origin, dba }).attachDeviceKey(key, { name, capabilities: browserCapabilities() });
    store(BROWSER_SEED, SubEtha.protocol.base64urlEncode(key.seed));
    store(BROWSER_DBA, r.dba_device);
    client = await makeClient();
    say(`Enrolled ${key.deviceId}.`);
    loadDevices();
  } catch (e) { say(`${e.code ?? "error"}: ${e.message}`); }
};
$("thisDevLoadKeys").onclick = () => loadWrappedKeysForBrowser((t) => { $("thisDevMsg").textContent = t; });
$("keyLoadBrowser").onclick = () => loadWrappedKeysForBrowser((t) => { $("keyMsg").textContent = t; });
$("thisDevRevoke").onclick = async () => {
  if (!browserDeviceKey) return;
  if (!confirm("Revoke and forget this browser's device key?")) return;
  const id = browserDeviceKey.deviceId;
  await client.request("DELETE", `/v1/devices/${encodeURIComponent(id)}`).catch(() => {});
  const dbaId = load(BROWSER_DBA);
  if (dbaId) await client.request("DELETE", `/v1/devices/${encodeURIComponent(dbaId)}`).catch(() => {});
  // Revoke the browser's devicebasedauth.org credential too (free), then forget its key.
  await browserDba().then(({ dba }) => dba.revoke()).catch(() => {});
  store(BROWSER_SEED, null);
  store(BROWSER_DBA, null);
  client = await makeClient();
  $("thisDevMsg").textContent = "Revoked and forgotten.";
  loadDevices();
};

async function loadDevices() {
  loadDbaLink();
  const { devices } = await client.listDevices();
  renderThisBrowser(devices);
  const devPolicy = (d) => [
    d.allow_transports?.length ? `allow: ${d.allow_transports.join(",")}` : "",
    d.deny_transports?.length ? `deny: ${d.deny_transports.join(",")}` : "",
  ].filter(Boolean).join(" · ");
  const devStatus = (d) => d.revoked_at ? '<span class="bad">revoked</span>' : d.paused ? '<span class="bad">paused</span>' : '<span class="ok">active</span>';
  $("devRows").innerHTML = devices.map((d) => {
    const pol = devPolicy(d);
    const actions = d.revoked_at ? "" : `<button class="secondary" data-devedit="${esc(d.id)}">Edit…</button> <button class="secondary" data-devpause="${esc(d.id)}" data-paused="${d.paused ? "1" : "0"}">${d.paused ? "Resume" : "Pause"}</button> <button class="secondary" data-devtr="${esc(d.id)}">Transports…</button> <button class="secondary" data-devrevoke="${esc(d.id)}">Revoke</button>`;
    return `<tr><td>${esc(d.name || "")}${browserDeviceKey?.deviceId === d.id && !d.revoked_at ? ' <span class="muted">(this browser)</span>' : ""}${pol ? `<br><small class="muted">${esc(pol)}</small>` : ""}</td><td><code title="${esc(d.id)}">${esc(d.id.slice(0, 14))}…</code></td><td>${esc((d.capabilities ?? []).join(", "))}</td><td>${esc(when(d.last_seen_at))}</td><td>${devStatus(d)}</td><td>${actions}</td></tr>`;
  }).join("") || `<tr><td colspan="6" class="muted">No devices yet.</td></tr>`;
  document.querySelectorAll("[data-devedit]").forEach((b) => b.onclick = async () => {
    const d = devices.find((x) => x.id === b.dataset.devedit);
    if (!d) return;
    const name = prompt("Device name:", d.name || "");
    if (name === null) return;
    const caps = prompt("Device capabilities (comma-separated, e.g. ws,webpush,ble,audio,qr,lan):", (d.capabilities ?? []).join(","));
    if (caps === null) return;
    await client.updateDevice(d.id, { name: name.trim(), capabilities: caps.split(",").map((s) => s.trim()).filter(Boolean) }).catch((e) => alert(`${e.code}: ${e.message}`));
    loadDevices();
  });
  document.querySelectorAll("[data-devpause]").forEach((b) => b.onclick = async () => {
    const paused = b.dataset.paused !== "1";
    await client.updateDevice(b.dataset.devpause, { paused }).catch((e) => alert(`${e.code}: ${e.message}`));
    loadDevices();
  });
  document.querySelectorAll("[data-devtr]").forEach((b) => b.onclick = async () => {
    const d = devices.find((x) => x.id === b.dataset.devtr);
    const deny = prompt("Deny transports for this device (comma-separated, blank = none):", (d?.deny_transports ?? []).join(","));
    if (deny === null) return;
    const allow = prompt("Allow transports for this device (comma-separated, blank = all):", (d?.allow_transports ?? []).join(","));
    if (allow === null) return;
    await client.updateDevice(b.dataset.devtr, { deny_transports: listOrNull(deny), allow_transports: listOrNull(allow) }).catch((e) => alert(`${e.code}: ${e.message}`));
    loadDevices();
  });
  document.querySelectorAll("[data-devrevoke]").forEach((b) => b.onclick = async () => {
    if (!confirm("Revoke this device? It can no longer sign requests.")) return;
    await client.revokeDevice(b.dataset.devrevoke).catch((e) => alert(e.message));
    loadDevices();
  });
}
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
    const types = op.body.types ?? [{ type: op.body.type, example: op.body.example, binary: !!op.body.binary }];
    const sel = $("exBodyTypes");
    sel.hidden = types.length <= 1;
    sel.innerHTML = types.map((t) => `<option value="${esc(t.type)}">${esc(t.type)}</option>`).join("");
    sel.value = types[0].type;
    const applyMedia = () => {
      const m = types.find((t) => t.type === sel.value) ?? types[0];
      $("exBodyType").textContent = types.length <= 1 ? m.type : "";
      $("exFileWrap").hidden = !m.binary;
      $("exFile").value = "";
      $("exBody").hidden = !!m.binary;
      const text = typeof m.example === "string" ? m.example : m.example == null ? "" : JSON.stringify(m.example, null, 2);
      $("exBody").value = me?.handle ? text.replaceAll("@alice/", `@${me.handle}/`) : text;
    };
    sel.onchange = applyMedia;
    applyMedia();
  }
}
function exRequest() {
  const op = currentOp();
  const contentType = op.body ? ($("exBodyTypes").value || op.body.type) : undefined;
  const file = op.body && !$("exFileWrap").hidden ? $("exFile").files?.[0] ?? null : null;
  const values = { path: {}, query: {}, header: {}, contentType, file, body: op.body && !file ? $("exBody").value : undefined };
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
