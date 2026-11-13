// The person who logs in. Each user owns exactly one workspace.
const { mongoose, Schema, newId, options } = require("./_base");

const userSchema = new Schema(
  {
    _id: { type: String, default: newId },
    organizationId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, default: "", select: false }, // empty until the invite link is used
    resetTokenHash: { type: String, default: null, select: false }, // "set your password" link (invite / reset)
    resetExpiresAt: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
    failedLogins: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
  },
  options
);

module.exports = mongoose.model("User", userSchema);
