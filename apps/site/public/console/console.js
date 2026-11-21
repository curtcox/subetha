// The console is an ordinary SDK client (PLAN §11).
import { LANGUAGES, LANGUAGE_NAMES, snippet } from "./snippets.js";
import { buildRequest, operations, toCurl } from "./explorer.js";

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
  $("bal").textContent = usd(me.balance_usd_micros);
  const h = me.handle ? `@${me.handle}/` : "";
  $("pubTopic").value ||= `${h}test`;
  $("subTopic").value ||= `${h}test`;
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get("topic")) { $("subTopic").value = hash.get("topic"); subscribe(); }
  if (hash.get("tab")) showTab(hash.get("tab"));
}

$("tokenBtn").onclick = () => { store("subetha.token", $("tokenInput").value.trim()); refresh(); };
$("signout").onclick = async () => { store("subetha.token", null); if (clerk) await clerk.signOut(); location.reload(); };
$("createBtn").onclick = async () => {
  await client.request("POST", "/v1/account", { handle: $("handleInput").value.trim() || undefined }).catch((e) => alert(e.message));
  refresh();
};

function showTab(name) {
  const b = document.querySelector(`#tabs button[data-tab="${name}"]`);
  if (!b) return;
  document.querySelectorAll("#tabs button").forEach((x) => x.classList.toggle("active", x === b));
  document.querySelectorAll("[data-panel]").forEach((p) => p.hidden = p.dataset.panel !== name);
  ({ topics: loadTopics, tokens: loadTokens, billing: loadBilling, explorer: loadExplorer })[name]?.();
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
    me = await client.account(); $("bal").textContent = usd(me.balance_usd_micros);
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

async function loadBilling() {
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
    if (r.ok && me) client.account().then((a) => { me = a; $("bal").textContent = usd(a.balance_usd_micros); }).catch(() => {});
  } catch (e) {
    $("exStatus").textContent = e.name === "AbortError" ? `Stopped after ${Math.round((performance.now() - t0) / 1000)} s` : `Failed: ${e.message}`;
  } finally { clearTimeout(timer); }
};

init().catch((e) => { console.error(e); });
