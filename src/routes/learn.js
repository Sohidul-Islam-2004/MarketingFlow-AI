// AI Training: read the Facebook Page + website, show the shop knowledge the AI wrote, save it when the seller approves.
// The reading itself is in services/learn.js.
const router = require("express").Router();
const { ShopScan, Organization, SocialAccount } = require("../models");
const { handle, fail } = require("../lib/errors");
const { aiReady } = require("../lib/ai");
const learn = require("../services/learn");

router.get("/", handle(async (req, res) => {
  const [scan, shop, page] = await Promise.all([
    ShopScan.findById(req.org).lean(),
    Organization.findById(req.org).select("website ai").lean(),
    SocialAccount.findOne({ organizationId: req.org, platform: "Facebook" }).select("accountName").lean(),
  ]);
  // "running" in the database but nothing is running: the server restarted in the middle
  if (scan?.status === "running" && !learn.isRunning(req.org)) Object.assign(scan, { status: "failed", error: "It was interrupted. Please start again." });
  res.json({ scan, website: scan?.website || shop?.website || "", pageName: page?.accountName || null, currentKnowledge: shop?.ai?.knowledge || "", aiReady: aiReady() });
}));

router.post("/start", handle(async (req, res) => {
  await learn.startScan(req.org, req.body.website);
  res.json({ ok: true });
}));

// Saves the shop knowledge the seller approved
router.post("/save-knowledge", handle(async (req, res) => {
  const knowledge = String(req.body.knowledge || "").trim().slice(0, 20000);
  if (!knowledge) throw fail(400, "The shop knowledge is empty");
  const set = { "ai.knowledge": knowledge };
  if (String(req.body.deliveryTime || "").trim()) set["ai.deliveryTime"] = String(req.body.deliveryTime).trim().slice(0, 200);
  if (String(req.body.returnPolicy || "").trim()) set.returnPolicy = String(req.body.returnPolicy).trim().slice(0, 1000);
  await Organization.updateOne({ _id: req.org }, { $set: set });
  res.json({ ok: true });
}));

module.exports = router;
