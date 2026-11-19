// Where the AI got stuck (last 7 days), so the shop can teach it in one tap:
//   - questions the AI handed to a person ("not sure", "wants a photo of…")
//   - questions the shop answered itself (often something the AI didn't know)
// Teaching or skipping marks the customer's message as reviewed, so it isn't shown again.
// Complaints and AI errors are left out: there is nothing to teach there.
const { Conversation } = require("../models");

const DAYS = 7;
const SKIP_REASON = /^(Customer said|AI error|AI is not set up)/;
const question = (m) => String(m?.text || "").replace(/^🎤\s*/, "").trim();
const isAttachment = (text) => /^\[[\w, ]+\]$/.test(text) || text === "📷 [photo]";

async function stuckQuestions(org) {
  const since = new Date(Date.now() - DAYS * 86400e3);
  const convs = await Conversation.find({ organizationId: org, updatedAt: { $gte: since } })
    .select("customerName psid messages").sort({ updatedAt: -1 }).limit(300).lean();
  const items = [];
  let handedOver = 0, staffAnswered = 0;
  for (const c of convs) {
    if (String(c.psid).startsWith("sim_")) continue; // test chats
    let asked = null; // the customer's last message
    const byQuestion = new Map();
    for (const m of c.messages || []) {
      if (m.from === "customer") { asked = m; continue; }
      if (!asked || asked.reviewed || new Date(asked.at) < since) continue;
      const q = question(asked);
      if (!q || isAttachment(q)) continue;
      const key = `${c._id}|${new Date(asked.at).toISOString()}`;
      const item = byQuestion.get(key) || { key, conversationId: c._id, at: asked.at, customerName: c.customerName, question: q, reason: "", answer: "" };
      if (m.from === "system" && m.text.startsWith("Handed to a person: ")) {
        const reason = m.text.slice("Handed to a person: ".length);
        if (SKIP_REASON.test(reason)) continue;
        if (!item.reason) handedOver++;
        item.reason = reason;
      } else if (m.from === "agent" && !m.image && m.text.trim().length >= 8) {
        if (!item.answer) staffAnswered++;
        item.answer = item.answer ? `${item.answer}\n${m.text.trim()}` : m.text.trim();
      } else continue;
      byQuestion.set(key, item);
    }
    items.push(...byQuestion.values());
  }
  items.sort((a, b) => new Date(b.at) - new Date(a.at));
  return { items: items.slice(0, 30), handedOver, staffAnswered };
}

// Teach or Skip: don't show this question again
async function markReviewed(org, conversationId, at) {
  const conv = await Conversation.findOne({ _id: conversationId, organizationId: org });
  if (!conv) return false;
  const m = conv.messages.find((x) => x.from === "customer" && new Date(x.at).toISOString() === new Date(at).toISOString());
  if (!m) return false;
  m.reviewed = true;
  conv.markModified("messages");
  await conv.save();
  return true;
}

module.exports = { stuckQuestions, markReviewed };
