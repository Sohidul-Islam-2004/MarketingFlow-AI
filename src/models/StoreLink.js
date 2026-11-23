// The shop's own website (WooCommerce or Shopify), connected in Settings → Website.
// Keys are stored encrypted. Products come from the website; confirmed orders go to it (services/storeSync.js).
const { mongoose, Schema, newId, options } = require("./_base");

const storeLinkSchema = new Schema(
  {
    _id: { type: String, default: newId },
    organizationId: { type: String, required: true, unique: true },
    platform: { type: String, required: true }, // "woocommerce" | "shopify" | "custom" (a developer-made website's product feed)
    url: { type: String, required: true }, // https://myshop.com  or  myshop.myshopify.com
    key: { type: String, default: "" }, // encrypted: WooCommerce consumer key / Shopify client ID or access token
    secret: { type: String, default: "" }, // encrypted: WooCommerce consumer secret / Shopify client secret ("" = key is a token)
    token: { type: String, default: "" }, // encrypted: Shopify access token made from the client ID + secret (lasts a day)
    tokenUntil: { type: Date, default: null },
    ordersUrl: { type: String, default: "" }, // custom website: where confirmed orders are POSTed (empty = orders stay here)
    sendOrders: { type: Boolean, default: true }, // confirmed orders are created on the website too
    productCount: { type: Number, default: 0 },
    lastSyncAt: { type: Date, default: null },
    lastNote: { type: String, default: "" },
    lastError: { type: String, default: null },
  },
  options
);

module.exports = mongoose.model("StoreLink", storeLinkSchema);
