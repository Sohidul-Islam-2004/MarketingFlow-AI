// Turning phone / computer alerts on and off (public/js/alerts.js + public/sw.js)
const router = require("express").Router();
const { PushSubscription } = require("../models");
const { handle, fail } = require("../lib/errors");
const push = require("../services/push");

router.get("/", handle(async (req, res) => {
  if (!push.pushReady()) return res.json({ ready: false });
  const { publicKey } = await push.keys();
  res.json({ ready: true, publicKey, devices: await PushSubscription.countDocuments({ organizationId: req.org }) });
}));

router.post("/subscribe", handle(async (req, res) => {
  const s = req.body.subscription || {};
  if (!/^https:\/\//.test(s.endpoint || "") || !s.keys?.p256dh || !s.keys?.auth) throw fail(400, "This browser sent a broken alert subscription");
  await PushSubscription.findOneAndUpdate(
    { endpoint: s.endpoint },
    { organizationId: req.org, userId: req.user._id, endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth }, device: String(req.body.device || "").slice(0, 60) },
    { upsert: true, new: true }
  );
  res.json({ ok: true });
}));

router.post("/unsubscribe", handle(async (req, res) => {
  await PushSubscription.deleteOne({ organizationId: req.org, endpoint: String(req.body.endpoint || "") });
  res.json({ ok: true });
}));

router.post("/test", handle(async (req, res) => {
  const sub = await PushSubscription.findOne({ organizationId: req.org, endpoint: String(req.body.endpoint || "") }).lean();
  if (!sub) throw fail(404, "Alerts are not on for this device");
  await push.keys();
  if (!(await push.send(sub, { title: "Alerts are working ✅", body: "You will get an alert for new orders and chats that need you.", url: "/#overview" }))) throw fail(400, "The alert could not be sent. Turn alerts off and on again.");
  res.json({ ok: true });
}));

module.exports = router;
