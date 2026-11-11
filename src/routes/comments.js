// Facebook comments: list, send/edit a reply, skip, hide, and the test simulator.
const router = require("express").Router();
const crypto = require("crypto");
const { Comment, SocialAccount } = require("../models");
const { handle, fail } = require("../lib/errors");
const engine = require("../services/comments");

const TABS = { needs_you: ["needs_human", "approval", "failed"], waiting: ["waiting"], replied: ["replied"], spam: ["spam"], all: null };

router.get("/", handle(async (req, res) => {
  const statuses = TABS[req.query.tab || "needs_you"];
  const q = { organizationId: req.org, ...(statuses ? { status: { $in: statuses } } : {}) };
  const [rows, needsYou] = await Promise.all([
    Comment.find(q).sort({ createdAt: -1 }).limit(200).lean(),
    Comment.countDocuments({ organizationId: req.org, status: { $in: TABS.needs_you } }),
  ]);
  res.json({ rows, needsYou });
}));

async function findComment(req) {
  const c = await Comment.findOne({ _id: req.params.id, organizationId: req.org });
  if (!c) throw fail(404, "Comment not found");
  return c;
}

// Send a public reply now (approve the suggested text or write your own)
router.post("/:id/reply", handle(async (req, res) => {
  const c = await findComment(req);
  const text = String(req.body.text || c.reply || "").trim();
  if (!text) throw fail(400, "Write a reply");
  await engine.postPublicReply(req.org, c, text);
  await c.save();
  res.json(c);
}));

router.post("/:id/dm", handle(async (req, res) => {
  const c = await findComment(req);
  if (c.dmSent) throw fail(400, "A message was already sent for this comment (Facebook allows one)");
  await engine.sendDm(req.org, c);
  await c.save();
  res.json(c);
}));

router.post("/:id/skip", handle(async (req, res) => {
  const c = await findComment(req);
  c.status = "ignored";
  c.replySendAt = null;
  await c.save();
  res.json(c);
}));

router.post("/:id/hide", handle(async (req, res) => {
  const c = await findComment(req);
  await engine.hideOnFacebook(req.org, c, true);
  c.status = "spam";
  c.note = "hidden by you";
  await c.save();
  res.json(c);
}));

// Simulator: runs the whole engine without Facebook
router.post("/simulate", handle(async (req, res) => {
  const message = String(req.body.message || "").trim();
  if (!message) throw fail(400, "Write a test comment");
  const page = await SocialAccount.findOne({ organizationId: req.org, platform: "Facebook" }).lean();
  const comment = await engine.handleNewComment(req.org, {
    pageId: page?.accountId || "sim_page", commentId: `sim_${crypto.randomBytes(6).toString("hex")}`, postId: "sim_post",
    fromName: req.body.name || "Test customer", message,
  });
  res.json(comment);
}));

module.exports = router;
