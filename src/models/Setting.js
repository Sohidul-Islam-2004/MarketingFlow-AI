// Settings for the whole server (not one shop), e.g. the keys for phone alerts. { _id: "vapid", value: {...} }
const { mongoose, Schema, Mixed, options } = require("./_base");

const settingSchema = new Schema({ _id: { type: String }, value: { type: Mixed, default: null } }, options);

module.exports = mongoose.model("Setting", settingSchema);
