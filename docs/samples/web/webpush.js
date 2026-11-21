// Register this browser for Web Push and subscribe it to a topic.
// Needs a service worker (samples/web/sw.js) and an admin token (do this from your console page,
// not a public site). Delivery uses the relay's VAPID key from GET /v1/config.
export async function enableWebPush({ baseUrl = "https://subetha.org", token, topic }) {
  const api = (path, body) =>
    fetch(`${baseUrl}${path}`, {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body && JSON.stringify(body),
    }).then(async (r) => (r.ok ? r.json() : Promise.reject(await r.json())));

  const { vapid_public_key: vapidKey } = await api("/v1/config");
  if (!vapidKey) throw new Error("Web Push is not configured on this relay");
  if ((await Notification.requestPermission()) !== "granted") throw new Error("notifications blocked");

  const reg = await navigator.serviceWorker.register("/sw.js");
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidKey });

  const ep = await api("/v1/endpoints", { kind: "webpush", address: JSON.stringify(sub.toJSON()), name: navigator.userAgent.slice(0, 60) });
  await api("/v1/subscriptions", { topic, endpoint_id: ep.id });
  return ep.id;
}
