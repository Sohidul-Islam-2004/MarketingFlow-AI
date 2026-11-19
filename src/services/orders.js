// Orders: creating, pricing and moving through statuses. All money maths happens here, never in the AI.
const { Order, Product, Organization, Counter, Conversation } = require("../models");
const { fail } = require("../lib/errors");
const { normalizePhone, isValidPhone, taka, DAY } = require("../lib/utils");
const { notify } = require("../lib/notify");
const { findZone, canonicalDistrict } = require("../lib/places");
const stock = require("./stock");
const messenger = require("./messenger");

const STATUS_LABEL = { pending: "To call", confirmed: "Confirmed", packed: "Packed", shipped: "Shipped", delivered: "Delivered", returned: "Returned", cancelled: "Cancelled" };

// Which status can follow which
const NEXT = {
  pending: ["confirmed", "cancelled"],
  confirmed: ["packed", "cancelled"],
  packed: ["shipped", "cancelled"],
  shipped: ["delivered", "returned"],
  delivered: ["returned"],
  returned: [],
  cancelled: [],
};
const HOLDS_STOCK = ["pending", "confirmed", "packed"]; // stock is reserved in these statuses

// Messages the customer gets on Messenger / Instagram when the order moves.
// Meta only allows them within 24 hours of the customer's last message (message tags for later updates were
// switched off by Meta in 2026), so the order history says whether the customer got it.
const itemsText = (o) => o.items.map((i) => `• ${i.name}${i.variantName ? ` (${i.variantName})` : ""} × ${i.qty}`).join("\n");
const toPay = (o) => o.paymentMethod === "COD" && !o.paid;
const CUSTOMER_MESSAGE = {
  confirmed: (o, shop) => `✅ আপনার অর্ডার #${o.orderNo} কনফার্ম হয়েছে!\n${itemsText(o)}\nমোট: ${taka(o.total)}${toPay(o) ? " (ক্যাশ অন ডেলিভারি)" : ""}${shop.deliveryTime ? `\nডেলিভারি: ${shop.deliveryTime}` : ""}\nধন্যবাদ 🙏`,
  shipped: (o) => `🚚 আপনার অর্ডার #${o.orderNo} পাঠানো হয়েছে${o.courierName ? ` (${o.courierName})` : ""}।${o.trackingNo ? `\nট্র্যাকিং নম্বর: ${o.trackingNo}` : ""}${toPay(o) ? `\nপার্সেল নেওয়ার সময় ${taka(o.total)} দিতে হবে।` : ""}`,
  delivered: (o) => `📦 আপনার অর্ডার #${o.orderNo} ডেলিভারি হয়েছে। আমাদের সাথে কেনাকাটার জন্য ধন্যবাদ! কোনো সমস্যা হলে এখানেই জানাবেন 🙏`,
};

// Same phone + same products in an order that is still going (last 2 days) = probably ordered twice
// (asked again in another chat or comment, or the shop typed in an order the AI already took)
const ACTIVE = ["pending", "confirmed", "packed", "shipped"];
const itemsKey = (items) => items.map((i) => `${i.productId}:${i.variantId || ""}`).sort().join("|");
async function findDouble(org, phone, lines) {
  const recent = await Order.find({ organizationId: org, phone, status: { $in: ACTIVE }, createdAt: { $gte: new Date(Date.now() - 2 * DAY) } })
    .select("orderNo items createdAt").sort({ createdAt: -1 }).lean();
  return recent.find((o) => itemsKey(o.items) === itemsKey(lines)) || null;
}
const dhakaTime = (d) => new Date(d).toLocaleString("en-GB", { timeZone: "Asia/Dhaka", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

async function nextOrderNo(org) {
  const c = await Counter.findOneAndUpdate({ _id: `order:${org}` }, { $inc: { seq: 1 } }, { upsert: true, new: true });
  const o = await Organization.findById(org).select("orderPrefix").lean();
  return `${o?.orderPrefix || "ORD-"}${100000 + c.seq}`;
}

// Prices, delivery fee and total for a list of items + address. Used by the order form preview too.
async function priceOrder(org, { items = [], address, district, discount = 0 }) {
  const products = await Product.find({ organizationId: org, _id: { $in: items.map((i) => String(i.productId)) } }).lean();
  const lines = items.map((i) => stock.resolveLine(products, i));
  const subtotal = lines.reduce((sum, l) => sum + l.price * l.qty, 0);
  const org_ = await Organization.findById(org).select("zones").lean();
  const zone = findZone(org_?.zones, { address, district });
  const deliveryFee = zone.freeOver && subtotal >= zone.freeOver ? 0 : zone.fee;
  const disc = Math.max(0, Math.min(subtotal, Number(discount) || 0));
  return { lines, subtotal, deliveryFee, discount: disc, total: subtotal + deliveryFee - disc, zone };
}

// input: { customerName, phone, address, district, items:[{productId, variantId, qty}], paymentMethod, discount, notes,
//          source, conversationId, psid, idemKey, allowDouble }
async function createOrder(org, input, by) {
  if (input.idemKey) {
    const existing = await Order.findOne({ organizationId: org, idemKey: input.idemKey });
    if (existing) return existing;
  }
  const phone = normalizePhone(input.phone);
  const customerName = String(input.customerName || "").trim();
  const address = String(input.address || "").trim();
  if (!customerName) throw fail(400, "Customer name is required");
  if (!isValidPhone(phone)) throw fail(400, "Enter a valid phone number like 01712345678");
  if (address.length < 6) throw fail(400, "Write the full delivery address");
  if (!input.items?.length) throw fail(400, "Add at least one product");

  // The AI may never give discounts; only a person creating the order by hand can
  const discount = input.source === "manual" ? input.discount : 0;
  const price = await priceOrder(org, { items: input.items, address, district: input.district, discount });

  // Ordered twice? The shop is asked first ("create anyway?"); orders from chats are only marked, the shop sees it on the call
  const double = await findDouble(org, phone, price.lines);
  if (double && input.source === "manual" && !input.allowDouble) {
    throw fail(409, `${customerName} (${phone}) already has an order with the same products: #${double.orderNo} (${dhakaTime(double.createdAt)}).`, "DOUBLE_ORDER");
  }

  const orderNo = await nextOrderNo(org);
  const reserved = [];
  for (const line of price.lines) {
    if (!(await stock.reserve(org, line, orderNo))) {
      for (const r of reserved) await stock.release(org, r, orderNo);
      throw fail(409, `Not enough stock for ${line.name}${line.variantName ? " · " + line.variantName : ""} (only ${line.available} left)`);
    }
    reserved.push(line);
  }

  const status = input.confirmed ? "confirmed" : "pending";
  try {
    const order = await Order.create({
      organizationId: org, orderNo, status,
      customerName, phone, address, district: price.zone.district, zone: price.zone.zone,
      items: price.lines.map(({ available, ...l }) => l),
      subtotal: price.subtotal, deliveryFee: price.deliveryFee, discount: price.discount, total: price.total,
      paymentMethod: ["COD", "bKash", "Nagad"].includes(input.paymentMethod) ? input.paymentMethod : "COD",
      paid: !!input.paid,
      source: input.source || "manual", conversationId: input.conversationId || null, psid: input.psid || null, idemKey: input.idemKey || null,
      duplicateOf: double?.orderNo || null, duplicateOfId: double?._id || null,
      notes: String(input.notes || "").slice(0, 1000),
      history: [{ status, by, note: double ? `Order created · ⚠️ maybe the same as #${double.orderNo}` : "Order created" }],
    });
    // An order the shop didn't type in itself (AI chat, comment): tell the shop at once, so it can call the customer
    if (order.source !== "manual") {
      await notify(org, `🛒 New order #${orderNo} · ${taka(order.total)}`, `${customerName}: ${order.items.map((i) => `${i.name}${i.variantName ? ` (${i.variantName})` : ""} ×${i.qty}`).join(", ")}${status === "pending" ? ". Call to confirm." : ""}`, status === "pending" ? "orders?status=pending" : "orders");
    }
    return order;
  } catch (e) {
    for (const r of reserved) await stock.release(org, r, orderNo);
    throw e;
  }
}

// Moves an order to a new status and updates stock. options: { by, note, courierName, trackingNo, restock }
async function changeStatus(org, orderId, to, options = {}) {
  const order = await Order.findOne({ _id: orderId, organizationId: org });
  if (!order) throw fail(404, "Order not found");
  const from = order.status;
  if (!(NEXT[from] || []).includes(to)) throw fail(400, `Can't change ${STATUS_LABEL[from] || from} to ${STATUS_LABEL[to] || to}`);
  if (to === "cancelled" && !String(options.note || "").trim()) throw fail(400, "Write why the order is cancelled");

  // Claim the change first, so two clicks can't apply it twice
  const claimed = await Order.updateOne({ _id: order._id, status: from }, { $set: { status: to } });
  if (!claimed.modifiedCount) throw fail(409, "This order was just changed. Refresh and try again.");

  const lines = order.items.filter((l) => l.variantId);
  if (to === "cancelled" && HOLDS_STOCK.includes(from)) for (const l of lines) await stock.release(org, l, order.orderNo);
  if (to === "shipped") for (const l of lines) await stock.ship(org, l, order.orderNo);
  if (to === "returned" && options.restock !== false) for (const l of lines) await stock.putBack(org, l, order.orderNo);

  order.status = to;
  if (to === "shipped") {
    if (options.courierName) order.courierName = String(options.courierName).slice(0, 60);
    if (options.trackingNo) order.trackingNo = String(options.trackingNo).slice(0, 60);
  }
  if (to === "delivered" && order.paymentMethod === "COD") order.paid = true;
  const note = [options.note, to === "returned" ? (options.restock === false ? "not restocked" : "restocked") : ""].filter(Boolean).join(" · ");
  order.history.push({ status: to, by: options.by || "system", note });
  await order.save();
  // Message the customer, and write in the history whether it reached them
  const told = await tellCustomer(org, order, to);
  if (told) {
    order.history[order.history.length - 1].note = [note, told.note].filter(Boolean).join(" · ");
    order.markModified("history");
    await order.save();
  }
  return { ...order.toObject(), told };
}

// Returns null when there is nothing to send (no chat with this customer), otherwise { sent, note }
async function tellCustomer(org, order, status) {
  if (!CUSTOMER_MESSAGE[status] || !order.conversationId) return null;
  const conv = await Conversation.findOne({ _id: order.conversationId, organizationId: org });
  if (!conv) return null;
  if (!messenger.canReply(conv)) return { sent: false, note: "customer not messaged: no message from them in the last 24 hours" };
  const shop = (await Organization.findById(org).select("ai").lean())?.ai || {};
  const msg = await messenger.reply(org, conv, "ai", CUSTOMER_MESSAGE[status](order, shop));
  await conv.save();
  return msg.error ? { sent: false, note: `customer not messaged: ${msg.error}` } : { sent: true, note: `💬 customer told on ${conv.channel === "Instagram" ? "Instagram" : "Messenger"}` };
}

// Change customer details / notes. Address change recalculates the delivery fee (only before packing).
async function editOrder(org, orderId, changes) {
  const order = await Order.findOne({ _id: orderId, organizationId: org });
  if (!order) throw fail(404, "Order not found");
  const early = ["pending", "confirmed"].includes(order.status);
  if ("notes" in changes) order.notes = String(changes.notes || "").slice(0, 1000);
  if ("paid" in changes) order.paid = !!changes.paid;
  if ("paymentMethod" in changes && ["COD", "bKash", "Nagad"].includes(changes.paymentMethod)) order.paymentMethod = changes.paymentMethod;
  const details = ["customerName", "phone", "address", "district", "discount"].filter((k) => k in changes);
  if (details.length && !early) throw fail(400, "Customer details can only change before the order is packed");
  if (changes.customerName) order.customerName = String(changes.customerName).trim();
  if (changes.phone) {
    const p = normalizePhone(changes.phone);
    if (!isValidPhone(p)) throw fail(400, "Invalid phone number");
    order.phone = p;
  }
  if (changes.address || changes.district || "discount" in changes) {
    if (changes.address) order.address = String(changes.address).trim();
    const o = await Organization.findById(org).select("zones").lean();
    const zone = findZone(o?.zones, { address: order.address, district: canonicalDistrict(changes.district) || order.district });
    order.district = zone.district; order.zone = zone.zone;
    order.deliveryFee = zone.freeOver && order.subtotal >= zone.freeOver ? 0 : zone.fee;
    if ("discount" in changes) order.discount = Math.max(0, Math.min(order.subtotal, Number(changes.discount) || 0));
    order.total = order.subtotal + order.deliveryFee - order.discount;
  }
  await order.save();
  return order;
}

// "Called, no answer": the order stays "To call", we count the tries so the shop knows when to give up
async function noAnswer(org, id, by) {
  const order = await Order.findOne({ _id: id, organizationId: org });
  if (!order) throw fail(404, "Order not found");
  if (order.status !== "pending") throw fail(400, "This order is already confirmed or closed");
  order.callTries = (order.callTries || 0) + 1;
  order.lastCallAt = new Date();
  order.history.push({ status: "pending", note: `Called, no answer (${order.callTries})`, by });
  await order.save();
  return order.toObject();
}

module.exports = { STATUS_LABEL, NEXT, priceOrder, createOrder, changeStatus, editOrder, noAnswer };
