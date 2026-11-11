// An uploaded image or video (file in /uploads)
const { mongoose, Schema, newId, options } = require("./_base");

const mediaAssetSchema = new Schema(
  {
    _id: { type: String, default: newId },
    organizationId: { type: String, required: true },
    name: String,
    kind: { type: String, default: "image" }, // image | video
    mimeType: String,
    size: Number,
    file: String, // file name inside /uploads
    url: { type: String, required: true }, // "/uploads/abc.jpg"
  },
  options
);
mediaAssetSchema.index({ organizationId: 1, createdAt: -1 });

module.exports = mongoose.model("MediaAsset", mediaAssetSchema);
