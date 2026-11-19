// Customer inbox: chats, staff replies, AI on/off, order draft, and the test simulator.
const router = require("express").Router();
const crypto = require("crypto");
const { Conversation, Order, Product } = require("../models");
const { handle, fail } = require("../lib/errors");
const { escapeRegex } = require("../lib/utils");
const messenger = require("../services/messenger");
const agent = require("../services/agent");

const listRow = (c) => ({
  _id: c._id, customerName: c.customerName, avatar: c.avatar, channel: c.channel, lastMessage: c.lastMessage, status: c.status,
  unread: c.unread, aiPaused: c.aiPaused, updatedAt: c.updatedAt, draftStatus: c.draft?.status || null, lastOrderNo: c.lastOrderNo,
});

async function findConversation(req) {
  const c = await Conversation.findOne({ _id: req.params.id, organizationId: req.org });
  if (!c) throw fail(404, "Chat not found");
  return c;
}

router.get("/", handle(async (req, res) => {
  const q = { organizationId: req.org };
  const tab = req.query.tab || "open";
  if (tab === "open") q.status = { $ne: "closed" };
  if (tab === "needs_human") q.status = "needs_human";
  if (tab === "closed") q.status = "closed";
  if (req.query.q) { const re = new RegExp(escapeRegex(req.query.q), "i"); q.$or = [{ customerName: re }, { lastMessage: re }, { "draft.phone": re }]; }
  const [rows, needsHuman] = await Promise.all([
    Conversation.find(q).select("-messages").sort({ updatedAt: -1 }).limit(200).lean(),
    Conversation.countDocuments({ organizationId: req.org, status: "needs_human" }),
  ]);
  res.json({ rows: rows.map(listRow), needsHuman });
}));

router.get("/:id", handle(async (req, res) => {
  const c = await findConversation(req);
  if (c.unread) await Conversation.updateOne({ _id: c._id }, { unread: 0 }, { timestamps: false });
  // The page asks every few seconds: answer "nothing new" when the chat didn't change
  if (req.query.since && req.query.since === c.updatedAt.toISOString()) return res.json({ unchanged: true });
  c.unread = 0;
  const draft = c.draft || { items: [] };
  const orders = await Order.find({ organizationId: req.org, $or: [{ conversationId: c._id }, ...(draft.phone ? [{ phone: draft.phone }] : [])] }).sort({ createdAt: -1 }).limit(5).lean();
  res.json({
    ...c.toJSON(),
    canReply: messenger.canReply(c), simulator: messenger.isSimulator(c),
    totals: agent.draftTotal(draft), missing: draft.status === "placed" ? [] : agent.draftMissing(draft), orders,
  });
}));

// Staff reply. The AI pauses for this chat so the two don't talk over each other.
router.post("/:id/reply", handle(async (req, res) => {
  const text = String(req.body.text || "").trim();
  if (!text) throw fail(400, "Write a message");
  const c = await findConversation(req);
  await messenger.oneAtATime(`${req.org}:${c.psid}`, async () => {
    const fresh = await Conversation.findById(c._id);
    await messenger.sendText(req.org, fresh, text);
    messenger.addMessage(fresh, "agent", text);
    fresh.aiPaused = true;
    if (fresh.status !== "open") fresh.status = "open";
    await fresh.save();
  });
  res.json({ ok: true });
}));

router.post("/:id/ai", handle(async (req, res) => {
  const c = await findConversation(req);
  c.aiPaused = !req.body.on;
  messenger.addMessage(c, "system", req.body.on ? `AI turned on by ${req.user.name}` : `${req.user.name} took over (AI off)`);
  if (req.body.on && c.status === "needs_human") { c.status = "open"; c.handoffReason = null; }
  await c.save();
  res.json({ ok: true });
}));

router.post("/:id/status", handle(async (req, res) => {
  if (!["open", "closed"].includes(req.body.status)) throw fail(400, "Status must be open or closed");
  const c = await findConversation(req);
  c.status = req.body.status;
  await c.save();
  res.json({ ok: true });
}));

// Staff edits the order draft: { name, phone, address, district, items:[{productId, variantId, qty}] }
router.put("/:id/draft", handle(async (req, res) => {
  const c = await findConversation(req);
  const settings = await agent.aiSettings(req.org);
  const products = await Product.find({ organizationId: req.org, archived: { $ne: true } }).lean();
  if (c.draft?.status === "placed") c.draft = { ...c.draft, items: [], status: "collecting" };
  else if (c.draft?.status === "awaiting_confirm") c.draft = { ...c.draft, status: "collecting" };
  agent.updateDraft(c, settings, products, req.body);
  if (Array.isArray(req.body.items) && !req.body.items.length) { c.draft.items = []; c.markModified("draft"); }
  await c.save();
  res.json({ ok: true });
}));

router.post("/:id/place-order", handle(async (req, res) => {
  const c = await findConversation(req);
  const settings = await agent.aiSettings(req.org);
  let order;
  try { order = await agent.placeOrderFromDraft(req.org, c, settings, req.user.name); }
  catch (e) { throw fail(e.status || 400, e.message); }
  if (req.body.tellCustomer !== false && messenger.canReply(c)) await messenger.reply(req.org, c, "agent", agent.orderPlacedText(order, settings));
  await c.save();
  res.json(order);
}));

router.post("/:id/suggest", handle(async (req, res) => {
  res.json(await agent.suggestReply(req.org, await findConversation(req)));
}));

router.delete("/:id", handle(async (req, res) => {
  await Conversation.deleteOne({ _id: req.params.id, organizationId: req.org });
  res.json({ ok: true });
}));

// Simulator: chat with your own AI agent without Facebook. Nothing is sent to Meta.
// Test chat. { text } or { image: "data:image/jpeg;base64,…" } to test what the AI does with a photo
router.post("/simulate", handle(async (req, res) => {
  const image = /^data:image\/(jpeg|png|webp);base64,/.test(String(req.body.image || "")) ? String(req.body.image) : null;
  const text = image ? "[image]" : String(req.body.text || "").trim();
  if (!text) throw fail(400, "Write a message");
  let id = req.body.conversationId;
  if (!id) {
    const c = await Conversation.create({ organizationId: req.org, psid: `sim_${crypto.randomBytes(6).toString("hex")}`, channel: "Simulator", customerName: req.body.name || "Test customer" });
    id = c._id;
  }
  await messenger.oneAtATime(`${req.org}:conv:${id}`, async () => {
    const c = await Conversation.findOne({ _id: id, organizationId: req.org });
    if (!c || !messenger.isSimulator(c)) throw fail(404, "Simulator chat not found");
    messenger.addMessage(c, "customer", image ? "📷 [photo]" : text);
    await agent.handleCustomerMessage(req.org, c, text, { images: image ? [image] : [] });
    await c.save();
  });
  res.json({ ok: true, conversationId: id });
}));

module.exports = router;
