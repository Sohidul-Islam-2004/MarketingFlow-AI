// Which Meta app a shop connects its Page with.
//
// Two ways:
//   1. Shared app: FB_APP_ID / FB_APP_SECRET in .env (your app). Before App Review only its
//      Admins/Testers can connect.
//   2. Own app: the shop makes its own app on developers.facebook.com and pastes the App ID and
//      App Secret on the Facebook Page screen. The shop is that app's Admin, so it can connect its
//      own Page without being a Tester and without App Review.
//
//   appFor(org)            -> { appId, appSecret, configId, own } or null (no app at all)
//   allSecrets()           -> every app secret we know (to check webhook signatures)
//   saveOwnApp(org, input) -> checks the app with Meta, registers our webhook URL, saves it
//   removeOwnApp(org)
const { Organization, SocialAccount } = require("../models");
const { graph } = require("../lib/graph");
const { encrypt, decrypt } = require("../lib/crypto");
const { fail } = require("../lib/errors");
const { META, PUBLIC_BASE_URL } = require("../config");

const WEBHOOK_FIELDS = "messages,messaging_postbacks,message_echoes,messaging_referrals,feed";

async function appFor(org) {
  const o = await Organization.findById(org).select("metaApp").lean();
  const own = o?.metaApp;
  if (own?.appId && own?.appSecret) {
    let appSecret;
    try { appSecret = decrypt(own.appSecret); }
    catch { throw fail(400, "Your saved App secret can't be read any more (the server key changed). Press Change and type the App secret again."); }
    return { appId: own.appId, appSecret, configId: own.configId || "", own: true };
  }
  if (META.APP_ID && META.APP_SECRET) return { appId: META.APP_ID, appSecret: META.APP_SECRET, configId: META.CONFIG_ID, own: false };
  return null;
}

// App IDs whose messages count as "sent by MarketingFlow" for this shop (the shared app and the shop's own)
async function ourAppIds(org) {
  const o = await Organization.findById(org).select("metaApp").lean();
  return [META.APP_ID, o?.metaApp?.appId].filter(Boolean).map(String);
}

// Webhooks from every app come to the same URL, signed with that app's secret.
// We keep the list for a minute so a busy server doesn't read the database for every message.
let secrets = { list: [], until: 0 };
async function allSecrets() {
  if (secrets.until > Date.now()) return secrets.list;
  const orgs = await Organization.find({ metaApp: { $ne: null } }).select("metaApp").lean();
  const own = orgs.filter((o) => o.metaApp?.appSecret).map((o) => { try { return decrypt(o.metaApp.appSecret); } catch { return null; } });
  const list = [META.APP_SECRET, ...own].filter(Boolean);
  secrets = { list, until: Date.now() + 60000 };
  return list;
}
const forgetSecrets = () => { secrets.until = 0; };

// Tells the shop's app to send Page events (messages, comments) to our /webhooks/meta
async function registerWebhook(appId, appSecret) {
  if (!META.VERIFY_TOKEN) return { ok: false, note: "META_WEBHOOK_VERIFY_TOKEN is missing in the server's .env" };
  if (!PUBLIC_BASE_URL.startsWith("https://")) return { ok: false, note: "The server's PUBLIC_BASE_URL is not an https address" };
  try {
    await graph(`/${appId}/subscriptions`, {
      token: `${appId}|${appSecret}`, method: "POST",
      params: { object: "page", callback_url: `${PUBLIC_BASE_URL}/webhooks/meta`, fields: WEBHOOK_FIELDS, verify_token: META.VERIFY_TOKEN, include_values: "true" },
    });
    return { ok: true, note: null };
  } catch (e) {
    return { ok: false, note: e.message };
  }
}

// Same for Instagram: messages and comments of the Instagram accounts linked to the shop's Pages.
// Called after "Connect Instagram". Fails quietly if the app has no Instagram product yet.
async function registerInstagramWebhook(org) {
  const app = await appFor(org).catch(() => null);
  if (!app || !META.VERIFY_TOKEN || !PUBLIC_BASE_URL.startsWith("https://")) return;
  await graph(`/${app.appId}/subscriptions`, {
    token: `${app.appId}|${app.appSecret}`, method: "POST",
    params: { object: "instagram", callback_url: `${PUBLIC_BASE_URL}/webhooks/meta`, fields: "messages,messaging_postbacks,comments", verify_token: META.VERIFY_TOKEN, include_values: "true" },
  }).catch((e) => console.log(`ℹ️  Instagram webhook for ${org}: ${e.message}`));
}

async function saveOwnApp(org, input) {
  const appId = String(input.appId || "").trim();
  const appSecret = String(input.appSecret || "").trim();
  const configId = String(input.configId || "").trim();
  if (!/^\d{6,}$/.test(appId)) throw fail(400, "App ID is a long number. Copy it from App settings → Basic.");
  if (!/^[0-9a-f]{32}$/i.test(appSecret)) throw fail(400, "App Secret is 32 letters and numbers. In App settings → Basic press Show next to App secret and copy it.");
  if (configId && !/^\d{6,}$/.test(configId)) throw fail(400, "Configuration ID is a long number (leave it empty if you don't use Facebook Login for Business)");

  const saved = (await Organization.findById(org).select("metaApp").lean())?.metaApp; // don't decrypt: the old secret may be unreadable
  if (saved?.appId && saved.appId !== appId && (await SocialAccount.exists({ organizationId: org, platform: "Facebook" }))) {
    throw fail(400, "Disconnect your Page first, then change the app");
  }

  // Meta answers only if the ID and the secret belong together
  let app;
  try { app = await graph(`/${appId}`, { token: `${appId}|${appSecret}`, params: { fields: "id,name" } }); }
  catch (e) { throw fail(400, `Meta didn't accept this App ID and App Secret: ${e.message}`); }

  const webhook = await registerWebhook(appId, appSecret);
  await Organization.updateOne({ _id: org }, {
    $set: { metaApp: { appId, appSecret: encrypt(appSecret), configId, name: app.name || "", savedAt: new Date(), webhookOk: webhook.ok, webhookNote: webhook.note } },
  });
  forgetSecrets();
  return { name: app.name, webhookOk: webhook.ok, webhookNote: webhook.note };
}

async function removeOwnApp(org) {
  const saved = (await Organization.findById(org).select("metaApp").lean())?.metaApp;
  if (saved?.appId && (await SocialAccount.exists({ organizationId: org, platform: "Facebook" }))) {
    throw fail(400, "Disconnect your Page first, then remove the app");
  }
  await Organization.updateOne({ _id: org }, { $set: { metaApp: null } });
  forgetSecrets();
}

module.exports = { appFor, allSecrets, ourAppIds, saveOwnApp, removeOwnApp, registerInstagramWebhook };
