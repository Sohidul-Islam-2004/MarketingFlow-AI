// Atomic counters, used for order numbers (ORD-100001, ORD-100002 ...)
const { mongoose, Schema } = require("./_base");

const counterSchema = new Schema({ _id: String, seq: { type: Number, default: 0 } }, { versionKey: false });

module.exports = mongoose.model("Counter", counterSchema);
