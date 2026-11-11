// Numbers for the Overview page. Days are counted in Bangladesh time.
const { Order, Conversation, Product, Comment } = require("../models");
const { DAY, dhakaToday, dhakaMidnight } = require("../lib/utils");

const NOT_COUNTED = ["cancelled"];

function periodRange(period) {
  const todayStart = dhakaMidnight(dhakaToday()).getTime();
  const days = { today: 1, "7d": 7, "30d": 30 }[period] || 1;
  const from = new Date(todayStart - (days - 1) * DAY);
  const to = new Date(todayStart + DAY);
  return { from, to, prevFrom: new Date(from - days * DAY), prevTo: from };
}

const change = (now, before) => (before > 0 ? Math.round(((now - before) / before) * 100) : null);

async function orderTotals(org, from, to) {
  const rows = await Order.find({ organizationId: org, createdAt: { $gte: from, $lt: to }, status: { $nin: NOT_COUNTED } }).select("total source").lean();
  return { count: rows.length, revenue: rows.reduce((s, o) => s + o.total, 0), ai: rows.filter((o) => o.source !== "manual").length };
}

async function overview(org, period = "today") {
  const r = periodRange(period);
  const [now, before, onHold, toPack, openChats, needsHuman, newComments, products, recent] = await Promise.all([
    orderTotals(org, r.from, r.to),
    orderTotals(org, r.prevFrom, r.prevTo),
    Order.countDocuments({ organizationId: org, status: "on_hold" }),
    Order.countDocuments({ organizationId: org, status: { $in: ["pending", "confirmed"] } }),
    Conversation.countDocuments({ organizationId: org, status: { $ne: "closed" } }),
    Conversation.countDocuments({ organizationId: org, status: "needs_human" }),
    Comment.countDocuments({ organizationId: org, status: { $in: ["needs_human", "approval"] } }),
    Product.find({ organizationId: org, archived: { $ne: true } }).select("name lowStockAt variants").lean(),
    Order.find({ organizationId: org }).sort({ createdAt: -1 }).limit(8).lean(),
  ]);
  const lowStock = products.filter((p) => p.variants.reduce((s, v) => s + v.available, 0) <= (p.lowStockAt ?? 5));
  return {
    period,
    sales: { revenue: now.revenue, revenueChange: change(now.revenue, before.revenue), orders: now.count, ordersChange: change(now.count, before.count), aiOrders: now.ai },
    todo: { onHold, toPack, needsHuman, newComments, lowStock: lowStock.length },
    openChats,
    lowStock: lowStock.slice(0, 5).map((p) => ({ id: p._id, name: p.name, available: p.variants.reduce((s, v) => s + v.available, 0) })),
    recentOrders: recent,
  };
}

module.exports = { overview };
