// Service worker for SubEtha Web Push: show the message, open its click URL, and ack it.
/* eslint-env serviceworker */
self.addEventListener("push", (event) => {
  const m = event.data ? event.data.json() : {};
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(m.title || m.topic || "SubEtha", {
        body: m.enc ? "Encrypted message: open the app to read it" : m.message,
        tag: m.id,
        data: m,
      }),
      // Acknowledge, so escalation (SMS, voice…) stops.
      m.id && fetch("https://subetha.org/v1/ack", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topic: m.topic, id: m.id, via: "webpush" }),
      }),
    ]),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data && event.notification.data.click;
  if (url) event.waitUntil(self.clients.openWindow(url));
});
