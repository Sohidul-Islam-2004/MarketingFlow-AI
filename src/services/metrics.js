// Numbers for the Overview page. Days are counted in Bangladesh time.
const { Order, Conversation, Product, Comment, SocialAccount, Organization } = require("../models");
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
  const groups = await Order.aggregate([
    { $match: { organizationId: org, createdAt: { $gte: from, $lt: to }, status: { $nin: NOT_COUNTED } } },
    { $group: { _id: "$source", n: { $sum: 1 }, revenue: { $sum: "$total" } } },
  ]);
  const sum = (field, rows = groups) => rows.reduce((s, g) => s + g[field], 0);
  return { count: sum("n"), revenue: sum("revenue"), ai: sum("n", groups.filter((g) => g._id !== "manual")) };
}

// What the AI did in the period: the value the shop gets from MarketingFlow.
// Time saved = about 1.5 minutes per chat reply and 1 minute per comment reply a person didn't have to write.
async function aiWork(org, from, to) {
  const [convs, comments] = await Promise.all([
    Conversation.find({ organizationId: org, channel: { $ne: "Simulator" }, updatedAt: { $gte: from } }).select("messages").lean(),
    Comment.countDocuments({ organizationId: org, status: "replied", updatedAt: { $gte: from, $lt: to } }),
  ]);
  let replies = 0, chats = 0;
  for (const c of convs) {
    const n = (c.messages || []).filter((m) => m.from === "ai" && new Date(m.at) >= from && new Date(m.at) < to).length;
    replies += n;
    if (n) chats++;
  }
  return { replies, chats, comments, minutesSaved: Math.round(replies * 1.5 + comments) };
}

// Sales of the last 7 days, one number per day (for the little chart)
async function last7Days(org) {
  const todayStart = dhakaMidnight(dhakaToday()).getTime();
  const from = new Date(todayStart - 6 * DAY);
  const orders = await Order.find({ organizationId: org, createdAt: { $gte: from }, status: { $nin: NOT_COUNTED } }).select("total createdAt").lean();
  return Array.from({ length: 7 }, (_, i) => {
    const start = todayStart - (6 - i) * DAY;
    const day = orders.filter((o) => new Date(o.createdAt).getTime() >= start && new Date(o.createdAt).getTime() < start + DAY);
    return { day: new Date(start + 6 * 3600e3).toISOString().slice(0, 10), revenue: day.reduce((s, o) => s + o.total, 0), orders: day.length };
  });
}

// First steps for a new shop. The Overview page shows them until all are done.
async function setupSteps(org, productCount) {
  const [page, shop, chat] = await Promise.all([
    SocialAccount.exists({ organizationId: org, platform: "Facebook" }),
    Organization.findById(org).select("ai").lean(),
    Conversation.exists({ organizationId: org }),
  ]);
  return { page: !!page, products: productCount > 0, knowledge: !!shop?.ai?.knowledge?.trim(), chat: !!chat };
}

async function overview(org, period = "today") {
  const r = periodRange(period);
  const [now, before, toPack, openChats, needsHuman, newComments, products, recent, ai, week, toCall] = await Promise.all([
    orderTotals(org, r.from, r.to),
    orderTotals(org, r.prevFrom, r.prevTo),
    Order.countDocuments({ organizationId: org, status: { $in: ["pending", "confirmed"] } }),
    Conversation.countDocuments({ organizationId: org, status: { $ne: "closed" } }),
    Conversation.countDocuments({ organizationId: org, status: "needs_human" }),
    Comment.countDocuments({ organizationId: org, status: { $in: ["needs_human", "approval"] } }),
    Product.find({ organizationId: org, archived: { $ne: true } }).select("name lowStockAt variants alwaysAvailable").lean(),
    Order.find({ organizationId: org }).sort({ createdAt: -1 }).limit(8).lean(),
    aiWork(org, r.from, r.to),
    last7Days(org),
    Order.countDocuments({ organizationId: org, status: "pending" }),
  ]);
  const lowStock = products.filter((p) => !p.alwaysAvailable && p.variants.reduce((s, v) => s + v.available, 0) <= (p.lowStockAt ?? 5));
  return {
    period,
    setup: await setupSteps(org, products.length),
    sales: { revenue: now.revenue, revenueChange: change(now.revenue, before.revenue), orders: now.count, ordersChange: change(now.count, before.count), aiOrders: now.ai },
    todo: { toPack, toCall, needsHuman, newComments, lowStock: lowStock.length },
    openChats,
    lowStock: lowStock.slice(0, 5).map((p) => ({ id: p._id, name: p.name, available: p.variants.reduce((s, v) => s + v.available, 0) })),
    recentOrders: recent,
    ai: { ...ai, orders: now.ai },
    week,
  };
}

module.exports = { overview };
