// SubEtha Web Push service worker. Register it, then subscribe with subscribeWebPush() from the
// SDK and POST /v1/endpoints {"kind": "webpush", "address": <subscription JSON>}.
// The push payload is the (possibly trimmed) SubEtha envelope JSON.
/* eslint-env serviceworker */

const EMOJI = {
  warning: "⚠️", rotating_light: "🚨", fire: "🔥", bell: "🔔", white_check_mark: "✅", heavy_check_mark: "✔️",
  x: "❌", tada: "🎉", rocket: "🚀", skull: "💀", door: "🚪", lock: "🔒", unlock: "🔓", package: "📦",
  computer: "💻", zap: "⚡", info: "ℹ️", "+1": "👍", "-1": "👎", loudspeaker: "📢", calendar: "📅",
};

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let m = {};
  try {
    m = event.data ? event.data.json() : {};
  } catch {
    m = { message: event.data ? event.data.text() : "" };
  }
  const priority = Number(m.priority ?? 3);
  const tags = Array.isArray(m.tags) ? m.tags : [];
  const emoji = tags.filter((t) => EMOJI[t]).map((t) => EMOJI[t]).join("");
  const other = tags.filter((t) => !EMOJI[t]);
  const title = [emoji, m.title || m.topic || "SubEtha"].filter(Boolean).join(" ");
  let body = m.enc ? "Encrypted message — open SubEtha to read it" : (m.message ?? "");
  if (m.truncated && !m.enc) body += " …";
  if (other.length) body += `${body ? "\n" : ""}Tags: ${other.join(", ")}`;
  const options = {
    body,
    tag: m.id || undefined,
    icon: m.icon || undefined,
    timestamp: m.time ? m.time * 1000 : Date.now(),
    requireInteraction: priority >= 5,
    silent: priority <= 1,
    vibrate: priority >= 5 ? [300, 100, 300, 100, 300] : priority === 4 ? [200, 100, 200] : undefined,
    data: { click: m.click || null, topic: m.topic || null, id: m.id || null },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  const url = d.click || self.registration.scope;
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) {
      if (c.url === url && "focus" in c) return c.focus();
    }
    return self.clients.openWindow(url);
  })());
});
