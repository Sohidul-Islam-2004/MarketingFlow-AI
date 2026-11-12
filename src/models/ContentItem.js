// A post for a Facebook Page.
// Status: Draft -> Scheduled -> Publishing -> Published | Partly published | Failed
const { mongoose, Schema, newId, options } = require("./_base");

const targetSchema = new Schema(
  {
    accountId: { type: String, required: true }, // SocialAccount id
    platform: String,
    accountName: String,
    status: { type: String, default: "pending" }, // pending | processing | published | failed
    postId: { type: String, default: null },
    permalink: { type: String, default: null },
    error: { type: String, default: null },
    attempts: { type: Number, default: 0 },
  },
  { _id: false }
);

const contentItemSchema = new Schema(
  {
    _id: { type: String, default: newId },
    organizationId: { type: String, required: true },
    title: { type: String, default: "" },
    text: { type: String, default: "" }, // caption
    hashtags: { type: [String], default: [] },
    mediaIds: { type: [String], default: [] },
    targets: { type: [targetSchema], default: [] },
    status: { type: String, default: "Draft" },
    scheduledAt: { type: Date, default: null },
    publishedAt: { type: Date, default: null },
    nextTryAt: { type: Date, default: null },
    lockedUntil: { type: Date, default: null },
    lastError: { type: String, default: null },
  },
  options
);
contentItemSchema.index({ organizationId: 1, createdAt: -1 });
contentItemSchema.index({ status: 1, scheduledAt: 1 });

module.exports = mongoose.model("ContentItem", contentItemSchema);
