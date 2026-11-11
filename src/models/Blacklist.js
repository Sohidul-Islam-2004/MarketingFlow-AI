// Blocked phone numbers (Fraud Shield)
const { mongoose, Schema, newId, options } = require("./_base");

const blacklistSchema = new Schema(
  {
    _id: { type: String, default: newId },
    organizationId: { type: String, required: true },
    phone: { type: String, required: true },
    reason: { type: String, default: "" },
  },
  options
);
blacklistSchema.index({ organizationId: 1, phone: 1 }, { unique: true });

module.exports = mongoose.model("Blacklist", blacklistSchema);
