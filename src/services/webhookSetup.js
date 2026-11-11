// Registers this server's webhook URL with your Meta app, so you don't have to paste it
// into the Meta dashboard by hand. Runs once each time the server starts.
//
// Needs in .env: FB_APP_ID, FB_APP_SECRET, META_WEBHOOK_VERIFY_TOKEN, PUBLIC_BASE_URL (https).
// Meta calls GET /webhooks/meta to check the URL, so the server must already be listening.
const { META, PUBLIC_BASE_URL } = require("../config");
const { graph } = require("../lib/graph");

const SUBSCRIPTIONS = [
  { object: "page", fields: "messages,messaging_postbacks,message_echoes,feed" },
  { object: "instagram", fields: "messages,comments" },
];

async function registerWebhooks() {
  if (!META.APP_ID || !META.APP_SECRET || !META.VERIFY_TOKEN) {
    return console.log("ℹ️  Webhook auto-setup skipped: FB_APP_ID / FB_APP_SECRET / META_WEBHOOK_VERIFY_TOKEN missing");
  }
  if (!PUBLIC_BASE_URL.startsWith("https://")) {
    return console.log("ℹ️  Webhook auto-setup skipped: PUBLIC_BASE_URL must be a public https address (tunnel or domain)");
  }

  const callbackUrl = `${PUBLIC_BASE_URL}/webhooks/meta`;
  const appToken = `${META.APP_ID}|${META.APP_SECRET}`; // app access token

  for (const s of SUBSCRIPTIONS) {
    try {
      await graph(`/${META.APP_ID}/subscriptions`, {
        token: appToken,
        method: "POST",
        params: { object: s.object, callback_url: callbackUrl, fields: s.fields, verify_token: META.VERIFY_TOKEN, include_values: "true" },
      });
      console.log(`✅ Webhook registered for ${s.object}: ${callbackUrl}`);
    } catch (e) {
      console.log(`⚠️  Webhook setup for ${s.object} failed: ${e.message}`);
    }
  }
}

module.exports = { registerWebhooks };
