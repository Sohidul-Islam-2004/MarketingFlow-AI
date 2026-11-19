// Service worker: shows alerts (new orders, chats that need you) even when MarketingFlow is closed.
// It does not keep any files offline, so updates always show up straight away.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "MarketingFlow", {
    body: d.body || "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { url: d.url || "/" },
  }));
});

// Tapping the alert opens MarketingFlow on the right page (or brings the open tab to the front)
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "/", self.location.origin).href;
  e.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const tab = tabs.find((t) => t.url.startsWith(self.location.origin));
    if (tab) { tab.postMessage({ open: url }); return tab.focus(); }
    return self.clients.openWindow(url);
  })());
});
