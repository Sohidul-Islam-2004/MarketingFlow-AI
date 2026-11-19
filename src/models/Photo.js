// A small photo kept in the database (made smaller in the browser first, about 100-300 KB):
//   kind "product" = the product's photo. The AI and the shop send it in chats; it stays until replaced.
//   kind "chat"    = a photo the shop sent from the Inbox. Removed after 7 days (services/photos.js).
// Served to Facebook / Instagram (and the Inbox) at /photos/<id>
const { mongoose, Schema, newId, options } = require("./_base");

const photoSchema = new Schema(
  {
    _id: { type: String, default: newId },
    organizationId: { type: String, required: true },
    kind: { type: String, default: "product" }, // product | chat
    productId: { type: String, default: null },
    mimeType: { type: String, default: "image/jpeg" },
    data: { type: String, required: true }, // base64
    size: Number,
  },
  options
);
photoSchema.index({ organizationId: 1, productId: 1 });
photoSchema.index({ kind: 1, createdAt: 1 });

module.exports = mongoose.model("Photo", photoSchema);
