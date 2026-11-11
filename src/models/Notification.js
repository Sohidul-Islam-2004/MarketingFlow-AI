// Bell notifications in the dashboard
const { mongoose, Schema, newId, options } = require("./_base");

const notificationSchema = new Schema(
  {
    _id: { type: String, default: newId },
    organizationId: { type: String, required: true },
    title: String,
    message: String,
    view: { type: String, default: null }, // page to open when clicked
    read: { type: Boolean, default: false },
  },
  options
);
notificationSchema.index({ organizationId: 1, createdAt: -1 });

module.exports = mongoose.model("Notification", notificationSchema);
