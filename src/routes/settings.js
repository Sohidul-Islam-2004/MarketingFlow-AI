// Workspace settings: business profile, AI agent, comments, delivery zones, Fraud Shield.
const router = require("express").Router();
const { Organization } = require("../models");
const { handle, fail } = require("../lib/errors");
const { toList } = require("../lib/utils");
const { DEFAULT_ZONES, DISTRICT_NAMES, canonicalDistrict, findZone } = require("../lib/places");
const { aiReady } = require("../lib/ai");

router.get("/", handle(async (req, res) => {
  const o = await Organization.findById(req.org).lean();
  res.json({
    profile: { name: o.name, phone: o.phone, logoUrl: o.logoUrl, returnPolicy: o.returnPolicy, orderPrefix: o.orderPrefix },
    ai: { ...o.ai, ready: aiReady() },
    comments: { autoReply: true, sendDm: true, delaySec: 30, needApproval: false, hideSpam: false, blockedWords: [], ...(o.comments || {}) },
    fraud: { holdAtScore: 60, refuseBlocked: false, ...(o.fraud || {}) },
    zones: o.zones?.length ? o.zones : DEFAULT_ZONES,
    usingDefaultZones: !o.zones?.length,
    districts: DISTRICT_NAMES,
  });
}));

router.put("/profile", handle(async (req, res) => {
  const b = req.body;
  if (!String(b.name || "").trim()) throw fail(400, "Business name can't be empty");
  await Organization.updateOne({ _id: req.org }, {
    name: String(b.name).trim(), phone: String(b.phone || ""), logoUrl: String(b.logoUrl || ""), returnPolicy: String(b.returnPolicy || ""),
    orderPrefix: String(b.orderPrefix || "ORD-").replace(/[^A-Za-z0-9-]/g, "").slice(0, 10) || "ORD-",
  });
  res.json({ ok: true });
}));

router.put("/ai", handle(async (req, res) => {
  const b = req.body;
  await Organization.updateOne({ _id: req.org }, {
    ai: {
      enabled: !!b.enabled, autoConfirm: !!b.autoConfirm, tone: String(b.tone || "friendly"),
      handoffBelow: Math.max(0, Math.min(100, Number(b.handoffBelow) || 0)),
      knowledge: String(b.knowledge || "").slice(0, 20000), deliveryTime: String(b.deliveryTime || ""), handoffMessage: String(b.handoffMessage || ""),
    },
  });
  res.json({ ok: true });
}));

router.put("/comments", handle(async (req, res) => {
  const b = req.body;
  await Organization.updateOne({ _id: req.org }, {
    comments: { autoReply: !!b.autoReply, sendDm: !!b.sendDm, needApproval: !!b.needApproval, hideSpam: !!b.hideSpam, delaySec: Math.max(0, Math.min(600, Number(b.delaySec) || 0)), blockedWords: toList(b.blockedWords) },
  });
  res.json({ ok: true });
}));

router.put("/fraud", handle(async (req, res) => {
  await Organization.updateOne({ _id: req.org }, { fraud: { holdAtScore: Math.max(20, Math.min(100, Number(req.body.holdAtScore) || 60)), refuseBlocked: !!req.body.refuseBlocked } });
  res.json({ ok: true });
}));

// zones: [{ name, fee, freeOver, districts: "Dhaka, Gazipur", areas: "savar, ashulia", isDefault }]  or { reset: true }
router.put("/zones", handle(async (req, res) => {
  if (req.body.reset) {
    await Organization.updateOne({ _id: req.org }, { zones: [] });
    return res.json({ ok: true });
  }
  const zones = (req.body.zones || []).map((z) => ({
    name: String(z.name || "").trim(), fee: Math.max(0, Number(z.fee) || 0), freeOver: Math.max(0, Number(z.freeOver) || 0),
    districts: toList(z.districts).map(canonicalDistrict).filter(Boolean), areas: toList(z.areas).map((a) => a.toLowerCase()), isDefault: !!z.isDefault,
  })).filter((z) => z.name);
  if (!zones.length) throw fail(400, "Add at least one zone");
  if (zones.filter((z) => z.isDefault).length !== 1) throw fail(400, "Mark exactly one zone as default (used when the address isn't recognised)");
  await Organization.updateOne({ _id: req.org }, { zones });
  res.json({ ok: true });
}));

router.post("/zones/test", handle(async (req, res) => {
  const o = await Organization.findById(req.org).select("zones").lean();
  res.json(findZone(o.zones, { address: req.body.address, district: req.body.district }));
}));

module.exports = router;
