// Sending Messenger and Instagram messages to customers. Both go through the connected Facebook Page
// (an Instagram chat keeps its Page id in conv.pageId).
const { SocialAccount } = require("../models");
const { graph } = require("../lib/graph");
const { decrypt } = require("../lib/crypto");
const { fail } = require("../lib/errors");

const REPLY_WINDOW = 24 * 3600e3; // Meta only allows replies within 24h of the customer's last message

const isSimulator = (conv) => String(conv.psid).startsWith("sim_");
const canReply = (conv) => isSimulator(conv) || (!!conv.lastCustomerAt && Date.now() - new Date(conv.lastCustomerAt) < REPLY_WINDOW);

// Adds a message to the conversation (keeps the last 300)
function addMessage(conv, from, text, extra = {}) {
  conv.messages.push({ from, text: String(text || "").slice(0, 4000) || "(empty)", ...extra });
  if (conv.messages.length > 300) conv.messages.splice(0, conv.messages.length - 300);
  if (from !== "system") conv.lastMessage = String(text).slice(0, 200);
  return conv.messages[conv.messages.length - 1];
}

async function pageOf(org, pageId) {
  const page = await SocialAccount.findOne({ organizationId: org, platform: "Facebook", ...(pageId ? { accountId: pageId } : {}) }).select("+accessToken");
  if (!page) throw fail(400, "Facebook Page is not connected");
  return page;
}

// Sends text. quickReplies = ["✅ Confirm", "✏️ Change"] shows buttons under the message.
async function sendText(org, conv, text, quickReplies = []) {
  if (isSimulator(conv)) return {};
  if (!canReply(conv)) throw fail(400, "The 24-hour reply window is closed. Meta only lets you answer after the customer messages again.");
  const page = await pageOf(org, conv.pageId);
  const message = { text: String(text).slice(0, conv.channel === "Instagram" ? 1000 : 2000) };
  if (quickReplies.length) message.quick_replies = quickReplies.map((t) => ({ content_type: "text", title: t.slice(0, 20), payload: t }));
  return graph(`/${page.accountId}/messages`, { token: decrypt(page.accessToken), method: "POST", body: { recipient: { id: conv.psid }, messaging_type: "RESPONSE", message } });
}

// Shows "seen" + the typing dots to the customer while the AI thinks. Never throws.
function showTyping(org, conv) {
  if (isSimulator(conv)) return;
  pageOf(org, conv.pageId)
    .then(async (page) => {
      const send = (sender_action) => graph(`/${page.accountId}/messages`, { token: decrypt(page.accessToken), method: "POST", body: { recipient: { id: conv.psid }, sender_action } });
      await send("mark_seen");
      await send("typing_on");
    })
    .catch(() => {});
}

// Bot/agent message: saved in the chat even if sending fails (the error is shown in the inbox)
async function reply(org, conv, from, text, quickReplies = []) {
  const msg = addMessage(conv, from, text, quickReplies.length ? { buttons: quickReplies.slice(0, 13) } : {});
  try {
    const r = await sendText(org, conv, text, quickReplies);
    msg.mid = r.message_id || null;
  } catch (e) {
    msg.error = e.message;
  }
  return msg;
}

// Messages from the same customer are handled one at a time (no double replies)
const queues = new Map();
function oneAtATime(key, task) {
  const run = (queues.get(key) || Promise.resolve()).catch(() => {}).then(task);
  queues.set(key, run);
  run.finally(() => queues.get(key) === run && queues.delete(key)).catch(() => {});
  return run;
}

module.exports = { isSimulator, canReply, addMessage, pageOf, sendText, reply, showTyping, oneAtATime };
