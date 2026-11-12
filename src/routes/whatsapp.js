// Connect a WhatsApp Business number (WhatsApp Cloud API).
// The seller pastes three things from Meta: phone number id, WhatsApp Business Account id, access token.
// List / check / disconnect are shared with Facebook and Instagram in routes/meta.js.
const router = require("express").Router();
const { SocialAccount } = require("../models");
const { handle, fail } = require("../lib/errors");
const { graph } = require("../lib/graph");
const { encrypt } = require("../lib/crypto");

router.post("/connect", handle(async (req, res) => {
  const phoneNumberId = String(req.body.phoneNumberId || "").trim();
  const wabaId = String(req.body.wabaId || "").trim();
  const token = String(req.body.token || "").trim();
  if (!/^\d{5,}$/.test(phoneNumberId)) throw fail(400, "Phone number ID must be a number (copy it from WhatsApp → API Setup, not the phone number itself)");
  if (!/^\d{5,}$/.test(wabaId)) throw fail(400, "WhatsApp Business Account ID must be a number");
  if (token.length < 50) throw fail(400, "Paste the full access token");

  // A number can belong to one workspace only, otherwise its messages would go to the wrong shop
  if (await SocialAccount.exists({ platform: "WhatsApp", accountId: phoneNumberId, organizationId: { $ne: req.org } })) {
    throw fail(409, "This WhatsApp number is already connected to another MarketingFlow account");
  }

  // 1) the token must be able to see this number inside this business account
  let numbers;
  try { numbers = (await graph(`/${wabaId}/phone_numbers`, { token, params: { fields: "id,display_phone_number,verified_name" } })).data || []; }
  catch (e) { throw fail(400, `Meta didn't accept the token or the Business Account ID: ${e.message}`); }
  const number = numbers.find((n) => String(n.id) === phoneNumberId);
  if (!number) throw fail(400, "That Phone number ID is not in this WhatsApp Business Account. Check both IDs.");

  // 2) tell Meta to send this account's messages to our webhook
  try { await graph(`/${wabaId}/subscribed_apps`, { token, method: "POST" }); }
  catch (e) { throw fail(400, `Could not switch on incoming messages: ${e.message}`); }

  await SocialAccount.findOneAndUpdate(
    { organizationId: req.org, platform: "WhatsApp", accountId: phoneNumberId },
    { accountName: `${number.verified_name || "WhatsApp"} (${number.display_phone_number || ""})`, wabaId, accessToken: encrypt(token), status: "active", statusNote: null, webhooksOn: true },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  res.json({ ok: true, name: number.verified_name, phone: number.display_phone_number });
}));

module.exports = router;
