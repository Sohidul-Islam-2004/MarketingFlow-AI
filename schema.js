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

/* ============ 1. CORE ============ */
const organizationSchema = new Schema(
  {
    _id: { type: String, default: genId },
    name: { type: String, required: true },
  },
  baseOpts()
);

/* ============ 2. CRM & LEADS ============ */
const leadSchema = new Schema(
  {
    _id: { type: String, required: true },              // comes from n8n leadId
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

/* ============ 4. AUTOMATION (Idempotency) ============ */
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
const Lead = model("Lead", leadSchema);
const Task = model("Task", taskSchema);
const ContentItem = model("ContentItem", contentItemSchema);
const WebhookEvent = model("WebhookEvent", webhookEventSchema);
const SocialAccount = model("SocialAccount", socialAccountSchema);

async function deleteOrganizationCascade(orgId) {
  await Promise.all([
    Task.deleteMany({ organizationId: orgId }),
    Lead.deleteMany({ organizationId: orgId }),
    ContentItem.deleteMany({ organizationId: orgId }),
    SocialAccount.deleteMany({ organizationId: orgId }),
  ]);
  await Organization.deleteOne({ _id: orgId });
}

module.exports = {
  Organization,
  Lead,
  Task,
  ContentItem,
  WebhookEvent,
  SocialAccount,
  deleteOrganizationCascade,
};