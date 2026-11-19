// Alerts on this phone / computer: new orders and chats that need you, even when MarketingFlow is closed.
// The browser asks once for permission; the server sends the alerts (src/services/push.js, public/sw.js).
import { get, post } from "./api.js";
import { toast } from "./ui.js";

const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const isIPhone = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
const deviceName = () => {
  const ua = navigator.userAgent;
  const os = /android/i.test(ua) ? "Android" : isIPhone() ? "iPhone" : /windows/i.test(ua) ? "Windows" : /mac/i.test(ua) ? "Mac" : "Linux";
  return `${os} ${matchMedia("(max-width: 800px)").matches ? "phone" : "computer"}`;
};

// Starts the service worker (also makes "Add to Home screen" work like an app) and opens pages from tapped alerts
export function startAlerts() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").catch(() => {});
  navigator.serviceWorker.addEventListener("message", (e) => { if (e.data?.open) location.hash = new URL(e.data.open).hash.slice(1); });
}

const subscription = async () => (await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription()) || null;

// "on" | "off" | "blocked" | "iphone" (add to Home Screen first) | "unsupported"
export async function alertsState() {
  if (!supported()) return isIPhone() ? "iphone" : "unsupported";
  if (Notification.permission === "denied") return "blocked";
  return Notification.permission === "granted" && (await subscription()) ? "on" : "off";
}

async function turnOn() {
  const info = await get("/api/push");
  if (!info.ready) throw new Error("Alerts are not ready on the server yet (run npm install, then restart)");
  if ((await Notification.requestPermission()) !== "granted") throw new Error("Alerts were not allowed. Allow notifications for this site in the browser settings.");
  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const key = Uint8Array.from(atob(info.publicKey.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((info.publicKey.length + 3) % 4)), (c) => c.charCodeAt(0));
  const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
  await post("/api/push/subscribe", { subscription: sub.toJSON(), device: deviceName() });
}

async function turnOff() {
  const sub = await subscription();
  if (!sub) return;
  await post("/api/push/unsubscribe", { endpoint: sub.endpoint });
  await sub.unsubscribe();
}

// A small box with the right button for this device. Used in the notifications pop-up and on the phone's More page.
export async function drawAlertsBox(box) {
  const state = await alertsState();
  const text = {
    off: ["🔔 Get an alert on this device", "When an order comes in or a chat needs you, even when MarketingFlow is closed.", `<button type="button" class="btn sm" data-alerts="on">Turn on alerts</button>`],
    on: ["✅ Alerts are on for this device", "New orders and chats that need you.", `<button type="button" class="btn sm light" data-alerts="test">Send a test</button><button type="button" class="btn sm light" data-alerts="off">Turn off</button>`],
    blocked: ["🔕 Alerts are blocked", "Allow notifications for this site in the browser settings, then come back here.", ""],
    iphone: ["🔔 Alerts on iPhone", "Tap Share → Add to Home Screen, open MarketingFlow from there, then turn on alerts.", ""],
  }[state];
  if (!text) { box.hidden = true; return; }
  box.innerHTML = `<b>${text[0]}</b><p class="small muted">${text[1]}</p>${text[2] ? `<div class="row mt">${text[2]}</div>` : ""}`;
  box.querySelectorAll("[data-alerts]").forEach((b) => (b.onclick = async () => {
    b.classList.add("busy");
    try {
      if (b.dataset.alerts === "on") { await turnOn(); toast("Alerts are on ✅"); }
      if (b.dataset.alerts === "off") { await turnOff(); toast("Alerts are off for this device"); }
      if (b.dataset.alerts === "test") { await post("/api/push/test", { endpoint: (await subscription())?.endpoint }); toast("Test alert sent"); }
    } catch (e) { toast(e.message, true); }
    await drawAlertsBox(box);
  }));
}
