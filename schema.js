const mongoose = require("mongoose");
const { Schema, model } = mongoose;

const genId = () => new mongoose.Types.ObjectId().toString();

const jsonOptions = {
  versionKey: false,
  virtuals: false,
  transform: (_doc, ret) => {
    ret.id = String(ret._id);
    delete ret._id;
    return ret;
  },
};

const baseOpts = (extra = {}) => ({
  timestamps: { createdAt: true, updatedAt: false },
  versionKey: false,
  toJSON: jsonOptions,
  ...extra,
});
const withUpdates = { timestamps: true }; // createdAt + updatedAt

/* ============ 1. CORE ============ */
const organizationSchema = new Schema(
  {
    _id: { type: String, default: genId },
    name: { type: String, required: true },
    plan: { type: String, default: "free" }, // free | pro | business
    planStatus: { type: String, default: "active" },
    planRenewsAt: { type: Date, default: null },
  },
  baseOpts()
);

// Atomic counters (used for order numbers)
const counterSchema = new Schema(
  { _id: { type: String }, seq: { type: Number, default: 0 } },
  { versionKey: false }
);

/* ============ 2. CRM & LEADS ============ */
const leadSchema = new Schema(
  {
    _id: { type: String, required: true }, // comes from n8n leadId
    organizationId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    email: { type: String, default: null },
    aiScore: { type: Number, default: 0 },
    aiStatus: { type: String, default: "Cold" },
    aiReason: { type: String, default: null },
  },
  baseOpts()
);
leadSchema.index({ organizationId: 1, aiStatus: 1 });

const taskSchema = new Schema(
  {
    _id: { type: String, default: genId },
    organizationId: { type: String, required: true, index: true },
    leadId: { type: String, default: null, index: true },
    title: { type: String, required: true },
    priority: { type: String, default: "High" },
    status: { type: String, default: "Pending" },
  },
  baseOpts()
);
taskSchema.index({ organizationId: 1, status: 1 });

/* ============ 3. CONTENT & MARKETING ============ */
const contentVariantSchema = new Schema(
  {
    platform: { type: String, required: true },
    caption: { type: String, required: true },
  },
  { _id: true }
);

const contentItemSchema = new Schema(
  {
    _id: { type: String, default: genId },
    organizationId: { type: String, required: true, index: true },
    ownerId: { type: String, default: "system" },
    title: { type: String, required: true },
    body: { type: String, required: true },
    status: { type: String, default: "Draft" },
    language: { type: String, default: "en" },
    variants: { type: [contentVariantSchema], default: [] },
  },
  baseOpts()
);
contentItemSchema.index({ organizationId: 1, status: 1 });

/* ============ 4. COMMERCE ============ */
const productSchema = new Schema(
  {
    _id: { type: String, default: genId },
    organizationId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    sku: { type: String, required: true },
    price: { type: Number, required: true, min: 0 },
    stock: { type: Number, default: 0, min: 0 },
    lowStockAt: { type: Number, default: 5 },
    category: { type: String, default: "General" },
    imageUrl: { type: String, default: null },
  },
  baseOpts(withUpdates)
);
productSchema.index({ organizationId: 1, sku: 1 }, { unique: true });

const orderItemSchema = new Schema(
  {
    productId: { type: String, default: null },
    name: { type: String, required: true },
    qty: { type: Number, default: 1, min: 1 },
    price: { type: Number, default: 0 },
  },
  { _id: false }
);

const orderSchema = new Schema(
  {
    _id: { type: String, default: genId },
    organizationId: { type: String, required: true, index: true },
    orderNo: { type: String, required: true },
    customerName: { type: String, required: true },
    phone: { type: String, required: true, index: true },
    address: { type: String, required: true },
    items: { type: [orderItemSchema], default: [] },
    total: { type: Number, required: true, min: 0 },
    paymentMethod: { type: String, default: "COD" }, // COD | bKash | Nagad | Card
    paymentStatus: { type: String, default: "unpaid" }, // unpaid | paid
    channel: { type: String, default: "Manual" }, // Messenger AI | Facebook Comment | Lead Discovery | Manual
    isAI: { type: Boolean, default: false },
    // pending | confirmed | processing | shipped | delivered | cancelled | on_hold
    status: { type: String, default: "pending" },
    riskScore: { type: Number, default: 0 },
    riskReasons: { type: [String], default: [] },
    courier: {
      provider: { type: String, default: null },
      trackingId: { type: String, default: null },
      shippedAt: { type: Date, default: null },
    },
  },
  baseOpts(withUpdates)
);
orderSchema.index({ organizationId: 1, orderNo: 1 }, { unique: true });
orderSchema.index({ organizationId: 1, createdAt: -1 });
orderSchema.index({ organizationId: 1, status: 1 });

/* ============ 5. MESSENGER INBOX ============ */
const messageSchema = new Schema(
  {
    from: { type: String, enum: ["customer", "ai", "agent"], required: true },
    text: { type: String, required: true },
    at: { type: Date, default: Date.now },
  },
  { _id: true }
);

const conversationSchema = new Schema(
  {
    _id: { type: String, default: genId },
    organizationId: { type: String, required: true, index: true },
    psid: { type: String, required: true }, // Facebook page-scoped user id
    customerName: { type: String, default: "Customer" },
    channel: { type: String, default: "Messenger" },
    status: { type: String, default: "open" }, // open | needs_review | closed
    unread: { type: Number, default: 0 },
    lastMessage: { type: String, default: "" },
    messages: { type: [messageSchema], default: [] },
  },
  baseOpts(withUpdates)
);
conversationSchema.index({ organizationId: 1, psid: 1 }, { unique: true });
conversationSchema.index({ organizationId: 1, status: 1, updatedAt: -1 });

/* ============ 6. FRAUD SHIELD ============ */
const blacklistSchema = new Schema(
  {
    _id: { type: String, default: genId },
    organizationId: { type: String, required: true, index: true },
    phone: { type: String, required: true },
    reason: { type: String, default: "Blocked manually" },
  },
  baseOpts()
);
blacklistSchema.index({ organizationId: 1, phone: 1 }, { unique: true });

/* ============ 7. AI AGENT SETTINGS ============ */
const agentConfigSchema = new Schema(
  {
    _id: { type: String, default: genId },
    organizationId: { type: String, required: true, unique: true },
    enabled: { type: Boolean, default: true },
    autoConfirm: { type: Boolean, default: true },
    tone: { type: String, default: "friendly" },
    escalateBelow: { type: Number, default: 60, min: 0, max: 100 },
    greeting: { type: String, default: "Hi! How can I help you today?" },
  },
  baseOpts(withUpdates)
);

/* ============ 8. AUTOMATION (Idempotency) ============ */
const webhookEventSchema = new Schema(
  {
    _id: { type: String, default: genId },
    provider: { type: String, required: true },
    externalEventId: { type: String, required: true, unique: true },
    tenantId: { type: String, required: true },
    processingStatus: { type: String, default: "pending" },
  },
  baseOpts({ timestamps: { createdAt: "receivedAt", updatedAt: false } })
);
webhookEventSchema.index({ tenantId: 1, processingStatus: 1 });

const socialAccountSchema = new Schema(
  {
    _id: { type: String, default: genId },
    organizationId: { type: String, required: true, index: true },
    platform: { type: String, required: true },
    accountName: { type: String, required: true },
    accountId: { type: String, required: true },
    accessToken: { type: String, required: true },
  },
  baseOpts()
);
socialAccountSchema.index({ organizationId: 1, platform: 1 });

/* ============ MODELS ============ */
const Organization = model("Organization", organizationSchema);
const Counter = model("Counter", counterSchema);
const Lead = model("Lead", leadSchema);
const Task = model("Task", taskSchema);
const ContentItem = model("ContentItem", contentItemSchema);
const Product = model("Product", productSchema);
const Order = model("Order", orderSchema);
const Conversation = model("Conversation", conversationSchema);
const Blacklist = model("Blacklist", blacklistSchema);
const AgentConfig = model("AgentConfig", agentConfigSchema);
const WebhookEvent = model("WebhookEvent", webhookEventSchema);
const SocialAccount = model("SocialAccount", socialAccountSchema);

async function nextOrderNo(orgId) {
  const c = await Counter.findOneAndUpdate(
    { _id: `order:${orgId}` },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return `ORD-${100000 + c.seq}`;
}

async function deleteOrganizationCascade(orgId) {
  const by = { organizationId: orgId };
  await Promise.all([
    Task.deleteMany(by),
    Lead.deleteMany(by),
    ContentItem.deleteMany(by),
    SocialAccount.deleteMany(by),
    Product.deleteMany(by),
    Order.deleteMany(by),
    Conversation.deleteMany(by),
    Blacklist.deleteMany(by),
    AgentConfig.deleteMany(by),
    Counter.deleteOne({ _id: `order:${orgId}` }),
  ]);
  await Organization.deleteOne({ _id: orgId });
}

module.exports = {
  Organization,
  Counter,
  Lead,
  Task,
  ContentItem,
  Product,
  Order,
  Conversation,
  Blacklist,
  AgentConfig,
  WebhookEvent,
  SocialAccount,
  nextOrderNo,
  deleteOrganizationCascade,
};