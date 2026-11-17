// Content Studio + Calendar: write posts (with AI help), schedule, publish now, retry.
const router = require("express").Router();
const { ContentItem, SocialAccount, MediaAsset, Product, Organization } = require("../models");
const { handle, fail } = require("../lib/errors");
const { toList } = require("../lib/utils");
const { askAI } = require("../lib/ai");
const publisher = require("../services/publisher");

const LOCKED = ["Publishing", "Published", "Partly published"];

async function findItem(req) {
  const item = await ContentItem.findOne({ _id: req.params.id, organizationId: req.org });
  if (!item) throw fail(404, "Post not found");
  return item;
}

async function targetsFor(org, accountIds = []) {
  const accounts = await SocialAccount.find({ organizationId: org, _id: { $in: accountIds }, platform: { $in: ["Facebook", "Instagram"] } }).lean();
  return accounts.map((a) => ({ accountId: a._id, platform: a.platform, accountName: a.accountName }));
}

function cleanBody(b) {
  return {
    title: String(b.title || "").trim().slice(0, 120),
    text: String(b.text || "").trim(),
    hashtags: toList(String(b.hashtags || "").replace(/\s+/g, ",")).map((h) => (h.startsWith("#") ? h : "#" + h)),
    mediaIds: Array.isArray(b.mediaIds) ? b.mediaIds.map(String) : [],
  };
}

router.get("/", handle(async (req, res) => {
  const q = { organizationId: req.org };
  if (req.query.status) q.status = { $in: String(req.query.status).split(",") };
  if (req.query.from && req.query.to) q.scheduledAt = { $gte: new Date(req.query.from), $lt: new Date(req.query.to) };
  res.json(await ContentItem.find(q).sort({ updatedAt: -1 }).limit(300).lean());
}));

router.get("/:id", handle(async (req, res) => {
  const item = await findItem(req);
  const media = await MediaAsset.find({ _id: { $in: item.mediaIds }, organizationId: req.org }).lean();
  res.json({ ...item.toJSON(), media });
}));

router.post("/", handle(async (req, res) => {
  const data = cleanBody(req.body);
  if (!data.text && !data.mediaIds.length) throw fail(400, "Write a caption or add a photo");
  const item = await ContentItem.create({ ...data, title: data.title || data.text.slice(0, 60), organizationId: req.org, targets: await targetsFor(req.org, req.body.accountIds) });
  res.json(item);
}));

router.put("/:id", handle(async (req, res) => {
  const item = await findItem(req);
  if (LOCKED.includes(item.status)) throw fail(400, `This post is ${item.status} and can't be edited`);
  Object.assign(item, cleanBody(req.body));
  if (Array.isArray(req.body.accountIds)) item.targets = await targetsFor(req.org, req.body.accountIds);
  await item.save();
  res.json(item);
}));

router.delete("/:id", handle(async (req, res) => {
  const item = await findItem(req);
  if (item.status === "Publishing") throw fail(400, "This post is being published right now");
  await item.deleteOne();
  res.json({ ok: true });
}));

// { scheduledAt } -> Scheduled. Checks the post first so problems show now, not at publish time.
router.post("/:id/schedule", handle(async (req, res) => {
  const item = await findItem(req);
  if (LOCKED.includes(item.status)) throw fail(400, `This post is ${item.status}`);
  const when = new Date(req.body.scheduledAt);
  if (isNaN(when)) throw fail(400, "Choose a date and time");
  if (when < Date.now() - 60e3) throw fail(400, "That time is in the past");
  const problems = await publisher.checkItem(item);
  if (problems.length) throw fail(400, problems.join(" · "));
  item.scheduledAt = when;
  item.status = "Scheduled";
  item.targets.forEach((t) => Object.assign(t, { status: "pending", attempts: 0, error: null }));
  await item.save();
  res.json(item);
}));

router.post("/:id/unschedule", handle(async (req, res) => {
  const item = await findItem(req);
  if (item.status !== "Scheduled") throw fail(400, "Only scheduled posts can be unscheduled");
  item.status = "Draft";
  await item.save();
  res.json(item);
}));

// Publish now, or retry the accounts that failed
router.post("/:id/publish", handle(async (req, res) => {
  const item = await findItem(req);
  if (["Publishing", "Published"].includes(item.status)) throw fail(400, `This post is already ${item.status}`);
  const problems = await publisher.checkItem(item);
  if (problems.length) throw fail(400, problems.join(" · "));
  item.targets.forEach((t) => { if (t.status !== "published") Object.assign(t, { status: "pending", attempts: 0, error: null }); });
  Object.assign(item, { status: "Scheduled", scheduledAt: new Date(), nextTryAt: null, lockedUntil: null });
  await item.save();
  await publisher.publishDuePosts();
  res.json(await ContentItem.findById(item._id).lean());
}));

// Calendar drag & drop: move the date only
router.post("/:id/move", handle(async (req, res) => {
  const item = await findItem(req);
  if (LOCKED.includes(item.status)) throw fail(400, `This post is ${item.status}`);
  const when = new Date(req.body.scheduledAt);
  if (isNaN(when)) throw fail(400, "Invalid date");
  if (item.status === "Scheduled" && when < Date.now()) throw fail(400, "A scheduled post can't move into the past");
  item.scheduledAt = when;
  await item.save();
  res.json(item);
}));

// AI writer: { kind: facebook_post | product_post | offer_post, topic, productId, language }
const KINDS = {
  facebook_post: "a Facebook post: strong first line, short paragraphs, a few emojis, one clear call to action",
  product_post: "a product post: hook, key benefits, who it is for, the price from PRODUCT, call to action",
  offer_post: "an offer post. Mention only offers written in the brief",
};
router.post("/ai-write", handle(async (req, res) => {
  const { kind = "facebook_post", topic = "", productId, language = "bn" } = req.body;
  if (!KINDS[kind]) throw fail(400, "Unknown post type");
  const [org, product] = await Promise.all([
    Organization.findById(req.org).select("name ai").lean(),
    productId ? Product.findOne({ _id: productId, organizationId: req.org }).lean() : null,
  ]);
  const lang = { bn: "Bangla", en: "English", mixed: "Bangla mixed with common English words" }[language] || "Bangla";
  const out = await askAI({
    system: `You write social media posts for a Bangladeshi online shop. Write 3 different versions of ${KINDS[kind]}. Language: ${lang}. Use only facts from the input: never invent prices, discounts or delivery promises. Return JSON: {"versions":[{"text":"","hashtags":["#tag"]}]}`,
    user: `SHOP: ${org?.name || ""}\nSHOP INFO: ${org?.ai?.knowledge?.slice(0, 1500) || "-"}\n${product ? `PRODUCT: ${product.name}, price ৳${product.price}, ${product.description || ""}\n` : ""}BRIEF: ${topic || "-"}`,
    temperature: 0.8,
  });
  res.json((out.versions || []).map((v) => ({ text: String(v.text || ""), hashtags: (v.hashtags || []).map((h) => (String(h).startsWith("#") ? h : "#" + h)) })));
}));

module.exports = router;
