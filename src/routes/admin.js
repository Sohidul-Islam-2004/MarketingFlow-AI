// Super Admin: create and manage customer accounts, and watch every connected Facebook Page.
// Only emails in SUPER_ADMIN_EMAILS (.env) can use these routes (see server.js).
//
//   GET    /api/admin/customers               all shops with their numbers
//   POST   /api/admin/customers               create a shop + owner, returns an invite link
//   PUT    /api/admin/customers/:org          plan, end date, suspend / activate, name, phone
//   POST   /api/admin/customers/:org/link     new "set your password" link (lost password)
//   DELETE /api/admin/customers/:org          delete the shop and ALL its data
//   GET    /api/admin/pages                   every connected Page
//   POST   /api/admin/pages/check             ask Facebook about every Page token
//   POST   /api/admin/pages/:id/ai            switch the shop's AI on / off
//   DELETE /api/admin/pages/:id               disconnect a Page
const fs = require("fs");
const path = require("path");
const router = require("express").Router();
const models = require("../models");
const { User, Organization, SocialAccount, Order, Conversation, Session, MediaAsset, Counter } = models;
const { handle, fail } = require("../lib/errors");
const { DAY } = require("../lib/utils");
const { blockedReason, passwordLink } = require("../services/account");
const { forgetSessions } = require("../middleware/auth");
const { checkAllPages, disconnectPage } = require("./meta");

const PLANS = ["trial", "basic", "pro"];
const validEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

// "2026-12-31" -> end of that day; "" -> no end date
function readDate(value) {
  if (!value) return null;
  const d = new Date(`${String(value).slice(0, 10)}T23:59:59+06:00`); // Dhaka time
  if (isNaN(d)) throw fail(400, "Write the end date like 2026-12-31");
  return d;
}

// counts per shop for the last 30 days: { orgId: { n, revenue } }
async function perShop(model, dateField, extraMatch = {}) {
  const since = new Date(Date.now() - 30 * DAY);
  const rows = await model.aggregate([
    { $match: { [dateField]: { $gte: since }, ...extraMatch } },
    { $group: { _id: "$organizationId", n: { $sum: 1 }, revenue: { $sum: "$total" } } },
  ]);
  return Object.fromEntries(rows.map((r) => [r._id, r]));
}

/* ---------- customers ---------- */
router.get("/customers", handle(async (req, res) => {
  const [orgs, users, pages, orders, chats] = await Promise.all([
    Organization.find().select("name phone plan expiresAt suspended createdAt").sort({ createdAt: -1 }).lean(),
    User.find().select("organizationId name email lastLoginAt").lean(),
    SocialAccount.find({ platform: "Facebook" }).select("organizationId status").lean(),
    perShop(Order, "createdAt", { status: { $nin: ["cancelled", "returned"] } }),
    perShop(Conversation, "updatedAt", { channel: { $ne: "Simulator" } }),
  ]);
  const rows = orgs.map((o) => {
    const owner = users.find((u) => u.organizationId === o._id);
    const myPages = pages.filter((p) => p.organizationId === o._id);
    return {
      ...o,
      state: blockedReason(o) || "active", // active | suspended | expired
      isMe: o._id === req.org, // the admin's own workspace: can't be suspended or deleted here
      owner: owner && { name: owner.name, email: owner.email, lastLoginAt: owner.lastLoginAt, invitePending: !owner.lastLoginAt }, // set-password and login both set lastLoginAt
      pages: myPages.length,
      brokenPages: myPages.filter((p) => p.status !== "active").length,
      orders30: orders[o._id]?.n || 0,
      revenue30: orders[o._id]?.revenue || 0,
      chats30: chats[o._id]?.n || 0,
    };
  });
  const count = (state) => rows.filter((r) => r.state === state).length;
  res.json({ rows, plans: PLANS, totals: { all: rows.length, active: count("active"), suspended: count("suspended"), expired: count("expired") } });
}));

router.post("/customers", handle(async (req, res) => {
  const business = String(req.body.business || "").trim();
  const ownerName = String(req.body.ownerName || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const plan = PLANS.includes(req.body.plan) ? req.body.plan : "trial";
  if (business.length < 2) throw fail(400, "Write the business name");
  if (ownerName.length < 2) throw fail(400, "Write the owner's name");
  if (!validEmail(email)) throw fail(400, "Write a valid email");
  if (await User.exists({ email })) throw fail(409, "This email already has an account");

  const org = await Organization.create({ name: business, phone: String(req.body.phone || "").trim(), plan, expiresAt: readDate(req.body.expiresAt) });
  const user = await User.create({ organizationId: org._id, name: ownerName, email }); // no password yet: the invite link sets it
  res.json({ ok: true, orgId: org._id, ...(await passwordLink(user._id, req)) });
}));

router.put("/customers/:org", handle(async (req, res) => {
  const set = {};
  if (req.body.name !== undefined) set.name = String(req.body.name).trim() || "My business";
  if (req.body.phone !== undefined) set.phone = String(req.body.phone).trim();
  if (req.body.plan !== undefined) set.plan = PLANS.includes(req.body.plan) ? req.body.plan : "trial";
  if (req.body.expiresAt !== undefined) set.expiresAt = readDate(req.body.expiresAt);
  if (req.body.suspended !== undefined) set.suspended = !!req.body.suspended;
  const r = await Organization.updateOne({ _id: req.params.org }, { $set: set });
  if (!r.matchedCount) throw fail(404, "Customer not found");
  forgetSessions(); // the change works at once, not after a minute
  res.json({ ok: true });
}));

router.post("/customers/:org/link", handle(async (req, res) => {
  const owner = await User.findOne({ organizationId: req.params.org });
  if (!owner) throw fail(404, "This shop has no owner account");
  res.json({ ok: true, email: owner.email, ...(await passwordLink(owner._id, req)) });
}));

// Deletes the shop and everything that belongs to it. It can't be undone.
router.delete("/customers/:org", handle(async (req, res) => {
  const org = await Organization.findById(req.params.org).lean();
  if (!org) throw fail(404, "Customer not found");
  if (org._id === req.org) throw fail(400, "You can't delete your own workspace");
  if (String(req.body.confirmName || "").trim() !== org.name) throw fail(400, "Type the business name exactly to delete it");

  for (const page of await SocialAccount.find({ organizationId: org._id }).select("+accessToken")) await disconnectPage(page);
  const users = await User.find({ organizationId: org._id }).select("_id").lean();
  await Session.deleteMany({ userId: { $in: users.map((u) => u._id) } });
  const uploads = path.join(__dirname, "..", "..", "uploads");
  for (const m of await MediaAsset.find({ organizationId: org._id }).select("file").lean()) if (m.file) fs.promises.unlink(path.join(uploads, m.file)).catch(() => {});
  // every collection that has organizationId (products, orders, chats, comments, posts, media, users...)
  for (const model of Object.values(models)) if (model.schema?.path("organizationId")) await model.deleteMany({ organizationId: org._id });
  await Counter.deleteMany({ _id: `order:${org._id}` });
  await models.ShopScan.deleteOne({ _id: org._id });
  await Organization.deleteOne({ _id: org._id });
  forgetSessions();
  res.json({ ok: true });
}));

/* ---------- Facebook Pages ---------- */
router.get("/pages", handle(async (req, res) => {
  const since = new Date(Date.now() - 30 * DAY);
  const [pages, orgs, chats] = await Promise.all([
    SocialAccount.find({ platform: "Facebook" }).sort({ createdAt: -1 }).lean(),
    Organization.find().select("name ai.enabled suspended expiresAt").lean(),
    Conversation.aggregate([{ $match: { updatedAt: { $gte: since }, channel: "Messenger" } }, { $group: { _id: "$pageId", n: { $sum: 1 } } }]),
  ]);
  const chatsOf = Object.fromEntries(chats.map((c) => [c._id, c.n]));
  const rows = pages.map((p) => {
    const org = orgs.find((o) => o._id === p.organizationId);
    // "silent" = connected, but Facebook sent nothing for 7 days (webhooks may be broken)
    const silent = p.status === "active" && (!p.lastWebhookAt || new Date(p.lastWebhookAt) < new Date(Date.now() - 7 * DAY));
    return {
      _id: p._id, accountId: p.accountId, accountName: p.accountName, pictureUrl: p.pictureUrl, organizationId: p.organizationId,
      business: org?.name || "(deleted)", shopState: blockedReason(org) || "active", aiOn: org?.ai?.enabled !== false,
      status: p.status, statusNote: p.statusNote, webhooksOn: p.webhooksOn, lastWebhookAt: p.lastWebhookAt, connectedAt: p.createdAt,
      chats30: chatsOf[p.accountId] || 0, silent,
    };
  });
  res.json({
    rows,
    totals: { all: rows.length, working: rows.filter((r) => r.status === "active" && r.webhooksOn).length, reconnect: rows.filter((r) => r.status !== "active").length, webhooksOff: rows.filter((r) => r.status === "active" && !r.webhooksOn).length, silent: rows.filter((r) => r.silent).length },
  });
}));

router.post("/pages/check", handle(async (req, res) => {
  res.json(await checkAllPages());
}));

router.post("/pages/:id/ai", handle(async (req, res) => {
  const page = await SocialAccount.findById(req.params.id).lean();
  if (!page) throw fail(404, "Page not found");
  await Organization.updateOne({ _id: page.organizationId }, { $set: { "ai.enabled": !!req.body.on } });
  res.json({ ok: true });
}));

router.delete("/pages/:id", handle(async (req, res) => {
  const page = await SocialAccount.findById(req.params.id).select("+accessToken");
  if (!page) throw fail(404, "Page not found");
  await disconnectPage(page);
  res.json({ ok: true });
}));

module.exports = router;
