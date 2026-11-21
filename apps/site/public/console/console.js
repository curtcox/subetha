// The console is an ordinary SDK client (PLAN §11).
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
}

$("tokenBtn").onclick = () => { store("subetha.token", $("tokenInput").value.trim()); refresh(); };
$("signout").onclick = async () => { store("subetha.token", null); if (clerk) await clerk.signOut(); location.reload(); };
$("createBtn").onclick = async () => {
  await client.request("POST", "/v1/account", { handle: $("handleInput").value.trim() || undefined }).catch((e) => alert(e.message));
  refresh();
};

document.querySelectorAll("#tabs button").forEach((b) => b.onclick = () => {
  document.querySelectorAll("#tabs button").forEach((x) => x.classList.toggle("active", x === b));
  document.querySelectorAll("[data-panel]").forEach((p) => p.hidden = p.dataset.panel !== b.dataset.tab);
  ({ topics: loadTopics, tokens: loadTokens, billing: loadBilling })[b.dataset.tab]?.();
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

$("curlBtn").onclick = async () => {
  const o = pubOpts();
  const parts = [`curl`, `-H "Authorization: Bearer $SUBETHA_TOKEN"`];
  if (o.title) parts.push(`-H "X-Title: ${o.title}"`);
  if (o.priority !== 3) parts.push(`-H "X-Priority: ${o.priority}"`);
  if (o.tags.length) parts.push(`-H "X-Tags: ${o.tags.join(",")}"`);
  if (o.route.mode !== "any") parts.push(`-H "X-Route-Mode: ${o.route.mode}"`);
  parts.push(`-d '${($("pubMsg").value || "triggered").replace(/'/g, "'\\''")}'`, `${location.origin}/${$("pubTopic").value.trim()}`);
  await navigator.clipboard?.writeText(parts.join(" \\\n  "));
  $("pubOut").hidden = false; $("pubOut").textContent = parts.join(" \\\n  ");
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

init().catch((e) => { console.error(e); });
