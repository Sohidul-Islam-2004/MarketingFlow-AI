// The shop-wide AI switch (Settings → AI, and the Super Admin "Shops" page).
//   On  = the AI answers every chat again: chats a person took over (or that waited for a person) get the AI back.
//   Off = the AI answers no chat. Each chat keeps its own state, so the list simply shows "AI off" everywhere.
const { Organization, Conversation } = require("../models");

async function setShopAI(org, on) {
  await Organization.updateOne({ _id: org }, { $set: { "ai.enabled": !!on } });
  if (!on) return { chats: 0 };
  const [paused, waiting] = await Promise.all([
    Conversation.updateMany({ organizationId: org, aiPaused: true }, { $set: { aiPaused: false } }, { timestamps: false }),
    Conversation.updateMany({ organizationId: org, status: "needs_human" }, { $set: { status: "open", handoffReason: null } }, { timestamps: false }),
  ]);
  return { chats: Math.max(paused.modifiedCount || 0, waiting.modifiedCount || 0) };
}

module.exports = { setShopAI };
