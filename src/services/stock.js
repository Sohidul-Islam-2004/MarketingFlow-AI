// Stock changes. Every change is atomic (one MongoDB update) and writes a StockMovement row.
const { Product, StockMovement } = require("../models");
const { fail } = require("../lib/errors");

const priceOf = (product, variant) => (variant && variant.price != null ? Number(variant.price) : Number(product.price) || 0);
const labelOf = (product, variant) => (variant && variant.name !== "Default" ? `${product.name} · ${variant.name}` : product.name);

// Changes one variant's numbers. `onlyIf` adds a condition (e.g. enough available stock).
async function changeVariant(org, line, change, onlyIf = {}) {
  const inc = {};
  for (const [field, n] of Object.entries(change)) if (n) inc[`variants.$.${field}`] = n;
  return Product.findOneAndUpdate(
    { _id: line.productId, organizationId: org, variants: { $elemMatch: { _id: line.variantId, ...onlyIf } } },
    { $inc: inc },
    { new: true }
  ).lean();
}

async function logMovement(org, product, variantId, data) {
  const variant = product.variants.find((v) => v._id === variantId);
  await StockMovement.create({ organizationId: org, productId: product._id, variantId, label: labelOf(product, variant), ...data });
}

// New order: hold units so nobody else can buy them. Returns false if not enough stock.
async function reserve(org, line, orderNo) {
  const p = await changeVariant(org, line, { reserved: line.qty, available: -line.qty }, line.always ? {} : { available: { $gte: line.qty } });
  if (!p) return false;
  await logMovement(org, p, line.variantId, { reservedChange: line.qty, reason: "order_reserve", orderNo });
  return true;
}

// Cancelled order: give the held units back
async function release(org, line, orderNo) {
  const p = await changeVariant(org, line, { reserved: -line.qty, available: line.qty });
  if (p) await logMovement(org, p, line.variantId, { reservedChange: -line.qty, reason: "order_release", orderNo });
}

// Shipped: the units leave the shop
async function ship(org, line, orderNo) {
  const p = await changeVariant(org, line, { reserved: -line.qty, onHand: -line.qty });
  if (p) await logMovement(org, p, line.variantId, { reservedChange: -line.qty, onHandChange: -line.qty, reason: "order_ship", orderNo });
}

// Returned parcel back on the shelf
async function putBack(org, line, orderNo) {
  const p = await changeVariant(org, line, { onHand: line.qty, available: line.qty });
  if (p) await logMovement(org, p, line.variantId, { onHandChange: line.qty, reason: "return", orderNo });
}

// Manual change from the Inventory page (restock, damage, count correction)
async function adjust(org, productId, variantId, change, reason, note = "") {
  if (!Number.isInteger(change) || change === 0) throw fail(400, "Enter a whole number, e.g. 10 or -2");
  const onlyIf = change < 0 ? { available: { $gte: -change } } : {};
  const p = await changeVariant(org, { productId, variantId }, { onHand: change, available: change }, onlyIf);
  if (!p) throw fail(400, change < 0 ? "Not enough available stock (units held by open orders can't be removed)" : "Variant not found");
  await logMovement(org, p, variantId, { onHandChange: change, reason, note });
  return p;
}

// { productId, variantId | variant name, qty } -> a clean order line with the price from the database
function resolveLine(products, item) {
  const product = products.find((p) => p._id === String(item.productId));
  if (!product || product.archived) throw fail(400, "Product not found");
  const variants = product.variants || [];
  let variant = variants.find((v) => v._id === String(item.variantId || ""));
  if (!variant && variants.length === 1) variant = variants[0];
  if (!variant && item.variantName) variant = variants.find((v) => v.name.toLowerCase() === String(item.variantName).toLowerCase());
  if (!variant) throw fail(400, `Choose an option for ${product.name}`);
  const qty = Math.max(1, Math.min(999, parseInt(item.qty, 10) || 1));
  return { productId: product._id, variantId: variant._id, name: product.name, variantName: variant.name === "Default" ? "" : variant.name, qty, price: priceOf(product, variant), available: product.alwaysAvailable ? 999 : variant.available, always: !!product.alwaysAvailable };
}

module.exports = { priceOf, labelOf, reserve, release, ship, putBack, adjust, resolveLine };
