// Orders list, create, edit, status changes, CSV export and printable invoice.
const router = require("express").Router();
const { Order, Organization } = require("../models");
const { handle, fail } = require("../lib/errors");
const { escapeRegex, dhakaMidnight, DAY, taka } = require("../lib/utils");
const orders = require("../services/orders");

function listQuery(org, q) {
  const f = { organizationId: org };
  if (q.status) f.status = { $in: String(q.status).split(",") };
  if (q.source) f.source = q.source;
  if (q.from || q.to) {
    f.createdAt = {};
    if (q.from) f.createdAt.$gte = dhakaMidnight(q.from);
    if (q.to) f.createdAt.$lt = new Date(dhakaMidnight(q.to).getTime() + DAY);
  }
  if (q.q) {
    const re = new RegExp(escapeRegex(String(q.q).trim()), "i");
    f.$or = [{ orderNo: re }, { customerName: re }, { phone: re }, { address: re }, { trackingNo: re }];
  }
  return f;
}

router.get("/", handle(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const perPage = 30;
  const filter = listQuery(req.org, req.query);
  const [rows, total, byStatus] = await Promise.all([
    Order.find(filter).sort({ createdAt: -1 }).skip((page - 1) * perPage).limit(perPage).lean(),
    Order.countDocuments(filter),
    Order.aggregate([{ $match: { organizationId: req.org } }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
  ]);
  res.json({ rows, total, page, pages: Math.max(1, Math.ceil(total / perPage)), counts: Object.fromEntries(byStatus.map((s) => [s._id, s.n])), labels: orders.STATUS_LABEL, next: orders.NEXT });
}));

router.get("/export.csv", handle(async (req, res) => {
  const rows = await Order.find(listQuery(req.org, req.query)).sort({ createdAt: -1 }).limit(10000).lean();
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const header = ["Order", "Date", "Status", "Customer", "Phone", "Address", "District", "Items", "Subtotal", "Delivery", "Discount", "Total", "Payment", "Paid", "Courier", "Tracking"];
  const lines = rows.map((o) => [o.orderNo, new Date(o.createdAt).toISOString().slice(0, 16).replace("T", " "), orders.STATUS_LABEL[o.status], o.customerName, o.phone, o.address, o.district, o.items.map((i) => `${i.name}${i.variantName ? ` (${i.variantName})` : ""} x${i.qty}`).join("; "), o.subtotal, o.deliveryFee, o.discount, o.total, o.paymentMethod, o.paid ? "yes" : "no", o.courierName, o.trackingNo].map(cell).join(","));
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="orders.csv"');
  res.send("﻿" + [header.map(cell).join(","), ...lines].join("\n")); // BOM so Excel shows Bangla correctly
}));

// Price preview for the order form
router.post("/quote", handle(async (req, res) => {
  const items = (req.body.items || []).filter((i) => i.productId);
  if (!items.length) return res.json({ subtotal: 0, deliveryFee: 0, discount: 0, total: 0, zone: null });
  const p = await orders.priceOrder(req.org, { ...req.body, items });
  res.json({ subtotal: p.subtotal, deliveryFee: p.deliveryFee, discount: p.discount, total: p.total, zone: p.zone });
}));

router.get("/:id", handle(async (req, res) => {
  const o = await Order.findOne({ _id: req.params.id, organizationId: req.org }).lean();
  if (!o) throw fail(404, "Order not found");
  res.json({ ...o, next: orders.NEXT[o.status] || [], labels: orders.STATUS_LABEL });
}));

router.post("/", handle(async (req, res) => {
  const order = await orders.createOrder(req.org, { ...req.body, source: "manual" }, req.user.name);
  res.json(order);
}));

router.put("/:id", handle(async (req, res) => {
  res.json(await orders.editOrder(req.org, req.params.id, req.body));
}));

router.post("/:id/no-answer", handle(async (req, res) => {
  res.json(await orders.noAnswer(req.org, req.params.id, req.user.name));
}));

// { status, note, courierName, trackingNo, restock }
router.post("/:id/status", handle(async (req, res) => {
  const { status, ...options } = req.body;
  res.json(await orders.changeStatus(req.org, req.params.id, status, { ...options, by: req.user.name }));
}));

// Printable invoice / label. Opens in a new tab; use the browser's Print -> Save as PDF.
router.get("/:id/invoice", handle(async (req, res) => {
  const [o, shop] = await Promise.all([Order.findOne({ _id: req.params.id, organizationId: req.org }).lean(), Organization.findById(req.org).lean()]);
  if (!o) throw fail(404, "Order not found");
  const e = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const cod = o.paymentMethod === "COD" && !o.paid ? o.total : 0;
  res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><title>${e(o.orderNo)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:30px auto;color:#111}table{width:100%;border-collapse:collapse;margin:16px 0}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left}td:last-child,th:last-child{text-align:right}.big{font-size:20px;font-weight:700}.muted{color:#666}@media print{button{display:none}}</style></head><body>
<button onclick="print()" style="float:right;padding:8px 14px">Print / Save PDF</button>
<div class="big">${e(shop?.name || "Invoice")}</div><div class="muted">${e(shop?.phone || "")}</div>
<p><b>Order ${e(o.orderNo)}</b> · ${new Date(o.createdAt).toLocaleDateString("en-GB", { timeZone: "Asia/Dhaka" })}</p>
<p><b>${e(o.customerName)}</b> · ${e(o.phone)}<br>${e(o.address)}${o.district ? ", " + e(o.district) : ""}</p>
<table><tr><th>Item</th><th>Qty</th><th>Price</th><th>Amount</th></tr>
${o.items.map((i) => `<tr><td>${e(i.name)}${i.variantName ? ` (${e(i.variantName)})` : ""}</td><td>${i.qty}</td><td>${taka(i.price)}</td><td>${taka(i.price * i.qty)}</td></tr>`).join("")}
<tr><td colspan="3">Delivery (${e(o.zone || "")})</td><td>${taka(o.deliveryFee)}</td></tr>
${o.discount ? `<tr><td colspan="3">Discount</td><td>-${taka(o.discount)}</td></tr>` : ""}
<tr><td colspan="3"><b>Total</b></td><td><b>${taka(o.total)}</b></td></tr></table>
<p class="big">Collect (COD): ${taka(cod)}</p>
${o.trackingNo ? `<p>${e(o.courierName)} · ${e(o.trackingNo)}</p>` : ""}${shop?.returnPolicy ? `<p class="muted">${e(shop.returnPolicy)}</p>` : ""}
</body></html>`);
}));

module.exports = router;
