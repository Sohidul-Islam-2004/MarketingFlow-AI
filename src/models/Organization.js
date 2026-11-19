// A workspace = one business. All other data belongs to an organization.
const { mongoose, Schema, newId, options } = require("./_base");

const zoneSchema = new Schema(
  { name: String, fee: Number, districts: [String], areas: [String], isDefault: Boolean, freeOver: { type: Number, default: 0 } },
  { _id: false }
);

const organizationSchema = new Schema(
  {
    _id: { type: String, default: newId },
    name: { type: String, required: true },
    phone: { type: String, default: "" },
    website: { type: String, default: "" }, // read by "AI Training"

    // Set by the Super Admin (routes/admin.js). A suspended or expired shop can't open the
    // dashboard and its AI stops answering customers.
    plan: { type: String, default: "trial" }, // trial | basic | pro (just a label for now)
    expiresAt: { type: Date, default: null }, // null = no end date
    suspended: { type: Boolean, default: false },

    // The shop's own Meta app (optional, services/metaApp.js). Empty = use the shared app from .env.
    // { appId, appSecret (encrypted), configId, name, savedAt, webhookOk, webhookNote }
    metaApp: { type: Schema.Types.Mixed, default: null },
    logoUrl: { type: String, default: "" },
    returnPolicy: { type: String, default: "" }, // printed on invoices
    orderPrefix: { type: String, default: "ORD-" },
    zones: { type: [zoneSchema], default: [] }, // empty = built-in Dhaka zones

    // AI sales agent (inbox)
    ai: {
      enabled: { type: Boolean, default: true },
      autoConfirm: { type: Boolean, default: true }, // AI orders start as "confirmed" instead of "pending"
      tone: { type: String, default: "friendly" },
      handoffBelow: { type: Number, default: 60 }, // hand chat to a human when AI confidence is below this %
      knowledge: { type: String, default: "" }, // policies, FAQ, size chart: the only facts the AI may use
      deliveryTime: { type: String, default: "24-48 hours inside Dhaka, 3-5 days outside" },
      handoffMessage: { type: String, default: "ধন্যবাদ! আমাদের টিমের একজন শীঘ্রই আপনাকে উত্তর দেবেন 🙏" },
      followUp: { type: Boolean, default: true }, // remind a customer once who stopped in the middle of an order
    },

    // Facebook comment engine
    comments: {
      autoReply: { type: Boolean, default: true }, // public reply under the comment
      sendDm: { type: Boolean, default: true }, // private reply (Messenger) for buying questions
      delaySec: { type: Number, default: 30 },
      needApproval: { type: Boolean, default: false }, // replies wait in "Approval" until you send them
      hideSpam: { type: Boolean, default: false },
      blockedWords: { type: [String], default: [] },
    },
  },
  options
);

module.exports = mongoose.model("Organization", organizationSchema);
