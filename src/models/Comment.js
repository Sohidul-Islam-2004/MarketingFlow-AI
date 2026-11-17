// A comment on one of your Facebook or Instagram posts, and what the comment engine did with it.
const { mongoose, Schema, newId, options } = require("./_base");

const commentSchema = new Schema(
  {
    _id: { type: String, default: newId },
    organizationId: { type: String, required: true },
    platform: { type: String, default: "Facebook" }, // Facebook | Instagram
    pageId: { type: String, required: true }, // the Facebook Page (Instagram comments too: its token is used)
    commentId: { type: String, required: true }, // Facebook comment id ("sim_..." for the simulator)
    postId: { type: String, default: null },
    fromName: { type: String, default: "Someone" },
    message: { type: String, default: "" },

    // price | stock | size | delivery | order | complaint | praise | spam | other
    category: { type: String, default: "other" },
    // new | waiting (delay) | approval | replied | needs_human | spam | ignored | failed
    status: { type: String, default: "new" },
    note: { type: String, default: "" }, // why the engine did what it did

    reply: { type: String, default: "" }, // public reply text
    replySendAt: { type: Date, default: null },
    replySentAt: { type: Date, default: null },
    dmSent: { type: Boolean, default: false },
    error: { type: String, default: "" },
  },
  options
);
commentSchema.index({ organizationId: 1, commentId: 1 }, { unique: true });
commentSchema.index({ organizationId: 1, createdAt: -1 });
commentSchema.index({ status: 1, replySendAt: 1 });

module.exports = mongoose.model("Comment", commentSchema);
