// Settings → Website: connect a WooCommerce / Shopify website, sync products, send orders
const router = require("express").Router();
const { StoreLink, Order } = require("../models");
const { handle, fail } = require("../lib/errors");
const store = require("../services/storeSync");

router.get("/", handle(async (req, res) => res.json(store.status(await StoreLink.findOne({ organizationId: req.org })))));
router.post("/preview", handle(async (req, res) => res.json(await store.preview(req.org, req.body))));
router.get("/feed-example", (req, res) => res.json({ feed: require("../services/stores/custom").FEED_EXAMPLE, order: require("../services/stores/custom").ORDER_EXAMPLE }));
router.post("/connect", handle(async (req, res) => res.json(await store.connect(req.org, req.body))));
router.post("/sync", handle(async (req, res) => res.json(await store.syncProducts(req.org))));
router.put("/", handle(async (req, res) => res.json(await store.setSendOrders(req.org, req.body.sendOrders))));
router.delete("/", handle(async (req, res) => { await store.disconnect(req.org); res.json({ ok: true }); }));

// "Send to website" on an order that didn't go (or was confirmed before connecting)
router.post("/orders/:id", handle(async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, organizationId: req.org });
  if (!order) throw fail(404, "Order not found");
  if (order.storeOrderId) return res.json({ ok: true, storeOrderId: order.storeOrderId });
  order.storeTries = 0;
  const note = await store.pushOrder(req.org, order);
  if (!note) throw fail(400, (await Order.findById(order._id).lean()).history.at(-1)?.note?.replace(/^🌐 /, "") || "Its products are not from the website");
  res.json({ ok: true, note });
}));

module.exports = router;
