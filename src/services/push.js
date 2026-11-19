// Alerts on the shop's phones and computers (Web Push), even when MarketingFlow is closed.
// Every bell notification (lib/notify.js) is also sent to the devices that turned alerts on.
// The keys are made once and kept in the database (or set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY in .env).
const { PushSubscription, Setting } = require("../models");
const { encrypt, decrypt } = require("../lib/crypto");
const { LEGAL } = require("../config");

let webpush = null;
try { webpush = require("web-push"); } catch { console.warn("⚠️  web-push is not installed (npm install): phone alerts are off"); }

const pushReady = () => !!webpush;

let loading = null;
function keys() {
  loading ||= (async () => {
    let k;
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) k = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
    else {
      const saved = await Setting.findById("vapid").lean();
      if (saved?.value?.publicKey) k = { publicKey: saved.value.publicKey, privateKey: decrypt(saved.value.privateKey) };
      else {
        k = webpush.generateVAPIDKeys();
        await Setting.create({ _id: "vapid", value: { publicKey: k.publicKey, privateKey: encrypt(k.privateKey) } });
      }
    }
    webpush.setVapidDetails(`mailto:${LEGAL.SUPPORT_EMAIL}`, k.publicKey, k.privateKey);
    return k;
  })().catch((e) => { loading = null; throw e; });
  return loading;
}

// payload = { title, body, url } (url opens when the alert is tapped, e.g. "/#orders")
async function send(sub, payload) {
  try {
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(payload), { TTL: 6 * 3600, urgency: "high" });
    return true;
  } catch (e) {
    if ([404, 410].includes(e.statusCode)) await PushSubscription.deleteOne({ _id: sub._id }); // the device turned alerts off
    else console.warn("push:", e.statusCode || "", e.body || e.message);
    return false;
  }
}

async function pushToShop(org, payload) {
  if (!webpush) return 0;
  const subs = await PushSubscription.find({ organizationId: org }).lean();
  if (!subs.length) return 0;
  await keys();
  const results = await Promise.all(subs.map((s) => send(s, payload)));
  return results.filter(Boolean).length;
}

module.exports = { pushReady, keys, send, pushToShop };
