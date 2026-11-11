// Facebook comment engine.
//
// New comment -> spam check -> category (price, stock, size, delivery, order, complaint, praise, other)
//   -> buying question: private Messenger reply (DM), and the chat continues with the AI agent
//   -> public reply from a fixed template with your real prices, sent after a delay (or after you approve)
//   -> complaints and negative comments: nothing is sent, the comment waits for you in "Needs you"
const { Comment, Conversation, Product, Organization } = require("../models");
const { graph } = require("../lib/graph");
const { decrypt } = require("../lib/crypto");
const { taka } = require("../lib/utils");
const { normalizeText, DEFAULT_ZONES } = require("../lib/places");
const { notify } = require("../lib/notify");
const { priceOf } = require("./stock");
const messenger = require("./messenger");

const RULES = [
  ["complaint", /(fake|ভুয়া|বাটপার|batpar|প্রতারক|scam|cheat|worst|খারাপ|kharap|নষ্ট|damaged|broken|refund|রিফান্ড|ফেরত|পাইনি|pai nai|paini|not received|ধোকা|dhoka|বাজে|baje)/i],
  ["order", /(\border\b|অর্ডার|nibo|নিব|নেব|lagbe|লাগবে|\bbuy\b|kinbo|কিনব|confirm|\binbox\b|ইনবক্স|\bib\b|\bdm\b|\bpm\b)/i],
  ["delivery", /(delivery|ডেলিভারি|courier|কুরিয়ার|charge|চার্জ|কবে পাব|kobe pabo|ঢাকার বাইরে|outside dhaka)/i],
  ["price", /(price|prize|\bdam\b|daam|দাম|প্রাইস|কত টাকা|koto taka|\bkoto\b|কত|how much|\bpp\b)/i],
  ["size", /(\bsize\b|সাইজ|\bcolou?r\b|কালার|রং|\bxxl\b|\bxl\b|মাপ)/i],
  ["stock", /(available|\bache\b|\base\b|আছে|stock|স্টক|pawa jabe|পাওয়া যাবে)/i],
  ["praise", /(nice|good|great|awesome|wow|love|beautiful|sundor|সুন্দর|ভালো|valo|bhalo|অসাধারণ|দারুণ|darun|❤|😍|👍|🥰)/i],
];
const BUYING = ["price", "stock", "size", "delivery", "order"];
const SPAM = /(https?:\/\/|www\.|\.com\b|t\.me\/|bit\.ly|wa\.me)/i;

function categorize(text, blockedWords = []) {
  const t = String(text || "");
  const blocked = blockedWords.find((w) => w && t.toLowerCase().includes(w.toLowerCase()));
  if (blocked) return { category: "spam", note: `contains blocked word "${blocked}"` };
  if (SPAM.test(t)) return { category: "spam", note: "contains a link" };
  if (/(.)\1{9,}/u.test(t)) return { category: "spam", note: "repeated characters" };
  const rule = RULES.find(([, re]) => re.test(t));
  return { category: rule ? rule[0] : "other", note: rule ? "" : "no rule matched" };
}

// Products whose name appears in the comment
function mentionedProducts(text, products) {
  const t = normalizeText(text);
  return products.filter((p) => [p.name, p.nameBn].filter(Boolean).some((n) => normalizeText(n).split(" ").filter((w) => w.length > 2).some((w) => t.includes(` ${w} `))));
}

// Public reply templates: only facts from your database
function templateReply(category, product, zones) {
  const prices = product ? [...new Set(product.variants.map((v) => priceOf(product, v)))].sort((a, b) => a - b) : [];
  const priceText = prices.length > 1 ? `${taka(prices[0])} – ${taka(prices[prices.length - 1])}` : prices.length ? taka(prices[0]) : "";
  const sizes = product ? product.variants.filter((v) => v.available > 0 && v.name !== "Default").map((v) => v.name).join(", ") : "";
  const inStock = product && product.variants.some((v) => v.available > 0);
  const inside = zones.find((z) => (z.districts || []).includes("Dhaka")) || zones[0];
  const outside = zones.find((z) => z.isDefault) || zones[zones.length - 1];
  switch (category) {
    case "price": return product ? `${product.name} এর দাম ${priceText}। বিস্তারিত ইনবক্সে পাঠিয়েছি ✅` : "দাম ও বিস্তারিত ইনবক্সে পাঠিয়েছি, চেক করুন ✅";
    case "stock": return !product ? "বিস্তারিত ইনবক্সে পাঠিয়েছি ✅" : inStock ? `জি, ${product.name} স্টকে আছে ✅${sizes ? ` (${sizes})` : ""} অর্ডার করতে ইনবক্স চেক করুন।` : `দুঃখিত, ${product.name} এখন স্টকে নেই। ইনবক্সে অন্য অপশন জানাচ্ছি 🙏`;
    case "size": return product && sizes ? `${product.name} পাওয়া যাচ্ছে: ${sizes}। ইনবক্সে বিস্তারিত পাঠিয়েছি ✅` : "সাইজ/কালারের বিস্তারিত ইনবক্সে পাঠিয়েছি ✅";
    case "delivery": return `ডেলিভারি চার্জ: ${inside.name} ${taka(inside.fee)}, ${outside.name} ${taka(outside.fee)}। ক্যাশ অন ডেলিভারি ✅`;
    case "order": return "ধন্যবাদ! ইনবক্সে মেসেজ পাঠিয়েছি, সেখানে অর্ডারটি কনফার্ম করুন ✅";
    case "praise": return "ধন্যবাদ ❤️";
    default: return "";
  }
}

const isSimulated = (c) => String(c.commentId).startsWith("sim_");

async function pageToken(org, pageId) {
  const page = await messenger.pageOf(org, pageId);
  return { page, token: decrypt(page.accessToken) };
}

// Private reply: Meta allows exactly one Messenger message per comment. It opens a chat in the inbox.
async function sendDm(org, comment) {
  if (comment.dmSent) return;
  const text = `আসসালামু আলাইকুম ${String(comment.fromName).split(" ")[0]}! 👋 আপনার কমেন্টের জন্য ধন্যবাদ। কোন পণ্য, সাইজ/কালার আর কয়টা লাগবে জানালে এখানেই অর্ডার রেডি করে দিচ্ছি।`;
  let psid = `sim_comment_${comment.commentId}`;
  if (!isSimulated(comment)) {
    const { page, token } = await pageToken(org, comment.pageId);
    const sent = await graph(`/${page.accountId}/messages`, { token, method: "POST", body: { recipient: { comment_id: comment.commentId }, message: { text } } });
    psid = String(sent.recipient_id || psid);
  }
  await messenger.oneAtATime(`${org}:${psid}`, async () => {
    let conv = await Conversation.findOne({ organizationId: org, psid });
    if (!conv) conv = new Conversation({ organizationId: org, psid, channel: isSimulated(comment) ? "Simulator" : "Messenger", pageId: comment.pageId, customerName: comment.fromName });
    messenger.addMessage(conv, "customer", `(Comment on your post) ${comment.message}`);
    messenger.addMessage(conv, "ai", text);
    conv.unread = (conv.unread || 0) + 1;
    await conv.save();
  });
  comment.dmSent = true;
}

async function postPublicReply(org, comment, text) {
  if (!isSimulated(comment)) {
    const { token } = await pageToken(org, comment.pageId);
    await graph(`/${comment.commentId}/comments`, { token, method: "POST", body: { message: text } });
  }
  comment.reply = text;
  comment.replySentAt = new Date();
  comment.status = "replied";
  comment.error = "";
}

async function hideOnFacebook(org, comment, hidden = true) {
  if (isSimulated(comment)) return;
  const { token } = await pageToken(org, comment.pageId);
  await graph(`/${comment.commentId}`, { token, method: "POST", body: { is_hidden: hidden } });
}

// Called for every new comment (from the webhook or the simulator)
async function handleNewComment(org, { pageId, commentId, postId, fromName, message }) {
  const o = await Organization.findById(org).select("comments zones").lean();
  const settings = { autoReply: true, sendDm: true, delaySec: 30, needApproval: false, hideSpam: false, blockedWords: [], ...(o?.comments || {}) };
  let comment;
  try {
    comment = await Comment.create({ organizationId: org, pageId, commentId, postId, fromName: fromName || "Someone", message: String(message || "").slice(0, 2000) });
  } catch (e) {
    if (e.code === 11000) return null; // Meta sent the same comment twice
    throw e;
  }

  const { category, note } = categorize(comment.message, settings.blockedWords);
  comment.category = category;
  comment.note = note;

  if (category === "spam") {
    comment.status = "spam";
    if (settings.hideSpam) await hideOnFacebook(org, comment).catch((e) => (comment.error = e.message));
    return comment.save();
  }
  if (category === "complaint") {
    comment.status = "needs_human";
    comment.note = "complaint: reply yourself";
    await notify(org, `${comment.fromName} left a complaint`, comment.message.slice(0, 140), "comments");
    return comment.save();
  }

  if (settings.sendDm && BUYING.includes(category)) {
    await sendDm(org, comment).catch((e) => (comment.error = `DM failed: ${e.message}`));
  }

  const products = await Product.find({ organizationId: org, archived: { $ne: true } }).lean();
  const product = mentionedProducts(comment.message, products)[0] || null;
  const text = settings.autoReply ? templateReply(category, product, o?.zones?.length ? o.zones : DEFAULT_ZONES) : "";
  if (!text) {
    comment.status = comment.dmSent ? "replied" : category === "other" ? "needs_human" : "ignored";
    if (category === "other") comment.note = "question the engine doesn't understand: reply yourself";
    return comment.save();
  }
  comment.reply = text;
  if (settings.needApproval) comment.status = "approval";
  else {
    comment.status = "waiting";
    comment.replySendAt = new Date(Date.now() + Math.max(0, Math.min(600, settings.delaySec)) * 1000);
  }
  return comment.save();
}

// Background job: sends public replies whose delay is over
async function sendWaitingReplies() {
  const due = await Comment.find({ status: "waiting", replySendAt: { $lte: new Date() } }).limit(50);
  for (const c of due) {
    try { await postPublicReply(c.organizationId, c, c.reply); }
    catch (e) { c.status = "failed"; c.error = e.message; }
    await c.save();
  }
}

module.exports = { categorize, templateReply, handleNewComment, sendWaitingReplies, postPublicReply, sendDm, hideOnFacebook, isSimulated };
