// A connected Facebook Page or Instagram account. The token is encrypted (lib/crypto.js).
const { mongoose, Schema, newId, options } = require("./_base");

const socialAccountSchema = new Schema(
  {
    _id: { type: String, default: newId },
    organizationId: { type: String, required: true },
    platform: { type: String, required: true }, // Facebook | Instagram
    accountId: { type: String, required: true }, // Page id or Instagram user id
    accountName: { type: String, required: true },
    pageId: { type: String, default: null }, // Instagram: the Facebook Page it is linked to
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
