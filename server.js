const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const multer = require("multer")
require("dotenv").config();
const dns = require("dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]); // Use Google DNS

const {
  Organization, Lead, Task, ContentItem, Product, Order, Conversation,
  Blacklist, AgentConfig, WebhookEvent, SocialAccount, nextOrderNo,
} = require("./schema.js");

/* ---------- config (.env) ----------
DATABASE_URL=mongodb+srv://...
PORT=3000
DEFAULT_TENANT=org_123
WORKSPACE_NAME=Test
N8N_BASE_URL=http://localhost:5678
N8N_PUBLISH_URL=http://localhost:5678/webhook-test/publish-facebook   (optional)
N8N_REPLY_URL=http://localhost:5678/webhook/messenger-reply            (optional)
WEBHOOK_SECRET=some-long-random-string                                 (optional, protects n8n inbound routes)
-------------------------------------- */
const DEFAULT_TENANT = process.env.DEFAULT_TENANT || "org_123";
const N8N_BASE = process.env.N8N_BASE_URL || "http://localhost:5678";
const N8N_PUBLISH = process.env.N8N_PUBLISH_URL || `${N8N_BASE}/webhook-test/publish-facebook`;
const N8N_REPLY = process.env.N8N_REPLY_URL || `${N8N_BASE}/webhook/messenger-reply`;

const PLANS = {
  free: { price: 0, aiOrders: 100, pages: 1 },
  pro: { price: 1999, aiOrders: 2000, pages: 5 },
  business: { price: 4999, aiOrders: 20000, pages: 25 },
};

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

/* ---------- helpers ---------- */
const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    if (err && err.code === 11000) return res.status(409).json({ error: "Already exists" });
    console.error(`${req.method} ${req.path}:`, err);
    res.status(500).json({ error: "Internal Server Error" });
  });

// Tenant comes from header, body, query, or the default workspace.
// Replace with the logged-in user's organization once you add auth.
const tid = (req) =>
  String(req.headers["x-tenant-id"] || req.body?.tenantId || req.query.tenantId || DEFAULT_TENANT);

// Protects routes that only n8n should call (skipped if WEBHOOK_SECRET is not set).
const needSecret = (req, res, next) => {
  const s = process.env.WEBHOOK_SECRET;
  if (s && req.headers["x-webhook-secret"] !== s) return res.status(401).json({ error: "Unauthorized" });
  next();
};

const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const DAY = 86400000;
const pct = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : cur > 0 ? 100 : 0);

const payLabel = (o) =>
  o.paymentMethod === "COD"
    ? `COD (${o.paymentStatus === "paid" ? "paid" : "unpaid"})`
    : o.paymentStatus === "paid" ? `Paid (${o.paymentMethod})` : `${o.paymentMethod} (unpaid)`;

const orderRow = (o) => ({
  id: String(o._id), no: o.orderNo, customer: o.customerName, phone: o.phone, address: o.address,
  total: o.total, payment: payLabel(o), channel: o.channel, status: o.status, isAI: o.isAI,
  risk: o.riskScore, reasons: o.riskReasons || [], courier: o.courier?.provider || null,
  tracking: o.courier?.trackingId || null, createdAt: o.createdAt,
});

async function sumOrders(org, match = {}) {
  const [r] = await Order.aggregate([
    { $match: { organizationId: org, status: { $ne: "cancelled" }, ...match } },
    { $group: { _id: null, count: { $sum: 1 }, revenue: { $sum: "$total" } } },
  ]);
  return { count: r?.count || 0, revenue: r?.revenue || 0 };
}

async function weekDelta(Model, org, extra = {}) {
  const now = Date.now();
  const q = (from, to) => Model.countDocuments({ organizationId: org, ...extra, createdAt: { $gte: new Date(from), $lt: new Date(to) } });
  const [cur, prev] = await Promise.all([q(now - 7 * DAY, now + 1), q(now - 14 * DAY, now - 7 * DAY)]);
  return pct(cur, prev);
}

// Simple rules-based fraud score (0-100). Tune the numbers to your business.
async function scoreRisk(org, { phone, total, paymentMethod }) {
  let score = 0;
  const reasons = [];
  if (await Blacklist.exists({ organizationId: org, phone })) { score += 100; reasons.push("Phone is blacklisted"); }
  if (!/^01[3-9]\d{8}$/.test(phone || "")) { score += 40; reasons.push("Invalid Bangladesh phone number"); }
  const recent = new Date(Date.now() - 10 * 60 * 1000);
  if (await Order.exists({ organizationId: org, phone, createdAt: { $gte: recent } })) { score += 30; reasons.push("Repeat order within 10 minutes"); }
  const cancelled = await Order.countDocuments({ organizationId: org, phone, status: "cancelled" });
  if (cancelled >= 2) { score += 25; reasons.push(`${cancelled} previous cancelled orders`); }
  if (paymentMethod === "COD" && total >= 10000) { score += 20; reasons.push("High-value COD order"); }
  return { score: Math.min(score, 100), reasons };
}

// Courier booking stub. Replace the body with a real Pathao / Steadfast / RedX API call.
async function bookCourier(provider, order) {
  return { provider, trackingId: `TRK-${Date.now().toString(36).toUpperCase()}` };
}

async function ensureWorkspace() {
  await Organization.updateOne(
    { _id: DEFAULT_TENANT },
    { $setOnInsert: { name: process.env.WORKSPACE_NAME || "Test" } },
    { upsert: true }
  );
  await AgentConfig.updateOne({ organizationId: DEFAULT_TENANT }, { $setOnInsert: {} }, { upsert: true });
}

/* ---------- connect ---------- */
mongoose
  .connect(process.env.DATABASE_URL)
  .then(async () => { console.log("✅ MongoDB connected"); await ensureWorkspace(); })
  .catch((err) => { console.error("❌ MongoDB connection error:", err); process.exit(1); });

app.get("/api/health", (_req, res) => res.json({ ok: mongoose.connection.readyState === 1 }));

/* =====================================================
   n8n / AUTOMATION ENDPOINTS (existing)
   ===================================================== */
app.post("/api/leads/check-duplicate", wrap(async (req, res) => {
  const { tenantId, eventId } = req.body;
  if (await WebhookEvent.findOne({ externalEventId: eventId })) return res.json({ isDuplicate: true });
  await WebhookEvent.create({ tenantId, externalEventId: eventId, provider: "n8n", processingStatus: "processed" });
  res.json({ isDuplicate: false });
}));

app.post("/api/leads/create", wrap(async (req, res) => {
  const { tenantId, leadId, name, email, aiScore, aiStatus, aiReason } = req.body;
  const lead = await Lead.create({
    _id: leadId, organizationId: tenantId, name, email,
    aiScore: parseInt(aiScore, 10) || 0, aiStatus: aiStatus || "Cold", aiReason,
  });
  res.json({ success: true, lead });
}));

app.post("/api/tasks/create", wrap(async (req, res) => {
  const { tenantId, leadId, title, priority } = req.body;
  const task = await Task.create({ organizationId: tenantId, leadId: leadId || null, title, priority: priority || "High" });
  res.json({ success: true, task });
}));

app.post("/api/content/create", wrap(async (req, res) => {
  const { tenantId, platform, topic, generatedText } = req.body;
  const content = await ContentItem.create({
    organizationId: tenantId, title: topic, body: generatedText, status: "Draft",
    variants: [{ platform, caption: generatedText }],
  });
  res.json({ success: true, content });
}));

/* =====================================================
   LEADS & CONTENT (dashboard)
   ===================================================== */
app.get("/api/leads", wrap(async (req, res) => {
  res.json(await Lead.find({ organizationId: tid(req) }).sort({ createdAt: -1 }).limit(200));
}));

app.get("/api/content", wrap(async (req, res) => {
  const items = await ContentItem.find({ organizationId: tid(req) }).sort({ createdAt: -1 }).limit(200);
  res.json(items.map((i) => ({
    id: String(i._id), platform: i.variants?.[0]?.platform || "General", topic: i.title,
    generatedText: i.body, status: i.status, createdAt: i.createdAt,
  })));
}));

app.put("/api/content/:id/approve", wrap(async (req, res) => {
  const org = tid(req);
  const item = await ContentItem.findOne({ _id: req.params.id, organizationId: org });
  if (!item) return res.status(404).json({ error: "Content not found" });
  const account = await SocialAccount.findOne({ organizationId: org, platform: req.body.platform });
  if (!account) return res.status(400).json({ error: "No account connected for this platform" });

  const r = await fetch(N8N_PUBLISH, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ postText: item.body, pageId: account.accountId, accessToken: account.accessToken }),
  });
  if (!r.ok) return res.status(502).json({ error: "Publishing workflow failed" });

  item.status = "Approved";
  await item.save();
  res.json({ success: true });
}));

/* =====================================================
   FACEBOOK PAGES (integrations) — tokens never sent to the browser
   ===================================================== */
app.post("/api/integrations/connect", wrap(async (req, res) => {
  const { organizationId, platform, accountName, accountId, accessToken } = req.body;
  const a = await SocialAccount.create({ organizationId: organizationId || tid(req), platform, accountName, accountId, accessToken });
  const out = a.toJSON(); delete out.accessToken;
  res.json({ success: true, account: out });
}));

app.get("/api/integrations", wrap(async (req, res) => {
  res.json(await SocialAccount.find({ organizationId: tid(req) }).select("-accessToken").sort({ createdAt: -1 }));
}));

app.delete("/api/integrations/:id", wrap(async (req, res) => {
  const r = await SocialAccount.deleteOne({ _id: req.params.id, organizationId: tid(req) });
  if (!r.deletedCount) return res.status(404).json({ error: "Account not found" });
  res.json({ success: true });
}));

/* =====================================================
   PRODUCTS (Inventory)
   ===================================================== */
app.get("/api/products", wrap(async (req, res) => {
  const q = { organizationId: tid(req) };
  if (req.query.q) q.name = new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  res.json(await Product.find(q).sort({ createdAt: -1 }).limit(500));
}));

app.post("/api/products", wrap(async (req, res) => {
  const { name, sku, price, stock, lowStockAt, category, imageUrl } = req.body;
  const p = await Product.create({ organizationId: tid(req), name, sku, price: Number(price), stock: Number(stock) || 0, lowStockAt, category, imageUrl });
  res.json({ success: true, product: p });
}));

app.put("/api/products/:id", wrap(async (req, res) => {
  const allowed = ["name", "sku", "price", "stock", "lowStockAt", "category", "imageUrl"];
  const patch = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  const p = await Product.findOneAndUpdate({ _id: req.params.id, organizationId: tid(req) }, patch, { new: true });
  if (!p) return res.status(404).json({ error: "Product not found" });
  res.json({ success: true, product: p });
}));

app.delete("/api/products/:id", wrap(async (req, res) => {
  const r = await Product.deleteOne({ _id: req.params.id, organizationId: tid(req) });
  if (!r.deletedCount) return res.status(404).json({ error: "Product not found" });
  res.json({ success: true });
}));

/* =====================================================
   ORDERS  (the AI agent in n8n also uses POST /api/orders with isAI:true)
   ===================================================== */
app.get("/api/orders", wrap(async (req, res) => {
  const q = { organizationId: tid(req) };
  if (req.query.status) q.status = req.query.status;
  if (req.query.ai === "1") q.isAI = true;
  if (req.query.today === "1") q.createdAt = { $gte: startOfDay(new Date()) };
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const rows = await Order.find(q).sort({ createdAt: -1 }).limit(limit);
  res.json(rows.map(orderRow));
}));

app.post("/api/orders", wrap(async (req, res) => {
  const org = tid(req);
  const b = req.body;
  const items = (Array.isArray(b.items) ? b.items : []).map((i) => ({ ...i, qty: Number(i.qty) || 1 }));

  // reserve stock, roll back if any line is short
  const taken = [];
  for (const it of items) {
    if (!it.productId) continue;
    const p = await Product.findOneAndUpdate(
      { _id: it.productId, organizationId: org, stock: { $gte: it.qty } },
      { $inc: { stock: -it.qty } }
    );
    if (!p) {
      for (const t of taken) await Product.updateOne({ _id: t.productId }, { $inc: { stock: t.qty } });
      return res.status(409).json({ error: `Not enough stock for ${it.name || it.productId}` });
    }
    taken.push(it);
  }

  const total = b.total != null && b.total !== "" ? Number(b.total) : items.reduce((s, i) => s + (i.price || 0) * i.qty, 0);
  const paymentMethod = b.paymentMethod || "COD";
  const risk = await scoreRisk(org, { phone: b.phone, total, paymentMethod });

  const order = await Order.create({
    organizationId: org,
    orderNo: await nextOrderNo(org),
    customerName: b.customerName, phone: b.phone, address: b.address,
    items, total, paymentMethod,
    paymentStatus: b.paymentStatus || (paymentMethod === "COD" ? "unpaid" : "paid"),
    channel: b.channel || (b.isAI ? "Messenger AI" : "Manual"),
    isAI: !!b.isAI,
    status: risk.score >= 80 ? "on_hold" : b.status || "pending",
    riskScore: risk.score, riskReasons: risk.reasons,
  });
  res.json({ success: true, order: orderRow(order) });
}));

app.put("/api/orders/:id", wrap(async (req, res) => {
  const org = tid(req);
  const order = await Order.findOne({ _id: req.params.id, organizationId: org });
  if (!order) return res.status(404).json({ error: "Order not found" });
  const { status, paymentStatus } = req.body;
  if (status === "cancelled" && order.status !== "cancelled") {
    for (const it of order.items) if (it.productId) await Product.updateOne({ _id: it.productId }, { $inc: { stock: it.qty } });
  }
  if (status) order.status = status;
  if (paymentStatus) order.paymentStatus = paymentStatus;
  await order.save();
  res.json({ success: true, order: orderRow(order) });
}));

app.post("/api/orders/:id/ship", wrap(async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, organizationId: tid(req) });
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (order.status === "cancelled" || order.status === "on_hold") return res.status(400).json({ error: `Can't ship an order that is ${order.status}` });
  const booking = await bookCourier(req.body.courier || "Pathao", order);
  order.courier = { ...booking, shippedAt: new Date() };
  order.status = "shipped";
  await order.save();
  res.json({ success: true, order: orderRow(order) });
}));

/* =====================================================
   MESSENGER INBOX
   ===================================================== */
app.get("/api/conversations", wrap(async (req, res) => {
  const q = { organizationId: tid(req) };
  if (req.query.status) q.status = req.query.status;
  const rows = await Conversation.find(q).select("-messages").sort({ updatedAt: -1 }).limit(200);
  res.json(rows.map((c) => ({
    id: String(c._id), customer: c.customerName, channel: c.channel, last: c.lastMessage,
    status: c.status, unread: c.unread, time: c.updatedAt,
  })));
}));

app.get("/api/conversations/:id", wrap(async (req, res) => {
  const c = await Conversation.findOneAndUpdate({ _id: req.params.id, organizationId: tid(req) }, { unread: 0 }, { new: true });
  if (!c) return res.status(404).json({ error: "Conversation not found" });
  res.json(c);
}));

// n8n posts every incoming customer message here (needsReview:true when the AI is unsure)
app.post("/api/inbox/inbound", needSecret, wrap(async (req, res) => {
  const { psid, customerName, text, channel, needsReview, aiReply } = req.body;
  if (!psid || !text) return res.status(400).json({ error: "psid and text are required" });
  const push = [{ from: "customer", text }];
  if (aiReply) push.push({ from: "ai", text: aiReply });
  const set = { lastMessage: aiReply || text };
  if (customerName) set.customerName = customerName;
  if (channel) set.channel = channel;
  const c = await Conversation.findOneAndUpdate(
    { organizationId: tid(req), psid },
    { $set: set, $push: { messages: { $each: push } }, $inc: { unread: 1 }, $setOnInsert: { status: "open" } },
    { upsert: true, new: true }
  );
  if (needsReview && c.status !== "needs_review") { c.status = "needs_review"; await c.save(); }
  else if (c.status === "closed") { c.status = "open"; await c.save(); }
  res.json({ success: true, id: String(c._id) });
}));

app.post("/api/conversations/:id/reply", wrap(async (req, res) => {
  const text = String(req.body.text || "").trim();
  if (!text) return res.status(400).json({ error: "Reply text is required" });
  const c = await Conversation.findOne({ _id: req.params.id, organizationId: tid(req) });
  if (!c) return res.status(404).json({ error: "Conversation not found" });
  c.messages.push({ from: "agent", text });
  c.lastMessage = text;
  c.status = "open";
  await c.save();
  // hand the message to n8n so it can send it through the Messenger API (best effort)
  fetch(N8N_REPLY, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ psid: c.psid, text }) })
    .catch((e) => console.warn("Reply webhook failed:", e.message));
  res.json({ success: true });
}));

app.put("/api/conversations/:id", wrap(async (req, res) => {
  const c = await Conversation.findOneAndUpdate({ _id: req.params.id, organizationId: tid(req) }, { status: req.body.status }, { new: true });
  if (!c) return res.status(404).json({ error: "Conversation not found" });
  res.json({ success: true });
}));

/* =====================================================
   FRAUD SHIELD
   ===================================================== */
app.get("/api/fraud/orders", wrap(async (req, res) => {
  const rows = await Order.find({ organizationId: tid(req), riskScore: { $gte: 30 } }).sort({ createdAt: -1 }).limit(100);
  res.json(rows.map(orderRow));
}));

app.get("/api/fraud/blacklist", wrap(async (req, res) => {
  res.json(await Blacklist.find({ organizationId: tid(req) }).sort({ createdAt: -1 }));
}));

app.post("/api/fraud/blacklist", wrap(async (req, res) => {
  const org = tid(req);
  const { phone, reason } = req.body;
  if (!phone) return res.status(400).json({ error: "phone is required" });
  await Blacklist.updateOne({ organizationId: org, phone }, { $setOnInsert: { reason: reason || "Blocked manually" } }, { upsert: true });
  await Order.updateMany({ organizationId: org, phone, status: "pending" }, { status: "on_hold" });
  res.json({ success: true });
}));

app.delete("/api/fraud/blacklist/:id", wrap(async (req, res) => {
  await Blacklist.deleteOne({ _id: req.params.id, organizationId: tid(req) });
  res.json({ success: true });
}));

/* =====================================================
   COURIER HUB
   ===================================================== */
app.get("/api/courier/shipments", wrap(async (req, res) => {
  const rows = await Order.find({
    organizationId: tid(req),
    status: { $in: ["confirmed", "processing", "shipped", "delivered"] },
  }).sort({ createdAt: -1 }).limit(100);
  res.json(rows.map(orderRow));
}));

/* =====================================================
   AI AGENT SETTINGS
   ===================================================== */
app.get("/api/agent", wrap(async (req, res) => {
  const org = tid(req);
  const c = await AgentConfig.findOneAndUpdate({ organizationId: org }, { $setOnInsert: {} }, { upsert: true, new: true, setDefaultsOnInsert: true });
  res.json(c);
}));

app.put("/api/agent", wrap(async (req, res) => {
  const allowed = ["enabled", "autoConfirm", "tone", "escalateBelow", "greeting"];
  const patch = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  const c = await AgentConfig.findOneAndUpdate({ organizationId: tid(req) }, patch, { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true });
  res.json({ success: true, config: c });
}));

/* =====================================================
   ANALYTICS
   ===================================================== */
app.get("/api/analytics", wrap(async (req, res) => {
  const org = tid(req);
  const from = startOfDay(Date.now() - 6 * DAY);
  const base = { organizationId: org, status: { $ne: "cancelled" } };
  const [daily, channels, statuses] = await Promise.all([
    Order.aggregate([
      { $match: { ...base, createdAt: { $gte: from } } },
      { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, revenue: { $sum: "$total" }, orders: { $sum: 1 } } },
    ]),
    Order.aggregate([{ $match: base }, { $group: { _id: "$channel", orders: { $sum: 1 }, revenue: { $sum: "$total" } } }, { $sort: { revenue: -1 } }]),
    Order.aggregate([{ $match: { organizationId: org } }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
  ]);
  const byDay = Object.fromEntries(daily.map((d) => [d._id, d]));
  const days = Array.from({ length: 7 }, (_, i) => {
    const key = new Date(from.getTime() + i * DAY).toLocaleDateString("en-CA"); // YYYY-MM-DD, local
    return { date: key, revenue: byDay[key]?.revenue || 0, orders: byDay[key]?.orders || 0 };
  });
  res.json({
    daily: days,
    channels: channels.map((c) => ({ channel: c._id, orders: c.orders, revenue: c.revenue })),
    statuses: statuses.map((s) => ({ status: s._id, count: s.count })),
  });
}));

/* =====================================================
   SUBSCRIPTION  (hook up bKash / SSLCommerz / Stripe before charging real money)
   ===================================================== */
app.get("/api/subscription", wrap(async (req, res) => {
  const org = tid(req);
  const o = (await Organization.findById(org)) || { plan: "free", planStatus: "active", planRenewsAt: null };
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const [aiOrders, pages] = await Promise.all([
    Order.countDocuments({ organizationId: org, isAI: true, createdAt: { $gte: monthStart } }),
    SocialAccount.countDocuments({ organizationId: org }),
  ]);
  res.json({ plan: o.plan, status: o.planStatus, renewsAt: o.planRenewsAt, limits: PLANS[o.plan], usage: { aiOrders, pages }, plans: PLANS });
}));

app.put("/api/subscription", wrap(async (req, res) => {
  const { plan } = req.body;
  if (!PLANS[plan]) return res.status(400).json({ error: "Unknown plan" });
  const renewsAt = plan === "free" ? null : new Date(Date.now() + 30 * DAY);
  await Organization.updateOne({ _id: tid(req) }, { plan, planStatus: "active", planRenewsAt: renewsAt }, { upsert: true });
  res.json({ success: true });
}));

/* =====================================================
   OVERVIEW (feeds every KPI card on the dashboard)
   ===================================================== */
app.get("/api/overview", wrap(async (req, res) => {
  const org = tid(req);
  const today = startOfDay(new Date());
  const yest = startOfDay(Date.now() - DAY);
  const T = { createdAt: { $gte: today } };
  const Y = { createdAt: { $gte: yest, $lt: today } };
  const weekAgo = new Date(Date.now() - 7 * DAY);

  const [
    tAll, yAll, tAI, yAI, total, paidNow, paidBefore,
    openThreads, needsReview, products, b2bLeads,
    threadsD, reviewD, productsD, leadsD,
  ] = await Promise.all([
    sumOrders(org, T), sumOrders(org, Y),
    sumOrders(org, { ...T, isAI: true }), sumOrders(org, { ...Y, isAI: true }),
    sumOrders(org),
    sumOrders(org, { paymentStatus: "paid" }),
    sumOrders(org, { paymentStatus: "paid", createdAt: { $lt: weekAgo } }),
    Conversation.countDocuments({ organizationId: org, status: { $ne: "closed" } }),
    Conversation.countDocuments({ organizationId: org, status: "needs_review" }),
    Product.countDocuments({ organizationId: org }),
    Lead.countDocuments({ organizationId: org }),
    weekDelta(Conversation, org), weekDelta(Conversation, org, { status: "needs_review" }),
    weekDelta(Product, org), weekDelta(Lead, org),
  ]);

  res.json({
    revenueToday: tAll.revenue, revenueDelta: pct(tAll.revenue, yAll.revenue),
    ordersTodayNote: `${tAll.count} orders recorded today`,
    ordersToday: tAll.count, ordersTotal: total.count, ordersDelta: pct(tAll.count, yAll.count),
    aiOrders: tAI.count, aiDelta: pct(tAI.count, yAI.count),
    collected: paidNow.revenue, collectedDelta: pct(paidNow.revenue, paidBefore.revenue),
    openThreads, threadsDelta: threadsD,
    needsReview, reviewDelta: reviewD,
    products, productsDelta: productsD,
    b2bLeads, leadsDelta: leadsD,
  });
}));

app.get("/api/stats", wrap(async (req, res) => {
  const org = tid(req);
  const [totalLeads, hotLeads, totalContent, publishedContent] = await Promise.all([
    Lead.countDocuments({ organizationId: org }),
    Lead.countDocuments({ organizationId: org, aiStatus: "Hot" }),
    ContentItem.countDocuments({ organizationId: org }),
    ContentItem.countDocuments({ organizationId: org, status: "Approved" }),
  ]);
  res.json({ totalLeads, hotLeads, totalContent, publishedContent });
}));







const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
});

app.post("/upload", upload.single("data"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No video." });
    if (!req.body.caption) return res.status(400).json({ error: "No caption." });

    const form = new FormData();
    form.append("data", new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname);
    form.append("caption", req.body.caption);

    const r = await fetch("http://localhost:5678/webhook-test/upload-video", {
      method: "POST",
      body: form,
    });

    if (!r.ok) {
      console.error("n8n error:", await r.text());
      return res.status(502).json({ error: "n8n rejected the request." });
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

























































/* ---------- start ---------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Backend running on http://localhost:${PORT}`));