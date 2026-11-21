// AI sales agent for Messenger and Instagram chats.
//
// How one customer message is handled (handleCustomerMessage):
//   1. If the bot is waiting for "Confirm" and the customer confirms -> place the order (no AI involved).
//   2. Complaints, refunds, "talk to a human" -> hand the chat to a person.
//   3. Otherwise ask the AI. It answers from your products + knowledge and fills the order "draft".
//   4. When the draft is complete the bot sends a summary with Confirm / Change buttons.
// Also: a returning customer's name/phone/address come from their last order (not asked again),
// sizes/options are offered as buttons, the AI can tell the customer how their orders are doing,
// a photo the customer sends is described by a vision model (services/vision.js) before the AI answers,
// a voice message is turned into text (lib/voice.js), and the AI can send product photos (services/photos.js).
// The AI never decides prices, delivery fees or totals: those come from the database (services/orders.js).
const { Product, Organization, Order } = require("../models");
const vision = require("./vision");
const voice = require("../lib/voice");
const photos = require("./photos");
const { STATUS_LABEL } = require("./orders");
const { blockedReason } = require("./account");
const { askAI, aiReady } = require("../lib/ai");
const { findZone, canonicalDistrict, normalizeText, DEFAULT_ZONES } = require("../lib/places");
const { normalizePhone, isValidPhone, taka } = require("../lib/utils");
const { notify } = require("../lib/notify");
const { priceOf, fullPriceOf } = require("./stock");
const { activeOffer, offerLabel } = require("../lib/offer");
const { createOrder } = require("./orders");
const messenger = require("./messenger");
const { productsIn } = require("../lib/productMatch");
const { graph } = require("../lib/graph");
const { decrypt } = require("../lib/crypto");

const CONFIRM_WORDS = /^(confirm(ed)?|yes|yeah|yep|ok(ay)?|done|sure|হ্যাঁ|হ্যা|হা|জি|জ্বি|ঠিক আছে|কনফার্ম|ওকে|ji|hae|ha)$/i;
const CHANGE_WORDS = /^(change|edit|বদল|পরিবর্তন)/i;
const HUMAN_WORDS = /(human|real person|agent|manush|মানুষ|complain|অভিযোগ|refund|রিফান্ড|ফেরত দিতে|damaged|broken|নষ্ট|ভাঙা|fraud|প্রতারণা|scam)/i;
const ATTACHMENT_ONLY = /^\[(image|audio|video|file|fallback|template|sticker|share|post|ig_post|story_mention|story|ig_story|media|reel|ig_reel)(, \w+)*\]$/i;
const BUTTONS = ["✅ Confirm", "✏️ Change"];

// Shares, reels, stories, stickers, voice… the AI can't open these. It answers from the caption when there is one,
// otherwise it politely asks which product the customer means (no hand-over to a person for this).
const ATTACHMENT_NOTE = {
  share: "shared a post", post: "shared a post", ig_post: "shared a post", ig_reel: "shared a reel", reel: "shared a reel",
  story_mention: "mentioned the shop in a story", story: "shared a story", ig_story: "shared a story", media: "sent a photo or video",
  fallback: "shared a link", template: "shared a post", sticker: "sent a sticker (like 👍)", audio: "sent a voice message",
  video: "sent a video", file: "sent a file", image: "sent a photo",
};
function attachmentText(text, captions = [], products = []) {
  const what = [...new Set(String(text).slice(1, -1).split(/,\s*/))].map((k) => ATTACHMENT_NOTE[k.toLowerCase()] || "sent an attachment").join(" and ");
  const caption = captions.find((c) => String(c || "").trim());
  // The post / reel shows our products: answer about them (in stock? price) and show their photos
  if (products.length) return `[Customer ${what} from our shop${caption ? ` (caption: "${String(caption).slice(0, 300)}")` : ""}. It shows our product${products.length > 1 ? "s" : ""}: ${products.map((p) => `${p.name} (productId ${p._id})`).join(", ")}. Answer about ${products.length > 1 ? "them" : "it"}: say if it is in stock and the price, ask which size/option if needed, and put the productIds that have a photo in "photos"]`;
  if (caption) return `[Customer ${what}. Its caption says: "${String(caption).slice(0, 300)}". If it is about one of our products, answer about that product; if you are not sure, ask which product they want]`;
  if (what.includes("sticker")) return `[Customer ${what}]`;
  return `[Customer ${what} that you cannot open. Do not guess what it shows. Politely ask which product they want: the name, or a photo/screenshot of it${what.includes("voice") ? ". Also ask them to type their message" : ""}]`;
}

async function aiSettings(org) {
  const o = await Organization.findById(org).select("ai zones name suspended expiresAt").lean();
  return { ...o, blocked: !!blockedReason(o), ai: { enabled: true, autoConfirm: true, tone: "friendly", handoffBelow: 60, knowledge: "", deliveryTime: "", handoffMessage: "", ...(o?.ai || {}) } };
}

/* ---------- what the AI is allowed to know ---------- */
function productLines(products) {
  return products.map((p) => {
    const stockText = (v) => (p.alwaysAvailable ? "available to order" : v.available > 0 ? `${v.available} in stock` : "OUT OF STOCK");
    const offer = activeOffer(p);
    const priceText = (v) => (offer ? `${taka(priceOf(p, v))} (OFFER, normal price ${taka(fullPriceOf(p, v))})` : taka(priceOf(p, v)));
    const variants = p.variants.map((v) => `${v._id}=${v.name} ${priceText(v)} ${stockText(v)}`).join("; ");
    const offerText = offer ? ` | OFFER: ${offerLabel(offer)}${offer.until ? ` until ${new Date(offer.until).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Dhaka" })}` : ""}` : "";
    // the shop's own details, in its own words (warranty, fabric, RAM…)
    const details = [...(p.info || []).filter((i) => i.value).map((i) => (i.label ? `${i.label}: ${i.value}` : i.value)), p.description].filter(Boolean).join("; ").replace(/\s+/g, " ").slice(0, 600);
    return `${p._id} | ${p.name}${p.nameBn ? " / " + p.nameBn : ""} | ${variants}${offerText}${details ? ` | details: ${details}` : ""} | photo: ${p.imageUrl ? "yes" : "no"}`;
  }).join("\n");
}

// The shop knowledge can be long (AI Training writes it from the whole website). Sending all of it with every
// message is slow and costly, so when it is longer than `budget` we send the sections that match the chat.
// Sections are separated by an empty line (AI Training writes "## Title" + "- fact" lines).
// Customers write Bangla/Banglish, the knowledge is mostly English: these add the English topic words.
const TOPICS = [
  [/ডেলিভারি|delivery|পাঠা|কুরিয়ার|courier|চার্জ|charge|কতদিন|koto ?din|shipping/i, "delivery shipping courier charge days"],
  [/ফেরত|রিটার্ন|return|exchange|বদল|change kor|refund|রিফান্ড/i, "return exchange refund"],
  [/পেমেন্ট|payment|বিকাশ|bkash|নগদ|nagad|ক্যাশ|cash|cod|advance|অগ্রিম/i, "payment bkash nagad cash advance"],
  [/ঠিকানা|address|শোরুম|showroom|outlet|আউটলেট|দোকান|store|location|কোথায়|kothay|খোলা|open/i, "address store outlet showroom location open hours"],
  [/সাইজ|size|মাপ|map|measurement/i, "size chart measurement"],
  [/ফোন|phone|নাম্বার|number|contact|যোগাযোগ|email/i, "phone contact email"],
];

function relevantKnowledge(knowledge, recentText, budget = 3500) {
  const text = String(knowledge || "").trim();
  if (text.length <= budget) return text;
  const hints = TOPICS.filter(([test]) => test.test(recentText)).map(([, english]) => english).join(" ");
  const words = [...new Set(normalizeText(`${recentText} ${hints}`).split(" ").filter((w) => w.length > 2))];
  const sections = text.split(/\n\s*\n/).map((body, index) => {
    const plain = normalizeText(body);
    return { body, index, score: words.filter((w) => plain.includes(w)).length };
  });
  const chosen = [];
  let used = 0;
  // best matches first; with no match at all the first sections (usually "about" and delivery) are used
  for (const s of [...sections].sort((a, b) => b.score - a.score || a.index - b.index)) {
    if (used + s.body.length > budget) continue;
    chosen.push(s);
    used += s.body.length;
  }
  return chosen.sort((a, b) => a.index - b.index).map((s) => s.body).join("\n\n");
}

async function knowledgeFor(org, settings, recentText, draft) {
  const all = await Product.find({ organizationId: org, archived: { $ne: true } }).lean();
  // Send the 40 products that best match the chat (and everything already in the draft)
  const words = normalizeText(recentText).split(" ").filter((w) => w.length > 1);
  const inDraft = new Set((draft?.items || []).map((i) => i.productId));
  const ranked = all
    .map((p) => ({ p, score: (inDraft.has(p._id) ? 100 : 0) + words.filter((w) => normalizeText(`${p.name} ${p.nameBn} ${p.category}`).includes(w)).length }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 40)
    .map((x) => x.p);
  const zones = settings.zones?.length ? settings.zones : DEFAULT_ZONES;
  const text = [
    `BUSINESS: ${settings.name || "our shop"}`,
    `DELIVERY FEES: ${zones.map((z) => `${z.name} ${taka(z.fee)}`).join(", ")}. Delivery time: ${settings.ai.deliveryTime || "ask the team"}. Payment: cash on delivery.`,
    settings.ai.knowledge ? `BUSINESS INFO / POLICIES / FAQ:\n${relevantKnowledge(settings.ai.knowledge, recentText)}` : "",
    `PRODUCTS (productId | name | options as variantId=name price stock | details written by the shop):\n${productLines(ranked) || "(no products yet)"}`,
  ].filter(Boolean).join("\n\n");
  return { text, products: all };
}

const ANSWER_SHAPE = `{"reply":"","intent":"question|order|confirm|change|handoff|other","confidence":0,"needsHuman":false,"handoffReason":"","draft":{"items":[{"productId":"","variantId":"","qty":1}],"name":"","phone":"","address":"","district":""},"readyToConfirm":false,"photos":["productId"]}`;

// The customer's recent orders (for "where is my order?") and the details of the last one (returning customer)
async function customerHistory(org, conv) {
  const orders = await Order.find({ organizationId: org, $or: [{ conversationId: conv._id }, ...(conv.psid ? [{ psid: conv.psid }] : [])] })
    .sort({ createdAt: -1 }).limit(3).lean();
  const last = orders.find((o) => o.customerName && o.phone && o.address);
  return { orders, known: last ? { name: last.customerName, phone: last.phone, address: last.address, district: last.district } : null };
}

function ordersText(orders) {
  if (!orders.length) return "";
  return "CUSTOMER'S ORDERS (newest first):\n" + orders.map((o) => {
    const items = (o.items || []).map((i) => `${i.name}${i.variantName ? ` (${i.variantName})` : ""} x${i.qty}`).join(", ");
    const ship = o.trackingNo ? `, courier ${o.courierName || ""} tracking ${o.trackingNo}` : "";
    const day = new Date(o.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Dhaka" });
    return `#${o.orderNo} | ${day} | ${STATUS_LABEL[o.status] || o.status} | ${items} | ${taka(o.total)}${ship}`;
  }).join("\n");
}

async function askAgent(org, settings, conv, latestText, history = { orders: [], known: null }) {
  const recent = conv.messages.filter((m) => m.from === "customer").slice(-6).map((m) => m.text).join(" ");
  const k = await knowledgeFor(org, settings, `${recent} ${latestText}`, conv.draft);
  const chat = conv.messages.slice(-16).filter((m) => m.from !== "system")
    .map((m) => `${m.from === "customer" ? "CUSTOMER" : m.from === "agent" ? "SHOP STAFF" : "YOU"}: ${m.text}`).join("\n");
  const d = conv.draft || {};
  const currentDraft = d.status === "placed" ? { items: [] } : { items: (d.items || []).map((i) => ({ productId: i.productId, variantId: i.variantId, qty: i.qty })), name: d.name || "", phone: d.phone || "", address: d.address || "", district: d.district || "" };

  const system = `You are the sales assistant of a Bangladeshi online shop, chatting on ${conv.channel === "Instagram" ? "Instagram" : "Facebook Messenger"}.
Reply in the customer's language and script (Bangla, Banglish or English). Short and warm, max 3-4 lines. Tone: ${settings.ai.tone}.
RULES
- Use ONLY the business info and PRODUCTS below. Never invent prices, stock, discounts, delivery times or policies. If you don't know, say you'll check with the team and set needsHuman=true.
- To take an order you need: product (exact productId), the variantId when the product has several sizes/colours, quantity, name, phone (01XXXXXXXXX), full address with area, and district (one of Bangladesh's 64 districts).
- Ask only for what is missing, one or two things at a time.
- If something is OUT OF STOCK, say so and suggest an in-stock alternative.
- Never offer discounts, free delivery or gifts unless the business info says so. Products marked OFFER already show their sale price: tell the customer about the offer and quote that price. Never give any other discount. Never calculate totals: the system sends the exact total.
- When everything is collected set readyToConfirm=true and reply with one short line in the customer's language saying the summary is below (e.g. "অর্ডারের সামারি নিচে দিলাম 👇"). Never say the order is placed.
- needsHuman=true for complaints, refunds, damaged items, angry customers, wholesale bargaining, or when unsure.
- "draft" must always contain the FULL draft (keep known values, add new ones).
- confidence: 0-100, how sure you are that your reply is correct.
- When asking which size/colour/option, just ask: the system shows the options as buttons.
- A message like "[Customer sent a photo: …]" is a photo described by the system: answer about that product as if they had asked about it.
- If the customer asks about an order they already placed (status, when it arrives), answer from CUSTOMER'S ORDERS ("To call" means the shop will call to confirm it). Never invent dates or tracking. To cancel or change a placed order set needsHuman=true.
- If RETURNING CUSTOMER details are given and the draft already has them, don't ask for name, phone or address again: say you'll send it to the same address and they can change it in the summary.
- PHOTOS: products marked "photo: yes" have a photo the system can send. When the customer asks to see a product (ছবি, pic, photo, দেখান) or asks about one specific product for the first time, put its productId in "photos" (max 3) and say the photo is below (e.g. "ছবি নিচে দিলাম 👇"). Never send the same photo twice in a row. Never write that a photo is below unless you put its productId in "photos". If they want a photo of a product with "photo: no", say a team member will send it and set needsHuman=true with handoffReason "wants a photo of <product>".
Return JSON only: ${ANSWER_SHAPE}`;
  const known = history.known ? `RETURNING CUSTOMER (from their last order): ${history.known.name}, ${history.known.phone}, ${history.known.address}, ${history.known.district || ""}` : "";
  const user = [k.text, ordersText(history.orders), known, `CURRENT DRAFT: ${JSON.stringify(currentDraft)}`, `CHAT SO FAR:\n${chat || "(new chat)"}`, `CUSTOMER (latest): ${latestText}`].filter(Boolean).join("\n\n");
  const answer = await askAI({ system, user, temperature: 0.3, maxTokens: 900 });
  return { answer, products: k.products };
}

/* ---------- the order draft ---------- */
// AI item -> draft line with the real price and stock
function draftLine(products, item) {
  const p = products.find((x) => x._id === String(item.productId));
  if (!p) return null;
  const v = p.variants.find((x) => x._id === String(item.variantId || "")) || (p.variants.length === 1 ? p.variants[0] : null);
  return {
    productId: p._id, variantId: v?._id || null, name: p.name, variantName: v && v.name !== "Default" ? v.name : "",
    qty: Math.max(1, Math.min(99, parseInt(item.qty, 10) || 1)), price: priceOf(p, v), fullPrice: activeOffer(p) ? fullPriceOf(p, v) : null, available: p.alwaysAvailable ? 999 : v ? v.available : 0, variantCount: p.variants.length,
  };
}

// Copies what the AI (or a staff member) filled in into conv.draft, then recalculates the delivery zone
function updateDraft(conv, settings, products, input) {
  const d = { items: [], status: "collecting", version: 0, ...(conv.draft || {}) };
  if (input.name && String(input.name).trim().length > 1) {
    d.name = String(input.name).trim().slice(0, 100);
    if (!conv.customerName || conv.customerName === "Customer") conv.customerName = d.name; // Facebook gave no name: use theirs
  }
  if (input.address && String(input.address).trim().length > 3) d.address = String(input.address).trim().slice(0, 300);
  if (input.phone) { const p = normalizePhone(input.phone); if (p.length >= 11) d.phone = p; }
  if (input.district && canonicalDistrict(input.district)) d.district = canonicalDistrict(input.district);
  if (Array.isArray(input.items) && input.items.length) {
    const lines = input.items.map((i) => draftLine(products, i)).filter(Boolean);
    if (lines.length) d.items = lines;
  }
  if (d.address || d.district) {
    const zone = findZone(settings.zones, { address: d.address, district: d.district });
    const subtotal = d.items.reduce((s, i) => s + i.price * i.qty, 0);
    d.zone = { name: zone.zone, fee: zone.freeOver && subtotal >= zone.freeOver ? 0 : zone.fee };
    if (!d.district && zone.district) d.district = zone.district;
  }
  d.version = (d.version || 0) + 1;
  conv.draft = d;
  conv.markModified("draft");
  return d;
}

function draftTotal(d) {
  const subtotal = (d.items || []).reduce((s, i) => s + i.price * i.qty, 0);
  const fee = d.zone?.fee || 0;
  return { subtotal, fee, total: subtotal + fee };
}

// What is still missing before the order can be placed
function draftMissing(d) {
  const missing = [];
  if (!d.items?.length) missing.push("product");
  for (const i of d.items || []) {
    if (!i.variantId && i.variantCount > 1) missing.push(`size/colour for ${i.name}`);
    else if ((i.available ?? 0) < i.qty) missing.push(`stock for ${i.name}${i.variantName ? " " + i.variantName : ""}`);
  }
  if (!d.name) missing.push("name");
  if (!isValidPhone(d.phone)) missing.push("phone");
  if (!d.address || d.address.length < 6) missing.push("address");
  if (!d.district) missing.push("district");
  return missing;
}

function summary(d) {
  const t = draftTotal(d);
  return [
    "🧾 অর্ডার সামারি",
    ...d.items.map((i) => `• ${i.name}${i.variantName ? ` (${i.variantName})` : ""} × ${i.qty} = ${taka(i.price * i.qty)}${i.fullPrice > i.price ? ` 🏷️ (অফার, আগে ${taka(i.fullPrice * i.qty)})` : ""}`),
    "",
    `পণ্যের দাম: ${taka(t.subtotal)}`,
    `ডেলিভারি (${d.zone?.name || "-"}): ${taka(t.fee)}`,
    `মোট (ক্যাশ অন ডেলিভারি): ${taka(t.total)}`,
    "",
    `👤 ${d.name}`, `📞 ${d.phone}`, `📍 ${d.address}, ${d.district}`,
    "",
    'সব ঠিক থাকলে "Confirm" লিখুন বা নিচের বাটনে চাপুন।',
  ].join("\n");
}

/* ---------- actions ---------- */
async function handToHuman(org, conv, reason, message) {
  conv.aiPaused = true;
  conv.status = "needs_human";
  conv.handoffReason = reason;
  messenger.addMessage(conv, "system", `Handed to a person: ${reason}`);
  if (message) await messenger.reply(org, conv, "ai", message);
  await notify(org, `${conv.customerName} needs a person`, reason, "inbox");
}

// Creates the order from the draft. Used by the bot (after "Confirm") and by staff ("Place order" button).
async function placeOrderFromDraft(org, conv, settings, by) {
  const d = conv.draft || {};
  if (d.status === "placed") throw new Error(`Order #${d.orderNo} was already placed from this chat`);
  const missing = draftMissing(d);
  if (missing.length) throw new Error("Still missing: " + missing.join(", "));
  const order = await createOrder(org, {
    customerName: d.name, phone: d.phone, address: d.address, district: d.district,
    items: d.items.map((i) => ({ productId: i.productId, variantId: i.variantId, qty: i.qty })),
    paymentMethod: "COD", source: "ai_chat", confirmed: by !== "AI", // AI orders wait until the shop calls the customer
    conversationId: conv._id, psid: conv.psid, idemKey: `chat:${conv._id}:v${d.version}`,
  }, by);
  conv.draft = { ...d, status: "placed", orderNo: order.orderNo };
  conv.markModified("draft");
  conv.lastOrderNo = order.orderNo;
  messenger.addMessage(conv, "system", `Order #${order.orderNo} created by ${by} · ${taka(order.total)}${order.duplicateOf ? ` · ⚠️ maybe the same as #${order.duplicateOf}` : ""}`);
  return order;
}

function orderPlacedText(order, settings) {
  const twice = order.duplicateOf ? `\n(আপনার আগের অর্ডার #${order.duplicateOf} টাও আছে। কল করার সময় আমরা মিলিয়ে নেব, দুবার পাঠানো হবে না।)` : "";
  if (order.status === "pending") return `✅ আপনার অর্ডার #${order.orderNo} (${taka(order.total)}) পেয়েছি। কনফার্ম করতে আমাদের টিম আপনাকে কল করবে। ধন্যবাদ 🙏${twice}`;
  return `✅ আপনার অর্ডার #${order.orderNo} কনফার্ম হয়েছে! মোট ${taka(order.total)}, ক্যাশ অন ডেলিভারি।${settings.ai.deliveryTime ? ` ডেলিভারি: ${settings.ai.deliveryTime}।` : ""} ধন্যবাদ 🙏`;
}

async function confirmOrder(org, conv, settings) {
  try {
    const order = await placeOrderFromDraft(org, conv, settings, "AI");
    await messenger.reply(org, conv, "ai", orderPlacedText(order, settings));
  } catch (e) {
    await handToHuman(org, conv, `Couldn't place the order: ${e.message}`, "দুঃখিত, অর্ডারটি এখনই নিতে পারিনি। আমাদের টিম শীঘ্রই আপনাকে সাহায্য করবে 🙏");
  }
}

// Main entry: the customer's message is already added to conv.messages. Caller saves conv.
// options = { images: [photo links / data URLs] } when the customer sent photos
async function handleCustomerMessage(org, conv, text, { images = [], captions = [], audios = [], shared = [] } = {}) {
  const settings = await aiSettings(org);
  conv.lastCustomerAt = new Date();
  conv.unread = (conv.unread || 0) + 1;
  if (conv.status === "closed") conv.status = "open";
  if (!settings.ai.enabled || conv.aiPaused || settings.blocked) return; // blocked = suspended / plan ended

  const d = conv.draft || { items: [], status: "collecting" };
  const plain = String(text || "").replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim(); // drop emoji and dots
  let ownWords = ATTACHMENT_ONLY.test(String(text || "").trim()) ? "" : String(text || ""); // what the customer said (not our note about an attachment)

  if (d.status === "awaiting_confirm" && (CONFIRM_WORDS.test(plain) || text === BUTTONS[0])) return confirmOrder(org, conv, settings);
  if (d.status === "awaiting_confirm" && (CHANGE_WORDS.test(plain) || text === BUTTONS[1])) {
    conv.draft = { ...d, status: "collecting" }; conv.markModified("draft");
    return messenger.reply(org, conv, "ai", "অবশ্যই! কী পরিবর্তন করতে চান? পণ্য, সাইজ, পরিমাণ, নাম, ফোন নাকি ঠিকানা?");
  }
  // A photo: a vision model says what it shows, then the AI answers as if the customer had typed it.
  // A shared post / reel / story, a sticker or a voice message: see attachmentText() above.
  if (ATTACHMENT_ONLY.test(String(text || "").trim())) {
    // A voice message: turned into text, then answered like a typed message (the chat shows "🎤 what they said")
    const names = audios.length ? (await Product.find({ organizationId: org, archived: { $ne: true } }).select("name").limit(40).lean()).map((p) => p.name).join(", ") : "";
    const heard = audios.length ? await voice.transcribe(audios[0], names).catch((e) => { console.warn("voice:", e.message); return null; }) : null;
    const seen = !heard && images.length ? await lookAtPhoto(org, images[0]).catch((e) => { console.warn("photo:", e.message); return null; }) : null;
    if (heard) {
      const said = [...conv.messages].reverse().find((m) => m.from === "customer");
      if (said) said.text = `🎤 ${heard}`;
      conv.lastMessage = `🎤 ${heard}`.slice(0, 200);
      text = ownWords = heard;
    } else if (seen) {
      if (seen.productId) conv.lastProductIds = [seen.productId];
      messenger.addMessage(conv, "system", `📷 AI saw: ${seen.text}${seen.productName ? ` (looks like ${seen.productName})` : ""}`);
      text = `[Customer sent a photo: ${seen.text}${seen.productName ? `. It looks like our product "${seen.productName}"` : ""}]`;
    } else {
      const post = await sharedPost(org, conv, shared, captions).catch((e) => { console.warn("shared post:", e.message); return null; });
      if (post?.products?.length) conv.lastProductIds = post.products.map((p) => p._id);
      text = attachmentText(String(text).trim(), post?.caption ? [post.caption] : captions, post?.products || []);
    }
  }
  if (HUMAN_WORDS.test(text)) return handToHuman(org, conv, `Customer said: "${text.slice(0, 80)}"`, settings.ai.handoffMessage);
  if (!aiReady()) return handToHuman(org, conv, "AI is not set up (AI_API_KEY missing)", settings.ai.handoffMessage);

  messenger.showTyping(org, conv);
  let result;
  const history = await customerHistory(org, conv);
  try { result = await askAgent(org, settings, conv, text, history); }
  catch (e) { return handToHuman(org, conv, `AI error: ${e.message}`, settings.ai.handoffMessage); }
  const { answer, products } = result;

  if (d.status === "awaiting_confirm" && answer.intent === "confirm" && !draftMissing(d).length) return confirmOrder(org, conv, settings);

  // A new order after one was already placed starts from an empty item list (customer details are kept)
  if (d.status === "placed") conv.draft = { name: d.name, phone: d.phone, address: d.address, district: d.district, zone: d.zone, version: d.version, items: [], status: "collecting" };
  else if (d.status === "awaiting_confirm") conv.draft = { ...d, status: "collecting" };
  let draft = updateDraft(conv, settings, products, answer.draft || {});
  // Returning customer: once they want something, fill in the details from their last order
  if (history.known && draft.items?.length && (!draft.name || !draft.phone || !draft.address)) {
    const k = history.known;
    draft = updateDraft(conv, settings, products, { name: draft.name || k.name, phone: draft.phone || k.phone, address: draft.address || k.address, district: draft.district || k.district });
  }

  if (answer.needsHuman || (Number(answer.confidence) || 0) < settings.ai.handoffBelow) {
    return handToHuman(org, conv, answer.handoffReason || `AI was not sure (${answer.confidence ?? 0}%)`, answer.reply || settings.ai.handoffMessage);
  }
  if (answer.readyToConfirm) {
    const missing = draftMissing(draft);
    if (!missing.length) {
      conv.draft = { ...draft, status: "awaiting_confirm" }; conv.markModified("draft");
      if (answer.reply) await messenger.reply(org, conv, "ai", answer.reply);
      return messenger.reply(org, conv, "ai", summary(draft), BUTTONS);
    }
    const noStock = missing.find((m) => m.startsWith("stock for "));
    if (noStock) return messenger.reply(org, conv, "ai", `দুঃখিত, ${noStock.replace("stock for ", "")} এখন যথেষ্ট স্টকে নেই। অন্য কোনোটা দেখাব?`);
  }
  await messenger.reply(org, conv, "ai", answer.reply || settings.ai.handoffMessage, optionButtons(draft, products));
  await sendProductPhotos(org, conv, products, answer, ownWords, draft);
}

// Product photos after the reply: the ones the AI chose (by id or name), or, when the customer asked for a photo
// or the reply says one is below, the products this chat is about (order draft, shared post, customer's photo).
// Max 3, and not a photo sent in the last hour unless the customer asks again.
// No photo to send? The customer is told honestly and the shop gets an alert to add the photo.
const PHOTO_WORDS = /ছবি|ফটো|দেখান|দেখাও|chobi|chobe|\bpic|picture|photo|dekhan|dekhao/i;
const PHOTO_PROMISE = /ছবি নিচে|নিচে দিলাম|নিচে দিচ্ছি|👇/;
async function sendProductPhotos(org, conv, products, answer, ownWords, draft) {
  const asked = PHOTO_WORDS.test(ownWords || "");
  const promised = PHOTO_PROMISE.test(answer.reply || "");
  const find = (x) => products.find((p) => p._id === String(x)) || products.find((p) => p.name.toLowerCase() === String(x).toLowerCase().trim());
  let wanted = (Array.isArray(answer.photos) ? answer.photos : []).map(find).filter(Boolean);
  if (!wanted.length && (asked || promised)) wanted = [...(draft.items || []).map((i) => i.productId), ...(conv.lastProductIds || [])].map(find).filter(Boolean);
  wanted = [...new Map(wanted.map((p) => [p._id, p])).values()].slice(0, 3);
  if (wanted.length) conv.lastProductIds = wanted.map((p) => p._id);

  const recent = new Set(conv.messages.filter((m) => m.image && m.from !== "customer" && Date.now() - new Date(m.at || 0) < 3600e3).map((m) => m.image));
  const toSend = wanted.filter((p) => p.imageUrl && (asked || !recent.has(p.imageUrl)));
  for (const p of toSend) await messenger.replyPhoto(org, conv, "ai", { image: p.imageUrl, publicUrl: photos.publicPhotoUrl(p.imageUrl), caption: `📷 ${p.name}` });
  if (toSend.length || !(asked || promised)) return;

  const noPhoto = wanted.filter((p) => !p.imageUrl);
  if (noPhoto.length) {
    const names = noPhoto.map((p) => p.name).join(", ");
    await messenger.reply(org, conv, "ai", `দুঃখিত, ${names}-এর ছবি এই মুহূর্তে আমার কাছে নেই। আমাদের টিম শিগগিরই ছবি পাঠিয়ে দেবে 🙏`);
    await notify(org, `${conv.customerName} wants a photo of ${names}`, "Send one from Chats now (📷). Add a photo in Products and the AI sends it by itself next time.", `inbox?open=${conv._id}`);
  } else if (!wanted.length) {
    await messenger.reply(org, conv, "ai", "কোন প্রোডাক্টের ছবি দেখতে চান? নামটা লিখুন, এখনই পাঠিয়ে দিচ্ছি 🙏");
  }
}

// The AI is asking which size/colour/option: offer the options that can be ordered as buttons (max 11)
function optionButtons(draft, products) {
  const item = (draft.items || []).find((i) => !i.variantId && i.variantCount > 1);
  const p = item && products.find((x) => x._id === item.productId);
  if (!p) return [];
  return p.variants.filter((v) => v.name !== "Default" && (p.alwaysAvailable || v.available > 0)).map((v) => v.name).slice(0, 11);
}

// A shared post or reel: its caption (from the message, or asked from Facebook / Instagram when it is the shop's own post)
// and the shop's products named in it
async function sharedPost(org, conv, shared, captions) {
  const s = shared.find((x) => x.title || x.id);
  let caption = s?.title || captions.find(Boolean) || "";
  if (!caption && s?.id && !messenger.isSimulator(conv)) {
    const page = await messenger.pageOf(org, conv.pageId);
    const field = /^ig_/.test(s.type) || conv.channel === "Instagram" ? "caption" : s.type === "reel" ? "description" : "message";
    const r = await graph(`/${s.id}`, { token: decrypt(page.accessToken), params: { fields: field } }).catch(() => ({})); // works for the shop's own posts
    caption = r[field] || "";
  }
  if (!caption) return null;
  const products = await Product.find({ organizationId: org, archived: { $ne: true } }).select("name nameBn").lean();
  return { caption, products: productsIn(caption, products, 3) };
}

async function lookAtPhoto(org, image) {
  if (!vision.visionReady()) return null;
  const products = await Product.find({ organizationId: org, archived: { $ne: true } }).select("name info imageUrl").sort({ updatedAt: -1 }).limit(150).lean();
  const seen = await vision.describePhoto(image, products);
  if (!seen?.text) return null;
  return { ...seen, productName: seen.productId ? products.find((p) => p._id === seen.productId)?.name : null };
}

// "Suggest reply" button for staff
async function suggestReply(org, conv) {
  const settings = await aiSettings(org);
  const k = await knowledgeFor(org, settings, conv.messages.slice(-6).map((m) => m.text).join(" "), conv.draft);
  const chat = conv.messages.slice(-20).map((m) => `${m.from.toUpperCase()}: ${m.text}`).join("\n");
  return askAI({
    system: `You help a shop's staff member reply to a customer. Use ONLY the business info. Return JSON: {"summary":"1-2 sentences: what the customer wants","reply":"a reply in the customer's language"}`,
    user: `${k.text}\n\nCHAT:\n${chat}`,
    temperature: 0.4, maxTokens: 600,
  });
}

module.exports = { aiSettings, updateDraft, draftTotal, draftMissing, placeOrderFromDraft, orderPlacedText, handleCustomerMessage, suggestReply, attachmentText };
