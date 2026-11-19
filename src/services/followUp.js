// Order recovery: a customer started an order (chose a product, or got the summary) and went quiet.
// 3 hours later the AI sends ONE friendly reminder. Only inside Meta's 24-hour reply window, never twice,
// never when a person took over the chat. The shop can switch it off: Setup → Settings → AI agent.
const { Conversation, Organization } = require("../models");
const messenger = require("./messenger");

const WAIT_HOURS = 3; // remind this long after the customer's last message
const LAST_HOURS = 20; // …but not later than this (Meta allows replies for 24 hours)

function reminderText(conv) {
  const d = conv.draft || {};
  const item = d.items?.[0];
  const name = item ? `${item.name}${item.variantName ? ` (${item.variantName})` : ""}` : "পণ্যটি";
  if (d.status === "awaiting_confirm") return { text: `আপনার ${name} এর অর্ডারটি এখনো কনফার্ম করা হয়নি 😊 সব ঠিক থাকলে নিচের Confirm চাপুন, বা কিছু বদলাতে চাইলে জানান।`, buttons: ["✅ Confirm", "✏️ Change"] };
  return { text: `আপনার পছন্দের ${name} এখনো স্টকে আছে 😊 অর্ডার করতে চাইলে জানাবেন, আমরা সাহায্য করব!`, buttons: [] };
}

async function sendReminders() {
  const now = Date.now();
  const convs = await Conversation.find({
    channel: { $in: ["Messenger", "Instagram"] },
    status: "open",
    aiPaused: { $ne: true },
    "draft.status": { $in: ["collecting", "awaiting_confirm"] },
    "draft.items.0": { $exists: true },
    lastCustomerAt: { $lte: new Date(now - WAIT_HOURS * 3600e3), $gte: new Date(now - LAST_HOURS * 3600e3) },
  }).limit(100);
  const shops = new Map();
  let sent = 0;
  for (const conv of convs) {
    if (conv.reminderAt && conv.reminderAt > conv.lastCustomerAt) continue; // already reminded since they last wrote
    const last = conv.messages[conv.messages.length - 1];
    if (!last || last.from !== "ai") continue; // the customer (or the shop) spoke last: nothing to remind
    if (!shops.has(conv.organizationId)) shops.set(conv.organizationId, await Organization.findById(conv.organizationId).select("ai suspended expiresAt").lean());
    const shop = shops.get(conv.organizationId);
    if (!shop || shop.ai?.enabled === false || shop.ai?.followUp === false || shop.suspended) continue;
    const { text, buttons } = reminderText(conv);
    await messenger.reply(conv.organizationId, conv, "ai", text, buttons);
    conv.reminderAt = new Date();
    await conv.save();
    sent++;
  }
  return sent;
}

module.exports = { sendReminders, reminderText };
