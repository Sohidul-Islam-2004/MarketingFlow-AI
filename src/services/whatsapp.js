// WhatsApp (Cloud API): sending messages from a connected WhatsApp Business number.
// Receiving is in routes/webhooks.js. Connecting a number is in routes/whatsapp.js.
//
// A number is saved as a SocialAccount: platform "WhatsApp", accountId = phone number id, wabaId = business account id.
const { SocialAccount } = require("../models");
const { graph } = require("../lib/graph");
const { decrypt } = require("../lib/crypto");
const { fail } = require("../lib/errors");

async function numberOf(org, phoneNumberId) {
  const number = await SocialAccount.findOne({ organizationId: org, platform: "WhatsApp", accountId: phoneNumberId }).select("+accessToken");
  if (!number) throw fail(400, "This WhatsApp number is not connected any more");
  return number;
}

const call = (number, body) =>
  graph(`/${number.accountId}/messages`, { token: decrypt(number.accessToken), method: "POST", body: { messaging_product: "whatsapp", ...body } });

// Sends text. buttons = ["✅ Confirm", "✏️ Change"] shows up to 3 tap buttons under the message.
async function sendText(org, conv, text, buttons = []) {
  const number = await numberOf(org, conv.pageId);
  const to = conv.psid.replace(/^wa_/, "");
  const message = buttons.length
    ? { type: "interactive", interactive: { type: "button", body: { text: String(text).slice(0, 1024) }, action: { buttons: buttons.slice(0, 3).map((t) => ({ type: "reply", reply: { id: t.slice(0, 200), title: t.slice(0, 20) } })) } } }
    : { type: "text", text: { body: String(text).slice(0, 4096), preview_url: false } };
  const r = await call(number, { recipient_type: "individual", to, ...message });
  return { message_id: r.messages?.[0]?.id || null };
}

// Blue ticks + "typing…" while the AI thinks. Needs the id of the customer's last message.
async function showTyping(org, conv) {
  const last = [...conv.messages].reverse().find((m) => m.from === "customer" && m.mid);
  if (!last) return;
  const number = await numberOf(org, conv.pageId);
  await call(number, { status: "read", message_id: last.mid, typing_indicator: { type: "text" } });
}

module.exports = { sendText, showTyping };
