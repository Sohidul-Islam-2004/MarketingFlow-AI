// Facebook Login: connect Facebook Pages, list them, check them, disconnect.
const router = require("express").Router();
const crypto = require("crypto");
const { SocialAccount } = require("../models");
const { handle, fail } = require("../lib/errors");
const { graph, graphAll } = require("../lib/graph");
const { encrypt, decrypt } = require("../lib/crypto");
const { currentUser } = require("../middleware/auth");
const { META } = require("../config");

// Permissions the app asks for. pages_messaging = reply in Messenger, pages_manage_engagement = reply to comments.
const SCOPES = [
  "pages_show_list", "pages_read_engagement", "pages_manage_metadata", "pages_manage_posts", "pages_messaging", "pages_manage_engagement",
  "business_management",
].join(",");
const WEBHOOK_FIELDS = ["messages", "messaging_postbacks", "message_echoes", "feed"];


// The "state" Facebook sends back tells us which workspace started the login. It is signed with
// the app secret, so it can't be faked and it still works if the server restarted in between.
const sign = (text) => crypto.createHmac("sha256", META.APP_SECRET).update(text).digest("hex").slice(0, 32);
const makeState = (org) => { const body = `${org}.${Date.now()}`; return `${body}.${sign(body)}`; };
function readState(state) {
  const [org, at, sig] = String(state || "").split(".");
  if (!org || !sig || sig !== sign(`${org}.${at}`)) return null;
  return Date.now() - Number(at) < 15 * 60e3 ? org : null; // valid for 15 minutes
}

const publicView = (a) => ({ _id: a._id, platform: a.platform, accountId: a.accountId, accountName: a.accountName, pictureUrl: a.pictureUrl, status: a.status, statusNote: a.statusNote, webhooksOn: a.webhooksOn, lastWebhookAt: a.lastWebhookAt });

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
  if (!META.APP_ID || !META.APP_SECRET) return res.status(400).send("Set FB_APP_ID and FB_APP_SECRET in .env first.");
  const state = makeState(who.org);
  const url = new URL(`https://www.facebook.com/${META.GRAPH_VERSION}/dialog/oauth`);
  url.searchParams.set("client_id", META.APP_ID);
  url.searchParams.set("redirect_uri", META.REDIRECT_URI);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  if (META.CONFIG_ID) url.searchParams.set("config_id", META.CONFIG_ID); // Facebook Login for Business
  else url.searchParams.set("scope", SCOPES);
  res.redirect(url.toString());
}

// Step 2: Facebook sends the browser back here with a code
async function finishConnect(req, res) {
  const back = (query) => res.redirect(`/#accounts?${query}`);
  try {
    const { code, state, error_description: denied } = req.query;
    if (denied) return back("error=" + encodeURIComponent(denied));
    const org = readState(state);
    const who = await currentUser(req);
    if (!org || !who || who.org !== org) return back("error=" + encodeURIComponent("Login expired. Please press Connect Facebook again."));
    const login = { org };

    const short = await graph("/oauth/access_token", { params: { client_id: META.APP_ID, client_secret: META.APP_SECRET, redirect_uri: META.REDIRECT_URI, code } });
    const long = await graph("/oauth/access_token", { params: { grant_type: "fb_exchange_token", client_id: META.APP_ID, client_secret: META.APP_SECRET, fb_exchange_token: short.access_token } });
    // Page tokens made from a long-lived user token don't expire
    const pages = await graphAll("/me/accounts", { token: long.access_token, params: { fields: "id,name,access_token,picture{url}", limit: 100 } });

    if (!pages.length) return back("error=" + encodeURIComponent("No Facebook Page was selected. Press Connect Facebook again and tick your Page in the Facebook window."));

    let nPages = 0;
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
    }
    back(`connected=1&pages=${nPages}${taken.length ? "&taken=" + encodeURIComponent(taken.join(", ")) : ""}`);
  } catch (e) {
    console.error("Facebook connect:", e.message);
    back("error=" + encodeURIComponent(e.message));
  }
}

router.get("/", handle(async (req, res) => {
  const rows = await SocialAccount.find({ organizationId: req.org, platform: "Facebook" }).sort({ accountName: 1 }).lean();
  res.json(rows.map(publicView));
}));

// Checks every token and turns webhooks on again for Pages where they are off
router.post("/check", handle(async (req, res) => {
  const accounts = await SocialAccount.find({ organizationId: req.org, platform: "Facebook" }).select("+accessToken");
  for (const a of accounts) {
    try {
      const token = decrypt(a.accessToken);
      await graph(`/${a.accountId}`, { token, params: { fields: "id" } });
      a.status = "active";
      a.statusNote = null;
      await turnOnWebhooks(a, token);
    } catch (e) {
      a.status = "needs_reconnect";
      a.statusNote = e.message;
    }
    await a.save();
  }
  res.json(accounts.map((a) => publicView(a.toObject())));
}));

router.delete("/:id", handle(async (req, res) => {
  const account = await SocialAccount.findOne({ _id: req.params.id, organizationId: req.org }).select("+accessToken");
  if (!account) throw fail(404, "Account not found");
  // Tell Meta to stop sending this Page\'s messages
  await graph(`/${account.accountId}/subscribed_apps`, { token: decrypt(account.accessToken), method: "DELETE" }).catch(() => {});
  await account.deleteOne();
  res.json({ ok: true });
}));

module.exports = { router, startConnect, finishConnect };
