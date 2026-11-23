// The shop's website (WooCommerce / Shopify) and MarketingFlow, kept in step:
//   products: name, price, photo, options, stock and description come from the website (every 2 hours + "Sync now").
//             What the shop wrote here (details, offer, its own notes) is never overwritten.
//   orders:   when an order is confirmed it is created on the website too (failed ones are tried again later).
// Stock: the website's number is what can still be sold. Units held by open orders here (reserved) are added
// on top of it, so  available = website stock  stays true.
const { StoreLink, Product, Order } = require("../models");
const { encrypt, decrypt } = require("../lib/crypto");
const { fail } = require("../lib/errors");
const woocommerce = require("./stores/woocommerce");
const shopify = require("./stores/shopify");
const custom = require("./stores/custom");

const API = { woocommerce, shopify, custom };
const NAMES = { woocommerce: "WooCommerce", shopify: "Shopify", custom: "your website" };
const canSendOrders = (doc) => doc.platform !== "custom" || !!doc.ordersUrl;
const NOT_COUNTED = 999; // an option the website sells without counting stock

const open = (doc) => ({ url: doc.url, key: doc.key ? decrypt(doc.key) : "", secret: doc.secret ? decrypt(doc.secret) : "", token: doc.token ? decrypt(doc.token) : "", tokenUntil: doc.tokenUntil, ordersUrl: doc.ordersUrl || "" });
async function keepToken(doc, link) { // Shopify: a new day-long token was made
  if (!link.tokenChanged) return;
  doc.token = encrypt(link.token);
  doc.tokenUntil = link.tokenUntil;
  await doc.save();
}

// What the Settings page shows (never the keys)
function status(doc) {
  if (!doc) return { connected: false };
  return { connected: true, platform: doc.platform, name: NAMES[doc.platform], url: doc.url, sendOrders: doc.sendOrders, canSendOrders: canSendOrders(doc), productCount: doc.productCount, lastSyncAt: doc.lastSyncAt, lastNote: doc.lastNote, lastError: doc.lastError };
}

// What the shop typed -> a link (checked, not saved)
function linkFrom({ platform, url, key, secret, ordersUrl }) {
  if (!API[platform]) throw fail(400, "Choose WooCommerce, Shopify or Other website");
  const clean = (x) => String(x || "").trim();
  const link = { platform, url: clean(url), key: clean(key), secret: clean(secret), ordersUrl: clean(ordersUrl) };
  if (!link.url) throw fail(400, platform === "shopify" ? "Write your store address (myshop.myshopify.com)" : platform === "custom" ? "Paste the product data link" : "Write your website address");
  if (platform === "custom") {
    for (const u of [link.url, link.ordersUrl].filter(Boolean)) if (!/^https?:\/\/\S+$/i.test(u)) throw fail(400, `"${u}" is not a full link (it starts with https://)`);
    return link;
  }
  if (!link.key) throw fail(400, platform === "shopify" ? "Paste the Client ID (or an access token)" : "Paste the Consumer key");
  if (platform === "woocommerce" && !link.secret) throw fail(400, "Paste the Consumer secret");
  return link;
}

// "Check and show my products": what would come in, before anything is saved
async function preview(org, input) {
  const link = linkFrom(input);
  let items;
  try { items = await API[link.platform].fetchProducts(link); } catch (e) { throw fail(400, e.message); }
  const mine = await Product.find({ organizationId: org }).select("name storeId").lean();
  const ids = new Set(mine.map((p) => p.storeId).filter(Boolean));
  const names = new Set(mine.filter((p) => !p.storeId).map((p) => p.name.trim().toLowerCase()));
  const seen = new Map();
  for (const it of items) seen.set(it.name.trim().toLowerCase(), (seen.get(it.name.trim().toLowerCase()) || 0) + 1);
  const problems = [];
  const noPrice = items.filter((it) => !it.price && !it.variants.some((v) => v.price));
  if (noPrice.length) problems.push(`${noPrice.length} without a price: ${noPrice.slice(0, 3).map((p) => p.name).join(", ")}${noPrice.length > 3 ? "…" : ""}. The AI can't quote them: add the price on the website.`);
  const twice = [...seen].filter(([, n]) => n > 1).map(([n]) => n);
  if (twice.length) problems.push(`Same name twice: ${twice.slice(0, 3).join(", ")}. Customers may get mixed up.`);
  const unnamed = items.filter((it) => it.variants.length > 1 && it.variants.some((v) => !v.name || /^#\d+$/.test(v.name)));
  if (unnamed.length) problems.push(`${unnamed.length} with options that have no name (e.g. ${unnamed[0].name}). Give each size / colour a name on the website.`);
  return {
    platform: link.platform, name: NAMES[link.platform], count: items.length,
    noPhoto: items.filter((it) => !it.imageUrl).length,
    matched: items.filter((it) => ids.has(it.id) || names.has(it.name.trim().toLowerCase())).length,
    problems,
    sample: items.slice(0, 12).map((it) => ({ name: it.name, price: it.price, offer: it.offer, imageUrl: it.imageUrl, category: it.category, text: it.text.slice(0, 160),
      options: it.variants.filter((v) => v.name).map((v) => ({ name: v.name, price: v.price, stock: v.stock })), stock: it.variants.length === 1 ? it.variants[0].stock : undefined })),
  };
}

// Check the keys work, save them, bring the products in
async function connect(org, input) {
  const link = linkFrom(input);
  try { await API[link.platform].test(link); } catch (e) { throw fail(400, e.message); }
  const doc = (await StoreLink.findOne({ organizationId: org })) || new StoreLink({ organizationId: org, platform: link.platform, url: link.url });
  Object.assign(doc, {
    platform: link.platform, url: link.url, key: link.key ? encrypt(link.key) : "", secret: link.secret ? encrypt(link.secret) : "", ordersUrl: link.ordersUrl,
    token: link.token ? encrypt(link.token) : "", tokenUntil: link.tokenUntil || null, lastError: null,
  });
  await doc.save();
  return syncProducts(org);
}

async function disconnect(org) {
  await StoreLink.deleteOne({ organizationId: org });
  // products stay (with their website id, so connecting again matches them up)
}

async function setSendOrders(org, on) {
  const doc = await StoreLink.findOne({ organizationId: org });
  if (!doc) throw fail(400, "No website connected");
  doc.sendOrders = !!on;
  await doc.save();
  return status(doc);
}

// The website's options -> ours, keeping each one's id, reserved units and own SKU
function mergeVariants(product, items, counted) {
  const old = product?.variants || [];
  const out = items.map((v) => {
    const was = old.find((x) => x.storeId === v.id) || (items.length === 1 && old.length === 1 && !old[0].storeId ? old[0] : null);
    const reserved = was?.reserved || 0;
    const sell = v.stock === null ? (counted ? NOT_COUNTED : 0) : v.stock;
    return { ...(was ? { _id: was._id } : {}), storeId: v.id, name: v.name || "Default", sku: was?.sku || "", price: v.price, onHand: sell + reserved, reserved, available: sell };
  });
  // an option gone from the website but still held by an open order stays until that order is done
  for (const v of old) if (!out.some((x) => x._id === v._id) && v.reserved > 0) out.push({ _id: v._id, storeId: v.storeId, name: v.name, sku: v.sku, price: v.price, onHand: v.reserved, reserved: v.reserved, available: 0 });
  return out;
}

async function syncProducts(org) {
  const doc = await StoreLink.findOne({ organizationId: org });
  if (!doc) throw fail(400, "No website connected");
  const link = open(doc);
  let items;
  try {
    items = await API[doc.platform].fetchProducts(link);
  } catch (e) {
    doc.lastError = e.message; doc.lastSyncAt = new Date();
    await doc.save();
    throw fail(400, e.message);
  }
  await keepToken(doc, link);

  const mine = await Product.find({ organizationId: org });
  const byStoreId = new Map(mine.filter((p) => p.storeId).map((p) => [p.storeId, p]));
  const byName = new Map(mine.filter((p) => !p.storeId).map((p) => [p.name.trim().toLowerCase(), p])); // made here before connecting
  let added = 0, updated = 0, removed = 0;
  for (const it of items) {
    const p = byStoreId.get(it.id) || byName.get(it.name.trim().toLowerCase());
    const counted = it.variants.some((v) => v.stock !== null);
    // own price only when it differs; on sale the product price + offer give the sale price (never both)
    const variants = mergeVariants(p, it.variants, counted).map((v) => ({ ...v, price: !it.offer && v.price != null && v.price !== it.price ? v.price : null }));
    // the website's sale is the offer; when the sale ends there, an offer that came from it ends too
    const offer = it.offer ? { offer: it.offer, offerFromStore: true } : p?.offerFromStore ? { offer: null, offerFromStore: false } : {};
    const fields = {
      storeId: it.id, name: it.name, price: it.price, storeText: it.text, alwaysAvailable: !counted, archived: false, variants, ...offer,
      imageUrl: p?.imageUrl?.startsWith("/photos/") ? p.imageUrl : it.imageUrl || p?.imageUrl || "", // a photo uploaded here wins
      category: it.category || p?.category || "General",
    };
    if (p) { Object.assign(p, fields); p.markModified?.("variants"); await p.save(); updated++; }
    else { await Product.create({ organizationId: org, ...fields }); added++; }
  }
  const live = new Set(items.map((i) => i.id));
  for (const p of mine) if (p.storeId && !live.has(p.storeId) && !p.archived) { p.archived = true; await p.save(); removed++; } // gone from the website

  doc.productCount = items.length;
  doc.lastSyncAt = new Date();
  doc.lastError = null;
  doc.lastNote = [`${items.length} products`, added && `${added} new`, updated && `${updated} updated`, removed && `${removed} removed`].filter(Boolean).join(" · ");
  await doc.save();
  return { ...status(doc), added, updated, removed };
}

// A confirmed order -> the website. Returns a note for the order's history, or null when there is nothing to do.
async function pushOrder(org, order) {
  if (order.storeOrderId) return null;
  const doc = await StoreLink.findOne({ organizationId: org });
  if (!doc || !doc.sendOrders || !canSendOrders(doc)) return null;
  const products = await Product.find({ organizationId: org, _id: { $in: order.items.map((i) => i.productId).filter(Boolean) } }).lean();
  const lines = [];
  for (const item of order.items) {
    const p = products.find((x) => x._id === item.productId);
    const v = p?.variants?.find((x) => x._id === item.variantId) || (p?.variants?.length === 1 ? p.variants[0] : null);
    if (p?.storeId && v?.storeId) lines.push({ productId: p.storeId, variantId: v.storeId, qty: item.qty, price: item.price, item });
  }
  if (!lines.length) return null; // none of its products come from the website
  const link = open(doc);
  try {
    const id = await API[doc.platform].createOrder(link, order, lines);
    await keepToken(doc, link);
    const missing = order.items.length - lines.length;
    const note = `🌐 sent to ${NAMES[doc.platform]} as #${id}${missing ? ` (${missing} item${missing > 1 ? "s" : ""} not on the website)` : ""}`;
    await Order.updateOne({ _id: order._id }, { $set: { storeOrderId: id }, $push: { history: { status: order.status, by: "system", note, at: new Date() } } });
    return note;
  } catch (e) {
    const first = !order.storeTries;
    await Order.updateOne({ _id: order._id }, { $inc: { storeTries: 1 }, ...(first ? { $push: { history: { status: order.status, by: "system", note: `🌐 not sent to ${NAMES[doc.platform]} yet: ${e.message} (tried again later)`, at: new Date() } } } : {}) });
    return null;
  }
}

// Every 2 hours: products of every connected shop, and confirmed orders that didn't reach the website
async function syncAll() {
  for (const doc of await StoreLink.find({})) {
    await syncProducts(doc.organizationId).catch((e) => console.warn(`website sync (${doc.organizationId}):`, e.message));
    const waiting = await Order.find({ organizationId: doc.organizationId, storeOrderId: null, storeTries: { $lt: 5 }, status: { $in: ["confirmed", "packed"] }, createdAt: { $gt: new Date(Date.now() - 7 * 24 * 3600e3) } });
    for (const o of waiting) await pushOrder(doc.organizationId, o);
  }
}

module.exports = { status, preview, connect, disconnect, setSendOrders, syncProducts, pushOrder, syncAll, NAMES };
