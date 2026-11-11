// Overview page numbers + bell notifications
const router = require("express").Router();
const { Notification } = require("../models");
const { handle } = require("../lib/errors");
const metrics = require("../services/metrics");

router.get("/overview", handle(async (req, res) => {
  res.json(await metrics.overview(req.org, req.query.period));
}));

router.get("/notifications", handle(async (req, res) => {
  const [rows, unread] = await Promise.all([
    Notification.find({ organizationId: req.org }).sort({ createdAt: -1 }).limit(30).lean(),
    Notification.countDocuments({ organizationId: req.org, read: false }),
  ]);
  res.json({ rows, unread });
}));

router.post("/notifications/read", handle(async (req, res) => {
  await Notification.updateMany({ organizationId: req.org, read: false }, { read: true });
  res.json({ ok: true });
}));

module.exports = router;
