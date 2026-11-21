// Meta webhooks: Messenger + Instagram messages, and Facebook + Instagram comments arrive here.
// The callback URL is registered automatically when the server starts (services/webhookSetup.js).
const router = require("express").Router();
const crypto = require("crypto");
const { SocialAccount, Conversation, ProcessedEvent } = require("../models");
const { graph } = require("../lib/graph");
const { decrypt } = require("../lib/crypto");
const { META } = require("../config");
const messenger = require("../services/messenger");
const { allSecrets, ourAppIds } = require("../services/metaApp");
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
    if (body.object === "instagram") {
      // entry.id = the Instagram account. Replies go out through its Facebook Page, so we need the Page too.
      const ig = await SocialAccount.findOne({ platform: "Instagram", accountId: String(entry.id) });
      if (!ig) continue;
      const page = await SocialAccount.findOne({ organizationId: ig.organizationId, platform: "Facebook", accountId: ig.pageId }).select("+accessToken");
      if (!page) continue;
      await SocialAccount.updateOne({ _id: ig._id }, { lastWebhookAt: new Date() });
      for (const event of entry.messaging || []) await onMessage(page, event, { channel: "Instagram", ownId: ig.accountId }).catch((e) => console.error("instagram message:", e));
      for (const change of entry.changes || []) if (change.field === "comments") await onInstagramComment(ig, change.value || {}).catch((e) => console.error("instagram comment:", e));
    }
  }
}

// Name + photo of the person. Facebook gives them only to apps with "Business Asset User Profile Access"
// (App Review); before that it says no, and the chat shows "Customer 4821" until the customer tells their name.
async function customerProfile(page, psid, channel) {
  try {
    if (channel === "Instagram") {
      const p = await graph(`/${psid}`, { token: decrypt(page.accessToken), params: { fields: "name,username,profile_pic" } });
      return { name: p.name || (p.username ? `@${p.username}` : null), avatar: p.profile_pic || null };
    }
    const p = await graph(`/${psid}`, { token: decrypt(page.accessToken), params: { fields: "first_name,last_name,profile_pic" } });
    return { name: [p.first_name, p.last_name].filter(Boolean).join(" ") || null, avatar: p.profile_pic || null };
  } catch (e) {
    console.warn(`customer name (${channel}):`, e.message); // usually: App Review not done yet
    return { name: null, avatar: null };
  }
}

// Ask again at most once a day while we only have "Customer"
async function fillProfile(page, conv, channel) {
  if (conv.customerName && conv.customerName !== "Customer" && conv.avatar) return;
  if (conv.profileTriedAt && Date.now() - new Date(conv.profileTriedAt).getTime() < 24 * 3600 * 1000) return;
  conv.profileTriedAt = new Date();
  const p = await customerProfile(page, conv.psid, channel);
  if (p.name && (!conv.customerName || conv.customerName === "Customer")) conv.customerName = p.name;
  if (p.avatar) conv.avatar = p.avatar;
}

// The ad shows in the chat for the shop, and the AI uses it to know which product the customer means
function rememberAd(conv, ad) {
  conv.adContext = { ...ad, at: new Date(), used: false };
  conv.markModified?.("adContext");
  messenger.addMessage(conv, "system", `📣 Came from your ad${ad.title ? `: "${ad.title}"` : ""}`, ad.photoUrl ? { image: ad.photoUrl } : {});
}

// channel = "Messenger" or "Instagram"; ownId = the Page id or the Instagram account id (to skip our own messages)
async function onMessage(page, event, { channel = "Messenger", ownId = page.accountId } = {}) {
  const org = page.organizationId;
  const msg = event.message;

  // "Echo" = Facebook's copy of a message the Page sent. Our own replies (AI or the Inbox) come back
  // too: skip those. If a person answered from Business Suite / the Page inbox, show it and pause the AI.
  if (msg?.is_echo) {
    if (msg.app_id && (await ourAppIds(org)).includes(String(msg.app_id))) return; // sent by MarketingFlow
    const psid = String(event.recipient?.id);
    await messenger.oneAtATime(`${org}:${psid}`, async () => {
      const conv = await Conversation.findOne({ organizationId: org, psid });
      if (!conv) return;
      if (msg.mid && conv.messages.some((m) => m.mid === msg.mid)) return; // we sent it (we keep the id of every message we send)
      const photo = (msg.attachments || []).find((a) => a.type === "image" && a.payload?.url)?.payload.url;
      const other = (msg.attachments || []).find((a) => a.type !== "image")?.type;
      // A reply within seconds of the customer is automatic (Business Suite instant reply / away message,
      // Meta's own AI): show it, but keep our AI on. A person typing takes longer: then the AI pauses.
      const lastCustomer = [...conv.messages].reverse().find((m) => m.from === "customer");
      const sentAt = Number(event.timestamp) || Date.now();
      const automatic = lastCustomer?.at && sentAt - new Date(lastCustomer.at).getTime() < 15000;
      messenger.addMessage(conv, "agent", msg.text || (photo ? "📷 Photo" : `📎 ${other || "attachment"}`), { mid: msg.mid, ...(photo ? { image: photo } : {}) });
      if (!automatic) conv.aiPaused = true;
      await conv.save();
    });
    return;
  }

  const psid = String(event.sender?.id || "");
  if (!psid || psid === String(ownId)) return;
  // Came from a "Send message" ad: Facebook tells which ad (title, photo, post). With the first message,
  // or alone when the customer already had a chat with the shop.
  const ref = msg?.referral || event.referral || event.postback?.referral;
  const ad = ref && (ref.source === "ADS" || ref.ads_context_data) ? {
    adId: ref.ad_id ? String(ref.ad_id) : null, title: String(ref.ads_context_data?.ad_title || "").slice(0, 200),
    photoUrl: ref.ads_context_data?.photo_url || ref.ads_context_data?.video_url || null, postId: ref.ads_context_data?.post_id ? String(ref.ads_context_data.post_id) : null,
  } : null;
  if (ad && !msg && !event.postback) { // only the ad click, nothing written yet: remember it for their next message
    await messenger.oneAtATime(`${org}:${psid}`, async () => {
      const conv = (await Conversation.findOne({ organizationId: org, psid })) || new Conversation({ organizationId: org, psid, channel, pageId: page.accountId });
      rememberAd(conv, ad);
      await conv.save();
    });
    return;
  }
  // the 👍 like and stickers come as "image" with a sticker_id: they are stickers, not photos
  const kind = (a) => (a.payload?.sticker_id || msg?.sticker_id ? "sticker" : a.type);
  const text = msg?.quick_reply?.payload || msg?.text || event.postback?.title || (msg?.attachments?.length ? `[${[...new Set(msg.attachments.map(kind))].join(", ")}]` : "");
  if (!text) return;
  if (!(await firstTime(`msg:${msg?.mid || `${event.timestamp}:${psid}`}`))) return;
  const images = (msg?.attachments || []).filter((a) => kind(a) === "image" && a.payload?.url).map((a) => a.payload.url); // the AI can look at photos
  const captions = (msg?.attachments || []).map((a) => a.payload?.title || a.title).filter(Boolean); // caption of a shared post / reel
  const audios = (msg?.attachments || []).filter((a) => a.type === "audio" && a.payload?.url).map((a) => a.payload.url); // voice messages: turned into text
  // a shared post / reel (often the shop's own): its id and caption, so the AI can tell which product it shows
  const shared = (msg?.attachments || []).filter((a) => ["share", "post", "ig_post", "reel", "ig_reel"].includes(a.type))
    .map((a) => ({ type: a.type, id: a.payload?.ig_post_media_id || a.payload?.reel_video_id || a.payload?.id || null, title: a.payload?.title || a.title || "" }));

  await messenger.oneAtATime(`${org}:${psid}`, async () => {
    let conv = await Conversation.findOne({ organizationId: org, psid });
    if (!conv) conv = new Conversation({ organizationId: org, psid, channel, pageId: page.accountId });
    if (channel !== "Simulator") await fillProfile(page, conv, channel);
    if (ad) rememberAd(conv, ad);
    messenger.addMessage(conv, "customer", text, { mid: msg?.mid || null, image: images[0] || null });
    await agent.handleCustomerMessage(org, conv, text, { images, captions, audios, shared });
    await conv.save();
  });
}

async function onFeedChange(page, v) {
  if (v.item !== "comment" || v.verb !== "add" || !v.message) return;
  if (String(v.from?.id) === String(page.accountId)) return; // the Page's own comment
  if (v.parent_id && v.parent_id !== v.post_id) return; // only top-level comments, not replies
  await comments.handleNewComment(page.organizationId, { pageId: page.accountId, commentId: v.comment_id, postId: v.post_id, fromName: v.from?.name, message: v.message });
}

// Instagram sends: { id (comment), text, from: { id, username }, media: { id }, parent_id }
async function onInstagramComment(ig, v) {
  if (!v.id || !v.text) return;
  if (String(v.from?.id) === String(ig.accountId)) return; // the shop's own comment
  if (v.parent_id) return; // only top-level comments, not replies
  if (!(await firstTime(`igc:${v.id}`))) return;
  await comments.handleNewComment(ig.organizationId, {
    platform: "Instagram", pageId: ig.pageId, commentId: v.id, postId: v.media?.id || null,
    fromName: v.from?.username ? `@${v.from.username}` : "Someone", message: v.text,
  });
}

module.exports = router;
