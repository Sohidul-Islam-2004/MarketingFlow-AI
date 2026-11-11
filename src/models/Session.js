// Login sessions. The cookie holds a random token; only its sha256 hash is stored here.
const { mongoose, Schema, options } = require("./_base");

const sessionSchema = new Schema(
  {
    _id: { type: String, required: true }, // sha256(token)
    userId: { type: String, required: true, index: true },
    organizationId: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  options
);
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // MongoDB deletes expired sessions

module.exports = mongoose.model("Session", sessionSchema);
