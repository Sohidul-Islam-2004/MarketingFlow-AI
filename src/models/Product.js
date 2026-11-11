// A product with one or more variants (size / colour). Stock lives on the variant:
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
    archived: { type: Boolean, default: false },
    variants: { type: [variantSchema], default: [] },
  },
  options
);

module.exports = mongoose.model("Product", productSchema);
