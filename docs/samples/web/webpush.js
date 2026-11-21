// Register this browser for Web Push and subscribe it to topics, from a page that loads
// https://subetha.org/sdk.js and serves the service worker at /sw.js (copy apps/site/public/sw.js).
// Run it from a click handler so the browser can ask for notification permission. Use a token
// that can manage endpoints (your own console session, not a public page).
async function enableWebPush({ baseUrl = "https://subetha.org", token, topics }) {
  const api = async (path, body) => {
    const r = await fetch(`${baseUrl}${path}`, {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body && JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${path}: ${(await r.json()).message}`);
    return r.json();
  };

  const { vapid_public_key: vapidKey } = await api("/v1/config");
  if (!vapidKey) throw new Error("Web Push isn't configured on this relay");

  const registration = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const address = await SubEtha.subscribeWebPush(registration, vapidKey); // or import { subscribeWebPush } from "@subetha/sdk"

  const endpoint = await api("/v1/endpoints", { kind: "webpush", address, name: navigator.userAgent.slice(0, 60) });
  for (const topic of topics) await api("/v1/subscriptions", { topic, endpoint_id: endpoint.id });
  return endpoint.id;
}

document.querySelector("#enable-push")?.addEventListener("click", () =>
  enableWebPush({ token: localStorage.getItem("subetha_token"), topics: ["@me/doorbell"] }).then(
    (id) => console.log("push endpoint", id),
    (e) => alert(e.message),
  ),
);
