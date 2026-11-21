// A Messenger chat with one customer, plus the order the AI is collecting ("draft").
const { mongoose, Schema, Mixed, newId, options } = require("./_base");

const messageSchema = new Schema(
  {
    from: { type: String, enum: ["customer", "ai", "agent", "system"], required: true },
    text: { type: String, required: true },
    at: { type: Date, default: Date.now },
    mid: { type: String, default: null }, // Meta message id
    error: { type: String, default: null }, // why sending failed
    image: { type: String, default: null }, // photo the customer sent (Meta's link, shown in the inbox)
    buttons: { type: [String], default: undefined }, // quick-reply buttons sent with an AI message
    reviewed: { type: Boolean, default: undefined }, // AI Training: the shop taught or skipped this question (services/stuck.js)
  },
  { _id: false }
);

const conversationSchema = new Schema(
  {
    _id: { type: String, default: newId },
    organizationId: { type: String, required: true },
    psid: { type: String, required: true }, // customer id given by Meta ("sim_..." for the simulator)
    channel: { type: String, default: "Messenger" }, // Messenger | Instagram | Simulator
    pageId: { type: String, default: null },
    customerName: { type: String, default: "Customer" },
    profileTriedAt: { type: Date, default: null }, // last time we asked Facebook for the name (works after App Review)
    avatar: { type: String, default: null },

    status: { type: String, default: "open" }, // open | needs_human | closed
    aiPaused: { type: Boolean, default: false }, // a person took over
    handoffReason: { type: String, default: null },
    unread: { type: Number, default: 0 },
    lastMessage: { type: String, default: "" },
    lastCustomerAt: { type: Date, default: null }, // Meta lets us reply for 24h after this
    reminderAt: { type: Date, default: null }, // when the "you didn't finish your order" reminder was sent (services/followUp.js)
    messages: { type: [messageSchema], default: [] },

    // { items:[{productId, variantId, name, variantName, qty, price, available, variantCount}],
    //   name, phone, address, district, zone:{name, fee}, version, status: collecting | awaiting_confirm | placed }
    draft: { type: Mixed, default: () => ({ items: [], status: "collecting" }) },
    lastOrderNo: { type: String, default: null },
    adContext: { type: Mixed, default: undefined }, // the Facebook / Instagram ad the customer came from: { adId, title, photoUrl, postId, at, used }
    lastProductIds: { type: [String], default: undefined }, // products this chat is about (shared post, photo, AI reply): "ছবি দেন" sends these
  },
  options
);
conversationSchema.index({ organizationId: 1, psid: 1 }, { unique: true });
conversationSchema.index({ organizationId: 1, updatedAt: -1 });
conversationSchema.index({ organizationId: 1, status: 1 });

module.exports = mongoose.model("Conversation", conversationSchema);
