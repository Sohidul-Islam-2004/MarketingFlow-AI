// The chat bubble on the shop's own website (public/widget.js). No login: the shop's public key is in the
// code it pastes on its website. Visitors are told apart by a random id their browser keeps.
//   GET  /api/widget/:key                      -> shop name, colour
//   GET  /api/widget/:key/messages?v=&after=   -> the chat (new messages since `after`)
//   POST /api/widget/:key/messages {v, text}   -> a visitor's message; the AI answers it like a Messenger chat
// Chats show in the Inbox as "Website"; the shop can take over and answer from there.
const router = require("express").Router();
const { Organization, Conversation } = require("../models");
const { handle, fail } = require("../lib/errors");
const messenger = require("../services/messenger");
const agent = require("../services/agent");
const { notify } = require("../lib/notify");
const { PUBLIC_BASE_URL } = require("../config");

// any website may call these (the shop's own domain)
router.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
  next();
});

async function shopOf(key) {
  const org = /^[a-z0-9]{10,40}$/i.test(String(key || "")) ? await Organization.findOne({ widgetKey: key }).select("name widgetOn widgetColor").lean() : null;
  if (!org || org.widgetOn === false) throw fail(404, "This chat is not available");
  return org;
}
const visitor = (v) => { if (!/^[a-zA-Z0-9_-]{8,64}$/.test(String(v || ""))) throw fail(400, "Missing visitor id"); return `web_${v}`; };

// A visitor can't flood the chat (and the shop's AI plan): 12 messages a minute, 150 a day
const hits = new Map();
function tooMany(id) {
  const now = Date.now();
  const list = (hits.get(id) || []).filter((t) => now - t < 24 * 3600e3);
  list.push(now);
  hits.set(id, list);
  if (hits.size > 20000) hits.clear();
  return list.filter((t) => now - t < 60e3).length > 12 || list.length > 150;
}

// what the website shows: the visitor's and the shop's messages (the shop's notes stay hidden)
const base = (req) => (/^https:\/\//.test(PUBLIC_BASE_URL) ? PUBLIC_BASE_URL.replace(/\/+$/, "") : `${req.protocol || String(req.headers["x-forwarded-proto"] || "http").split(",")[0]}://${req.headers.host}`);
const shown = (req, list, after) => list
  .filter((m) => m.from !== "system" && (!after || new Date(m.at) > after))
  .map((m) => ({ from: m.from === "customer" ? "me" : "shop", text: m.image && /^📷/.test(m.text) ? "" : m.text, image: m.image ? (m.image.startsWith("/") ? base(req) + m.image : m.image) : null, buttons: m.buttons || [], at: m.at }));

router.get("/:key", handle(async (req, res) => {
  const org = await shopOf(req.params.key);
  res.json({ name: org.name || "Shop", color: org.widgetColor || "#5b47e0" });
}));

router.get("/:key/messages", handle(async (req, res) => {
  const org = await shopOf(req.params.key);
  const conv = await Conversation.findOne({ organizationId: org._id, psid: visitor(req.query.v) }).select("messages").lean();
  const after = req.query.after ? new Date(req.query.after) : null;
  res.json({ messages: conv ? shown(req, conv.messages, after && !isNaN(after) ? after : null) : [] });
}));

router.post("/:key/messages", handle(async (req, res) => {
  const org = await shopOf(req.params.key);
  const psid = visitor(req.body.v);
  const text = String(req.body.text || "").trim().slice(0, 1000);
  if (!text) throw fail(400, "Write a message");
  if (tooMany(psid)) throw fail(429, "Too many messages. Please wait a minute.");
  const sentAt = new Date();
  let firstTime = false;
  await messenger.oneAtATime(`${org._id}:${psid}`, async () => {
    let conv = await Conversation.findOne({ organizationId: org._id, psid });
    if (!conv) {
      firstTime = true;
      conv = new Conversation({ organizationId: org._id, psid, channel: "Website", customerName: "Customer" });
    }
    conv.status = conv.status === "closed" ? "open" : conv.status;
    messenger.addMessage(conv, "customer", text);
    await agent.handleCustomerMessage(org._id, conv, text, {});
    await conv.save();
  });
  if (firstTime) notify(org._id, "New chat on your website", text.slice(0, 120), "inbox", { push: false }).catch(() => {});
  const conv = await Conversation.findOne({ organizationId: org._id, psid }).select("messages").lean();
  res.json({ messages: shown(req, conv.messages, new Date(sentAt.getTime() - 1)) });
}));

module.exports = router;
