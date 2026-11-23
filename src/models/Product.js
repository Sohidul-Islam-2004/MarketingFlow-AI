// A product for any kind of shop (clothes, electronics, food…). The shop writes everything in its own words:
//   info     = free "label: value" lines, e.g. Warranty: 1 year, Fabric: cotton, RAM: 8GB
//   variants = options the customer picks, e.g. M / L, 8/128GB Black, 500g. Each has its own price and stock.
//   alwaysAvailable = don't count stock (pre-order, made to order, digital)
//   offer    = { kind: "percent" | "amount", value, until }: a sale price the AI quotes and orders use (lib/offer.js)
// Stock lives on the variant:
//   onHand    = units physically in the shop
//   reserved  = units held by open orders (not shipped yet)
//   available = onHand - reserved  (what can still be sold)
const { mongoose, Schema, newId, options } = require("./_base");

const variantSchema = new Schema(
  {
    _id: { type: String, default: newId },
    name: { type: String, default: "Default" }, // "M", "L / Red"
    sku: { type: String, default: "" },
    price: { type: Number, default: null }, // empty = use the product price
    onHand: { type: Number, default: 0 },
    reserved: { type: Number, default: 0 },
    available: { type: Number, default: 0 },
    storeId: { type: String, default: null }, // the variant's id on the shop's website (WooCommerce / Shopify)
  }
);

const productSchema = new Schema(
  {
    _id: { type: String, default: newId },
    organizationId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    nameBn: { type: String, default: "" },
    sku: { type: String, default: "" },
    category: { type: String, default: "General" },
    price: { type: Number, required: true, min: 0 },
    costPrice: { type: Number, default: null },
    description: { type: String, default: "" },
    imageUrl: { type: String, default: "" },
    lowStockAt: { type: Number, default: 5 },
    info: { type: [{ _id: false, label: String, value: String }], default: [] },
    alwaysAvailable: { type: Boolean, default: false },
    offer: { type: new Schema({ kind: { type: String, default: "percent" }, value: { type: Number, default: 0 }, until: { type: Date, default: null } }, { _id: false }), default: null },
    archived: { type: Boolean, default: false },
    storeId: { type: String, default: null }, // product id on the shop's website: kept in sync by services/storeSync.js
    storeText: { type: String, default: "" },
    offerFromStore: { type: Boolean, default: false }, // the offer is the website's sale (ends when the sale ends there) // the website's description (the AI reads it; the shop's own "description" is never overwritten)
    variants: { type: [variantSchema], default: [] },
  },
  options
);

module.exports = mongoose.model("Product", productSchema);
