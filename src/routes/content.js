// Content Studio + Calendar: write posts (with AI help), schedule, publish now, retry.
const router = require("express").Router();
const { ContentItem, SocialAccount, MediaAsset, Product, Organization } = require("../models");
const { handle, fail } = require("../lib/errors");
const { toList } = require("../lib/utils");
const { cleanOffer, activeOffer, applyOffer, offerLabel } = require("../lib/offer");
const { removeMedia } = require("../services/tempMedia");
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

// Post offer from the editor: { kind, value, until, all, productIds }. No value = no offer.
function cleanPostOffer(b) {
  const o = cleanOffer(b);
  if (!o) return null;
  const productIds = Array.isArray(b.productIds) ? b.productIds.map(String).slice(0, 500) : [];
  const all = b.all !== false && b.all !== "false";
  if (!all && !productIds.length) throw fail(400, "Choose the products for the offer, or pick All products");
  return { ...o, all, productIds: all ? [] : productIds, appliedAt: null };
}

function cleanBody(b) {
  return {
    title: String(b.title || "").trim().slice(0, 120),
    text: String(b.text || "").trim(),
    hashtags: toList(String(b.hashtags || "").replace(/\s+/g, ",")).map((h) => (h.startsWith("#") ? h : "#" + h)),
    mediaIds: Array.isArray(b.mediaIds) ? b.mediaIds.map(String) : [],
    ...(b.offer !== undefined ? { offer: cleanPostOffer(b.offer || {}) } : {}),
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
  if (item.targets.some((t) => t.status === "on_facebook")) throw fail(400, "Facebook is keeping this post for its time. Press Unschedule first, then change it");
  Object.assign(item, cleanBody(req.body));
  if (Array.isArray(req.body.accountIds)) item.targets = await targetsFor(req.org, req.body.accountIds);
  await item.save();
  res.json(item);
}));

router.delete("/:id", handle(async (req, res) => {
  const item = await findItem(req);
  if (item.status === "Publishing") throw fail(400, "This post is being published right now");
  if (item.status === "Scheduled") await publisher.cancelOnFacebook(item);
  await removeMedia(req.org, item.mediaIds || []);
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
  const problems = await publisher.checkItem(item, { schedule: true });
  if (problems.length) throw fail(400, problems.join(" · "));
  item.targets.forEach((t) => Object.assign(t, { status: "pending", attempts: 0, error: null }));
  await publisher.scheduleOnFacebook(item, when); // with photos: Facebook keeps the post, our copy of the photos is deleted
  item.scheduledAt = when;
  item.status = "Scheduled";
  await item.save();
  res.json(item);
}));

router.post("/:id/unschedule", handle(async (req, res) => {
  const item = await findItem(req);
  if (item.status !== "Scheduled") throw fail(400, "Only scheduled posts can be unscheduled");
  await publisher.cancelOnFacebook(item); // its photos are not kept: add them again before scheduling
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
  if (item.targets.some((t) => t.status === "on_facebook")) throw fail(400, "Facebook is keeping this post for its time. Open it, press Unschedule, add the photos again and schedule the new time");
  item.scheduledAt = when;
  await item.save();
  res.json(item);
}));

// AI writer: { topic, language: "bn" | "en", productId? }
// The shop only writes what the post is about. The AI picks the style itself (offer / product / normal post),
// and products named in the topic are found automatically, with their real price and running offer.
const STYLES = `Pick the style from the brief:
- about a discount, sale or offer -> an offer post (mention only offers given in the input)
- about one or more products -> a product post (hook, key benefits, who it is for, the price, call to action)
- anything else -> a Facebook post (strong first line, short paragraphs, a few emojis, one call to action)`;

// Products whose name is in the topic ("cotton panjabi er notun collection" -> Cotton Panjabi). Bangla names work too.
function productsIn(topic, products) {
  const text = String(topic).toLowerCase();
  const words = (s) => String(s || "").toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u).filter((w) => w.length >= 3);
  return products.filter((p) => [p.name, p.nameBn].some((name) => {
    if (!name) return false;
    if (text.includes(String(name).toLowerCase())) return true;
    const w = words(name);
    return w.length > 0 && w.filter((x) => text.includes(x)).length / w.length >= 0.6;
  })).slice(0, 5);
}

const productLine = (p) => {
  const offer = activeOffer(p);
  const until = offer?.until ? ` until ${new Date(offer.until).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Dhaka" })}` : "";
  const price = offer ? `now ৳${applyOffer(p.price, offer)} (${offerLabel(offer)}${until}, normal price ৳${p.price})` : `৳${p.price}`;
  const details = (p.info || []).filter((i) => i.value).map((i) => (i.label ? `${i.label}: ${i.value}` : i.value)).join(", ");
  const options = (p.variants || []).map((v) => v.name).filter((n) => n && n !== "Default").join(", ");
  return `- ${p.name}: ${price}${options ? ` | options: ${options}` : ""}${details ? ` | ${details}` : ""}${p.description ? ` | ${String(p.description).slice(0, 200)}` : ""}`;
};

router.post("/ai-write", handle(async (req, res) => {
  const { topic = "", productId, language = "bn" } = req.body;
  if (!String(topic).trim() && !productId) throw fail(400, "Write what the post is about, e.g. \"Eid collection arrived\"");
  const [org, products] = await Promise.all([
    Organization.findById(req.org).select("name ai").lean(),
    Product.find({ organizationId: req.org, archived: { $ne: true } }).lean(),
  ]);
  const picked = productId ? products.filter((p) => String(p._id) === String(productId)) : productsIn(topic, products);
  const lang = { bn: "Bangla", en: "English", mixed: "Bangla mixed with common English words" }[language] || "Bangla";
  const out = await askAI({
    system: `You write social media posts for a Bangladeshi online shop. Write 3 different versions of a post. ${STYLES}
Language: ${lang}. Use only facts from the input: never invent prices, discounts or delivery promises. Return JSON: {"versions":[{"text":"","hashtags":["#tag"]}]}`,
    user: `SHOP: ${org?.name || ""}\nSHOP INFO: ${org?.ai?.knowledge?.slice(0, 1500) || "-"}\n${picked.length ? `PRODUCTS:\n${picked.map(productLine).join("\n")}\n` : ""}BRIEF: ${topic || "-"}`,
    temperature: 0.8,
  });
  res.json((out.versions || []).map((v) => ({ text: String(v.text || ""), hashtags: (v.hashtags || []).map((h) => (String(h).startsWith("#") ? h : "#" + h)) })));
}));

module.exports = router;
