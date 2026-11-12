// An order. Status flow (see services/orders.js):
//   pending -> confirmed -> packed -> shipped -> delivered
//   pending / confirmed / packed -> cancelled
//   shipped / delivered -> returned
const { mongoose, Schema, newId, options } = require("./_base");

const itemSchema = new Schema(
  {
    productId: String,
    variantId: String,
    name: { type: String, required: true },
    variantName: { type: String, default: "" },
    qty: { type: Number, default: 1, min: 1 },
    price: { type: Number, default: 0 },
  },
  { _id: false }
);

const historySchema = new Schema(
  { status: String, note: String, by: String, at: { type: Date, default: Date.now } },
  { _id: false }
);

const orderSchema = new Schema(
  {
    _id: { type: String, default: newId },
    organizationId: { type: String, required: true },
    orderNo: { type: String, required: true },
    status: { type: String, default: "pending" },

    customerName: { type: String, required: true },
    phone: { type: String, required: true },
    address: { type: String, required: true },
    district: { type: String, default: null },
    zone: { type: String, default: null },

    items: { type: [itemSchema], default: [] },
    subtotal: { type: Number, default: 0 },
    deliveryFee: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    total: { type: Number, required: true, min: 0 },

    paymentMethod: { type: String, default: "COD" }, // COD | bKash | Nagad
    paid: { type: Boolean, default: false },

    source: { type: String, default: "manual" }, // manual | ai_chat | comment
    conversationId: { type: String, default: null },
    psid: { type: String, default: null },
    idemKey: { type: String, default: null }, // stops the same AI draft creating two orders


    courierName: { type: String, default: "" }, // free text: Steadfast, Pathao, own rider...
    trackingNo: { type: String, default: "" },
    notes: { type: String, default: "" },
    history: { type: [historySchema], default: [] },
  },
  options
);
orderSchema.index({ organizationId: 1, orderNo: 1 }, { unique: true });
orderSchema.index({ organizationId: 1, createdAt: -1 });
orderSchema.index({ organizationId: 1, status: 1 });
orderSchema.index({ organizationId: 1, phone: 1 });
orderSchema.index({ organizationId: 1, idemKey: 1 });

module.exports = mongoose.model("Order", orderSchema);
