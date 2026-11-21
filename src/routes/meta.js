// Facebook Login: connect Facebook Pages and their Instagram accounts, list them, check them, disconnect.
// "Connect Facebook" asks only for Page permissions. "Connect Instagram" asks for those plus the
// Instagram ones, so a shop whose Meta app has no Instagram product can still connect its Page.
// Connecting uses the shop's own Meta app if it saved one, otherwise the shared app (services/metaApp.js).
const router = require("express").Router();
const crypto = require("crypto");
const { SocialAccount, Organization } = require("../models");
const { handle, fail } = require("../lib/errors");
const { graph, graphAll } = require("../lib/graph");
const { encrypt, decrypt } = require("../lib/crypto");
const { currentUser } = require("../middleware/auth");
const { META, TOKEN_ENC_KEY, PUBLIC_BASE_URL } = require("../config");
const metaApp = require("../services/metaApp");

// Permissions the app asks for. pages_messaging = reply in Messenger, pages_manage_engagement = reply to comments.
const SCOPES = [
  "pages_show_list", "pages_read_engagement", "pages_manage_metadata", "pages_manage_posts", "pages_messaging", "pages_manage_engagement",
  "business_management",
].join(",");
const INSTAGRAM_SCOPES = ["instagram_basic", "instagram_manage_messages", "instagram_manage_comments", "instagram_content_publish"].join(",");
const WEBHOOK_FIELDS = ["messages", "messaging_postbacks", "message_echoes", "messaging_referrals", "feed"];


// The "state" Facebook sends back tells us which workspace started the login. It is signed with
// a server key, so it can't be faked and it still works if the server restarted in between.
const sign = (text) => crypto.createHmac("sha256", `${TOKEN_ENC_KEY}|${META.APP_SECRET || ""}|state`).update(text).digest("hex").slice(0, 32);
// mode = "fb" (Facebook only) or "ig" (Facebook + Instagram)
const makeState = (org, mode) => { const body = `${org}.${Date.now()}.${mode}`; return `${body}.${sign(body)}`; };
function readState(state) {
  const [org, at, mode, sig] = String(state || "").split(".");
  if (!org || !sig || sig !== sign(`${org}.${at}.${mode}`)) return null;
  return Date.now() - Number(at) < 15 * 60e3 ? { org, mode } : null; // valid for 15 minutes
}

const publicView = (a) => ({ _id: a._id, platform: a.platform, pageId: a.pageId, accountId: a.accountId, accountName: a.accountName, pictureUrl: a.pictureUrl, status: a.status, statusNote: a.statusNote, webhooksOn: a.webhooksOn, lastWebhookAt: a.lastWebhookAt });

// Tells Meta to send this Page's messages and comments to our /webhooks/meta
async function turnOnWebhooks(page, pageToken) {
  try {
    await graph(`/${page.accountId}/subscribed_apps`, { token: pageToken, method: "POST", body: { subscribed_fields: WEBHOOK_FIELDS } });
    page.webhooksOn = true;
  } catch (e) {
    page.webhooksOn = false;
    page.statusNote = `Webhooks: ${e.message}`;
  }
}

// Step 1: send the browser to Facebook (GET, because it's a page redirect)
async function startConnect(req, res) {
  const who = await currentUser(req);
  if (!who) return res.redirect("/");
  let app;
  try { app = await metaApp.appFor(who.org); }
  catch (e) { return res.redirect("/#accounts?error=" + encodeURIComponent(e.message)); }
  if (!app) return res.redirect("/#accounts?error=" + encodeURIComponent("Add your Meta app (App ID and App Secret) first"));
  const mode = req.query.with === "instagram" ? "ig" : "fb";
  const state = makeState(who.org, mode);
  const url = new URL(`https://www.facebook.com/${META.GRAPH_VERSION}/dialog/oauth`);
  url.searchParams.set("client_id", app.appId);
  url.searchParams.set("redirect_uri", META.REDIRECT_URI);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  if (app.configId) url.searchParams.set("config_id", app.configId); // Facebook Login for Business
  else url.searchParams.set("scope", mode === "ig" ? `${SCOPES},${INSTAGRAM_SCOPES}` : SCOPES);
  res.redirect(url.toString());
}

// Step 2: Facebook sends the browser back here with a code
async function finishConnect(req, res) {
  const back = (query) => res.redirect(`/#accounts?${query}`);
  try {
    const { code, state, error_description: denied } = req.query;
    if (denied) return back("error=" + encodeURIComponent(denied));
    const login = readState(state); // { org, mode }
    const who = await currentUser(req);
    if (!login || !who || who.org !== login.org) return back("error=" + encodeURIComponent("Login expired. Please press Connect again."));
    const withInstagram = login.mode === "ig";

    const app = await metaApp.appFor(login.org); // the same app the login started with
    if (!app) return back("error=" + encodeURIComponent("No Meta app is set up"));
    const short = await graph("/oauth/access_token", { params: { client_id: app.appId, client_secret: app.appSecret, redirect_uri: META.REDIRECT_URI, code } });
    const long = await graph("/oauth/access_token", { params: { grant_type: "fb_exchange_token", client_id: app.appId, client_secret: app.appSecret, fb_exchange_token: short.access_token } });
    // Page tokens made from a long-lived user token don't expire
    const fields = "id,name,access_token,picture{url}" + (withInstagram ? ",instagram_business_account{id,username,profile_picture_url}" : "");
    const pages = await graphAll("/me/accounts", { token: long.access_token, params: { fields, limit: 100 } });

    if (!pages.length) return back("error=" + encodeURIComponent("No Facebook Page was selected. Press Connect Facebook again and tick your Page in the Facebook window."));

    let nPages = 0, nInstagram = 0;
    const taken = [];
    for (const p of pages) {
      // A Page can belong to one workspace only, otherwise its messages would go to the wrong shop
      if (await SocialAccount.exists({ platform: "Facebook", accountId: p.id, organizationId: { $ne: login.org } })) { taken.push(p.name); continue; }
      const page = await SocialAccount.findOneAndUpdate(
        { organizationId: login.org, platform: "Facebook", accountId: p.id },
        { $set: { accountName: p.name, accessToken: encrypt(p.access_token), pictureUrl: p.picture?.data?.url || null, status: "active", statusNote: null } },
        { upsert: true, new: true }
      ).select("+accessToken");
      await turnOnWebhooks(page, p.access_token);
      await page.save();
      nPages++;

      // The Instagram account linked to this Page (only when "Connect Instagram" was pressed)
      const ig = p.instagram_business_account;
      if (!ig) continue;
      if (await SocialAccount.exists({ platform: "Instagram", accountId: ig.id, organizationId: { $ne: login.org } })) { taken.push(`@${ig.username}`); continue; }
      await SocialAccount.findOneAndUpdate(
        { organizationId: login.org, platform: "Instagram", accountId: ig.id },
        { $set: { accountName: `@${ig.username}`, pageId: p.id, accessToken: encrypt(p.access_token), pictureUrl: ig.profile_picture_url || null, status: "active", statusNote: null, webhooksOn: page.webhooksOn } },
        { upsert: true, new: true }
      );
      nInstagram++;
    }
    if (withInstagram) {
      if (!nInstagram && !taken.length) return back("error=" + encodeURIComponent("No Instagram account was found. Make it a Business account, link it to your Facebook Page, then press Connect Instagram again and tick it."));
      await metaApp.registerInstagramWebhook(login.org); // so Instagram messages and comments reach us
    }
    back(`connected=1&pages=${nPages}&instagram=${nInstagram}${taken.length ? "&taken=" + encodeURIComponent(taken.join(", ")) : ""}`);
  } catch (e) {
    console.error("Facebook connect:", e.message);
    back("error=" + encodeURIComponent(e.message));
  }
}

/* ---------- the shop's own Meta app ---------- */
// Everything the shop needs to copy into its app, and what it saved (never the secret)
router.get("/app", handle(async (req, res) => {
  const o = await Organization.findById(req.org).select("metaApp").lean();
  const base = PUBLIC_BASE_URL || `${req.headers["x-forwarded-proto"] || "http"}://${req.headers.host}`;
  const own = o?.metaApp?.appId ? { appId: o.metaApp.appId, name: o.metaApp.name, configId: o.metaApp.configId, savedAt: o.metaApp.savedAt, webhookOk: o.metaApp.webhookOk, webhookNote: o.metaApp.webhookNote } : null;
  res.json({
    own, sharedApp: !!(META.APP_ID && META.APP_SECRET),
    copy: { redirectUri: META.REDIRECT_URI, domain: new URL(base).hostname, privacy: `${base}/privacy`, terms: `${base}/terms`, deletion: `${base}/data-deletion` },
  });
}));

router.put("/app", handle(async (req, res) => {
  res.json({ ok: true, ...(await metaApp.saveOwnApp(req.org, req.body)) });
}));

router.delete("/app", handle(async (req, res) => {
  await metaApp.removeOwnApp(req.org);
  res.json({ ok: true });
}));

router.get("/", handle(async (req, res) => {
  const rows = await SocialAccount.find({ organizationId: req.org, platform: { $in: ["Facebook", "Instagram"] } }).sort({ platform: 1, accountName: 1 }).lean();
  res.json(rows.map(publicView));
}));

// Checks every token and turns webhooks on again for Pages where they are off
// Asks Facebook if the Page token still works and switches webhooks on again. Saves the result.
// Also used by the Super Admin "Check all Pages" button and the 6-hourly job.
async function checkPage(a) {
  try {
    const token = decrypt(a.accessToken);
    await graph(`/${a.accountId}`, { token, params: { fields: "id" } });
    a.status = "active";
    a.statusNote = null;
    if (a.platform === "Facebook") await turnOnWebhooks(a, token); // Instagram uses its Page's webhooks
    else a.webhooksOn = !!(await SocialAccount.exists({ organizationId: a.organizationId, platform: "Facebook", accountId: a.pageId, webhooksOn: true }));
  } catch (e) {
    a.status = "needs_reconnect";
    a.statusNote = e.message;
  }
  await a.save();
}

// Checks every connected Page and Instagram account of every shop, 5 at a time. Returns { checked, broken }.
// Pages first, so an Instagram account sees whether its Page still receives messages.
async function checkAllPages() {
  const all = await SocialAccount.find({ platform: { $in: ["Facebook", "Instagram"] } }).select("+accessToken");
  const run = async (list) => { let next = 0; await Promise.all(Array.from({ length: 5 }, async () => { while (next < list.length) await checkPage(list[next++]); })); };
  await run(all.filter((a) => a.platform === "Facebook"));
  await run(all.filter((a) => a.platform === "Instagram"));
  return { checked: all.length, broken: all.filter((p) => p.status !== "active").length };
}

router.post("/check", handle(async (req, res) => {
  const accounts = await SocialAccount.find({ organizationId: req.org, platform: { $in: ["Facebook", "Instagram"] } }).select("+accessToken").sort({ platform: 1 });
  for (const a of accounts) await checkPage(a); // Facebook first, so Instagram sees the Page's result
  res.json(accounts.map((a) => publicView(a.toObject())));
}));

// Facebook Page: tell Meta to stop sending its messages, and forget the Page and its Instagram.
// Instagram account: just forget it (the Page stays connected).
async function disconnectPage(account) {
  if (account.platform === "Facebook") {
    await graph(`/${account.accountId}/subscribed_apps`, { token: decrypt(account.accessToken), method: "DELETE" }).catch(() => {});
    await SocialAccount.deleteMany({ organizationId: account.organizationId, platform: "Instagram", pageId: account.accountId });
  }
  await account.deleteOne();
}

router.delete("/:id", handle(async (req, res) => {
  const account = await SocialAccount.findOne({ _id: req.params.id, organizationId: req.org }).select("+accessToken");
  if (!account) throw fail(404, "Account not found");
  await disconnectPage(account);
  res.json({ ok: true });
}));

module.exports = { router, startConnect, finishConnect, checkPage, checkAllPages, disconnectPage };
