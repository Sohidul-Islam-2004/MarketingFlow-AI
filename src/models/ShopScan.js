// The result of "AI Training" (services/learn.js). One per workspace: _id = workspace id.
// The seller reads and edits it on the AI Training page, then presses Save.
const { mongoose, Schema, options } = require("./_base");

const shopScanSchema = new Schema(
  {
    _id: { type: String }, // workspace id

    // progress (the AI Training page checks these every 3 seconds)
    status: { type: String, default: "running" }, // running | ready | failed
    step: { type: String, default: "" }, // what it is doing right now
    error: { type: String, default: null },

    // what was read
    website: { type: String, default: "" },
    sources: { type: [Schema.Types.Mixed], default: [] }, // [{ kind: "page" | "web", title, url }]

    // what the AI learned (saved to the shop only when the seller presses Save)
    knowledge: { type: String, default: "" }, // "## Title" + "- fact" lines
    deliveryTime: { type: String, default: "" },
    returnPolicy: { type: String, default: "" },
  },
  options
);

module.exports = mongoose.model("ShopScan", shopScanSchema);