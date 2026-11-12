// A connected Facebook Page. The token is encrypted (lib/crypto.js).
const { mongoose, Schema, newId, options } = require("./_base");

const socialAccountSchema = new Schema(
  {
    _id: { type: String, default: newId },
    organizationId: { type: String, required: true },
    platform: { type: String, required: true }, // always "Facebook"
    accountId: { type: String, required: true }, // Page id
    accountName: { type: String, required: true },
    pictureUrl: { type: String, default: null },
    accessToken: { type: String, required: true, select: false },
    status: { type: String, default: "active" }, // active | needs_reconnect
    statusNote: { type: String, default: null },
    webhooksOn: { type: Boolean, default: false }, // Page subscribed to messages + comments
    lastWebhookAt: { type: Date, default: null },
  },
  options
);
socialAccountSchema.index({ organizationId: 1, platform: 1, accountId: 1 }, { unique: true });
socialAccountSchema.index({ platform: 1, accountId: 1 }); // webhook lookup

module.exports = mongoose.model("SocialAccount", socialAccountSchema);
