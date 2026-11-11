// Fraud Shield: orders on hold, phone check, and the block list.
const router = require("express").Router();
const { Order, Blacklist } = require("../models");
const { handle, fail } = require("../lib/errors");
const { normalizePhone, isValidPhone } = require("../lib/utils");
const { scoreOrder } = require("../services/fraud");

router.get("/on-hold", handle(async (req, res) => {
  res.json(await Order.find({ organizationId: req.org, status: "on_hold" }).sort({ createdAt: -1 }).lean());
}));

// Check a phone number before you confirm a phone/manual order
router.get("/check", handle(async (req, res) => {
  const phone = normalizePhone(req.query.phone);
  if (!isValidPhone(phone)) throw fail(400, "Write a valid phone number");
  const [risk, history] = await Promise.all([
    scoreOrder(req.org, { phone, address: req.query.address, customerName: "x" }),
    Order.aggregate([{ $match: { organizationId: req.org, phone } }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
  ]);
  res.json({ phone, ...risk, history: Object.fromEntries(history.map((h) => [h._id, h.n])) });
}));

router.get("/blocked", handle(async (req, res) => {
  res.json(await Blacklist.find({ organizationId: req.org }).sort({ createdAt: -1 }).lean());
}));

router.post("/blocked", handle(async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  if (!isValidPhone(phone)) throw fail(400, "Write a valid phone number");
  const reason = String(req.body.reason || "").trim();
  if (!reason) throw fail(400, "Write why you are blocking this number");
  await Blacklist.updateOne({ organizationId: req.org, phone }, { $set: { reason } }, { upsert: true });
  res.json({ ok: true });
}));

router.delete("/blocked/:id", handle(async (req, res) => {
  await Blacklist.deleteOne({ _id: req.params.id, organizationId: req.org });
  res.json({ ok: true });
}));

module.exports = router;
