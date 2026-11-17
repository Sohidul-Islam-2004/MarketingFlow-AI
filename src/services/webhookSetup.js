// Registers this server's webhook URL with your Meta app, so you don't have to paste it
// into the Meta dashboard by hand. Runs once each time the server starts.
//
// Needs in .env: FB_APP_ID, FB_APP_SECRET, META_WEBHOOK_VERIFY_TOKEN, PUBLIC_BASE_URL (https).
// Meta calls GET /webhooks/meta to check the URL, so the server must already be listening.
const { META, PUBLIC_BASE_URL } = require("../config");
const { graph } = require("../lib/graph");
const { sleep } = require("../lib/utils");

const SUBSCRIPTIONS = [
  { object: "page", fields: "messages,messaging_postbacks,message_echoes,feed" },
  { object: "instagram", fields: "messages,messaging_postbacks,comments" }, // only works if the app has the Instagram product
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

  // On Render (and similar hosts) the public address keeps going to the OLD server for a few seconds
  // after a deploy. If Meta checks the URL in that moment, the old server answers with the old
  // verify token -> 403. So: wait first, and try again a few times.
  const waits = [20, 40, 90]; // seconds before each try
  for (const s of SUBSCRIPTIONS) {
    for (const [i, wait] of waits.entries()) {
      await sleep(wait * 1000);
      try {
        await graph(`/${META.APP_ID}/subscriptions`, {
          token: appToken,
          method: "POST",
          params: { object: s.object, callback_url: callbackUrl, fields: s.fields, verify_token: META.VERIFY_TOKEN, include_values: "true" },
        });
        console.log(`✅ Webhook registered for ${s.object}: ${callbackUrl}`);
        break;
      } catch (e) {
        const last = i === waits.length - 1;
        console.log(`${last ? "⚠️ " : "…"} Webhook setup for ${s.object} failed${last ? "" : `, trying again in ${waits[i + 1]}s`}: ${e.message}`);
      }
    }
  }
}

module.exports = { registerWebhooks };
