// A phone or computer that wants alerts (new orders, chats that need a person). Made by the browser (sw.js).
const { mongoose, Schema, newId, options } = require("./_base");

const pushSubscriptionSchema = new Schema(
  {
    _id: { type: String, default: newId },
    organizationId: { type: String, required: true },
    userId: { type: String, default: null },
    endpoint: { type: String, required: true, unique: true },
    keys: { p256dh: String, auth: String },
    device: { type: String, default: "" }, // "Android phone", "Windows computer"…
  },
  options
);
pushSubscriptionSchema.index({ organizationId: 1 });

module.exports = mongoose.model("PushSubscription", pushSubscriptionSchema);
