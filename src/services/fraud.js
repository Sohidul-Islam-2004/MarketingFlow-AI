// Fraud Shield: a risk score from 0 to 100 for a cash-on-delivery order.
// Each rule adds or removes points and explains why, so you can see the reason on the order.
const { Order, Blacklist, Organization } = require("../models");
const { DAY, isValidPhone } = require("../lib/utils");
const { addressKey } = require("../lib/places");

const FAKE_NAME = /^(test|fake|asdf|qwerty|abc|xxx+|na|none|customer|\W*)$/i;

async function isBlocked(org, phone) {
  return phone ? !!(await Blacklist.exists({ organizationId: org, phone })) : false;
}

async function fraudSettings(org) {
  const o = await Organization.findById(org).select("fraud").lean();
  return { holdAtScore: 60, refuseBlocked: true, ...(o?.fraud || {}) };
}

// order: { phone, address, customerName }. Returns { score, reasons, blocked }
async function scoreOrder(org, order, ignoreOrderId = null) {
  const reasons = [];
  let score = 0;
  const add = (points, reason) => { score += points; reasons.push(`${points > 0 ? "+" : ""}${points} ${reason}`); };
  const others = { organizationId: org, ...(ignoreOrderId ? { _id: { $ne: ignoreOrderId } } : {}) };

  const blocked = await isBlocked(org, order.phone);
  if (blocked) add(100, "phone is on your block list");

  const [returned, delivered, last24h, phonesAtAddress] = await Promise.all([
    Order.countDocuments({ ...others, phone: order.phone, status: "returned" }),
    Order.countDocuments({ ...others, phone: order.phone, status: "delivered" }),
    Order.countDocuments({ ...others, phone: order.phone, createdAt: { $gte: new Date(Date.now() - DAY) } }),
    order.address ? Order.distinct("phone", { ...others, addressKey: addressKey(order.address) }) : [],
  ]);

  if (returned) add(Math.min(50, returned * 25), `${returned} returned order(s) before`);
  if (last24h >= 2) add(15, `${last24h + 1} orders from this phone in 24 hours`);
  const otherPhones = phonesAtAddress.filter((p) => p !== order.phone).length;
  if (otherPhones >= 2) add(20, `${otherPhones + 1} different phones used for this address`);
  if (!isValidPhone(order.phone) || /^01(\d)\1{8}$/.test(order.phone) || FAKE_NAME.test(String(order.customerName || "").trim())) add(20, "name or phone looks fake");
  if (delivered) add(-Math.min(30, delivered * 15), `${delivered} delivered order(s) before`);

  return { score: Math.max(0, Math.min(100, score)), reasons, blocked };
}

module.exports = { scoreOrder, isBlocked, fraudSettings };
