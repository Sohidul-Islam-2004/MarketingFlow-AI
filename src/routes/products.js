// Inventory: products, variants and stock.
const router = require("express").Router();
const { Product, StockMovement, Order } = require("../models");
const { handle, fail } = require("../lib/errors");
const { escapeRegex } = require("../lib/utils");
const { newId } = require("../models/_base");
const stock = require("../services/stock");
const { activeOffer, cleanOffer } = require("../lib/offer");
const photos = require("../services/photos");
const { askAI, aiReady } = require("../lib/ai");

const REASONS = ["restock", "damage", "correction", "return"];

function withTotals(p) {
  const sum = (field) => p.variants.reduce((s, v) => s + (v[field] || 0), 0);
  const available = sum("available");
  const offer = activeOffer(p);
  return { ...p, onHand: sum("onHand"), reserved: sum("reserved"), available, lowStock: !p.alwaysAvailable && available <= (p.lowStockAt ?? 5),
    offerOn: !!offer, salePrice: offer ? stock.priceOf(p, null) : null, offerEnded: !!(p.offer?.value && !offer) };
}

// Turns form rows into variants. Stock of an existing variant is never changed here (use "adjust").
function cleanVariants(rows, existing = []) {
  return (rows || []).map((r) => {
    const old = existing.find((v) => v._id === r.id);
    const name = String(r.name || "").trim() || "Default";
    const price = r.price === "" || r.price == null ? null : Math.max(0, Number(r.price) || 0);
    if (old) return { ...old, name, sku: String(r.sku || ""), price };
    const qty = Math.max(0, parseInt(r.stock, 10) || 0);
    return { _id: newId(), name, sku: String(r.sku || ""), price, onHand: qty, reserved: 0, available: qty };
  });
}

// Only fields that were sent are changed (the simple form doesn't send SKU, cost price…, so old values stay)
function cleanProduct(b) {
  const p = { name: String(b.name || "").trim(), price: Number(b.price) };
  if (!p.name) throw fail(400, "Product name is required");
  if (!(p.price >= 0) || b.price === "" || b.price == null) throw fail(400, "Price is required");
  const text = (k) => { if (b[k] !== undefined) p[k] = String(b[k] || "").trim(); };
  ["nameBn", "sku", "description", "imageUrl"].forEach(text);
  if (b.category !== undefined) p.category = String(b.category || "").trim() || "General";
  if (b.costPrice !== undefined) p.costPrice = b.costPrice === "" || b.costPrice == null ? null : Number(b.costPrice);
  if (b.lowStockAt !== undefined) p.lowStockAt = Math.max(0, Number(b.lowStockAt) || 0);
  if (b.offer !== undefined) p.offer = cleanOffer(b.offer);
  if (b.alwaysAvailable !== undefined) p.alwaysAvailable = !!b.alwaysAvailable && b.alwaysAvailable !== "false";
  if (Array.isArray(b.info)) {
    p.info = b.info.map((r) => ({ label: String(r.label || "").trim().slice(0, 40), value: String(r.value || "").trim().slice(0, 300) }))
      .filter((r) => r.label || r.value).slice(0, 20);
  }
  return p;
}

router.get("/", handle(async (req, res) => {
  const q = { organizationId: req.org, archived: req.query.archived === "1" ? true : { $ne: true } };
  if (req.query.q) { const re = new RegExp(escapeRegex(req.query.q), "i"); q.$or = [{ name: re }, { nameBn: re }, { sku: re }, { category: re }, { "info.value": re }, { "variants.name": re }]; }
  const rows = (await Product.find(q).sort({ createdAt: -1 }).lean()).map(withTotals);
  res.json(req.query.low === "1" ? rows.filter((p) => p.lowStock) : rows);
}));

router.post("/", handle(async (req, res) => {
  const variants = cleanVariants(req.body.variants?.length ? req.body.variants : [{ name: "Default", stock: req.body.stock }]);
  const product = await Product.create({ ...cleanProduct(req.body), organizationId: req.org, variants });
  for (const v of variants) {
    if (v.onHand) await StockMovement.create({ organizationId: req.org, productId: product._id, variantId: v._id, label: stock.labelOf(product, v), onHandChange: v.onHand, reason: "initial" });
  }
  res.json(withTotals(product.toObject()));
}));

router.put("/:id", handle(async (req, res) => {
  const product = await Product.findOne({ _id: req.params.id, organizationId: req.org });
  if (!product) throw fail(404, "Product not found");
  Object.assign(product, cleanProduct(req.body));
  if (Array.isArray(req.body.variants)) {
    const existing = product.toObject().variants;
    const next = cleanVariants(req.body.variants, existing);
    const removed = existing.filter((v) => !next.some((n) => n._id === v._id));
    const busy = removed.find((v) => v.onHand > 0 || v.reserved > 0);
    if (busy) throw fail(400, `"${busy.name}" still has stock. Set its stock to 0 first.`);
    if (!next.length) throw fail(400, "A product needs at least one option");
    product.variants = next;
    for (const v of next.filter((n) => !existing.some((e) => e._id === n._id) && n.onHand)) {
      await StockMovement.create({ organizationId: req.org, productId: product._id, variantId: v._id, label: stock.labelOf(product, v), onHandChange: v.onHand, reason: "initial" });
    }
  }
  await product.save();
  res.json(withTotals(product.toObject()));
}));

// Archived products disappear from the shop and the AI but stay on old orders
// One offer for many products at once: { kind, value, until, ids? } (no ids = every product). value 0 = stop the offers.
// "✨ Sort with AI": a product post written any way (every page writes differently) ->
// options with their own price, details (name: value) and the rest as notes. Nothing is saved here.
router.post("/sort-text", handle(async (req, res) => {
  const text = String(req.body.text || "").trim().slice(0, 4000);
  if (text.length < 5) throw fail(400, "Paste or write the product text first");
  if (!aiReady()) throw fail(400, "The AI is not set up");
  const out = await askAI({
    temperature: 0, maxTokens: 1200,
    system: `You sort the text of ONE product from a Bangladeshi online shop (often copied from a Facebook post) into a form.
- "options": things the customer chooses between, each with its own price (e.g. "শুধু বোরকা" 950, "বোরকা + হিজাব" 1250) or sizes/colours listed as choices. price = number in taka or null when it has no own price. Max 20.
- "details": facts customers ask about, as short label + value (কাপড়, ঘের, লম্বা, বডি, হাতা, সাইজ, ওয়ারেন্টি…). Split lines that hold several facts. Keep the shop's own words and language; drop emoji.
- "notes": anything else useful for answering customers, short, in the shop's words.
- "price": the main/lowest price as a number, or null.
- Leave OUT delivery charges and shop-wide policies (they belong to the shop settings): put them in "left_out".
- Never invent anything that is not in the text.
Return JSON only: {"price":null,"options":[{"name":"","price":null}],"details":[{"label":"","value":""}],"notes":"","left_out":[""]}`,
    user: text,
  });
  const num = (x) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Math.round(Number(x)) : null);
  res.json({
    price: num(out.price),
    options: (Array.isArray(out.options) ? out.options : []).filter((o) => o?.name).slice(0, 20).map((o) => ({ name: String(o.name).slice(0, 60), price: num(o.price) })),
    details: (Array.isArray(out.details) ? out.details : []).filter((d) => d?.label && d?.value).slice(0, 30).map((d) => ({ label: String(d.label).slice(0, 40), value: String(d.value).slice(0, 200) })),
    notes: String(out.notes || "").slice(0, 1500),
    leftOut: (Array.isArray(out.left_out) ? out.left_out : []).filter(Boolean).map(String).slice(0, 5),
  });
}));

router.post("/offer", handle(async (req, res) => {
  const offer = cleanOffer(req.body);
  const q = { organizationId: req.org, archived: { $ne: true } };
  if (Array.isArray(req.body.ids) && req.body.ids.length) q._id = { $in: req.body.ids.map(String) };
  const r = await Product.updateMany(q, { $set: { offer } });
  res.json({ ok: true, changed: r.modifiedCount ?? r.nModified ?? 0 });
}));

router.post("/:id/archive", handle(async (req, res) => {
  const product = await Product.findOneAndUpdate({ _id: req.params.id, organizationId: req.org }, { archived: req.body.archived !== false }, { new: true });
  if (!product) throw fail(404, "Product not found");
  res.json({ ok: true });
}));

// The product's photo: { image: "data:image/jpeg;base64,..." } (made small in the browser). The AI sends it in chats.
router.post("/:id/photo", handle(async (req, res) => {
  res.json({ imageUrl: await photos.setProductPhoto(req.org, req.params.id, req.body.image) });
}));

router.delete("/:id/photo", handle(async (req, res) => {
  const product = await Product.findOne({ _id: req.params.id, organizationId: req.org });
  if (!product) throw fail(404, "Product not found");
  await photos.removeProductPhoto(req.org, product);
  product.imageUrl = "";
  await product.save();
  res.json({ ok: true });
}));

router.delete("/:id", handle(async (req, res) => {
  if (await Order.exists({ organizationId: req.org, "items.productId": req.params.id })) throw fail(400, "This product is on orders. Archive it instead.");
  const product = await Product.findOne({ _id: req.params.id, organizationId: req.org });
  if (product) await photos.removeProductPhoto(req.org, product);
  await Product.deleteOne({ _id: req.params.id, organizationId: req.org });
  await StockMovement.deleteMany({ organizationId: req.org, productId: req.params.id });
  res.json({ ok: true });
}));

// { variantId, change: +10 / -2, reason, note }
router.post("/:id/adjust", handle(async (req, res) => {
  if (!REASONS.includes(req.body.reason)) throw fail(400, "Choose a reason");
  const p = await stock.adjust(req.org, req.params.id, req.body.variantId, parseInt(req.body.change, 10), req.body.reason, String(req.body.note || "").slice(0, 200));
  res.json(withTotals(p));
}));

router.get("/:id/history", handle(async (req, res) => {
  res.json(await StockMovement.find({ organizationId: req.org, productId: req.params.id }).sort({ createdAt: -1 }).limit(200).lean());
}));

module.exports = router;
