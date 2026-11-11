// One row for every stock change, so you can always see why a number changed.
const { mongoose, Schema, newId, options } = require("./_base");

const stockMovementSchema = new Schema(
  {
    _id: { type: String, default: newId },
    organizationId: { type: String, required: true },
    productId: { type: String, required: true },
    variantId: String,
    label: String, // "Panjabi · M"
    onHandChange: { type: Number, default: 0 },
    reservedChange: { type: Number, default: 0 },
    // order_reserve | order_release | order_ship | return | restock | damage | correction | initial
    reason: String,
    orderNo: { type: String, default: null },
    note: { type: String, default: "" },
  },
  options
);
stockMovementSchema.index({ organizationId: 1, productId: 1, createdAt: -1 });

module.exports = mongoose.model("StockMovement", stockMovementSchema);
