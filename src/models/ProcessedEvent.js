// Remembers Meta webhook events we already handled, so a retry from Meta isn't processed twice.
const { mongoose, Schema, options } = require("./_base");

const processedEventSchema = new Schema(
  { _id: String, createdAt: { type: Date, default: Date.now } },
  { ...options, timestamps: false }
);
processedEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 }); // forget after 7 days

module.exports = mongoose.model("ProcessedEvent", processedEventSchema);
