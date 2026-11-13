// Meta webhooks: Messenger messages and Page comments arrive here.
// The callback URL is registered automatically when the server starts (services/webhookSetup.js).
const router = require("express").Router();
const crypto = require("crypto");
const { SocialAccount, Conversation, ProcessedEvent } = require("../models");
const { graph } = require("../lib/graph");
const { decrypt } = require("../lib/crypto");
const { META } = require("../config");
const messenger = require("../services/messenger");
const { allSecrets } = require("../services/metaApp");
const agent = require("../services/agent");
const comments = require("../services/comments");

// Meta checks the URL once when you save it in the dashboard
router.get("/", (req, res) => {
  const ok = req.query["hub.mode"] === "subscribe" && META.VERIFY_TOKEN && req.query["hub.verify_token"] === META.VERIFY_TOKEN;
  ok ? res.send(req.query["hub.challenge"]) : res.sendStatus(403);
});

router.post("/", async (req, res) => {
  // Only accept events signed with the secret of the shared app or of a shop's own app
  const secrets = await allSecrets().catch(() => [META.APP_SECRET].filter(Boolean));
  const got = Buffer.from(String(req.headers["x-hub-signature-256"] || ""));
  const signedBy = secrets.some((secret) => {
    const expected = Buffer.from("sha256=" + crypto.createHmac("sha256", secret).update(req.rawBody || "").digest("hex"));
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  });
  if (!signedBy) return res.sendStatus(401); // no known app signed it (or no app is set up at all)
  res.sendStatus(200); // answer Meta quickly, then work
  handleEvents(req.body).catch((e) => console.error("Webhook:", e));
});

// Runs only once per event id (Meta sometimes sends the same event again)
async function firstTime(id) {
  try { await ProcessedEvent.create({ _id: id }); return true; }
  catch (e) { if (e.code === 11000) return false; throw e; }
}

async function handleEvents(body) {
  for (const entry of body.entry || []) {
    if (body.object === "page") {
      const page = await SocialAccount.findOne({ platform: "Facebook", accountId: String(entry.id) }).select("+accessToken");
      if (!page) continue;
      await SocialAccount.updateOne({ _id: page._id }, { lastWebhookAt: new Date() });
      for (const event of entry.messaging || []) await onMessage(page, event).catch((e) => console.error("message:", e));
      for (const change of entry.changes || []) if (change.field === "feed") await onFeedChange(page, change.value || {}).catch((e) => console.error("comment:", e));
    }
  }
}

async function customerProfile(page, psid) {
  try {
    const p = await graph(`/${psid}`, { token: decrypt(page.accessToken), params: { fields: "first_name,last_name,profile_pic" } });
    return { name: [p.first_name, p.last_name].filter(Boolean).join(" ") || "Customer", avatar: p.profile_pic || null };
  } catch {
    return { name: "Customer", avatar: null };
  }
}

async function onMessage(page, event) {
  const org = page.organizationId;
  const msg = event.message;

  // "Echo" = a message sent by the Page. If a person sent it from Business Suite, show it and pause the AI.
  if (msg?.is_echo) {
    if (String(msg.app_id || "") === String(META.APP_ID)) return; // sent by this app
    const psid = String(event.recipient?.id);
    await messenger.oneAtATime(`${org}:${psid}`, async () => {
      const conv = await Conversation.findOne({ organizationId: org, psid });
      if (!conv) return;
      messenger.addMessage(conv, "agent", msg.text || "[attachment]", { mid: msg.mid });
      conv.aiPaused = true;
      await conv.save();
    });
    return;
  }

  const psid = String(event.sender?.id || "");
  if (!psid || psid === String(page.accountId)) return;
  const text = msg?.quick_reply?.payload || msg?.text || event.postback?.title || (msg?.attachments?.length ? `[${msg.attachments.map((a) => a.type).join(", ")}]` : "");
  if (!text) return;
  if (!(await firstTime(`msg:${msg?.mid || `${event.timestamp}:${psid}`}`))) return;

  await messenger.oneAtATime(`${org}:${psid}`, async () => {
    let conv = await Conversation.findOne({ organizationId: org, psid });
    if (!conv) {
      const profile = await customerProfile(page, psid);
      conv = new Conversation({ organizationId: org, psid, channel: "Messenger", pageId: page.accountId, customerName: profile.name, avatar: profile.avatar });
    }
    messenger.addMessage(conv, "customer", text, { mid: msg?.mid || null });
    await agent.handleCustomerMessage(org, conv, text);
    await conv.save();
  });
}

async function onFeedChange(page, v) {
  if (v.item !== "comment" || v.verb !== "add" || !v.message) return;
  if (String(v.from?.id) === String(page.accountId)) return; // the Page's own comment
  if (v.parent_id && v.parent_id !== v.post_id) return; // only top-level comments, not replies
  await comments.handleNewComment(page.organizationId, { pageId: page.accountId, commentId: v.comment_id, postId: v.post_id, fromName: v.from?.name, message: v.message });
}

module.exports = router;
