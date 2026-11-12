// The result of "Train the AI from my Page + website" (services/learn.js). One per workspace: _id = workspace id.
// The seller reviews it on the AI Training page before anything is saved to the shop.
const { mongoose, Schema, options } = require("./_base");

const shopScanSchema = new Schema(
  {
    _id: { type: String }, // workspace id
    status: { type: String, default: "running" }, // running | ready | failed
    step: { type: String, default: "" }, // what it is doing right now (shown while running)
    error: { type: String, default: null },
    website: { type: String, default: "" },
    sources: { type: [Schema.Types.Mixed], default: [] }, // [{ kind: "page" | "web", title, url }] what was read
    knowledge: { type: String, default: "" }, // shop facts the AI wrote, as "## Title" + "- fact" lines
    deliveryTime: { type: String, default: "" },
    returnPolicy: { type: String, default: "" },
    products: { type: [Schema.Types.Mixed], default: [] }, // [{ name, nameBn, price, category, description, variants: [], imageUrl, sourceUrl, from }]
  },
  options
);

module.exports = mongoose.model("ShopScan", shopScanSchema);
