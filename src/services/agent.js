// AI sales agent for Messenger / Instagram.
//
// How one customer message is handled (handleCustomerMessage):
//   1. If the bot is waiting for "Confirm" and the customer confirms -> place the order (no AI involved).
//   2. Complaints, refunds, "talk to a human" -> hand the chat to a person.
//   3. Otherwise ask the AI. It answers from your products + knowledge and fills the order "draft".
//   4. When the draft is complete the bot sends a summary with Confirm / Change buttons.
// The AI never decides prices, delivery fees or totals: those come from the database (services/orders.js).
const { Product, Organization } = require("../models");
const { askAI, aiReady } = require("../lib/ai");
const { findZone, canonicalDistrict, normalizeText, DEFAULT_ZONES } = require("../lib/places");
const { normalizePhone, isValidPhone, taka } = require("../lib/utils");
const { notify } = require("../lib/notify");
const { priceOf } = require("./stock");
const { createOrder } = require("./orders");
const { isBlocked } = require("./fraud");
const messenger = require("./messenger");

const CONFIRM_WORDS = /^(confirm(ed)?|yes|yeah|yep|ok(ay)?|done|sure|হ্যাঁ|হ্যা|হা|জি|জ্বি|ঠিক আছে|কনফার্ম|ওকে|ji|hae|ha)$/i;
const CHANGE_WORDS = /^(change|edit|বদল|পরিবর্তন)/i;
const HUMAN_WORDS = /(human|real person|agent|manush|মানুষ|complain|অভিযোগ|refund|রিফান্ড|ফেরত দিতে|damaged|broken|নষ্ট|ভাঙা|fraud|প্রতারণা|scam)/i;
const ATTACHMENT_ONLY = /^\[(image|audio|video|file|fallback|template|sticker|share|story_mention|reel|ig_reel)(, \w+)*\]$/i;
const BUTTONS = ["✅ Confirm", "✏️ Change"];

async function aiSettings(org) {
  const o = await Organization.findById(org).select("ai zones name").lean();
  return { ...o, ai: { enabled: true, autoConfirm: true, tone: "friendly", handoffBelow: 60, knowledge: "", deliveryTime: "", handoffMessage: "", ...(o?.ai || {}) } };
}

/* ---------- what the AI is allowed to know ---------- */
function productLines(products) {
  return products.map((p) => {
    const variants = p.variants.map((v) => `${v._id}=${v.name} ${taka(priceOf(p, v))} ${v.available > 0 ? `${v.available} in stock` : "OUT OF STOCK"}`).join("; ");
    return `${p._id} | ${p.name}${p.nameBn ? " / " + p.nameBn : ""} | ${p.category} | ${variants}`;
  }).join("\n");
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
    settings.ai.knowledge ? `BUSINESS INFO / POLICIES / FAQ:\n${settings.ai.knowledge}` : "",
    `PRODUCTS (productId | name | category | variants as variantId=name price stock):\n${productLines(ranked) || "(no products yet)"}`,
  ].filter(Boolean).join("\n\n");
  return { text, products: all };
}

const ANSWER_SHAPE = `{"reply":"","intent":"question|order|confirm|change|handoff|other","confidence":0,"needsHuman":false,"handoffReason":"","draft":{"items":[{"productId":"","variantId":"","qty":1}],"name":"","phone":"","address":"","district":""},"readyToConfirm":false}`;

async function askAgent(org, settings, conv, latestText) {
  const recent = conv.messages.filter((m) => m.from === "customer").slice(-6).map((m) => m.text).join(" ");
  const k = await knowledgeFor(org, settings, `${recent} ${latestText}`, conv.draft);
  const chat = conv.messages.slice(-16).filter((m) => m.from !== "system")
    .map((m) => `${m.from === "customer" ? "CUSTOMER" : m.from === "agent" ? "SHOP STAFF" : "YOU"}: ${m.text}`).join("\n");
  const d = conv.draft || {};
  const currentDraft = d.status === "placed" ? { items: [] } : { items: (d.items || []).map((i) => ({ productId: i.productId, variantId: i.variantId, qty: i.qty })), name: d.name || "", phone: d.phone || "", address: d.address || "", district: d.district || "" };

  const system = `You are the sales assistant of a Bangladeshi online shop, chatting on Facebook Messenger / Instagram.
Reply in the customer's language and script (Bangla, Banglish or English). Short and warm, max 3-4 lines. Tone: ${settings.ai.tone}.
RULES
- Use ONLY the business info and PRODUCTS below. Never invent prices, stock, discounts, delivery times or policies. If you don't know, say you'll check with the team and set needsHuman=true.
- To take an order you need: product (exact productId), the variantId when the product has several sizes/colours, quantity, name, phone (01XXXXXXXXX), full address with area, and district (one of Bangladesh's 64 districts).
- Ask only for what is missing, one or two things at a time.
- If something is OUT OF STOCK, say so and suggest an in-stock alternative.
- Never offer discounts, free delivery or gifts unless the business info says so. Never calculate totals: the system sends the exact total.
- When everything is collected set readyToConfirm=true and reply with a short line like "Here is your order summary 👇". Never say the order is placed.
- needsHuman=true for complaints, refunds, damaged items, angry customers, wholesale bargaining, or when unsure.
- "draft" must always contain the FULL draft (keep known values, add new ones).
- confidence: 0-100, how sure you are that your reply is correct.
Return JSON only: ${ANSWER_SHAPE}`;
  const user = `${k.text}\n\nCURRENT DRAFT: ${JSON.stringify(currentDraft)}\n\nCHAT SO FAR:\n${chat || "(new chat)"}\n\nCUSTOMER (latest): ${latestText}`;
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
    qty: Math.max(1, Math.min(99, parseInt(item.qty, 10) || 1)), price: priceOf(p, v), available: v ? v.available : 0, variantCount: p.variants.length,
  };
}

// Copies what the AI (or a staff member) filled in into conv.draft, then recalculates the delivery zone
function updateDraft(conv, settings, products, input) {
  const d = { items: [], status: "collecting", version: 0, ...(conv.draft || {}) };
  if (input.name && String(input.name).trim().length > 1) d.name = String(input.name).trim().slice(0, 100);
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
    ...d.items.map((i) => `• ${i.name}${i.variantName ? ` (${i.variantName})` : ""} × ${i.qty} = ${taka(i.price * i.qty)}`),
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
    paymentMethod: "COD", source: "ai_chat", confirmed: by !== "AI" || settings.ai.autoConfirm,
    conversationId: conv._id, psid: conv.psid, idemKey: `chat:${conv._id}:v${d.version}`,
  }, by);
  conv.draft = { ...d, status: "placed", orderNo: order.orderNo };
  conv.markModified("draft");
  conv.lastOrderNo = order.orderNo;
  messenger.addMessage(conv, "system", `Order #${order.orderNo} created by ${by} · ${taka(order.total)}${order.status === "on_hold" ? ` · ON HOLD (risk ${order.riskScore})` : ""}`);
  if (order.status === "on_hold") conv.status = "needs_human";
  return order;
}

function orderPlacedText(order, settings) {
  if (order.status === "on_hold" || order.status === "pending") return `✅ আপনার অর্ডার #${order.orderNo} (${taka(order.total)}) পেয়েছি। কনফার্ম করতে আমাদের টিম আপনাকে কল করবে। ধন্যবাদ 🙏`;
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
async function handleCustomerMessage(org, conv, text) {
  const settings = await aiSettings(org);
  conv.lastCustomerAt = new Date();
  conv.unread = (conv.unread || 0) + 1;
  if (conv.status === "closed") conv.status = "open";
  if (!settings.ai.enabled || conv.aiPaused) return;

  const d = conv.draft || { items: [], status: "collecting" };
  const plain = String(text || "").replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim(); // drop emoji and dots

  if (d.status === "awaiting_confirm" && (CONFIRM_WORDS.test(plain) || text === BUTTONS[0])) return confirmOrder(org, conv, settings);
  if (d.status === "awaiting_confirm" && (CHANGE_WORDS.test(plain) || text === BUTTONS[1])) {
    conv.draft = { ...d, status: "collecting" }; conv.markModified("draft");
    return messenger.reply(org, conv, "ai", "অবশ্যই! কী পরিবর্তন করতে চান? পণ্য, সাইজ, পরিমাণ, নাম, ফোন নাকি ঠিকানা?");
  }
  // The AI can't see photos or hear voice messages: a person has to look
  if (ATTACHMENT_ONLY.test(String(text || "").trim())) return handToHuman(org, conv, `Customer sent ${text} (the AI can't open it)`, settings.ai.handoffMessage);
  if (await isBlocked(org, d.phone)) return handToHuman(org, conv, "Customer is on the block list", settings.ai.handoffMessage);
  if (HUMAN_WORDS.test(text)) return handToHuman(org, conv, `Customer said: "${text.slice(0, 80)}"`, settings.ai.handoffMessage);
  if (!aiReady()) return handToHuman(org, conv, "AI is not set up (AI_API_KEY missing)", settings.ai.handoffMessage);

  messenger.showTyping(org, conv);
  let result;
  try { result = await askAgent(org, settings, conv, text); }
  catch (e) { return handToHuman(org, conv, `AI error: ${e.message}`, settings.ai.handoffMessage); }
  const { answer, products } = result;

  if (d.status === "awaiting_confirm" && answer.intent === "confirm" && !draftMissing(d).length) return confirmOrder(org, conv, settings);

  // A new order after one was already placed starts from an empty item list (customer details are kept)
  if (d.status === "placed") conv.draft = { name: d.name, phone: d.phone, address: d.address, district: d.district, zone: d.zone, version: d.version, items: [], status: "collecting" };
  else if (d.status === "awaiting_confirm") conv.draft = { ...d, status: "collecting" };
  const draft = updateDraft(conv, settings, products, answer.draft || {});

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
  await messenger.reply(org, conv, "ai", answer.reply || settings.ai.handoffMessage);
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

module.exports = { aiSettings, updateDraft, draftTotal, draftMissing, placeOrderFromDraft, orderPlacedText, handleCustomerMessage, suggestReply };
