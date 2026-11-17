// Connects to MongoDB and upgrades data saved by the old version of the app (safe to run every start).
const dns = require("dns");
const mongoose = require("mongoose");
const { DATABASE_URL, DNS_SERVERS, DEFAULT_TENANT } = require("./config");

async function connectDB() {
  if (!DATABASE_URL) throw new Error("DATABASE_URL is missing in .env");
  if (DNS_SERVERS !== "system") dns.setServers(DNS_SERVERS.split(",").map((s) => s.trim()));
  await mongoose.connect(DATABASE_URL);
  console.log("✅ MongoDB connected");
  await upgradeOldData().catch((e) => console.error("Data upgrade failed:", e.message));
}

// Old version -> new version. Uses the raw collections so old field shapes can't break anything.
async function upgradeOldData() {
  const db = mongoose.connection.db;
  if (!db) return;
  const col = (name) => db.collection(name);

  // Orders: old statuses -> the 8 statuses this version uses
  const orderStatus = { processing: "confirmed", out_for_delivery: "shipped", failed_delivery: "shipped", return_requested: "delivered", returned_to_sender: "returned", returned_restocked: "returned", returned_damaged: "returned", return_rejected: "delivered", rejected: "cancelled" };
  for (const [from, to] of Object.entries(orderStatus)) await col("orders").updateMany({ status: from }, { $set: { status: to } });
  await col("orders").updateMany({ paymentStatus: "paid", paid: { $exists: false } }, { $set: { paid: true } });
  // v2.3: Fraud Shield and WhatsApp were removed. Old-style Instagram rows (from before v2.3, without a Page id)
  // are removed too; today's Instagram accounts always have pageId, so they are kept on every restart.
  await col("orders").updateMany({ status: "on_hold" }, { $set: { status: "pending" } });
  await col("socialaccounts").deleteMany({ $or: [{ platform: "WhatsApp" }, { platform: "Instagram", pageId: { $in: [null, ""] } }] });
  await col("orders").updateMany({ "courier.trackingId": { $exists: true } }, [{ $set: { trackingNo: { $ifNull: ["$courier.trackingId", ""] }, courierName: { $ifNull: ["$courier.provider", ""] } } }]);

  // Products: "status: archived" -> archived flag; products without variants get one "Default" variant
  await col("products").updateMany({ status: "archived" }, { $set: { archived: true } });
  const bare = await col("products").find({ $or: [{ variants: { $exists: false } }, { variants: { $size: 0 } }] }).toArray();
  for (const p of bare) {
    const n = Math.max(0, Number(p.stock) || 0);
    await col("products").updateOne({ _id: p._id }, { $set: { variants: [{ _id: new mongoose.Types.ObjectId().toString(), name: "Default", sku: p.sku || "", price: null, onHand: n, reserved: 0, available: n }] } });
  }

  // Conversations: orderDraft -> draft, needs_review -> needs_human
  await col("conversations").updateMany({ orderDraft: { $exists: true }, draft: { $exists: false } }, { $rename: { orderDraft: "draft" } });
  await col("conversations").updateMany({ status: "needs_review" }, { $set: { status: "needs_human" } });

  // Content: body -> text; approval statuses no longer exist (single owner)
  await col("contentitems").updateMany({ body: { $exists: true }, text: { $exists: false } }, { $rename: { body: "text" } });
  await col("contentitems").updateMany({ status: { $in: ["In Review", "Approved", "Rejected"] } }, { $set: { status: "Draft" } });
  await col("contentitems").updateMany({ status: "Partially Published" }, { $set: { status: "Partly published" } });

  // AI agent settings lived in their own collection; now they are part of the workspace
  const agents = await col("agentconfigs").find({}).toArray().catch(() => []);
  for (const a of agents) {
    await col("organizations").updateOne({ _id: a.organizationId, "ai.knowledge": { $exists: false } }, {
      $set: { ai: { enabled: a.enabled !== false, autoConfirm: a.autoConfirm !== false, tone: a.tone || "friendly", handoffBelow: a.escalateBelow ?? 60, knowledge: a.knowledge || "", deliveryTime: a.deliveryTime || "24-48 hours inside Dhaka, 3-5 days outside", handoffMessage: a.handoffMessage || "ধন্যবাদ! আমাদের টিমের একজন শীঘ্রই আপনাকে উত্তর দেবেন 🙏" } },
    });
  }

  // Accounts made with the previous version (team version) had no organizationId: use their first workspace
  const oldUsers = await col("users").find({ organizationId: { $exists: false } }).toArray();
  for (const u of oldUsers) {
    const m = await col("memberships").findOne({ userId: u._id, status: "active" }).catch(() => null);
    await col("users").updateOne({ _id: u._id }, { $set: { organizationId: m?.organizationId || DEFAULT_TENANT } });
  }

  // Make sure the default workspace exists (the first sign-up takes it over)
  await col("organizations").updateOne({ _id: DEFAULT_TENANT }, { $setOnInsert: { name: "My business", createdAt: new Date() } }, { upsert: true });
}

module.exports = { connectDB };
