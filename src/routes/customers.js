// Customers: everyone who ordered, grouped by phone number. Made from the orders, so there is no extra list to keep up to date.
const router = require("express").Router();
const { Order } = require("../models");
const { handle, fail } = require("../lib/errors");
const { escapeRegex, normalizePhone } = require("../lib/utils");

// One customer's numbers from their orders (newest order first)
function summary(orders) {
  const n = (s) => orders.filter((o) => o.status === s).length;
  const delivered = n("delivered");
  const bad = n("returned") + n("cancelled");
  const last = orders[0];
  return {
    name: last.customerName, phone: last.phone, address: last.address, district: last.district,
    orderCount: orders.length, delivered, returned: n("returned"), cancelled: n("cancelled"),
    spent: orders.filter((o) => o.status === "delivered").reduce((s, o) => s + o.total, 0),
    lastOrderAt: last.createdAt,
    // risky: returns or cancels more than they take · regular: 2+ delivered · new: first order
    tag: bad >= 2 && bad > delivered ? "risky" : delivered >= 2 ? "regular" : orders.length === 1 ? "new" : "",
  };
}

router.get("/", handle(async (req, res) => {
  const f = { organizationId: req.org };
  if (req.query.q) {
    const re = new RegExp(escapeRegex(String(req.query.q).trim()), "i");
    f.$or = [{ customerName: re }, { phone: re }, { address: re }];
  }
  const rows = await Order.find(f).select("customerName phone address district total status createdAt").sort({ createdAt: -1 }).limit(5000).lean();
  const byPhone = new Map();
  for (const o of rows) {
    if (!byPhone.has(o.phone)) byPhone.set(o.phone, []);
    byPhone.get(o.phone).push(o);
  }
  res.json([...byPhone.values()].slice(0, 300).map(summary)); // the customers who ordered last come first
}));

router.get("/:phone", handle(async (req, res) => {
  const orders = await Order.find({ organizationId: req.org, phone: normalizePhone(req.params.phone) }).sort({ createdAt: -1 }).lean();
  if (!orders.length) throw fail(404, "Customer not found");
  res.json({ ...summary(orders), conversationId: orders.find((o) => o.conversationId)?.conversationId || null, orders });
}));

module.exports = router;
