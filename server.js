const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config();
const dns = require("dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]); // Use Google DNS

const {
  Organization, Lead, Task, Brand, ContentItem, ContentPlan, MediaAsset, CreativeTemplate,
  AdEntity, AdInsight, AdBreakdown, CampaignDraft, ChangeRequest, Recommendation, BudgetPlan,
  Experiment, AccountInsight, Competitor, CompetitorSnapshot, Product, Order, Conversation,
  Blacklist, AgentConfig, WebhookEvent, SocialAccount, Notification, AiUsage, nextOrderNo,
} = require("./schema.js");

/* ---------- config (.env) ----------
DATABASE_URL=mongodb+srv://...
PORT=3000
DEFAULT_TENANT=org_123
WORKSPACE_NAME=Test
PUBLIC_BASE_URL=https://your-domain-or-ngrok.app     (public URL of this server; Instagram needs public media URLs)

# Meta app (developers.facebook.com)
FB_APP_ID=...
FB_APP_SECRET=...
FB_REDIRECT_URI=http://localhost:3000/auth/facebook/callback
FB_CONFIG_ID=                                        (Facebook Login for Business configuration id, optional)
FB_GRAPH_VERSION=v23.0                               (check the latest version in Meta's changelog)
META_WEBHOOK_VERIFY_TOKEN=some-random-string         (same value in App Dashboard > Webhooks)
TOKEN_ENC_KEY=64-hex-chars                           (node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

# AI gateway (any OpenAI-compatible API: OpenAI, Groq, OpenRouter, Together, Ollama, vLLM ...)
AI_BASE_URL=https://api.openai.com/v1
AI_API_KEY=...
AI_MODEL=gpt-4o-mini
AI_IMAGE_MODEL=gpt-image-1                           (optional; leave empty to disable AI image generation)
AI_IMAGE_SIZE=1024x1024

# n8n (existing flows) + alerts
N8N_BASE_URL=http://localhost:5678
N8N_REPLY_URL=http://localhost:5678/webhook/messenger-reply
WEBHOOK_SECRET=some-long-random-string               (protects n8n inbound routes)
ALERT_WEBHOOK_URL=                                   (optional n8n webhook: email / WhatsApp alerts)
SALES_WEBHOOK_URL=                                   (optional n8n webhook: new lead -> sales team)
JOBS=on                                              (set "off" to disable background jobs)
-------------------------------------- */
const DEFAULT_TENANT = process.env.DEFAULT_TENANT || "org_123";
const N8N_BASE = process.env.N8N_BASE_URL || "http://localhost:5678";
const N8N_REPLY = process.env.N8N_REPLY_URL || `${N8N_BASE}/webhook/messenger-reply`;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const UPLOAD_DIR = path.join(__dirname, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const PLANS = {
  free: { price: 0, aiOrders: 100, pages: 1 },
  pro: { price: 1999, aiOrders: 2000, pages: 5 },
  business: { price: 4999, aiOrders: 20000, pages: 25 },
};

const app = express();
app.use(cors());
// rawBody is kept so Meta webhook signatures can be verified
app.use(express.json({ limit: "10mb", verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use("/uploads", express.static(UPLOAD_DIR, { maxAge: "7d" }));
app.use(express.static(__dirname));

/* ---------- helpers ---------- */
// Throw fail(400, "message") inside any route: the message is returned to the browser.
const fail = (http, message, meta) => Object.assign(new Error(message), { http, meta });

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    if (err && err.code === 11000) return res.status(409).json({ error: "Already exists" });
    if (err && err.http) return res.status(err.http).json({ error: err.message, meta: err.meta });
    if (err && err.name === "ValidationError") return res.status(400).json({ error: err.message });
    console.error(`${req.method} ${req.path}:`, err);
    res.status(500).json({ error: "Internal Server Error" });
  });

// Tenant comes from header, body, query, or the default workspace.
// Replace with the logged-in user's organization once you add auth.
const tid = (req) =>
  String(req.headers["x-tenant-id"] || req.body?.tenantId || req.query.tenantId || DEFAULT_TENANT);
// Who is acting (for approvals / audit). Replace with the logged-in user once you add auth.
const actor = (req) => String(req.headers["x-user-name"] || req.body?.by || "Admin").slice(0, 80);

// Protects routes that only n8n should call (skipped if WEBHOOK_SECRET is not set).
const needSecret = (req, res, next) => {
  const s = process.env.WEBHOOK_SECRET;
  if (s && req.headers["x-webhook-secret"] !== s) return res.status(401).json({ error: "Unauthorized" });
  next();
};

const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const DAY = 86400000;
const pct = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : cur > 0 ? 100 : 0);
const ymd = (d) => new Date(d).toISOString().slice(0, 10);
const daysAgo = (n) => ymd(Date.now() - n * DAY);
const round = (n, d = 2) => Math.round((Number(n) || 0) * 10 ** d) / 10 ** d;
const pick = (obj, keys) => Object.fromEntries(Object.entries(obj || {}).filter(([k]) => keys.includes(k)));
const lines = (v) => (Array.isArray(v) ? v : String(v || "").split(/\r?\n|,/)).map((s) => String(s).trim()).filter(Boolean);
const linesNL = (v) => (Array.isArray(v) ? v : String(v || "").split(/\r?\n/)).map((s) => String(s).trim()).filter(Boolean); // keeps commas
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const todayIn = (tz) => { try { return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date()); } catch { return ymd(new Date()); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Accepts "2026-11-01" or "7" (days back). Returns { from, to } as YYYY-MM-DD.
function range(q, defDays = 7) {
  const to = q.to || ymd(new Date());
  const from = q.from || ymd(new Date(to).getTime() - (Number(q.days) || defDays - 1) * DAY);
  return { from, to };
}

const payLabel = (o) =>
  o.paymentMethod === "COD"
    ? `COD (${o.paymentStatus === "paid" ? "paid" : "unpaid"})`
    : o.paymentStatus === "paid" ? `Paid (${o.paymentMethod})` : `${o.paymentMethod} (unpaid)`;

const orderRow = (o) => ({
  id: String(o._id), no: o.orderNo, customer: o.customerName, phone: o.phone, address: o.address,
  total: o.total, payment: payLabel(o), channel: o.channel, status: o.status, isAI: o.isAI,
  risk: o.riskScore, reasons: o.riskReasons || [], courier: o.courier?.provider || null,
  tracking: o.courier?.trackingId || null, createdAt: o.createdAt,
});

async function sumOrders(org, match = {}) {
  const [r] = await Order.aggregate([
    { $match: { organizationId: org, status: { $ne: "cancelled" }, ...match } },
    { $group: { _id: null, count: { $sum: 1 }, revenue: { $sum: "$total" } } },
  ]);
  return { count: r?.count || 0, revenue: r?.revenue || 0 };
}

async function weekDelta(Model, org, extra = {}) {
  const now = Date.now();
  const q = (from, to) => Model.countDocuments({ organizationId: org, ...extra, createdAt: { $gte: new Date(from), $lt: new Date(to) } });
  const [cur, prev] = await Promise.all([q(now - 7 * DAY, now + 1), q(now - 14 * DAY, now - 7 * DAY)]);
  return pct(cur, prev);
}

// Simple rules-based fraud score (0-100). Tune the numbers to your business.
async function scoreRisk(org, { phone, total, paymentMethod }) {
  let score = 0;
  const reasons = [];
  if (await Blacklist.exists({ organizationId: org, phone })) { score += 100; reasons.push("Phone is blacklisted"); }
  if (!/^01[3-9]\d{8}$/.test(phone || "")) { score += 40; reasons.push("Invalid Bangladesh phone number"); }
  const recent = new Date(Date.now() - 10 * 60 * 1000);
  if (await Order.exists({ organizationId: org, phone, createdAt: { $gte: recent } })) { score += 30; reasons.push("Repeat order within 10 minutes"); }
  const cancelled = await Order.countDocuments({ organizationId: org, phone, status: "cancelled" });
  if (cancelled >= 2) { score += 25; reasons.push(`${cancelled} previous cancelled orders`); }
  if (paymentMethod === "COD" && total >= 10000) { score += 20; reasons.push("High-value COD order"); }
  return { score: Math.min(score, 100), reasons };
}

// Courier booking stub. Replace the body with a real Pathao / Steadfast / RedX API call.
async function bookCourier(provider, order) {
  return { provider, trackingId: `TRK-${Date.now().toString(36).toUpperCase()}` };
}

async function ensureWorkspace() {
  await Organization.updateOne(
    { _id: DEFAULT_TENANT },
    { $setOnInsert: { name: process.env.WORKSPACE_NAME || "Test" } },
    { upsert: true }
  );
  await AgentConfig.updateOne({ organizationId: DEFAULT_TENANT }, { $setOnInsert: {} }, { upsert: true });
}

/* ---------- token encryption (AES-256-GCM) ---------- */
const ENC_KEY = (() => {
  const hex = process.env.TOKEN_ENC_KEY || "";
  if (/^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, "hex");
  console.warn("⚠️  TOKEN_ENC_KEY missing/invalid: using a derived dev key. Set a 64-hex TOKEN_ENC_KEY in production.");
  return crypto.createHash("sha256").update(process.env.WEBHOOK_SECRET || "marketingflow-dev-key").digest();
})();
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", ENC_KEY, iv);
  const data = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return ["enc:v1", iv.toString("hex"), c.getAuthTag().toString("hex"), data.toString("hex")].join(":");
}
function decrypt(stored) {
  if (!stored || !String(stored).startsWith("enc:v1:")) return stored; // legacy plain-text token
  const [, , iv, tag, data] = String(stored).split(":");
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", ENC_KEY, Buffer.from(iv, "hex"));
    d.setAuthTag(Buffer.from(tag, "hex"));
    return Buffer.concat([d.update(Buffer.from(data, "hex")), d.final()]).toString("utf8");
  } catch {
    // Happens when TOKEN_ENC_KEY changed after the token was saved
    throw fail(401, "Saved token can't be decrypted (TOKEN_ENC_KEY changed). Reconnect Facebook in Meta Accounts.");
  }
}
const tok = (acc) => decrypt(acc.accessToken);

/* ---------- settings + notifications ---------- */
const DEFAULT_SETTINGS = {
  requireApproval: true, creativeApproval: false, optimizationMode: "recommend", maxBudgetDeltaPct: 20,
  maxDailyBudget: 0, guardrailAllowlist: [], salesTeam: [], rrIndex: 0, timezone: "Asia/Dhaka",
  leadCategories: ["Product inquiry", "Service inquiry", "Wholesale / B2B", "Support", "Other"],
};
async function getSettings(org) {
  const o = await Organization.findById(org).lean();
  return { ...DEFAULT_SETTINGS, ...(o?.marketingSettings || {}) };
}

async function notify(org, type, title, message, view = null) {
  await Notification.create({ organizationId: org, type, title, message, view }).catch((e) => console.warn("notify:", e.message));
  const url = process.env.ALERT_WEBHOOK_URL;
  if (url) {
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tenantId: org, type, title, message }) })
      .catch((e) => console.warn("Alert webhook failed:", e.message));
  }
}

/* ---------- connect ---------- */
mongoose
  .connect(process.env.DATABASE_URL)
  .then(async () => {
    console.log("✅ MongoDB connected");
    const missing = [["Conversation", Conversation, "orderDraft"], ["Conversation", Conversation, "aiHandled"], ["AgentConfig", AgentConfig, "deliveryInside"], ["Brand", Brand, "facts"]].filter(([, M, p]) => !M || !M.schema.path(p)).map(([n, , p]) => `${n}.${p}`);
    if (missing.length) console.error(`\n❌ schema.js is OUTDATED (missing ${missing.join(", ")}). Replace schema.js with the new one or data will not be saved.\n`);
    await ensureWorkspace(); startJobs();
  })
  .catch((err) => { console.error("❌ MongoDB connection error:", err); process.exit(1); });

app.get("/api/health", (_req, res) => res.json({ ok: mongoose.connection.readyState === 1, ai: aiConfigured(), meta: !!process.env.FB_APP_ID, publicUrl: !!PUBLIC_BASE_URL }));

/* =====================================================
   META GRAPH API HELPERS
   ===================================================== */
const FB_APP_ID = process.env.FB_APP_ID;
const FB_APP_SECRET = process.env.FB_APP_SECRET;
const FB_REDIRECT_URI = process.env.FB_REDIRECT_URI || `http://localhost:${process.env.PORT || 3000}/auth/facebook/callback`;
const GRAPH_VER = process.env.FB_GRAPH_VERSION || "v23.0";
const GRAPH = `https://graph.facebook.com/${GRAPH_VER}`;
const GRAPH_VIDEO = `https://graph-video.facebook.com/${GRAPH_VER}`;

// GET params go in the query string, POST bodies are sent as JSON (nested objects allowed).
async function graph(p, { token, params = {}, method = "GET", body, base = GRAPH } = {}) {
  const url = new URL(p.startsWith("http") ? p : base + p);
  const q = { ...params };
  if (token) q.access_token = token;
  Object.entries(q).forEach(([k, v]) => v != null && url.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : String(v)));
  const opts = { method };
  if (body && method !== "GET") {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)));
  }
  const r = await fetch(url, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    const e = j.error || {};
    throw fail(502, e.error_user_msg || e.message || `Meta API error ${r.status}`, { code: e.code, subcode: e.error_subcode, type: e.type, fbtrace_id: e.fbtrace_id });
  }
  return j;
}
// Follows paging.next until `max` rows
async function graphAll(p, opts = {}, max = 2000) {
  let j = await graph(p, opts);
  const out = [...(j.data || [])];
  while (j.paging?.next && out.length < max) {
    const r = await fetch(j.paging.next);
    j = await r.json();
    if (j.error) throw fail(502, j.error.message);
    out.push(...(j.data || []));
  }
  return out;
}
// Meta budgets are in the currency's minor unit (poisha/cents) except a few currencies.
const NO_MINOR = new Set(["JPY", "KRW", "CLP", "COP", "CRC", "HUF", "ISK", "IDR", "PYG", "TWD", "VND"]);
const minorDiv = (cur) => (NO_MINOR.has(String(cur || "").toUpperCase()) ? 1 : 100);

// Permissions each feature needs (shown as "missing" in the accounts screen)
const REQUIRED_SCOPES = {
  Facebook: ["pages_show_list", "pages_read_engagement", "pages_manage_posts", "read_insights", "pages_manage_metadata", "leads_retrieval"],
  Instagram: ["instagram_basic", "instagram_content_publish", "instagram_manage_insights"],
  "Meta Ads": ["ads_read", "ads_management"],
};
const OAUTH_SCOPES = [
  "pages_show_list", "pages_read_engagement", "pages_manage_posts", "pages_manage_metadata", "read_insights",
  "instagram_basic", "instagram_content_publish", "instagram_manage_insights", "instagram_manage_messages",
  "business_management", "ads_read", "ads_management", "leads_retrieval",
].join(",");

const publicUrl = (u) => (!u ? null : /^https?:\/\//.test(u) ? u : PUBLIC_BASE_URL ? PUBLIC_BASE_URL + u : null);
const isPublicBase = () => !!PUBLIC_BASE_URL && !/localhost|127\.0\.0\.1/.test(PUBLIC_BASE_URL);

const accView = (a) => {
  const o = a.toJSON ? a.toJSON() : { ...a };
  delete o.accessToken;
  const need = REQUIRED_SCOPES[o.platform] || [];
  o.missingScopes = o.scopes?.length ? need.filter((s) => !o.scopes.includes(s)) : null; // null = unknown
  return o;
};

async function adAccountFor(org, adAccountId) {
  const acc = await SocialAccount.findOne({ organizationId: org, platform: "Meta Ads", ...(adAccountId ? { accountId: adAccountId } : {}) }).select("+accessToken");
  if (!acc) throw fail(400, "No Meta ad account connected. Connect Facebook with ads permissions first.");
  return acc;
}

/* =====================================================
   FACEBOOK LOGIN (OAuth) + ACCOUNT HUB
   ===================================================== */
const OAUTH_STATES = new Map(); // state -> { org, at }  (single-server; move to Mongo/Redis when scaling)

app.get("/api/meta/connect", (req, res) => {
  if (!FB_APP_ID || !FB_APP_SECRET) return res.status(400).send("Set FB_APP_ID and FB_APP_SECRET in .env first.");
  const state = crypto.randomBytes(24).toString("hex");
  OAUTH_STATES.set(state, { org: tid(req), at: Date.now() });
  for (const [k, v] of OAUTH_STATES) if (Date.now() - v.at > 15 * 60e3) OAUTH_STATES.delete(k);
  const u = new URL(`https://www.facebook.com/${GRAPH_VER}/dialog/oauth`);
  u.searchParams.set("client_id", FB_APP_ID);
  u.searchParams.set("redirect_uri", FB_REDIRECT_URI);
  u.searchParams.set("state", state);
  u.searchParams.set("response_type", "code");
  if (process.env.FB_CONFIG_ID) u.searchParams.set("config_id", process.env.FB_CONFIG_ID);
  else u.searchParams.set("scope", OAUTH_SCOPES);
  res.redirect(u.toString());
});

app.get("/auth/facebook/callback", async (req, res) => {
  const back = (q) => res.redirect(`/?view=pages&${q}`);
  try {
    const { code, state, error, error_description } = req.query;
    if (error) return back("error=" + encodeURIComponent(error_description || error));
    const st = OAUTH_STATES.get(state);
    if (!st) return back("error=" + encodeURIComponent("Login expired or invalid state. Try again."));
    OAUTH_STATES.delete(state);
    const org = st.org;

    const short = await graph("/oauth/access_token", { params: { client_id: FB_APP_ID, client_secret: FB_APP_SECRET, redirect_uri: FB_REDIRECT_URI, code } });
    const long = await graph("/oauth/access_token", { params: { grant_type: "fb_exchange_token", client_id: FB_APP_ID, client_secret: FB_APP_SECRET, fb_exchange_token: short.access_token } });
    const userToken = long.access_token;
    const userExpires = long.expires_in ? new Date(Date.now() + long.expires_in * 1000) : null;

    const perms = await graph("/me/permissions", { token: userToken });
    const scopes = (perms.data || []).filter((p) => p.status === "granted").map((p) => p.permission);

    const upsert = (platform, accountId, set) =>
      SocialAccount.findOneAndUpdate(
        { organizationId: org, platform, accountId },
        { $set: { ...set, platform, accountId, organizationId: org, scopes, connectedVia: "oauth", status: "active", healthNote: null, lastCheckedAt: new Date() } },
        { upsert: true, new: true }
      );

    // Pages + linked Instagram professional accounts (page tokens from a long-lived user token do not expire)
    const pages = await graphAll("/me/accounts", { token: userToken, params: { fields: "id,name,access_token,tasks,picture{url},instagram_business_account{id,username,profile_picture_url}", limit: 100 } });
    let nPages = 0, nIg = 0, nAds = 0;
    for (const p of pages) {
      await upsert("Facebook", p.id, { accountName: p.name, accessToken: encrypt(p.access_token), tasks: p.tasks || [], pictureUrl: p.picture?.data?.url || null, tokenExpiresAt: null });
      nPages++;
      const ig = p.instagram_business_account;
      if (ig) {
        await upsert("Instagram", ig.id, { accountName: ig.username || p.name, username: ig.username, pageId: p.id, pictureUrl: ig.profile_picture_url || null, accessToken: encrypt(p.access_token), tasks: p.tasks || [], tokenExpiresAt: null });
        nIg++;
      }
    }
    // Ad accounts (Marketing API uses the user token, ~60 days; reconnect before it expires)
    if (scopes.includes("ads_read") || scopes.includes("ads_management")) {
      const ads = await graphAll("/me/adaccounts", { token: userToken, params: { fields: "id,name,account_status,currency,timezone_name,business{id,name}", limit: 100 } }).catch(() => []);
      for (const a of ads) {
        await upsert("Meta Ads", a.id, { accountName: a.name || a.id, currency: a.currency, timezone: a.timezone_name, businessId: a.business?.id || null, businessName: a.business?.name || null, accessToken: encrypt(userToken), tokenExpiresAt: userExpires, healthNote: a.account_status === 1 ? null : `Ad account status ${a.account_status}` });
        nAds++;
      }
    }
    // Business portfolios
    if (scopes.includes("business_management")) {
      const biz = await graphAll("/me/businesses", { token: userToken, params: { fields: "id,name" } }).catch(() => []);
      await Organization.updateOne({ _id: org }, { metaBusinesses: biz.map((b) => ({ id: b.id, name: b.name })) });
    }
    back(`connected=1&pages=${nPages}&ig=${nIg}&ads=${nAds}`);
  } catch (e) {
    console.error("Facebook callback:", e.meta || e);
    back("error=" + encodeURIComponent(e.message));
  }
});

// List accounts (tokens never leave the server)
app.get("/api/integrations", wrap(async (req, res) => {
  const q = { organizationId: tid(req) };
  if (req.query.platform) q.platform = req.query.platform;
  if (req.query.brandId) q.brandId = req.query.brandId;
  const rows = await SocialAccount.find(q).sort({ platform: 1, createdAt: -1 });
  res.json(rows.map(accView));
}));

// Manual connect (advanced: paste a page token)
app.post("/api/integrations/connect", wrap(async (req, res) => {
  const { organizationId, platform, accountName, accountId, accessToken, pageId, brandId, clientName } = req.body;
  if (!platform || !accountName || !accountId || !accessToken) throw fail(400, "platform, accountName, accountId and accessToken are required");
  const a = await SocialAccount.create({ organizationId: organizationId || tid(req), platform, accountName, accountId, pageId: pageId || null, brandId: brandId || null, clientName: clientName || null, accessToken: encrypt(accessToken) });
  res.json({ success: true, account: accView(a) });
}));

// Assign brand / agency client
app.put("/api/integrations/:id", wrap(async (req, res) => {
  const patch = pick(req.body, ["brandId", "clientName", "accountName"]);
  const a = await SocialAccount.findOneAndUpdate({ _id: req.params.id, organizationId: tid(req) }, patch, { new: true });
  if (!a) throw fail(404, "Account not found");
  res.json({ success: true, account: accView(a) });
}));

app.delete("/api/integrations/:id", wrap(async (req, res) => {
  const r = await SocialAccount.deleteOne({ _id: req.params.id, organizationId: tid(req) });
  if (!r.deletedCount) return res.status(404).json({ error: "Account not found" });
  res.json({ success: true });
}));

// Token health monitoring (debug_token)
async function checkTokens(org) {
  const accs = await SocialAccount.find({ organizationId: org, platform: { $in: ["Facebook", "Instagram", "Meta Ads"] } }).select("+accessToken");
  const out = [];
  for (const a of accs) {
    const before = a.status;
    try {
      if (FB_APP_ID && FB_APP_SECRET) {
        const d = (await graph("/debug_token", { params: { input_token: tok(a), access_token: `${FB_APP_ID}|${FB_APP_SECRET}` } })).data || {};
        if (d.scopes?.length) a.scopes = d.scopes;
        a.tokenExpiresAt = d.expires_at ? new Date(d.expires_at * 1000) : null;
        a.status = !d.is_valid ? "expired" : a.tokenExpiresAt && a.tokenExpiresAt - Date.now() < 7 * DAY ? "expiring" : "active";
        a.healthNote = d.error?.message || (a.status === "expiring" ? "Token expires soon. Reconnect Facebook." : null);
      } else {
        await graph("/me", { token: tok(a), params: { fields: "id" } });
        a.status = "active"; a.healthNote = "Set FB_APP_ID/SECRET for full token checks";
      }
    } catch (e) {
      a.status = /expired|session|validat/i.test(e.message) ? "expired" : "error";
      a.healthNote = e.message;
    }
    a.lastCheckedAt = new Date();
    await a.save();
    if (before !== a.status && ["expired", "expiring", "error"].includes(a.status)) {
      await notify(org, "token", `${a.platform} account needs attention`, `${a.accountName}: ${a.healthNote || a.status}`, "pages");
    }
    out.push(accView(a));
  }
  return out;
}
app.post("/api/integrations/health", wrap(async (req, res) => res.json(await checkTokens(tid(req)))));

// Business portfolios and their assets
app.get("/api/meta/businesses", wrap(async (req, res) => {
  const o = await Organization.findById(tid(req)).lean();
  res.json(o?.metaBusinesses || []);
}));
app.get("/api/meta/businesses/:id/assets", wrap(async (req, res) => {
  const acc = await adAccountFor(tid(req)).catch(() => null)
    || await SocialAccount.findOne({ organizationId: tid(req), connectedVia: "oauth" }).select("+accessToken");
  if (!acc) throw fail(400, "Connect Facebook first");
  const token = tok(acc), id = req.params.id;
  const safe = (p, f) => graphAll(`/${id}/${p}`, { token, params: { fields: f, limit: 100 } }).catch((e) => ({ error: e.message }));
  const [pages, adAccounts, clientAdAccounts] = await Promise.all([
    safe("owned_pages", "id,name"), safe("owned_ad_accounts", "id,name,currency,account_status"), safe("client_ad_accounts", "id,name,currency,account_status"),
  ]);
  res.json({ pages, adAccounts, clientAdAccounts });
}));

/* =====================================================
   AI GATEWAY (OpenAI-compatible: OpenAI, Groq, OpenRouter, Ollama, vLLM...)
   ===================================================== */
const AI_BASE = (process.env.AI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const AI_MODEL = process.env.AI_MODEL || "gpt-4o-mini";
const aiConfigured = () => !!(process.env.AI_API_KEY || process.env.AI_BASE_URL);
const aiHeaders = () => ({ "Content-Type": "application/json", ...(process.env.AI_API_KEY ? { Authorization: `Bearer ${process.env.AI_API_KEY}` } : {}) });

function parseJSON(text) {
  const t = String(text || "").replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try { return JSON.parse(t); } catch { }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { } }
  throw fail(502, "AI returned invalid JSON. Try again or use a stronger model.");
}

async function aiChat(org, task, { system, user, json = true, temperature = 0.7, maxTokens = 3000 }) {
  if (!aiConfigured()) throw fail(503, "AI is not configured. Set AI_BASE_URL, AI_API_KEY and AI_MODEL in .env");
  const body = { model: AI_MODEL, temperature, max_tokens: maxTokens, messages: [{ role: "system", content: system }, { role: "user", content: user }] };
  if (json) body.response_format = { type: "json_object" };
  let r = await fetch(`${AI_BASE}/chat/completions`, { method: "POST", headers: aiHeaders(), body: JSON.stringify(body) });
  if (!r.ok && json && r.status === 400) { // some providers don't support response_format
    delete body.response_format;
    r = await fetch(`${AI_BASE}/chat/completions`, { method: "POST", headers: aiHeaders(), body: JSON.stringify(body) });
  }
  const j = await r.json().catch(() => ({}));
  const usage = j.usage || {};
  AiUsage.create({ organizationId: org, task, model: AI_MODEL, promptTokens: usage.prompt_tokens || 0, completionTokens: usage.completion_tokens || 0, ok: r.ok }).catch(() => { });
  if (!r.ok) throw fail(502, `AI provider error: ${j.error?.message || r.status}`);
  const text = j.choices?.[0]?.message?.content || "";
  return json ? parseJSON(text) : text;
}
const aiJSON = (org, task, system, user, opts = {}) => aiChat(org, task, { system, user, ...opts });

const LANG = {
  bn: "Bangla (Bengali script, natural Bangladeshi style)",
  en: "English",
  banglish: "Banglish (Bangla written with English letters, casual)",
  mixed: "Bangla mixed with common English words, the way Bangladeshi brands write online",
};

/* ---------- brand context = the "approved knowledge" every prompt is grounded in ---------- */
async function getBrand(org, brandId) {
  if (brandId) { const b = await Brand.findOne({ _id: brandId, organizationId: org }); if (b) return b; }
  return Brand.findOne({ organizationId: org }).sort({ isDefault: -1, createdAt: 1 });
}
async function brandContext(org, brandId, { products = true } = {}) {
  const b = await getBrand(org, brandId);
  const prods = products ? await Product.find({ organizationId: org }).sort({ createdAt: -1 }).limit(20).lean() : [];
  const parts = [];
  if (b) {
    parts.push(`BRAND: ${b.name}${b.industry ? ` (industry: ${b.industry})` : ""}`);
    if (b.description) parts.push(`ABOUT: ${b.description}`);
    if (b.website) parts.push(`WEBSITE: ${b.website}`);
    parts.push(`TONE: ${b.tone}${b.voice ? `. VOICE GUIDE: ${b.voice}` : ""}`);
    if (b.audience) parts.push(`TARGET AUDIENCE: ${b.audience}`);
    if (b.pillars?.length) parts.push(`CONTENT PILLARS: ${b.pillars.map((p) => `${p.name}${p.description ? ` (${p.description})` : ""}`).join("; ")}`);
    if (b.offerings) parts.push(`PRODUCTS/SERVICES: ${b.offerings}`);
    if (b.facts?.length) parts.push(`APPROVED FACTS (the ONLY facts you may state about prices, offers, delivery, policies):\n- ${b.facts.join("\n- ")}`);
    if (b.prohibited?.length) parts.push(`NEVER SAY / PROHIBITED CLAIMS: ${b.prohibited.join("; ")}`);
    if (b.hashtags?.length) parts.push(`BRAND HASHTAGS: ${b.hashtags.join(" ")}`);
    if (b.defaultCta) parts.push(`DEFAULT CTA: ${b.defaultCta}`);
  } else parts.push("BRAND: (no brand profile yet; write generic but professional content)");
  if (prods.length) parts.push(`CATALOGUE (name | price BDT | category | stock):\n${prods.map((p) => `- ${p.name} | ${p.price} | ${p.category} | ${p.stock > 0 ? "in stock" : "out of stock"}`).join("\n")}`);
  return { brand: b, text: parts.join("\n") };
}
const GROUNDING = "Rules: use only the approved facts and catalogue for prices, discounts, delivery and policies. If a detail is missing, do not invent it; write around it or use a placeholder like [price]. Never use prohibited claims. No fake reviews, fake urgency or misleading claims. Follow Meta advertising policies.";

// Bangladesh + global marketing calendar hints (lunar dates shift every year: AI is told to flag them)
const SEASONAL = {
  1: "New Year; winter sale; Thirty-First Night aftermath; Bishwa Ijtema", 2: "21 Feb International Mother Language Day; Pohela Falgun (13 Feb); Valentine's Day (14 Feb); Ekushey Boi Mela",
  3: "26 Mar Independence Day; Ramadan / Eid-ul-Fitr may fall here (lunar)", 4: "14 Apr Pohela Boishakh (Bangla New Year); Eid season (lunar)",
  5: "Mother's Day (2nd Sunday); Eid-ul-Adha may fall here (lunar); summer", 6: "Father's Day (3rd Sunday); national budget; monsoon begins",
  7: "Monsoon; back-to-school; HSC exams", 8: "Monsoon; 15 Aug National Mourning Day (avoid celebratory tone)", 9: "Durga Puja may begin (lunar); autumn",
  10: "Durga Puja (lunar); Halloween (urban youth)", 11: "11.11 sale; Black Friday; winter collection launch", 12: "16 Dec Victory Day; 12.12 sale; Christmas; year-end sale; winter",
};
const seasonalFor = (start, months = 1) => Array.from({ length: months }, (_, i) => { const m = ((new Date(start).getMonth() + i) % 12) + 1; return `Month ${m}: ${SEASONAL[m]}`; }).join("\n");

app.get("/api/ai/status", wrap(async (req, res) => {
  const since = new Date(Date.now() - 30 * DAY);
  const [u] = await AiUsage.aggregate([{ $match: { organizationId: tid(req), createdAt: { $gte: since } } }, { $group: { _id: null, calls: { $sum: 1 }, prompt: { $sum: "$promptTokens" }, completion: { $sum: "$completionTokens" } } }]);
  const byTask = await AiUsage.aggregate([{ $match: { organizationId: tid(req), createdAt: { $gte: since } } }, { $group: { _id: "$task", calls: { $sum: 1 }, tokens: { $sum: { $add: ["$promptTokens", "$completionTokens"] } } } }, { $sort: { calls: -1 } }]);
  res.json({ configured: aiConfigured(), model: AI_MODEL, imageModel: process.env.AI_IMAGE_MODEL || null, last30d: u || { calls: 0, prompt: 0, completion: 0 }, byTask });
}));

/* =====================================================
   BRANDS (multiple brands, agency clients, voice, colours, logo)
   ===================================================== */
const BRAND_FIELDS = ["name", "clientName", "industry", "description", "website", "tone", "voice", "audience", "pillars", "offerings", "facts", "prohibited", "hashtags", "languages", "defaultCta", "colors", "logoUrl", "isDefault"];
function cleanBrand(b) {
  const p = pick(b, BRAND_FIELDS);
  for (const k of ["facts", "prohibited"]) if (k in p) p[k] = linesNL(p[k]);
  if ("languages" in p) p.languages = lines(p.languages);
  if ("hashtags" in p) p.hashtags = lines(String(p.hashtags).replace(/\s+/g, ",")).map((h) => (h.startsWith("#") ? h : "#" + h));
  if ("pillars" in p) p.pillars = (Array.isArray(p.pillars) ? p.pillars : linesNL(p.pillars)).map((x) => {
    if (typeof x === "object") return x;
    const [name, ...rest] = String(x).split(/[:\-–—]/);
    return { name: name.trim(), description: rest.join("-").trim() };
  });
  return p;
}
app.get("/api/brands", wrap(async (req, res) => res.json(await Brand.find({ organizationId: tid(req) }).sort({ isDefault: -1, name: 1 }))));
app.get("/api/brands/:id", wrap(async (req, res) => {
  const b = await Brand.findOne({ _id: req.params.id, organizationId: tid(req) });
  if (!b) throw fail(404, "Brand not found");
  res.json(b);
}));
app.post("/api/brands", wrap(async (req, res) => {
  const org = tid(req);
  const data = cleanBrand(req.body);
  if (!data.name) throw fail(400, "Brand name is required");
  if (!(await Brand.exists({ organizationId: org }))) data.isDefault = true;
  if (data.isDefault) await Brand.updateMany({ organizationId: org }, { isDefault: false });
  res.json({ success: true, brand: await Brand.create({ ...data, organizationId: org }) });
}));
app.put("/api/brands/:id", wrap(async (req, res) => {
  const org = tid(req);
  const data = cleanBrand(req.body);
  if (data.isDefault) await Brand.updateMany({ organizationId: org }, { isDefault: false });
  const b = await Brand.findOneAndUpdate({ _id: req.params.id, organizationId: org }, data, { new: true, runValidators: true });
  if (!b) throw fail(404, "Brand not found");
  res.json({ success: true, brand: b });
}));
app.delete("/api/brands/:id", wrap(async (req, res) => {
  const org = tid(req);
  await Brand.deleteOne({ _id: req.params.id, organizationId: org });
  await SocialAccount.updateMany({ organizationId: org, brandId: req.params.id }, { brandId: null });
  res.json({ success: true });
}));

/* =====================================================
   AI CONTENT STRATEGY & PLANNING (1.2)
   ===================================================== */
async function performanceDigest(org, brandId, limit = 8) {
  const q = { organizationId: org, status: { $in: ["Published", "Partially Published"] } };
  if (brandId) q.brandId = brandId;
  const items = await ContentItem.find(q).sort({ publishedAt: -1 }).limit(60).lean();
  const scored = items.map((i) => {
    const m = (i.targets || []).reduce((a, t) => ({ reach: a.reach + (t.metrics?.reach || 0), eng: a.eng + (t.metrics?.engagement || 0) }), { reach: 0, eng: 0 });
    return { title: i.title, type: i.type, format: i.format, pillar: i.pillar, reach: m.reach, engagement: m.eng, rate: m.reach ? round((m.eng / m.reach) * 100) : 0, text: (i.body || "").slice(0, 140) };
  }).filter((x) => x.reach > 0).sort((a, b) => b.rate - a.rate);
  return { top: scored.slice(0, limit), bottom: scored.slice(-Math.min(limit, Math.floor(scored.length / 2))).reverse(), total: items.length };
}

async function businessDigest(org) {
  const since = new Date(Date.now() - 90 * DAY);
  const [orders, leadsBySource, topProducts] = await Promise.all([
    Order.aggregate([{ $match: { organizationId: org, createdAt: { $gte: since }, status: { $ne: "cancelled" } } }, { $group: { _id: "$channel", n: { $sum: 1 }, revenue: { $sum: "$total" }, avg: { $avg: "$total" } } }]),
    Lead.aggregate([{ $match: { organizationId: org, createdAt: { $gte: since } } }, { $group: { _id: { source: "$source", status: "$aiStatus", category: "$category" }, n: { $sum: 1 } } }]),
    Order.aggregate([{ $match: { organizationId: org, createdAt: { $gte: since } } }, { $unwind: "$items" }, { $group: { _id: "$items.name", qty: { $sum: "$items.qty" } } }, { $sort: { qty: -1 } }, { $limit: 10 }]),
  ]);
  const areas = await Order.aggregate([{ $match: { organizationId: org, createdAt: { $gte: since } } }, { $project: { a: { $arrayElemAt: [{ $split: ["$address", ","] }, -1] } } }, { $group: { _id: { $trim: { input: "$a" } }, n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 8 }]);
  return { ordersByChannel: orders, leadsBySource, topProducts, topAreas: areas };
}

async function savePlan(org, data) { return ContentPlan.create({ organizationId: org, ...data }); }

const STRATEGY_SHAPE = `{"summary":"","objectives":[{"objective":"","kpi":"","target":""}],"audienceSegments":[{"name":"","needs":"","message":""}],"positioning":"","pillars":[{"name":"","share":"30%","ideas":[""]}],"channelMix":[{"platform":"","role":"","cadence":""}],"campaignIdeas":[{"name":"","timing":"","concept":"","offer":"","channels":[""]}],"paidStrategy":{"budgetSplit":"","objectives":"","audiences":""},"contentFormats":[""],"kpis":[""],"risks":[""],"next30Days":[""]}`;

app.post("/api/ai/strategy", wrap(async (req, res) => {
  const org = tid(req);
  const { brandId, goal, period = "next 3 months", budget, extra } = req.body;
  const ctx = await brandContext(org, brandId);
  const [perf, biz] = await Promise.all([performanceDigest(org, brandId, 5), businessDigest(org)]);
  const data = await aiJSON(org, "strategy",
    `You are a senior digital marketing strategist for Bangladeshi and global SMEs on Facebook and Instagram. Return JSON only in this shape: ${STRATEGY_SHAPE}. ${GROUNDING}`,
    `${ctx.text}\n\nGOAL: ${goal || "grow sales and leads"}\nPERIOD: ${period}\nMONTHLY AD BUDGET: ${budget || "not given"}\nEXTRA NOTES: ${extra || "-"}\n\nRECENT CONTENT PERFORMANCE: ${JSON.stringify(perf.top)}\nBUSINESS DATA (90 days): ${JSON.stringify(biz)}\nSEASONAL CONTEXT:\n${seasonalFor(new Date(), 3)}\nIndustry: tailor the strategy to the brand's industry.`,
    { maxTokens: 3500 });
  const plan = await savePlan(org, { brandId: ctx.brand?.id || null, kind: "strategy", title: `Strategy: ${goal || "Growth"} (${period})`, input: req.body, data });
  res.json({ success: true, plan });
}));

// Monthly plan / weekly calendar / seasonal campaign / product-based plan
app.post("/api/ai/plan", wrap(async (req, res) => {
  const org = tid(req);
  const { brandId, kind = "monthly", startDate, platforms = ["Facebook", "Instagram"], postsPerWeek = 5, goal, campaignName, productIds = [], includeSeasonal = true, language = "bn" } = req.body;
  const start = startDate ? new Date(startDate) : new Date(Date.now() + DAY);
  const days = kind === "weekly" ? 7 : kind === "campaign" ? Number(req.body.days) || 14 : 30;
  const end = new Date(start.getTime() + (days - 1) * DAY);
  const ctx = await brandContext(org, brandId);
  const focus = productIds.length ? await Product.find({ organizationId: org, _id: { $in: productIds } }).lean() : [];
  const perf = await performanceDigest(org, brandId, 5);
  const count = Math.max(1, Math.round((postsPerWeek * days) / 7));
  const data = await aiJSON(org, "plan_" + kind,
    `You are a social media content planner. Return JSON only: {"theme":"","summary":"","items":[{"date":"YYYY-MM-DD","platform":"Facebook|Instagram","format":"post|carousel|reel|story","pillar":"","topic":"","angle":"","caption":"short draft caption in the requested language","cta":""}]}. Spread posts sensibly across the period (best times for Bangladesh audiences are usually evenings), balance pillars, mix formats per platform. ${GROUNDING}`,
    `${ctx.text}\n\nPLAN TYPE: ${kind}${campaignName ? ` (campaign: ${campaignName})` : ""}\nPERIOD: ${ymd(start)} to ${ymd(end)}\nPLATFORMS: ${platforms.join(", ")}\nNUMBER OF POSTS: about ${count}\nGOAL: ${goal || "engagement and sales"}\nLANGUAGE FOR CAPTIONS: ${LANG[language] || language}\n${focus.length ? `FOCUS PRODUCTS: ${focus.map((p) => `${p.name} (${p.price} BDT)`).join(", ")}\n` : ""}${includeSeasonal ? `SEASONAL CONTEXT (verify lunar dates):\n${seasonalFor(start, Math.ceil(days / 30))}\n` : ""}BEST PERFORMING PAST POSTS: ${JSON.stringify(perf.top)}`,
    { maxTokens: 4000 });
  const items = (data.items || []).map((i) => ({ ...i, date: i.date ? new Date(i.date + "T18:00:00") : start }));
  const plan = await savePlan(org, {
    brandId: ctx.brand?.id || null, kind, title: campaignName || `${kind === "weekly" ? "Weekly calendar" : kind === "campaign" ? "Campaign plan" : "Monthly plan"} ${ymd(start)}`,
    input: req.body, data: { theme: data.theme, summary: data.summary }, items, startDate: start, endDate: end,
  });
  res.json({ success: true, plan });
}));

app.post("/api/ai/audience", wrap(async (req, res) => {
  const org = tid(req);
  const ctx = await brandContext(org, req.body.brandId);
  const biz = await businessDigest(org);
  const data = await aiJSON(org, "audience",
    `You are a marketing analyst. Analyse the target audience. Return JSON: {"summary":"","segments":[{"name":"","size":"small|medium|large","demographics":"","interests":[""],"painPoints":[""],"buyingTriggers":[""],"bestChannels":[""],"messageAngle":"","metaTargetingIdeas":[""]}],"insightsFromData":[""],"gaps":[""]}. Base data-driven insights only on the supplied numbers; label assumptions clearly.`,
    `${ctx.text}\n\nBUSINESS DATA (90 days): ${JSON.stringify(biz)}`);
  const plan = await savePlan(org, { brandId: ctx.brand?.id || null, kind: "audience", title: `Audience analysis ${ymd(new Date())}`, input: req.body, data });
  res.json({ success: true, plan });
}));

// trends | competitors | seasonal | performance | industry
app.post("/api/ai/research", wrap(async (req, res) => {
  const org = tid(req);
  const { brandId, kind = "trends", notes } = req.body;
  const ctx = await brandContext(org, brandId);
  let extra = "";
  if (kind === "competitors") {
    const comps = await Competitor.find({ organizationId: org }).lean();
    extra = `COMPETITOR DATA (public): ${JSON.stringify(comps.map((c) => ({ name: c.name, latest: c.latest ? { ...c.latest, posts: (c.latest.posts || []).slice(0, 8).map((p) => ({ caption: (p.caption || "").slice(0, 200), likes: p.like_count, comments: p.comments_count, type: p.media_type })) } : null, notes: (c.notes || []).slice(-10) })))}`;
  }
  if (kind === "performance") extra = `OWN CONTENT PERFORMANCE: ${JSON.stringify(await performanceDigest(org, brandId, 10))}`;
  if (kind === "seasonal") extra = `SEASONAL CONTEXT (next 3 months, verify lunar dates):\n${seasonalFor(new Date(), 3)}`;
  const shapes = {
    trends: `{"summary":"","topics":[{"topic":"","whyNow":"","contentIdea":"","format":"","confidence":"low|medium|high"}],"hashtagIdeas":[""],"note":"These are AI-suggested themes, not live trend data"}`,
    competitors: `{"summary":"","patterns":[{"competitor":"","whatTheyPost":"","frequency":"","whatWorks":"","offers":""}],"gaps":[""],"ideasForUs":[{"idea":"","why":""}]}`,
    seasonal: `{"summary":"","campaigns":[{"name":"","dates":"","concept":"","offerIdea":"","contentPlan":[""],"adAngle":"","prepareBy":""}]}`,
    performance: `{"summary":"","whatWorks":[""],"whatDoesnt":[""],"recommendations":[{"action":"","evidence":"","expectedImpact":"low|medium|high"}],"postIdeas":[""]}`,
    industry: `{"summary":"","bestPractices":[""],"contentMix":[{"type":"","share":""}],"kpis":[""],"pitfalls":[""]}`,
  };
  if (!shapes[kind]) throw fail(400, "Unknown research kind");
  const data = await aiJSON(org, "research_" + kind,
    `You are a marketing research analyst for Facebook and Instagram. Return JSON only: ${shapes[kind]}. Use only the supplied data for claims about competitors or performance. ${GROUNDING}`,
    `${ctx.text}\n\n${extra}\nNOTES: ${notes || "-"}\nDATE: ${ymd(new Date())}`);
  const titles = { trends: "Trending topic ideas", competitors: "Competitor content research", seasonal: "Seasonal campaign plan", performance: "Performance-based recommendations", industry: "Industry content strategy" };
  const plan = await savePlan(org, { brandId: ctx.brand?.id || null, kind: "research", title: `${titles[kind]} ${ymd(new Date())}`, input: req.body, data });
  res.json({ success: true, plan });
}));

app.get("/api/plans", wrap(async (req, res) => {
  const q = { organizationId: tid(req) };
  if (req.query.kind) q.kind = { $in: String(req.query.kind).split(",") };
  if (req.query.brandId) q.brandId = req.query.brandId;
  res.json(await ContentPlan.find(q).sort({ createdAt: -1 }).limit(100));
}));
app.get("/api/plans/:id", wrap(async (req, res) => {
  const p = await ContentPlan.findOne({ _id: req.params.id, organizationId: tid(req) });
  if (!p) throw fail(404, "Plan not found");
  res.json(p);
}));
app.delete("/api/plans/:id", wrap(async (req, res) => {
  await ContentPlan.deleteOne({ _id: req.params.id, organizationId: tid(req) });
  res.json({ success: true });
}));

// Turn plan ideas into draft content items (dated, ready for the calendar)
app.post("/api/plans/:id/drafts", wrap(async (req, res) => {
  const org = tid(req);
  const p = await ContentPlan.findOne({ _id: req.params.id, organizationId: org });
  if (!p) throw fail(404, "Plan not found");
  const ids = req.body.itemIds?.length ? req.body.itemIds : p.items.map((i) => i.id);
  const lang = p.input?.language || "bn";
  let created = 0;
  for (const it of p.items) {
    if (!ids.includes(it.id) || it.contentItemId) continue;
    const c = await ContentItem.create({
      organizationId: org, brandId: p.brandId, planId: p.id, title: it.topic || "Planned post",
      body: it.caption || it.angle || it.topic || "Draft", type: it.format === "reel" ? "reel_script" : "post",
      format: ["reel", "story"].includes(it.format) ? it.format : "post", pillar: it.pillar, cta: it.cta, language: lang,
      scheduledAt: it.date || null, variants: it.platform ? [{ platform: it.platform, caption: it.caption || it.topic || "" }] : [],
      versions: [], approvals: [{ action: "created", by: actor(req), comment: `From plan: ${p.title}` }],
    });
    it.contentItemId = c.id;
    created++;
  }
  await p.save();
  res.json({ success: true, created, plan: p });
}));

/* =====================================================
   AI CONTENT GENERATION (1.3)
   ===================================================== */
const CONTENT_TYPES = {
  facebook_post: "A complete Facebook post: scroll-stopping first line, short paragraphs, emojis in moderation, one clear CTA, 3-5 hashtags in hashtags[].",
  instagram_post: "An Instagram caption: strong first line (visible before 'more'), line breaks, CTA, 8-15 relevant hashtags in hashtags[] (max 30), under 2200 characters.",
  caption: "A short social caption of 1-3 sentences.",
  hashtags: "Only hashtags: put 15-25 relevant hashtags in hashtags[] mixing broad, niche and local (Bangladesh/Dhaka) tags. body = one line explaining the mix.",
  ad_copy: "Meta ad copy. body = primary text (ideally under 125 characters, max 300), headline = max 40 characters, description = max 30 characters, cta = a Meta CTA type (SHOP_NOW, LEARN_MORE, SIGN_UP, ORDER_NOW, CONTACT_US, MESSAGE_PAGE, GET_OFFER, BOOK_NOW).",
  headline: "Headlines only. Each variant: headline = one punchy headline (max 40 characters), body = the same headline with a one-line supporting sentence.",
  cta: "Call-to-action lines only. Each variant: cta = short CTA button text, body = one CTA sentence for a caption.",
  product_description: "A product description for social/e-commerce: hook, key benefits, features/specs, who it is for, approved price only, CTA.",
  promotional: "A promotional/offer post. Mention only offers that exist in the approved facts or the brief.",
  video_script: "A video ad/explainer script. Fill scenes[] (scene, duration, visual, voiceover, onScreenText). body = the full script as readable text.",
  reel_script: "A 15-30 second Reel script: hook in the first 2 seconds, scenes[] with timing, on-screen text, audio/trend suggestion. body = readable script; hashtags[] for the caption.",
  story: "A 3-5 frame Story sequence. scenes[] = frames (onScreenText, visual, sticker idea like poll/question/link). body = summary.",
  video_concept: "3 short video concepts. Each variant: headline = concept name, body = concept (idea, hook, format, length, why it works).",
  storyboard: "A storyboard. scenes[] with shot type, visual description, duration, voiceover and on-screen text. body = summary of the story arc.",
  voiceover: "A voice-over script with natural pauses marked as (pause). body = the script. Include approximate duration in headline.",
  translate: "Translate the SOURCE TEXT into the target language. Keep tone, emojis, line breaks and hashtag meaning. Natural, not literal.",
  rewrite: "Rewrite the SOURCE TEXT following the instruction. Keep all facts unchanged.",
  adapt: "Adapt the SOURCE TEXT for each requested platform. One variant per platform with the platform field set (Facebook: conversational, fewer hashtags; Instagram: caption style, hashtags in hashtags[]).",
};
const VARIANT_SHAPE = `{"variants":[{"platform":"Facebook|Instagram|null","headline":"","body":"","description":"","hashtags":["#tag"],"cta":"","scenes":[{"scene":1,"duration":"3s","visual":"","voiceover":"","onScreenText":""}]}]}`;

async function generateContent(org, input) {
  const { brandId, type = "facebook_post", platform = "Facebook", language = "bn", topic = "", productId, tone, count = 3, extra = "", sourceText = "", targetLanguage, instruction } = input;
  if (!CONTENT_TYPES[type]) throw fail(400, "Unknown content type");
  if (["translate", "rewrite", "adapt"].includes(type) && !sourceText) throw fail(400, "Source text is required");
  const ctx = await brandContext(org, brandId);
  const product = productId ? await Product.findOne({ _id: productId, organizationId: org }).lean() : null;
  const platforms = platform === "Both" ? ["Facebook", "Instagram"] : [platform];
  const n = type === "adapt" ? platforms.length : Math.min(Math.max(Number(count) || 1, 1), 5);
  const lang = type === "translate" ? LANG[targetLanguage] || targetLanguage || "English" : LANG[language] || language;
  return aiJSON(org, "content_" + type,
    `You are an expert social media copywriter for Facebook and Instagram in Bangladesh. TASK: ${CONTENT_TYPES[type]} Write ${n} distinct variant(s). Language: ${lang}. ${tone ? `Tone override: ${tone}.` : ""} Platform(s): ${platforms.join(", ")}. Return JSON only: ${VARIANT_SHAPE}. Leave unused fields empty. ${GROUNDING}`,
    `${ctx.text}\n\n${product ? `PRODUCT: ${product.name} | price ${product.price} BDT | ${product.category} | ${product.stock > 0 ? "in stock" : "out of stock"}\n` : ""}TOPIC / BRIEF: ${topic || "-"}\nEXTRA (offer, keywords, notes): ${extra || "-"}\n${instruction ? `INSTRUCTION: ${instruction}\n` : ""}${sourceText ? `SOURCE TEXT:\n${sourceText}` : ""}`,
    { temperature: ["translate", "adapt"].includes(type) ? 0.3 : 0.8 });
}

app.post("/api/ai/content", wrap(async (req, res) => {
  const out = await generateContent(tid(req), req.body);
  res.json({ success: true, variants: (out.variants || []).map((v) => ({ ...v, hashtags: (v.hashtags || []).map((h) => (String(h).startsWith("#") ? h : "#" + h)) })) });
}));

/* =====================================================
   CONTENT ITEMS: drafts, approval workflow, versions (1.5)
   ===================================================== */
// n8n flow (existing): saves a generated draft
app.post("/api/content/create", wrap(async (req, res) => {
  const { tenantId, platform, topic, generatedText } = req.body;
  const content = await ContentItem.create({
    organizationId: tenantId, title: topic, body: generatedText, status: "Draft",
    type: platform === "Instagram" ? "instagram_post" : "facebook_post",
    variants: [{ platform, caption: generatedText }],
  });
  res.json({ success: true, content });
}));

const EDITABLE = ["title", "body", "type", "format", "pillar", "headline", "cta", "hashtags", "language", "variants", "mediaIds", "link", "brandId", "scheduledAt"];
const LOCKED = ["Publishing", "Published", "Partially Published"];

async function buildTargets(org, accountIds = []) {
  if (!accountIds.length) return [];
  const accs = await SocialAccount.find({ organizationId: org, _id: { $in: accountIds }, platform: { $in: ["Facebook", "Instagram"] } });
  return accs.map((a) => ({ accountId: a.id, platform: a.platform, accountName: a.accountName, status: "pending" }));
}
function cleanContent(b) {
  const p = pick(b, EDITABLE);
  if ("hashtags" in p) p.hashtags = lines(String(Array.isArray(p.hashtags) ? p.hashtags.join(" ") : p.hashtags).replace(/\s+/g, ",")).map((h) => (h.startsWith("#") ? h : "#" + h));
  if ("variants" in p) p.variants = (p.variants || []).filter((v) => v && v.platform && v.caption);
  if ("scheduledAt" in p) p.scheduledAt = p.scheduledAt ? new Date(p.scheduledAt) : null;
  return p;
}
const snapshot = (c, by, note) => ({ body: c.body, headline: c.headline, hashtags: c.hashtags, cta: c.cta, variants: (c.variants || []).map((v) => ({ platform: v.platform, caption: v.caption })), by, note });

app.get("/api/content", wrap(async (req, res) => {
  const q = { organizationId: tid(req) };
  if (req.query.status) q.status = { $in: String(req.query.status).split(",") };
  if (req.query.brandId) q.brandId = req.query.brandId;
  if (req.query.type) q.type = { $in: String(req.query.type).split(",") };
  if (req.query.from || req.query.to) q.scheduledAt = { ...(req.query.from ? { $gte: new Date(req.query.from) } : {}), ...(req.query.to ? { $lte: new Date(req.query.to) } : {}) };
  if (req.query.unscheduled === "1") q.scheduledAt = null;
  if (req.query.q) q.$or = [{ title: new RegExp(escRe(req.query.q), "i") }, { body: new RegExp(escRe(req.query.q), "i") }];
  const sort = req.query.sort === "schedule" ? { scheduledAt: 1 } : req.query.sort === "published" ? { publishedAt: -1 } : { createdAt: -1 };
  res.json(await ContentItem.find(q).select("-versions").sort(sort).limit(Math.min(Number(req.query.limit) || 300, 1000)));
}));

app.get("/api/content/:id", wrap(async (req, res) => {
  const c = await ContentItem.findOne({ _id: req.params.id, organizationId: tid(req) });
  if (!c) throw fail(404, "Content not found");
  const media = await MediaAsset.find({ _id: { $in: c.mediaIds }, organizationId: c.organizationId });
  res.json({ ...c.toJSON(), media });
}));

app.post("/api/content", wrap(async (req, res) => {
  const org = tid(req);
  const data = cleanContent(req.body);
  if (!data.body) throw fail(400, "Content body is required");
  data.title = data.title || data.body.slice(0, 60);
  const c = await ContentItem.create({
    ...data, organizationId: org, ownerId: actor(req), status: "Draft",
    targets: await buildTargets(org, req.body.accountIds || []), planId: req.body.planId || null,
    approvals: [{ action: "created", by: actor(req) }],
  });
  res.json({ success: true, content: c });
}));

app.put("/api/content/:id", wrap(async (req, res) => {
  const org = tid(req);
  const c = await ContentItem.findOne({ _id: req.params.id, organizationId: org });
  if (!c) throw fail(404, "Content not found");
  if (LOCKED.includes(c.status)) throw fail(400, `Can't edit content that is ${c.status}`);
  const data = cleanContent(req.body);
  // Compare plain values: saved variants carry an _id and empty fields may be "" or null
  const norm = (k, v) => (k === "variants" ? (v || []).map((x) => ({ platform: x.platform, caption: String(x.caption || "").trim() }))
    : k === "hashtags" ? [...(v || [])].map(String) : v == null ? "" : String(v).trim());
  const textChanged = ["body", "headline", "hashtags", "cta", "variants"].some((k) => k in data && JSON.stringify(norm(k, data[k])) !== JSON.stringify(norm(k, c[k])));
  if (textChanged) { c.versions.push(snapshot(c, actor(req), req.body.versionNote || "edit")); if (c.versions.length > 30) c.versions.shift(); }
  Object.assign(c, data);
  if (req.body.accountIds) c.targets = await buildTargets(org, req.body.accountIds);
  // editing approved/scheduled content sends it back for review when approval is required
  const s = await getSettings(org);
  if (textChanged && s.requireApproval && ["Approved", "Scheduled", "Failed"].includes(c.status)) { c.status = "In Review"; c.approvals.push({ action: "resubmitted", by: actor(req), comment: "Edited after approval" }); }
  await c.save();
  res.json({ success: true, content: c });
}));

app.post("/api/content/:id/restore/:idx", wrap(async (req, res) => {
  const c = await ContentItem.findOne({ _id: req.params.id, organizationId: tid(req) });
  if (!c) throw fail(404, "Content not found");
  if (LOCKED.includes(c.status)) throw fail(400, `Can't edit content that is ${c.status}`);
  const v = c.versions[Number(req.params.idx)];
  if (!v) throw fail(404, "Version not found");
  c.versions.push(snapshot(c, actor(req), "before restore"));
  Object.assign(c, { body: v.body, headline: v.headline, hashtags: v.hashtags, cta: v.cta, variants: v.variants });
  if (["Approved", "Scheduled"].includes(c.status)) c.status = "In Review";
  await c.save();
  res.json({ success: true, content: c });
}));

app.delete("/api/content/:id", wrap(async (req, res) => {
  const c = await ContentItem.findOne({ _id: req.params.id, organizationId: tid(req) });
  if (!c) throw fail(404, "Content not found");
  if (c.status === "Publishing") throw fail(400, "Content is publishing right now");
  await c.deleteOne();
  res.json({ success: true });
}));

// Draft -> In Review (or straight to Approved when approval is off)
app.post("/api/content/:id/submit", wrap(async (req, res) => {
  const org = tid(req);
  const c = await ContentItem.findOne({ _id: req.params.id, organizationId: org });
  if (!c) throw fail(404, "Content not found");
  if (!["Draft", "Rejected", "Failed"].includes(c.status)) throw fail(400, `Content is already ${c.status}`);
  const s = await getSettings(org);
  c.status = s.requireApproval ? "In Review" : "Approved";
  c.approvals.push({ action: s.requireApproval ? "submitted" : "auto-approved", by: actor(req), comment: req.body.comment || "" });
  await c.save();
  if (s.requireApproval) await notify(org, "approval", "Content waiting for approval", c.title, "calendar");
  res.json({ success: true, content: c });
}));

// Approver decision: approve | reject | changes
app.post("/api/content/:id/review", wrap(async (req, res) => {
  const c = await ContentItem.findOne({ _id: req.params.id, organizationId: tid(req) });
  if (!c) throw fail(404, "Content not found");
  const { action, comment = "" } = req.body;
  if (!["approve", "reject", "changes"].includes(action)) throw fail(400, "action must be approve, reject or changes");
  if (!["In Review", "Draft"].includes(c.status)) throw fail(400, `Content is ${c.status}`);
  c.status = action === "approve" ? "Approved" : action === "reject" ? "Rejected" : "Draft";
  c.approvals.push({ action: action === "changes" ? "changes requested" : action + "d", by: actor(req), comment });
  await c.save();
  res.json({ success: true, content: c });
}));

// Schedule an approved item (or set a planned date on a draft)
app.post("/api/content/:id/schedule", wrap(async (req, res) => {
  const org = tid(req);
  const c = await ContentItem.findOne({ _id: req.params.id, organizationId: org });
  if (!c) throw fail(404, "Content not found");
  if (LOCKED.includes(c.status)) throw fail(400, `Content is ${c.status}`);
  if (req.body.accountIds) c.targets = await buildTargets(org, req.body.accountIds);
  const when = req.body.scheduledAt ? new Date(req.body.scheduledAt) : null;
  if (!when || isNaN(when)) throw fail(400, "A valid scheduledAt is required");
  c.scheduledAt = when;
  const s = await getSettings(org);
  if (c.status === "Approved" || c.status === "Scheduled" || (!s.requireApproval && ["Draft", "Rejected", "Failed"].includes(c.status))) {
    if (!c.targets.length) throw fail(400, "Pick at least one Page or Instagram account");
    await preflight(c);
    c.status = "Scheduled";
    c.targets.forEach((t) => { if (t.status !== "published") { t.status = "pending"; t.attempts = 0; t.error = null; } });
    c.nextAttemptAt = null;
    c.approvals.push({ action: "scheduled", by: actor(req), comment: when.toISOString() });
  }
  await c.save();
  res.json({ success: true, content: c });
}));

// Calendar drag-and-drop: move the date, keep the status
app.put("/api/content/:id/date", wrap(async (req, res) => {
  const c = await ContentItem.findOne({ _id: req.params.id, organizationId: tid(req) });
  if (!c) throw fail(404, "Content not found");
  if (LOCKED.includes(c.status)) throw fail(400, `Content is ${c.status}`);
  const when = new Date(req.body.scheduledAt);
  if (isNaN(when)) throw fail(400, "Invalid date");
  if (c.status === "Scheduled" && when < new Date()) throw fail(400, "Can't move a scheduled post into the past");
  c.scheduledAt = when;
  await c.save();
  res.json({ success: true, content: c });
}));

app.post("/api/content/:id/cancel", wrap(async (req, res) => {
  const c = await ContentItem.findOne({ _id: req.params.id, organizationId: tid(req) });
  if (!c) throw fail(404, "Content not found");
  if (c.status !== "Scheduled") throw fail(400, "Only scheduled content can be unscheduled");
  c.status = "Approved";
  c.approvals.push({ action: "unscheduled", by: actor(req) });
  await c.save();
  res.json({ success: true, content: c });
}));

// Publish now (approved content)
app.post("/api/content/:id/publish", wrap(async (req, res) => {
  const org = tid(req);
  const c = await ContentItem.findOne({ _id: req.params.id, organizationId: org });
  if (!c) throw fail(404, "Content not found");
  if (req.body.accountIds) c.targets = await buildTargets(org, req.body.accountIds);
  const s = await getSettings(org);
  if (s.requireApproval && !["Approved", "Scheduled", "Failed", "Partially Published"].includes(c.status)) throw fail(400, "Content must be approved before publishing");
  if (!c.targets.length) throw fail(400, "Pick at least one Page or Instagram account");
  await preflight(c);
  c.status = "Scheduled";
  c.scheduledAt = new Date();
  c.nextAttemptAt = null;
  c.targets.forEach((t) => { if (t.status !== "published") { t.status = "pending"; t.attempts = 0; t.error = null; } });
  c.approvals.push({ action: "publish now", by: actor(req) });
  await c.save();
  await runJob("publish", publishDue);
  res.json({ success: true, content: await ContentItem.findById(c.id) });
}));

app.post("/api/content/:id/retry", wrap(async (req, res) => {
  const c = await ContentItem.findOne({ _id: req.params.id, organizationId: tid(req) });
  if (!c) throw fail(404, "Content not found");
  if (!["Failed", "Partially Published"].includes(c.status)) throw fail(400, "Nothing to retry");
  c.targets.forEach((t) => { if (t.status === "failed") { t.status = "pending"; t.attempts = 0; t.error = null; } });
  c.status = "Scheduled"; c.scheduledAt = new Date(); c.nextAttemptAt = null;
  await c.save();
  await runJob("publish", publishDue);
  res.json({ success: true, content: await ContentItem.findById(c.id) });
}));

// Back-compat with the old dashboard button: approve + publish to the platform's accounts
app.put("/api/content/:id/approve", wrap(async (req, res) => {
  const org = tid(req);
  const c = await ContentItem.findOne({ _id: req.params.id, organizationId: org });
  if (!c) return res.status(404).json({ error: "Content not found" });
  if (!c.targets.length) {
    const accs = await SocialAccount.find({ organizationId: org, platform: req.body.platform || "Facebook" });
    if (!accs.length) return res.status(400).json({ error: "No account connected for this platform" });
    c.targets = accs.map((a) => ({ accountId: a.id, platform: a.platform, accountName: a.accountName }));
  }
  c.approvals.push({ action: "approved", by: actor(req) });
  c.status = "Scheduled"; c.scheduledAt = new Date();
  await c.save();
  await runJob("publish", publishDue);
  res.json({ success: true });
}));

// Bulk scheduling: rows of { date, time, platform, caption, mediaUrl }
app.post("/api/content/bulk", wrap(async (req, res) => {
  const org = tid(req);
  const s = await getSettings(org);
  const rows = Array.isArray(req.body.rows) ? req.body.rows.slice(0, 500) : [];
  const accounts = await SocialAccount.find({ organizationId: org, _id: { $in: req.body.accountIds || [] } });
  if (!accounts.length) throw fail(400, "Pick at least one Page or Instagram account");
  const created = [], errors = [];
  for (const [i, r] of rows.entries()) {
    try {
      const when = new Date(`${r.date}T${r.time || "19:00"}`);
      if (isNaN(when)) throw new Error("invalid date/time");
      if (!r.caption) throw new Error("caption missing");
      const plat = r.platform && r.platform !== "Both" ? [r.platform] : ["Facebook", "Instagram"];
      const targets = accounts.filter((a) => plat.includes(a.platform)).map((a) => ({ accountId: a.id, platform: a.platform, accountName: a.accountName }));
      if (!targets.length) throw new Error(`no selected account for ${plat.join("/")}`);
      let mediaIds = [];
      if (r.mediaUrl) {
        const m = await MediaAsset.create({ organizationId: org, brandId: req.body.brandId || null, name: r.mediaUrl.split("/").pop().slice(0, 80), kind: /\.(mp4|mov|webm)(\?|$)/i.test(r.mediaUrl) ? "video" : "image", url: r.mediaUrl, source: "url", status: "approved" });
        mediaIds = [m.id];
      }
      const c = await ContentItem.create({
        organizationId: org, brandId: req.body.brandId || null, title: r.caption.slice(0, 60), body: r.caption,
        format: r.format || "post", mediaIds, targets, scheduledAt: when,
        status: s.requireApproval ? "In Review" : "Scheduled",
        approvals: [{ action: "bulk import", by: actor(req) }],
      });
      created.push(c.id);
    } catch (e) { errors.push(`Row ${i + 1}: ${e.message}`); }
  }
  if (s.requireApproval && created.length) await notify(org, "approval", `${created.length} bulk posts waiting for approval`, "Review them in the content calendar", "calendar");
  res.json({ success: true, created: created.length, errors, needsApproval: s.requireApproval });
}));

/* =====================================================
   PUBLISHING ENGINE (queue + retries + idempotency)
   ===================================================== */
const MAX_ATTEMPTS = 3;
const hashtagCount = (t) => (String(t).match(/#[\p{L}\p{N}_]+/gu) || []).length;

function captionFor(item, platform) {
  const v = (item.variants || []).find((x) => x.platform === platform);
  let text = v?.caption || item.body || "";
  const tags = (item.hashtags || []).filter((h) => !text.includes(h));
  if (tags.length) text += "\n\n" + tags.join(" ");
  return text.trim();
}

function validateTarget(item, acc, media, settings) {
  const e = [];
  const text = captionFor(item, acc.platform);
  if (["expired", "revoked"].includes(acc.status)) e.push(`${acc.accountName}: token ${acc.status}, reconnect Facebook`);
  if (settings.creativeApproval && media.some((m) => m.status !== "approved")) e.push("All media must be approved first");
  const vids = media.filter((m) => m.kind === "video");
  if (item.format === "reel" && !vids.length) e.push("Reels need a video");
  if (item.format === "story" && !media.length) e.push("Stories need an image or video");
  if (acc.platform === "Facebook") {
    if (acc.tasks?.length && !acc.tasks.some((t) => ["CREATE_CONTENT", "MANAGE"].includes(t))) e.push(`${acc.accountName}: you don't have permission to post on this Page`);
    if (!text && !media.length) e.push("Facebook post needs text or media");
    if (item.format === "story" && media[0]?.kind === "video") e.push("Facebook video stories aren't supported here; use a photo story");
  }
  if (acc.platform === "Instagram") {
    if (!media.length) e.push("Instagram needs at least one image or video");
    if (text.length > 2200) e.push("Instagram caption is longer than 2200 characters");
    if (hashtagCount(text) > 30) e.push("Instagram allows max 30 hashtags");
    if (media.length > 10) e.push("Instagram carousel allows max 10 items");
    if (media.some((m) => m.kind === "image" && m.mimeType && !/jpe?g/i.test(m.mimeType))) e.push("Instagram accepts JPEG images only. Convert in Creative Studio > Resize & convert");
    if (media.some((m) => !publicUrl(m.url)) || (!isPublicBase() && media.some((m) => !/^https?:/.test(m.url)))) e.push("Instagram needs public media URLs: set PUBLIC_BASE_URL (e.g. an ngrok https URL)");
  }
  return e;
}

// Check before scheduling so problems show up immediately instead of at publish time
async function preflight(item) {
  const org = item.organizationId;
  const settings = await getSettings(org);
  const media = await orderedMedia(item);
  const errs = [];
  for (const t of item.targets) {
    const acc = await SocialAccount.findOne({ _id: t.accountId, organizationId: org });
    if (!acc) { errs.push(`${t.accountName || t.accountId}: account disconnected`); continue; }
    errs.push(...validateTarget(item, acc, media, settings));
  }
  if (errs.length) throw fail(400, [...new Set(errs)].join(" · "));
}
async function orderedMedia(item) {
  const media = await MediaAsset.find({ _id: { $in: item.mediaIds || [] }, organizationId: item.organizationId });
  return (item.mediaIds || []).map((id) => media.find((m) => m.id === id)).filter(Boolean);
}
const localFile = (m) => (m.file ? path.join(UPLOAD_DIR, m.file) : null);

// Upload to Facebook by public URL, or by sending the file bytes when the server isn't public
async function fbUpload(pathname, token, m, fields, video = false) {
  const pub = isPublicBase() || /^https?:/.test(m.url) ? publicUrl(m.url) : null;
  const base = video ? GRAPH_VIDEO : GRAPH;
  if (pub) return graph(pathname, { token, method: "POST", base, body: { ...fields, [video ? "file_url" : "url"]: pub } });
  const f = localFile(m);
  if (!f || !fs.existsSync(f)) throw fail(400, `Media file missing: ${m.name}`);
  const form = new FormData();
  Object.entries(fields).forEach(([k, v]) => v != null && form.append(k, typeof v === "object" ? JSON.stringify(v) : String(v)));
  form.append("source", new Blob([fs.readFileSync(f)], { type: m.mimeType || "application/octet-stream" }), m.file);
  const r = await fetch(`${base}${pathname}?access_token=${encodeURIComponent(token)}`, { method: "POST", body: form });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw fail(502, j.error?.error_user_msg || j.error?.message || `Upload failed (${r.status})`);
  return j;
}

async function fbReel(page, token, m, text) {
  const start = await graph(`/${page}/video_reels`, { token, method: "POST", body: { upload_phase: "start" } });
  const url = `https://rupload.facebook.com/video-upload/${GRAPH_VER}/${start.video_id}`;
  const pub = isPublicBase() || /^https?:/.test(m.url) ? publicUrl(m.url) : null;
  let r;
  if (pub) r = await fetch(url, { method: "POST", headers: { Authorization: `OAuth ${token}`, file_url: pub } });
  else {
    const buf = fs.readFileSync(localFile(m));
    r = await fetch(url, { method: "POST", headers: { Authorization: `OAuth ${token}`, offset: "0", file_size: String(buf.length) }, body: buf });
  }
  if (!r.ok) throw fail(502, `Reel upload failed: ${(await r.text()).slice(0, 200)}`);
  await graph(`/${page}/video_reels`, { token, method: "POST", body: { upload_phase: "finish", video_id: start.video_id, video_state: "PUBLISHED", description: text } });
  return start.video_id;
}

async function publishFB(item, t, acc, media) {
  const token = tok(acc), page = acc.accountId, text = captionFor(item, "Facebook");
  const vids = media.filter((m) => m.kind === "video"), imgs = media.filter((m) => m.kind === "image");
  let id;
  if (item.format === "reel" && vids[0]) id = await fbReel(page, token, vids[0], text);
  else if (item.format === "story") {
    const ph = await fbUpload(`/${page}/photos`, token, imgs[0], { published: false });
    id = (await graph(`/${page}/photo_stories`, { token, method: "POST", body: { photo_id: ph.id } })).post_id || ph.id;
  } else if (vids[0]) id = (await fbUpload(`/${page}/videos`, token, vids[0], { description: text }, true)).id;
  else if (imgs.length === 1) { const r = await fbUpload(`/${page}/photos`, token, imgs[0], { message: text }); id = r.post_id || r.id; }
  else if (imgs.length > 1) {
    const ids = [];
    for (const m of imgs.slice(0, 10)) ids.push((await fbUpload(`/${page}/photos`, token, m, { published: false })).id);
    id = (await graph(`/${page}/feed`, { token, method: "POST", body: { message: text, attached_media: ids.map((x) => ({ media_fbid: x })) } })).id;
  } else id = (await graph(`/${page}/feed`, { token, method: "POST", body: { message: text, link: item.link || undefined } })).id;
  let permalink = null;
  try { const p = await graph(`/${id}`, { token, params: { fields: "permalink_url" } }); permalink = p.permalink_url ? (p.permalink_url.startsWith("http") ? p.permalink_url : "https://www.facebook.com" + p.permalink_url) : null; } catch { }
  return { id, permalink };
}

async function publishIG(item, t, acc, media) {
  const token = tok(acc), ig = acc.accountId, text = captionFor(item, "Instagram");
  if (!t.creationId) {
    const u = media.map((m) => ({ m, url: publicUrl(m.url) }));
    let body;
    if (item.format === "story") body = { media_type: "STORIES", [u[0].m.kind === "video" ? "video_url" : "image_url"]: u[0].url };
    else if (item.format === "reel" || (u.length === 1 && u[0].m.kind === "video")) body = { media_type: "REELS", video_url: u.find((x) => x.m.kind === "video").url, caption: text, share_to_feed: true };
    else if (u.length > 1) {
      const kids = [];
      for (const x of u.slice(0, 10)) kids.push((await graph(`/${ig}/media`, { token, method: "POST", body: x.m.kind === "video" ? { media_type: "VIDEO", video_url: x.url, is_carousel_item: true } : { image_url: x.url, is_carousel_item: true } })).id);
      t.childIds = kids;
      body = { media_type: "CAROUSEL", children: kids.join(","), caption: text };
    } else body = { image_url: u[0].url, caption: text };
    t.creationId = (await graph(`/${ig}/media`, { token, method: "POST", body })).id;
  }
  const s = await graph(`/${t.creationId}`, { token, params: { fields: "status_code,status" } });
  if (s.status_code === "IN_PROGRESS") return { processing: true };
  if (["ERROR", "EXPIRED"].includes(s.status_code)) { t.creationId = null; throw fail(502, `Instagram media processing failed: ${s.status || s.status_code}`); }
  const p = await graph(`/${ig}/media_publish`, { token, method: "POST", body: { creation_id: t.creationId } });
  let permalink = null;
  try { permalink = (await graph(`/${p.id}`, { token, params: { fields: "permalink" } })).permalink; } catch { }
  return { id: p.id, permalink };
}

async function processPublish(item) {
  const org = item.organizationId;
  const settings = await getSettings(org);
  const media = await orderedMedia(item);
  let again = false, processing = false;
  for (const t of item.targets) {
    if (t.status === "published" || (t.status === "failed" && t.attempts >= MAX_ATTEMPTS)) continue;
    const acc = await SocialAccount.findOne({ _id: t.accountId, organizationId: org }).select("+accessToken");
    try {
      if (!acc) throw fail(400, "Account disconnected");
      const errs = validateTarget(item, acc, media, settings);
      if (errs.length) { t.status = "failed"; t.attempts = MAX_ATTEMPTS; t.error = errs.join("; "); continue; }
      const r = acc.platform === "Instagram" ? await publishIG(item, t, acc, media) : await publishFB(item, t, acc, media);
      if (r.processing) { t.status = "processing"; processing = true; }
      else Object.assign(t, { status: "published", providerPostId: r.id, permalink: r.permalink, publishedAt: new Date(), error: null });
    } catch (e) {
      t.attempts = (t.attempts || 0) + 1;
      t.error = e.message;
      t.status = t.attempts >= MAX_ATTEMPTS ? "failed" : "pending";
      if (t.status === "pending") again = true;
    }
  }
  if (processing || again) {
    item.status = "Publishing";
    const maxAttempts = Math.max(1, ...item.targets.map((t) => t.attempts || 0));
    item.nextAttemptAt = new Date(Date.now() + (processing && !again ? 20e3 : 60e3 * 2 ** (maxAttempts - 1)));
  } else {
    const ok = item.targets.filter((t) => t.status === "published").length;
    item.status = ok === item.targets.length ? "Published" : ok ? "Partially Published" : "Failed";
    item.publishedAt = ok ? new Date() : null;
    item.nextAttemptAt = null;
    const failed = item.targets.filter((t) => t.status === "failed");
    item.lastError = failed.map((t) => `${t.accountName}: ${t.error}`).join(" | ") || null;
    if (failed.length) await notify(org, "publish_failed", `Publishing failed: ${item.title}`, item.lastError, "calendar");
  }
  item.lockUntil = null;
  await item.save();
}

async function publishDue() {
  const now = new Date();
  for (let i = 0; i < 20; i++) {
    const item = await ContentItem.findOneAndUpdate(
      {
        status: { $in: ["Scheduled", "Publishing"] }, scheduledAt: { $lte: now },
        $and: [{ $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] }, { $or: [{ lockUntil: null }, { lockUntil: { $lt: now } }] }],
      },
      { $set: { status: "Publishing", lockUntil: new Date(Date.now() + 5 * 60e3) } },
      { new: true, sort: { scheduledAt: 1 } }
    );
    if (!item) break;
    try { await processPublish(item); }
    catch (e) { console.error("publish:", e); await ContentItem.updateOne({ _id: item.id }, { lockUntil: null, nextAttemptAt: new Date(Date.now() + 120e3) }); }
  }
}

/* =====================================================
   AI CREATIVE & MEDIA STUDIO (1.4)
   ===================================================== */
const assetUpload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      const ext = (path.extname(file.originalname) || (file.mimetype.includes("video") ? ".mp4" : ".jpg")).toLowerCase().replace(/[^.a-z0-9]/g, "");
      cb(null, `${Date.now()}-${crypto.randomBytes(5).toString("hex")}${ext}`);
    },
  }),
  limits: { fileSize: 300 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /^(image|video)\//.test(file.mimetype)),
});

async function saveBufferAsset(org, buf, { name, mimeType = "image/png", ext = ".png", ...rest }) {
  const file = `${Date.now()}-${crypto.randomBytes(5).toString("hex")}${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, file), buf);
  return MediaAsset.create({ organizationId: org, name: name || file, kind: mimeType.startsWith("video") ? "video" : "image", mimeType, size: buf.length, file, url: `/uploads/${file}`, ...rest });
}

app.get("/api/assets", wrap(async (req, res) => {
  const q = { organizationId: tid(req) };
  if (req.query.status) q.status = req.query.status;
  if (req.query.kind) q.kind = req.query.kind;
  if (req.query.brandId) q.brandId = req.query.brandId;
  if (req.query.ids) q._id = { $in: String(req.query.ids).split(",") };
  res.json(await MediaAsset.find(q).sort({ createdAt: -1 }).limit(500));
}));

// Multiple files: field "files". Optional body: brandId, source, parentId, width, height, tags
app.post("/api/assets/upload", assetUpload.array("files", 20), wrap(async (req, res) => {
  const org = tid(req);
  const s = await getSettings(org);
  if (!req.files?.length) throw fail(400, "No image/video files received");
  const out = [];
  for (const f of req.files) {
    out.push(await MediaAsset.create({
      organizationId: org, brandId: req.body.brandId || null, name: req.body.name || f.originalname, kind: f.mimetype.startsWith("video") ? "video" : "image",
      mimeType: f.mimetype, size: f.size, file: f.filename, url: `/uploads/${f.filename}`, source: req.body.source || "upload",
      parentId: req.body.parentId || null, width: Number(req.body.width) || undefined, height: Number(req.body.height) || undefined,
      tags: lines(req.body.tags), status: s.creativeApproval ? "pending" : "approved", prompt: req.body.prompt || null,
    }));
  }
  if (s.creativeApproval) await notify(org, "approval", `${out.length} creative(s) waiting for approval`, out.map((a) => a.name).join(", "), "creative");
  res.json({ success: true, assets: out });
}));

app.post("/api/assets/from-url", wrap(async (req, res) => {
  const org = tid(req);
  const { url, name, brandId } = req.body;
  if (!/^https?:\/\//.test(url || "")) throw fail(400, "A full http(s) URL is required");
  const r = await fetch(url);
  if (!r.ok) throw fail(400, `Couldn't download (${r.status})`);
  const type = r.headers.get("content-type") || "image/jpeg";
  if (!/^(image|video)\//.test(type)) throw fail(400, "URL is not an image or video");
  const buf = Buffer.from(await r.arrayBuffer());
  const ext = "." + (type.split("/")[1] || "jpg").replace("jpeg", "jpg").replace(/[^a-z0-9]/g, "");
  const s = await getSettings(org);
  res.json({ success: true, asset: await saveBufferAsset(org, buf, { name: name || url.split("/").pop().slice(0, 80), mimeType: type, ext, brandId, source: "url", status: s.creativeApproval ? "pending" : "approved" }) });
}));

app.put("/api/assets/:id", wrap(async (req, res) => {
  const a = await MediaAsset.findOneAndUpdate({ _id: req.params.id, organizationId: tid(req) }, pick({ ...req.body, tags: req.body.tags ? lines(req.body.tags) : undefined }, ["name", "tags", "brandId"]), { new: true });
  if (!a) throw fail(404, "Asset not found");
  res.json({ success: true, asset: a });
}));

// Creative approval
app.post("/api/assets/:id/review", wrap(async (req, res) => {
  const { action, note } = req.body;
  if (!["approve", "reject"].includes(action)) throw fail(400, "action must be approve or reject");
  const a = await MediaAsset.findOneAndUpdate({ _id: req.params.id, organizationId: tid(req) }, { status: action === "approve" ? "approved" : "rejected", reviewNote: note || null }, { new: true });
  if (!a) throw fail(404, "Asset not found");
  res.json({ success: true, asset: a });
}));

app.delete("/api/assets/:id", wrap(async (req, res) => {
  const org = tid(req);
  const a = await MediaAsset.findOne({ _id: req.params.id, organizationId: org });
  if (!a) throw fail(404, "Asset not found");
  if (await ContentItem.exists({ organizationId: org, mediaIds: a.id, status: { $in: ["Scheduled", "Publishing"] } })) throw fail(400, "This media is used by a scheduled post");
  if (a.file) fs.promises.unlink(path.join(UPLOAD_DIR, a.file)).catch(() => { });
  await a.deleteOne();
  res.json({ success: true });
}));

// AI image generation (OpenAI-compatible /images/generations). kind: image | ad_creative | product_promo | banner | post_design
app.post("/api/creative/ai-image", wrap(async (req, res) => {
  const org = tid(req);
  if (!process.env.AI_IMAGE_MODEL) throw fail(503, "AI image generation is off. Set AI_IMAGE_MODEL (and AI_API_KEY) in .env");
  const { prompt = "", kind = "image", productId, brandId, style = "", size = process.env.AI_IMAGE_SIZE || "1024x1024", offer = "" } = req.body;
  const brand = await getBrand(org, brandId);
  const product = productId ? await Product.findOne({ _id: productId, organizationId: org }).lean() : null;
  const kindText = {
    image: "", ad_creative: "A high-converting social media advertisement creative,", product_promo: "A product promotional image,",
    banner: "A wide promotional web/social banner,", post_design: "A clean social media post design,",
  }[kind] || "";
  const full = [
    kindText, prompt, product ? `Featuring the product: ${product.name} (${product.category}).` : "", offer ? `Offer theme: ${offer}.` : "",
    brand ? `Brand colours ${brand.colors?.primary}, ${brand.colors?.secondary}, ${brand.colors?.accent}. Brand style: ${brand.tone}.` : "",
    style ? `Style: ${style}.` : "", "Leave clean empty space for text overlay; do not render any text, letters, logos or watermarks.",
  ].filter(Boolean).join(" ");
  const r = await fetch(`${AI_BASE}/images/generations`, { method: "POST", headers: aiHeaders(), body: JSON.stringify({ model: process.env.AI_IMAGE_MODEL, prompt: full, size, n: 1 }) });
  const j = await r.json().catch(() => ({}));
  AiUsage.create({ organizationId: org, task: "image_" + kind, model: process.env.AI_IMAGE_MODEL, ok: r.ok }).catch(() => { });
  if (!r.ok) throw fail(502, `Image provider error: ${j.error?.message || r.status}`);
  const d = j.data?.[0] || {};
  let buf;
  if (d.b64_json) buf = Buffer.from(d.b64_json, "base64");
  else if (d.url) buf = Buffer.from(await (await fetch(d.url)).arrayBuffer());
  else throw fail(502, "Image provider returned no image");
  const s = await getSettings(org);
  const asset = await saveBufferAsset(org, buf, { name: `AI ${kind} ${ymd(new Date())}`, mimeType: "image/png", ext: ".png", brandId: brand?.id || null, source: "ai", prompt: full, tags: ["ai", kind], status: s.creativeApproval ? "pending" : "approved" });
  res.json({ success: true, asset });
}));

// Creative templates (rendered to PNG in the browser banner maker)
app.get("/api/creative/templates", wrap(async (req, res) => res.json(await CreativeTemplate.find({ organizationId: tid(req) }).sort({ createdAt: -1 }))));
app.post("/api/creative/templates", wrap(async (req, res) => {
  const { name, format, layout, brandId } = req.body;
  if (!name) throw fail(400, "Template name is required");
  res.json({ success: true, template: await CreativeTemplate.create({ organizationId: tid(req), name, format, layout, brandId: brandId || null }) });
}));
app.delete("/api/creative/templates/:id", wrap(async (req, res) => {
  await CreativeTemplate.deleteOne({ _id: req.params.id, organizationId: tid(req) });
  res.json({ success: true });
}));

/* =====================================================
   META ADS: sync, structure, insights (1.6)
   ===================================================== */
const MKEYS = ["spend", "impressions", "reach", "clicks", "linkClicks", "leads", "purchases", "purchaseValue"];
const LEAD_TYPES = ["lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead", "leadgen_grouped"];
const PURCHASE_TYPES = ["purchase", "omni_purchase", "offsite_conversion.fb_pixel_purchase", "onsite_web_purchase"];
// Meta reports the same conversion under several action types; take the largest instead of summing (avoids double counting)
const actionVal = (arr, types) => Math.max(0, ...(arr || []).filter((a) => types.includes(a.action_type)).map((a) => Number(a.value) || 0));

// CTR/CPC here use LINK clicks (inline_link_clicks). Reach summed over days over-counts unique people, so frequency is approximate.
function kpis(m = {}) {
  const s = m.spend || 0, i = m.impressions || 0, lc = m.linkClicks || 0, conv = (m.leads || 0) + (m.purchases || 0);
  return {
    ...pick(m, MKEYS), spend: round(s), ctr: i ? round((lc / i) * 100) : 0, cpc: lc ? round(s / lc) : 0, cpm: i ? round((s / i) * 1000) : 0,
    cpl: m.leads ? round(s / m.leads) : 0, cpa: conv ? round(s / conv) : 0, roas: s ? round((m.purchaseValue || 0) / s) : 0,
    frequency: m.reach ? round(i / m.reach) : 0, cvr: lc ? round((conv / lc) * 100) : 0, results: conv,
  };
}
const sumGroup = Object.fromEntries(MKEYS.map((k) => [k, { $sum: "$" + k }]));

async function perfBy(org, { adAccountId, from, to, level = "campaign", ids }) {
  const key = level === "ad" ? "$adId" : level === "adset" ? "$adsetId" : level === "account" ? "$adAccountId" : "$campaignId";
  const match = { organizationId: org, date: { $gte: from, $lte: to } };
  if (adAccountId) match.adAccountId = adAccountId;
  if (ids?.length) match[key.slice(1)] = { $in: ids };
  const rows = await AdInsight.aggregate([{ $match: match }, { $group: { _id: key, ...sumGroup } }]);
  return Object.fromEntries(rows.map((r) => [r._id, kpis(r)]));
}
async function totals(org, match) {
  const [r] = await AdInsight.aggregate([{ $match: { organizationId: org, ...match } }, { $group: { _id: null, ...sumGroup } }]);
  return kpis(r || {});
}

async function syncAdAccount(org, acc, days = 30) {
  const token = tok(acc);
  const act = acc.accountId.startsWith("act_") ? acc.accountId : "act_" + acc.accountId;
  const info = await graph(`/${act}`, { token, params: { fields: "name,currency,timezone_name,account_status" } });
  const div = minorDiv(info.currency);
  const money = (v) => (v != null && v !== "" ? Number(v) / div : null);
  const now = new Date();
  const ent = (level, x, extra) => ({
    updateOne: {
      filter: { organizationId: org, metaId: x.id },
      update: { $set: { organizationId: org, adAccountId: acc.accountId, level, metaId: x.id, name: x.name, status: x.status, effectiveStatus: x.effective_status, syncedAt: now, ...extra } },
      upsert: true,
    },
  });
  const [camps, sets, ads] = await Promise.all([
    graphAll(`/${act}/campaigns`, { token, params: { fields: "id,name,objective,status,effective_status,daily_budget,lifetime_budget,start_time,stop_time", limit: 200 } }),
    graphAll(`/${act}/adsets`, { token, params: { fields: "id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,optimization_goal,start_time,end_time,targeting", limit: 200 } }),
    graphAll(`/${act}/ads`, { token, params: { fields: "id,name,adset_id,campaign_id,status,effective_status,creative{id,title,body,image_url,thumbnail_url,call_to_action_type,object_story_spec}", limit: 200 } }),
  ]);
  const ops = [
    ...camps.map((c) => ent("campaign", c, { objective: c.objective, dailyBudget: money(c.daily_budget), lifetimeBudget: money(c.lifetime_budget), startTime: c.start_time || null, stopTime: c.stop_time || null, campaignId: c.id })),
    ...sets.map((s) => ent("adset", s, { parentId: s.campaign_id, campaignId: s.campaign_id, dailyBudget: money(s.daily_budget), lifetimeBudget: money(s.lifetime_budget), optimizationGoal: s.optimization_goal, startTime: s.start_time || null, stopTime: s.end_time || null, targeting: s.targeting || null })),
    ...ads.map((a) => ent("ad", a, { parentId: a.adset_id, campaignId: a.campaign_id, creative: a.creative || null })),
  ];
  if (ops.length) await AdEntity.bulkWrite(ops, { ordered: false });

  // Daily ad-level insights
  const timeRange = { since: daysAgo(days - 1), until: daysAgo(0) };
  const ins = await graphAll(`/${act}/insights`, {
    token, params: { level: "ad", time_increment: 1, time_range: timeRange, limit: 500, fields: "ad_id,adset_id,campaign_id,spend,impressions,reach,clicks,inline_link_clicks,frequency,actions,action_values" },
  }, 20000);
  const iops = ins.map((r) => ({
    updateOne: {
      filter: { organizationId: org, adId: r.ad_id, date: r.date_start },
      update: {
        $set: {
          organizationId: org, adAccountId: acc.accountId, date: r.date_start, adId: r.ad_id, adsetId: r.adset_id, campaignId: r.campaign_id,
          spend: Number(r.spend) || 0, impressions: Number(r.impressions) || 0, reach: Number(r.reach) || 0, clicks: Number(r.clicks) || 0,
          linkClicks: Number(r.inline_link_clicks) || 0, frequency: Number(r.frequency) || 0,
          leads: actionVal(r.actions, LEAD_TYPES), purchases: actionVal(r.actions, PURCHASE_TYPES), purchaseValue: actionVal(r.action_values, PURCHASE_TYPES),
        }
      },
      upsert: true,
    },
  }));
  if (iops.length) await AdInsight.bulkWrite(iops, { ordered: false });

  // Placement + audience breakdowns (last 30 days, campaign level)
  const bfields = "campaign_id,spend,impressions,reach,clicks,inline_link_clicks,actions,action_values";
  for (const [kind, breakdowns, keyOf] of [
    ["placement", "publisher_platform,platform_position", (r) => `${r.publisher_platform} · ${r.platform_position}`],
    ["age_gender", "age,gender", (r) => `${r.age} · ${r.gender}`],
    ["region", "region", (r) => r.region],
  ]) {
    try {
      const rows = await graphAll(`/${act}/insights`, { token, params: { level: "campaign", breakdowns, date_preset: "last_30d", fields: bfields, limit: 500 } }, 5000);
      await AdBreakdown.deleteMany({ organizationId: org, adAccountId: acc.accountId, kind });
      if (rows.length) await AdBreakdown.insertMany(rows.map((r) => ({
        organizationId: org, adAccountId: acc.accountId, kind, campaignId: r.campaign_id, key: keyOf(r), range: "last_30d", syncedAt: now,
        metrics: { spend: Number(r.spend) || 0, impressions: Number(r.impressions) || 0, reach: Number(r.reach) || 0, clicks: Number(r.clicks) || 0, linkClicks: Number(r.inline_link_clicks) || 0, leads: actionVal(r.actions, LEAD_TYPES), purchases: actionVal(r.actions, PURCHASE_TYPES), purchaseValue: actionVal(r.action_values, PURCHASE_TYPES) },
      })));
    } catch (e) { console.warn(`breakdown ${kind}:`, e.message); }
  }
  await SocialAccount.updateOne({ _id: acc.id }, { currency: info.currency, timezone: info.timezone_name, lastSyncedAt: now, healthNote: info.account_status === 1 ? null : `Ad account status ${info.account_status}` });
  return { campaigns: camps.length, adsets: sets.length, ads: ads.length, insightRows: ins.length };
}

app.get("/api/ads/accounts", wrap(async (req, res) => res.json((await SocialAccount.find({ organizationId: tid(req), platform: "Meta Ads" }).sort({ accountName: 1 })).map(accView))));

app.post("/api/ads/sync", wrap(async (req, res) => {
  const org = tid(req);
  const accs = req.body.adAccountId ? [await adAccountFor(org, req.body.adAccountId)] : await SocialAccount.find({ organizationId: org, platform: "Meta Ads" }).select("+accessToken");
  if (!accs.length) throw fail(400, "No ad account connected");
  const out = {};
  for (const a of accs) {
    out[a.accountId] = await syncAdAccount(org, a, Number(req.body.days) || 30).catch((e) => ({ error: e.message }));
  }
  await runAdRules(org).catch((e) => console.warn("rules:", e.message));
  await checkBudgets(org).catch((e) => console.warn("budgets:", e.message));
  res.json({ success: true, result: out });
}));

// Campaign -> ad set -> ad tree with metrics for the range
app.get("/api/ads/tree", wrap(async (req, res) => {
  const org = tid(req);
  const { adAccountId } = req.query;
  const { from, to } = range(req.query, 7);
  const q = { organizationId: org, ...(adAccountId ? { adAccountId } : {}) };
  if (req.query.active === "1") q.effectiveStatus = { $nin: ["DELETED", "ARCHIVED"] };
  const [ents, pc, ps, pa] = await Promise.all([
    AdEntity.find(q).lean(),
    perfBy(org, { adAccountId, from, to, level: "campaign" }), perfBy(org, { adAccountId, from, to, level: "adset" }), perfBy(org, { adAccountId, from, to, level: "ad" }),
  ]);
  const m = { campaign: pc, adset: ps, ad: pa };
  const view = (e) => ({ id: e.metaId, level: e.level, name: e.name, status: e.status, effectiveStatus: e.effectiveStatus, objective: e.objective, dailyBudget: e.dailyBudget, lifetimeBudget: e.lifetimeBudget, optimizationGoal: e.optimizationGoal, adAccountId: e.adAccountId, creative: e.creative ? { title: e.creative.title, body: e.creative.body, image: e.creative.image_url || e.creative.thumbnail_url, cta: e.creative.call_to_action_type } : null, metrics: m[e.level][e.metaId] || kpis() });
  const camps = ents.filter((e) => e.level === "campaign").map((c) => ({
    ...view(c),
    adsets: ents.filter((s) => s.level === "adset" && s.parentId === c.metaId).map((s) => ({ ...view(s), ads: ents.filter((a) => a.level === "ad" && a.parentId === s.metaId).map(view) })),
  })).sort((a, b) => b.metrics.spend - a.metrics.spend);
  res.json({ from, to, campaigns: camps });
}));

app.get("/api/ads/performance", wrap(async (req, res) => {
  const org = tid(req);
  const { adAccountId, level = "campaign" } = req.query;
  const { from, to } = range(req.query, 7);
  const ids = req.query.ids ? String(req.query.ids).split(",") : null;
  const [perf, ents, total] = await Promise.all([
    perfBy(org, { adAccountId, from, to, level, ids }),
    AdEntity.find({ organizationId: org, level, ...(adAccountId ? { adAccountId } : {}), ...(ids ? { metaId: { $in: ids } } : {}) }).lean(),
    totals(org, { date: { $gte: from, $lte: to }, ...(adAccountId ? { adAccountId } : {}) }),
  ]);
  const rows = ents.map((e) => ({ id: e.metaId, name: e.name, status: e.effectiveStatus, objective: e.objective, dailyBudget: e.dailyBudget, campaignId: e.campaignId, metrics: perf[e.metaId] || kpis() }))
    .filter((r) => ids || r.metrics.impressions > 0 || r.status === "ACTIVE").sort((a, b) => b.metrics.spend - a.metrics.spend);
  res.json({ from, to, level, total, rows });
}));

app.get("/api/ads/daily", wrap(async (req, res) => {
  const org = tid(req);
  const { from, to } = range(req.query, 30);
  const match = { organizationId: org, date: { $gte: from, $lte: to } };
  if (req.query.adAccountId) match.adAccountId = req.query.adAccountId;
  for (const k of ["campaignId", "adsetId", "adId"]) if (req.query[k]) match[k] = req.query[k];
  const rows = await AdInsight.aggregate([{ $match: match }, { $group: { _id: "$date", ...sumGroup } }, { $sort: { _id: 1 } }]);
  res.json(rows.map((r) => ({ date: r._id, ...kpis(r) })));
}));

app.get("/api/ads/breakdowns", wrap(async (req, res) => {
  const org = tid(req);
  const q = { organizationId: org, kind: req.query.kind || "placement" };
  if (req.query.adAccountId) q.adAccountId = req.query.adAccountId;
  if (req.query.campaignId) q.campaignId = req.query.campaignId;
  const rows = await AdBreakdown.find(q).lean();
  const agg = {};
  for (const r of rows) { agg[r.key] = agg[r.key] || {}; for (const k of MKEYS) agg[r.key][k] = (agg[r.key][k] || 0) + (r.metrics[k] || 0); }
  res.json(Object.entries(agg).map(([key, m]) => ({ key, ...kpis(m) })).sort((a, b) => b.spend - a.spend));
}));

// Rename is low-impact and applied directly. Status/budget changes go through change requests.
app.put("/api/ads/entities/:metaId", wrap(async (req, res) => {
  const org = tid(req);
  const e = await AdEntity.findOne({ organizationId: org, metaId: req.params.metaId });
  if (!e) throw fail(404, "Not found. Sync the ad account first.");
  if (!req.body.name) throw fail(400, "name is required");
  const acc = await adAccountFor(org, e.adAccountId);
  await graph(`/${e.metaId}`, { token: tok(acc), method: "POST", body: { name: req.body.name } });
  e.name = req.body.name; await e.save();
  res.json({ success: true });
}));

app.get("/api/ads/audiences", wrap(async (req, res) => {
  const acc = await adAccountFor(tid(req), req.query.adAccountId);
  const act = acc.accountId.startsWith("act_") ? acc.accountId : "act_" + acc.accountId;
  res.json(await graphAll(`/${act}/customaudiences`, { token: tok(acc), params: { fields: "id,name,subtype,approximate_count_lower_bound,approximate_count_upper_bound,operation_status,delivery_status,time_created", limit: 200 } }));
}));
app.post("/api/ads/audiences/lookalike", wrap(async (req, res) => {
  const { adAccountId, sourceId, country = "BD", ratio = 0.01, name } = req.body;
  if (!sourceId) throw fail(400, "Pick a source audience");
  const acc = await adAccountFor(tid(req), adAccountId);
  const act = acc.accountId.startsWith("act_") ? acc.accountId : "act_" + acc.accountId;
  const r = await graph(`/${act}/customaudiences`, { token: tok(acc), method: "POST", body: { name: name || `Lookalike ${country} ${Math.round(ratio * 100)}%`, subtype: "LOOKALIKE", origin_audience_id: sourceId, lookalike_spec: { type: "similarity", country, ratio: Number(ratio) } } });
  res.json({ success: true, id: r.id });
}));
app.get("/api/ads/pixels", wrap(async (req, res) => {
  const acc = await adAccountFor(tid(req), req.query.adAccountId);
  const act = acc.accountId.startsWith("act_") ? acc.accountId : "act_" + acc.accountId;
  res.json(await graphAll(`/${act}/adspixels`, { token: tok(acc), params: { fields: "id,name,last_fired_time,is_unavailable", limit: 50 } }));
}));
app.get("/api/ads/geo", wrap(async (req, res) => {
  const acc = await adAccountFor(tid(req), req.query.adAccountId);
  const r = await graph("/search", { token: tok(acc), params: { type: "adgeolocation", q: req.query.q || "", location_types: JSON.stringify([req.query.type || "city"]), limit: 15 } });
  res.json((r.data || []).map((g) => ({ key: g.key, name: g.name, type: g.type, region: g.region, country: g.country_code })));
}));

/* ---------- campaign drafts + approval workflow ---------- */
const DRAFT_FIELDS = ["brandId", "adAccountId", "name", "objective", "specialAdCategories", "dailyBudget", "startTime", "endTime", "targeting", "placements", "pixelId", "conversionEvent", "pageId", "leadFormId", "creative"];
const OBJECTIVES = {
  OUTCOME_TRAFFIC: { optimization_goal: "LINK_CLICKS", destination_type: "WEBSITE" },
  OUTCOME_LEADS: { optimization_goal: "LEAD_GENERATION", destination_type: "ON_AD" },
  OUTCOME_SALES: { optimization_goal: "OFFSITE_CONVERSIONS", destination_type: "WEBSITE" },
  OUTCOME_AWARENESS: { optimization_goal: "REACH" },
};
function utmLink(link, utm = {}) {
  if (!link) return null;
  try {
    const u = new URL(link);
    for (const [k, v] of Object.entries({ utm_source: utm.source, utm_medium: utm.medium, utm_campaign: utm.campaign, utm_content: utm.content })) if (v) u.searchParams.set(k, v);
    return u.toString();
  } catch { return link; }
}
function validateDraft(d) {
  const e = [];
  if (!OBJECTIVES[d.objective]) e.push("Objective must be Traffic, Leads, Sales or Awareness (create others in Ads Manager)");
  if (!(d.dailyBudget > 0)) e.push("Daily budget must be greater than 0");
  if (!d.pageId) e.push("Pick a Facebook Page");
  if (!d.creative?.mediaId) e.push("Pick an approved image for the ad");
  if (!d.creative?.primaryText) e.push("Primary text is required");
  if (d.objective === "OUTCOME_LEADS" && !d.leadFormId) e.push("Lead campaigns need an instant form");
  if (d.objective === "OUTCOME_SALES" && (!d.pixelId || !d.conversionEvent)) e.push("Sales campaigns need a pixel and conversion event");
  if (["OUTCOME_TRAFFIC", "OUTCOME_SALES"].includes(d.objective) && !d.creative?.link) e.push("Website link is required");
  if (!d.targeting?.countries?.length && !d.targeting?.cities?.length) e.push("Add at least one location");
  return e;
}

app.get("/api/ads/drafts", wrap(async (req, res) => res.json(await CampaignDraft.find({ organizationId: tid(req) }).sort({ updatedAt: -1 }).limit(100))));
app.post("/api/ads/drafts", wrap(async (req, res) => {
  const d = pick(req.body, DRAFT_FIELDS);
  if (!d.name || !d.adAccountId) throw fail(400, "name and adAccountId are required");
  res.json({ success: true, draft: await CampaignDraft.create({ ...d, organizationId: tid(req), reviews: [{ action: "created", by: actor(req) }] }) });
}));
app.put("/api/ads/drafts/:id", wrap(async (req, res) => {
  const d = await CampaignDraft.findOne({ _id: req.params.id, organizationId: tid(req) });
  if (!d) throw fail(404, "Draft not found");
  if (!["draft", "rejected", "error"].includes(d.status)) throw fail(400, `Draft is ${d.status}; it can't be edited`);
  Object.assign(d, pick(req.body, DRAFT_FIELDS));
  d.status = "draft";
  await d.save();
  res.json({ success: true, draft: d });
}));
app.delete("/api/ads/drafts/:id", wrap(async (req, res) => {
  const d = await CampaignDraft.findOne({ _id: req.params.id, organizationId: tid(req) });
  if (!d) throw fail(404, "Draft not found");
  if (d.meta?.campaignId) throw fail(400, "This draft already exists in Meta. Pause or delete it in Ads Manager.");
  await d.deleteOne();
  res.json({ success: true });
}));
app.post("/api/ads/drafts/:id/submit", wrap(async (req, res) => {
  const org = tid(req);
  const d = await CampaignDraft.findOne({ _id: req.params.id, organizationId: org });
  if (!d) throw fail(404, "Draft not found");
  const errs = validateDraft(d);
  if (errs.length) throw fail(400, errs.join(" · "));
  d.status = "pending_approval";
  d.reviews.push({ action: "submitted", by: actor(req), comment: req.body.comment || "" });
  await d.save();
  await notify(org, "approval", "Ad campaign waiting for approval", `${d.name}: ${d.dailyBudget}/day`, "ads");
  res.json({ success: true, draft: d });
}));
app.post("/api/ads/drafts/:id/review", wrap(async (req, res) => {
  const d = await CampaignDraft.findOne({ _id: req.params.id, organizationId: tid(req) });
  if (!d) throw fail(404, "Draft not found");
  if (d.status !== "pending_approval") throw fail(400, "Draft is not waiting for approval");
  const { action, comment = "" } = req.body;
  if (!["approve", "reject"].includes(action)) throw fail(400, "action must be approve or reject");
  d.status = action === "approve" ? "approved" : "rejected";
  d.reviews.push({ action: action + "d", by: actor(req), comment });
  await d.save();
  res.json({ success: true, draft: d });
}));

// Creates campaign + ad set + creative + ad in Meta, all PAUSED. Re-running continues where it stopped.
app.post("/api/ads/drafts/:id/create", wrap(async (req, res) => {
  const org = tid(req);
  const d = await CampaignDraft.findOne({ _id: req.params.id, organizationId: org });
  if (!d) throw fail(404, "Draft not found");
  if (!["approved", "error"].includes(d.status)) throw fail(400, "Only approved drafts can be created in Meta");
  const errs = validateDraft(d);
  if (errs.length) throw fail(400, errs.join(" · "));
  const acc = await adAccountFor(org, d.adAccountId);
  const token = tok(acc);
  const act = acc.accountId.startsWith("act_") ? acc.accountId : "act_" + acc.accountId;
  const div = minorDiv(acc.currency);
  d.meta = d.meta || {};
  try {
    if (!d.meta.campaignId) {
      const body = { name: d.name, objective: d.objective, status: "PAUSED", special_ad_categories: d.specialAdCategories || [], buying_type: "AUCTION" };
      if (process.env.META_ADSET_BUDGET_SHARING_FLAG !== "0") body.is_adset_budget_sharing_enabled = false; // required by newer API versions when budgets live on ad sets
      d.meta.campaignId = (await graph(`/${act}/campaigns`, { token, method: "POST", body })).id;
      await d.save();
    }
    if (!d.meta.adsetId) {
      const t = d.targeting || {};
      const geo = t.cities?.length ? { cities: t.cities.map((c) => ({ key: c.key, radius: c.radius || 10, distance_unit: "kilometer" })) } : { countries: t.countries };
      const targeting = { geo_locations: geo, age_min: t.ageMin || 18, age_max: t.ageMax || 65, targeting_automation: { advantage_audience: t.advantageAudience ? 1 : 0 } };
      if (t.genders?.length) targeting.genders = t.genders;
      if (t.customAudiences?.length) targeting.custom_audiences = t.customAudiences.map((a) => ({ id: a.id }));
      if (t.excludedAudiences?.length) targeting.excluded_custom_audiences = t.excludedAudiences.map((a) => ({ id: a.id }));
      const p = d.placements || {};
      if (!p.automatic && p.publisherPlatforms?.length) {
        targeting.publisher_platforms = p.publisherPlatforms;
        if (p.facebookPositions?.length) targeting.facebook_positions = p.facebookPositions;
        if (p.instagramPositions?.length) targeting.instagram_positions = p.instagramPositions;
      }
      const o = OBJECTIVES[d.objective];
      const body = {
        name: `${d.name} - Ad set`, campaign_id: d.meta.campaignId, daily_budget: Math.round(d.dailyBudget * div), billing_event: "IMPRESSIONS",
        optimization_goal: o.optimization_goal, bid_strategy: "LOWEST_COST_WITHOUT_CAP", targeting, status: "PAUSED",
        start_time: d.startTime ? new Date(d.startTime).toISOString() : undefined, end_time: d.endTime ? new Date(d.endTime).toISOString() : undefined,
      };
      if (o.destination_type) body.destination_type = o.destination_type;
      if (d.objective === "OUTCOME_LEADS") body.promoted_object = { page_id: d.pageId };
      if (d.objective === "OUTCOME_SALES") body.promoted_object = { pixel_id: d.pixelId, custom_event_type: d.conversionEvent };
      d.meta.adsetId = (await graph(`/${act}/adsets`, { token, method: "POST", body })).id;
      await d.save();
    }
    if (!d.meta.imageHash) {
      const m = await MediaAsset.findOne({ _id: d.creative.mediaId, organizationId: org });
      if (!m) throw fail(400, "Ad image not found");
      let buf;
      if (m.file && fs.existsSync(localFile(m))) buf = fs.readFileSync(localFile(m));
      else buf = Buffer.from(await (await fetch(publicUrl(m.url))).arrayBuffer());
      const r = await graph(`/${act}/adimages`, { token, method: "POST", body: { bytes: buf.toString("base64") } });
      d.meta.imageHash = Object.values(r.images || {})[0]?.hash;
      if (!d.meta.imageHash) throw fail(502, "Meta did not return an image hash");
      await d.save();
    }
    if (!d.meta.creativeId) {
      const c = d.creative;
      const link = utmLink(c.link, c.utm) || "https://fb.me/";
      const cta = d.objective === "OUTCOME_LEADS" ? { type: c.cta || "SIGN_UP", value: { lead_gen_form_id: d.leadFormId } } : { type: c.cta || "LEARN_MORE", value: { link } };
      const body = { name: `${d.name} - Creative`, object_story_spec: { page_id: d.pageId, link_data: { link, message: c.primaryText, name: c.headline || undefined, description: c.description || undefined, image_hash: d.meta.imageHash, call_to_action: cta } } };
      d.meta.creativeId = (await graph(`/${act}/adcreatives`, { token, method: "POST", body })).id;
      await d.save();
    }
    if (!d.meta.adId) {
      d.meta.adId = (await graph(`/${act}/ads`, { token, method: "POST", body: { name: `${d.name} - Ad`, adset_id: d.meta.adsetId, creative: { creative_id: d.meta.creativeId }, status: "PAUSED" } })).id;
    }
    d.status = "created"; d.lastError = null;
    d.reviews.push({ action: "created in Meta (paused)", by: actor(req) });
    d.markModified("meta");
    await d.save();
    syncAdAccount(org, acc, 7).catch(() => { });
    res.json({ success: true, draft: d });
  } catch (e) {
    d.status = "error"; d.lastError = e.message; d.markModified("meta");
    await d.save();
    throw e;
  }
}));

// Ask to activate a created draft (goes through change-request approval)
app.post("/api/ads/drafts/:id/activate", wrap(async (req, res) => {
  const org = tid(req);
  const d = await CampaignDraft.findOne({ _id: req.params.id, organizationId: org });
  if (!d || d.status !== "created") throw fail(400, "Only drafts created in Meta can be activated");
  const cr = await ChangeRequest.create({ organizationId: org, adAccountId: d.adAccountId, level: "campaign", metaId: d.meta.campaignId, entityName: d.name, type: "activate_draft", from: "PAUSED", to: "ACTIVE", reason: req.body.reason || "Launch campaign", requestedBy: actor(req), draftId: d.id });
  await notify(org, "approval", "Campaign activation needs approval", `${d.name}: ${d.dailyBudget}/day`, "ads");
  res.json({ success: true, change: cr });
}));

/* ---------- change requests (approval-based campaign changes) ---------- */
async function applyChange(org, cr) {
  const acc = await adAccountFor(org, cr.adAccountId);
  const token = tok(acc);
  if (cr.type === "status") await graph(`/${cr.metaId}`, { token, method: "POST", body: { status: cr.to } });
  else if (cr.type === "budget") await graph(`/${cr.metaId}`, { token, method: "POST", body: { daily_budget: Math.round(Number(cr.to) * minorDiv(acc.currency)) } });
  else if (cr.type === "activate_draft") {
    const d = await CampaignDraft.findOne({ _id: cr.draftId, organizationId: org });
    for (const id of [d.meta.campaignId, d.meta.adsetId, d.meta.adId]) await graph(`/${id}`, { token, method: "POST", body: { status: "ACTIVE" } });
    d.status = "active"; await d.save();
  } else throw fail(400, "Unknown change type");
  if (cr.type === "status") await AdEntity.updateOne({ organizationId: org, metaId: cr.metaId }, { status: cr.to });
  if (cr.type === "budget") await AdEntity.updateOne({ organizationId: org, metaId: cr.metaId }, { dailyBudget: Number(cr.to) });
  cr.status = "applied"; cr.appliedAt = new Date(); cr.error = null;
  await cr.save();
}
function withinGuardrails(s, cr, entity) {
  if (s.optimizationMode !== "guardrailed" || cr.type !== "budget" || !entity?.dailyBudget) return false;
  if (!s.guardrailAllowlist?.includes(entity.campaignId || entity.metaId)) return false;
  const delta = Math.abs((Number(cr.to) - entity.dailyBudget) / entity.dailyBudget) * 100;
  return delta <= s.maxBudgetDeltaPct && (!s.maxDailyBudget || Number(cr.to) <= s.maxDailyBudget);
}
async function requestChange(org, { metaId, type, to, reason, source = "user", by = "system" }) {
  const e = await AdEntity.findOne({ organizationId: org, metaId });
  if (!e) throw fail(404, "Ad entity not found. Sync first.");
  if (type === "status" && !["ACTIVE", "PAUSED"].includes(to)) throw fail(400, "status must be ACTIVE or PAUSED");
  if (type === "budget" && !(Number(to) > 0)) throw fail(400, "Budget must be greater than 0");
  if (type === "budget" && e.dailyBudget == null) throw fail(400, "This item has no daily budget (budget is set at another level or is lifetime)");
  const cr = await ChangeRequest.create({ organizationId: org, adAccountId: e.adAccountId, level: e.level, metaId, entityName: e.name, type, from: type === "budget" ? e.dailyBudget : e.status, to: type === "budget" ? Number(to) : to, reason, source, requestedBy: by });
  const s = await getSettings(org);
  if (withinGuardrails(s, cr, e)) {
    cr.status = "approved"; cr.reviewedBy = "guardrail"; cr.source = "guardrail";
    try { await applyChange(org, cr); } catch (err) { cr.status = "failed"; cr.error = err.message; await cr.save(); }
  } else await notify(org, "approval", "Campaign change needs approval", `${e.name}: ${type} ${cr.from} → ${cr.to}`, "ads");
  return cr;
}
app.get("/api/ads/changes", wrap(async (req, res) => {
  const q = { organizationId: tid(req) };
  if (req.query.status) q.status = { $in: String(req.query.status).split(",") };
  res.json(await ChangeRequest.find(q).sort({ createdAt: -1 }).limit(200));
}));
app.post("/api/ads/changes", wrap(async (req, res) => {
  const { metaId, type, to, reason } = req.body;
  res.json({ success: true, change: await requestChange(tid(req), { metaId, type, to, reason, by: actor(req) }) });
}));
app.post("/api/ads/changes/:id/review", wrap(async (req, res) => {
  const org = tid(req);
  const cr = await ChangeRequest.findOne({ _id: req.params.id, organizationId: org });
  if (!cr) throw fail(404, "Change request not found");
  if (!["pending", "failed"].includes(cr.status)) throw fail(400, `Change is ${cr.status}`);
  const { action, comment = "" } = req.body;
  if (!["approve", "reject"].includes(action)) throw fail(400, "action must be approve or reject");
  cr.reviewedBy = actor(req); cr.reviewComment = comment;
  if (action === "reject") { cr.status = "rejected"; await cr.save(); return res.json({ success: true, change: cr }); }
  cr.status = "approved";
  try { await applyChange(org, cr); }
  catch (e) { cr.status = "failed"; cr.error = e.message; await cr.save(); throw e; }
  res.json({ success: true, change: cr });
}));

/* =====================================================
   AI ADS OPTIMIZATION (1.7): deterministic rules + AI analysis
   ===================================================== */
async function upsertRec(org, key, data) {
  const exists = await Recommendation.findOne({ organizationId: org, key, status: "open" });
  if (exists) { Object.assign(exists, data); await exists.save(); return { rec: exists, isNew: false }; }
  return { rec: await Recommendation.create({ organizationId: org, key, ...data }), isNew: true };
}

async function runAdRules(org) {
  const s = await getSettings(org);
  const accs = await SocialAccount.find({ organizationId: org, platform: "Meta Ads" });
  const week = ymd(new Date()).slice(0, 8) + String(Math.ceil(new Date().getDate() / 7));
  let created = 0;
  for (const acc of accs) {
    const A = acc.accountId;
    const cur = { from: daysAgo(6), to: daysAgo(0) }, prev = { from: daysAgo(13), to: daysAgo(7) };
    const [ad7, adPrev, c7, cPrev, s7, acct, ents, today] = await Promise.all([
      perfBy(org, { adAccountId: A, ...cur, level: "ad" }), perfBy(org, { adAccountId: A, ...prev, level: "ad" }),
      perfBy(org, { adAccountId: A, ...cur, level: "campaign" }), perfBy(org, { adAccountId: A, ...prev, level: "campaign" }),
      perfBy(org, { adAccountId: A, ...cur, level: "adset" }), totals(org, { adAccountId: A, date: { $gte: cur.from, $lte: cur.to } }),
      AdEntity.find({ organizationId: org, adAccountId: A }).lean(), perfBy(org, { adAccountId: A, from: daysAgo(0), to: daysAgo(0), level: "campaign" }),
    ]);
    const byId = Object.fromEntries(ents.map((e) => [e.metaId, e]));
    const cur$ = acc.currency || "";
    const add = async (key, data) => { const r = await upsertRec(org, `${key}:${week}`, { adAccountId: A, ...data }); if (r.isNew) { created++; if (data.severity === "high") await notify(org, "ads", data.title, data.detail, "optimize"); } };

    for (const [id, m] of Object.entries(ad7)) {
      const e = byId[id];
      if (!e || e.effectiveStatus !== "ACTIVE" || m.impressions < 1000) continue;
      // Underperforming: CTR far below account average, or cost per lead far above it
      const lowCtr = acct.ctr > 0 && m.ctr < acct.ctr * 0.5;
      const highCpl = acct.cpl > 0 && ((m.leads > 0 && m.cpl > acct.cpl * 1.5) || (m.leads === 0 && m.spend > acct.cpl * 2));
      if (lowCtr || highCpl) {
        await add(`under:${id}`, {
          type: "underperforming", level: "ad", metaId: id, entityName: e.name, severity: acct.spend && m.spend / acct.spend > 0.2 ? "high" : "medium",
          title: `Underperforming ad: ${e.name}`,
          detail: lowCtr ? `Link CTR ${m.ctr}% vs account ${acct.ctr}% over the last 7 days.` : `Cost per lead ${m.cpl || "∞"} ${cur$} vs account ${acct.cpl} ${cur$}.`,
          evidence: { period: `${cur.from}..${cur.to}`, ad: m, account: pick(acct, ["ctr", "cpl", "cpc", "spend"]) }, action: { type: "status", to: "PAUSED" },
        });
      }
      // Creative fatigue: high frequency and CTR dropping versus the previous week
      const p = adPrev[id];
      if (p && p.impressions >= 1000 && m.frequency >= 3 && m.ctr < p.ctr * 0.7) {
        await add(`fatigue:${id}`, {
          type: "fatigue", level: "ad", metaId: id, entityName: e.name, severity: "medium",
          title: `Creative fatigue: ${e.name}`, detail: `Frequency ${m.frequency} and link CTR fell from ${p.ctr}% to ${m.ctr}%. Refresh the creative or broaden the audience.`,
          evidence: { thisWeek: m, lastWeek: p },
        });
      }
    }
    for (const [id, m] of Object.entries(c7)) {
      const e = byId[id];
      if (!e) continue;
      const p = cPrev[id], t = today[id];
      if (t && e.dailyBudget && t.spend > e.dailyBudget * 1.2) {
        await add(`spendday:${id}:${daysAgo(0)}`, { type: "high_spend", level: "campaign", metaId: id, entityName: e.name, severity: "high", title: `High spend today: ${e.name}`, detail: `Spent ${t.spend} ${cur$} today vs daily budget ${e.dailyBudget} ${cur$}.`, evidence: { today: t, dailyBudget: e.dailyBudget } });
      }
      if (p && p.spend > 0 && m.spend > p.spend * 1.5 && m.spend > 1000 && (m.cpa === 0 || (p.cpa && m.cpa > p.cpa * 1.2))) {
        await add(`spendweek:${id}`, { type: "high_spend", level: "campaign", metaId: id, entityName: e.name, severity: "medium", title: `Spend up ${pct(m.spend, p.spend)}%: ${e.name}`, detail: `Spend grew from ${p.spend} to ${m.spend} ${cur$} while cost per result went from ${p.cpa || "-"} to ${m.cpa || "-"}.`, evidence: { thisWeek: m, lastWeek: p } });
      }
    }
    // Budget suggestions where a daily budget exists (campaign budget or ad set budget)
    const avgCpa = acct.cpa || 0;
    const step = Math.min(s.maxBudgetDeltaPct || 20, 30) / 100;
    for (const e of ents.filter((x) => ["campaign", "adset"].includes(x.level) && x.dailyBudget && x.effectiveStatus === "ACTIVE")) {
      const m = (e.level === "campaign" ? c7 : s7)[e.metaId];
      if (!m || m.results < 3 || !avgCpa) continue;
      if (m.cpa < avgCpa * 0.75) {
        const to = Math.round(e.dailyBudget * (1 + step));
        await add(`bud+:${e.metaId}`, { type: "budget_increase", level: e.level, metaId: e.metaId, entityName: e.name, severity: "low", title: `Scale ${e.name} by ${Math.round(step * 100)}%`, detail: `Cost per result ${m.cpa} ${cur$} is ${Math.round((1 - m.cpa / avgCpa) * 100)}% better than the account average (${avgCpa}). Suggested daily budget ${e.dailyBudget} → ${to}.`, evidence: { metrics: m, accountCpa: avgCpa }, action: { type: "budget", to } });
      } else if (m.cpa > avgCpa * 1.5) {
        const to = Math.max(1, Math.round(e.dailyBudget * (1 - step)));
        await add(`bud-:${e.metaId}`, { type: "budget_decrease", level: e.level, metaId: e.metaId, entityName: e.name, severity: "medium", title: `Reduce budget on ${e.name}`, detail: `Cost per result ${m.cpa} ${cur$} is ${Math.round((m.cpa / avgCpa - 1) * 100)}% worse than the account average (${avgCpa}). Suggested daily budget ${e.dailyBudget} → ${to}.`, evidence: { metrics: m, accountCpa: avgCpa }, action: { type: "budget", to } });
      }
    }
  }
  // Guardrailed automation: budget suggestions inside the guardrails are applied automatically
  if (s.optimizationMode === "guardrailed") {
    const recs = await Recommendation.find({ organizationId: org, status: "open", "action.type": "budget" });
    for (const r of recs) {
      const e = await AdEntity.findOne({ organizationId: org, metaId: r.metaId }).lean();
      const probe = { type: "budget", to: r.action.to };
      if (withinGuardrails(s, probe, e)) {
        await requestChange(org, { metaId: r.metaId, type: "budget", to: r.action.to, reason: r.title, source: "guardrail", by: "guardrail" }).catch((err) => console.warn("guardrail:", err.message));
        r.status = "actioned"; await r.save();
      }
    }
  }
  return created;
}

app.post("/api/ads/rules/run", wrap(async (req, res) => res.json({ success: true, created: await runAdRules(tid(req)) })));

app.get("/api/ads/recommendations", wrap(async (req, res) => {
  const q = { organizationId: tid(req), status: req.query.status || "open" };
  if (req.query.adAccountId) q.adAccountId = req.query.adAccountId;
  res.json(await Recommendation.find(q).sort({ createdAt: -1 }).limit(200));
}));
app.put("/api/ads/recommendations/:id", wrap(async (req, res) => {
  const r = await Recommendation.findOneAndUpdate({ _id: req.params.id, organizationId: tid(req) }, pick(req.body, ["status"]), { new: true });
  if (!r) throw fail(404, "Recommendation not found");
  res.json({ success: true, recommendation: r });
}));
// Turn a recommendation's action into a change request (approval flow)
app.post("/api/ads/recommendations/:id/act", wrap(async (req, res) => {
  const org = tid(req);
  const r = await Recommendation.findOne({ _id: req.params.id, organizationId: org });
  if (!r?.action) throw fail(400, "This recommendation has no automatic action");
  const cr = await requestChange(org, { metaId: r.metaId, type: r.action.type, to: req.body.to ?? r.action.to, reason: r.title, source: r.source, by: actor(req) });
  r.status = "actioned"; await r.save();
  res.json({ success: true, change: cr });
}));

// AI analysis of campaigns/ads with explainable recommendations
app.post("/api/ads/ai-analysis", wrap(async (req, res) => {
  const org = tid(req);
  const { adAccountId } = req.body;
  const { from, to } = range(req.body, 14);
  const [camps, ads, placements, demo, total] = await Promise.all([
    perfBy(org, { adAccountId, from, to, level: "campaign" }), perfBy(org, { adAccountId, from, to, level: "ad" }),
    AdBreakdown.find({ organizationId: org, kind: "placement", ...(adAccountId ? { adAccountId } : {}) }).lean(),
    AdBreakdown.find({ organizationId: org, kind: "age_gender", ...(adAccountId ? { adAccountId } : {}) }).lean(),
    totals(org, { date: { $gte: from, $lte: to }, ...(adAccountId ? { adAccountId } : {}) }),
  ]);
  const ents = await AdEntity.find({ organizationId: org, metaId: { $in: [...Object.keys(camps), ...Object.keys(ads)] } }).lean();
  const name = (id) => ents.find((e) => e.metaId === id);
  const table = (o) => Object.entries(o).filter(([, m]) => m.spend > 0).sort((a, b) => b[1].spend - a[1].spend).slice(0, 25).map(([id, m]) => ({ id, name: name(id)?.name, objective: name(id)?.objective, status: name(id)?.effectiveStatus, creative: name(id)?.creative ? { title: name(id).creative.title, body: (name(id).creative.body || "").slice(0, 160) } : undefined, ...pick(m, ["spend", "impressions", "ctr", "cpc", "cpm", "leads", "cpl", "purchases", "roas", "frequency"]) }));
  const brk = (rows) => rows.slice(0, 30).map((r) => ({ key: r.key, ...pick(kpis(r.metrics), ["spend", "impressions", "ctr", "cpl", "roas"]) }));
  if (!total.spend) throw fail(400, "No ad spend in this period. Sync the ad account first.");
  const ctx = await brandContext(org, req.body.brandId, { products: false });
  const data = await aiJSON(org, "ads_analysis",
    `You are a senior Meta Ads performance analyst. Analyse ONLY the numbers provided. Every recommendation must cite the evidence (numbers) it is based on and a confidence. Return JSON: {"summary":"","highlights":[""],"recommendations":[{"type":"copy|creative|audience|placement|budget|general","targetId":"campaign or ad id or null","title":"","detail":"","evidence":"","confidence":"low|medium|high","priority":"low|medium|high"}],"copyIdeas":[{"forAdId":"","primaryText":"","headline":""}],"dataLimitations":[""]}`,
    `${ctx.text}\nPERIOD: ${from}..${to}\nACCOUNT TOTALS: ${JSON.stringify(pick(total, ["spend", "impressions", "ctr", "cpc", "cpm", "leads", "cpl", "purchases", "roas"]))}\nCAMPAIGNS: ${JSON.stringify(table(camps))}\nADS: ${JSON.stringify(table(ads))}\nPLACEMENTS (30d): ${JSON.stringify(brk(placements))}\nAGE/GENDER (30d): ${JSON.stringify(brk(demo))}`,
    { maxTokens: 3000, temperature: 0.4 });
  for (const r of data.recommendations || []) {
    const e = r.targetId ? name(r.targetId) : null;
    await Recommendation.create({ organizationId: org, adAccountId: adAccountId || e?.adAccountId, type: r.type || "general", level: e?.level, metaId: e?.metaId, entityName: e?.name, title: r.title, detail: `${r.detail}${r.evidence ? `\nEvidence: ${r.evidence}` : ""}`, evidence: { confidence: r.confidence, period: `${from}..${to}` }, severity: r.priority || "medium", source: "ai" });
  }
  res.json({ success: true, from, to, analysis: data });
}));

// AI copy recommendations for one ad
app.post("/api/ads/ai-copy", wrap(async (req, res) => {
  const org = tid(req);
  const e = await AdEntity.findOne({ organizationId: org, metaId: req.body.adId, level: "ad" }).lean();
  if (!e) throw fail(404, "Ad not found. Sync first.");
  const m = (await perfBy(org, { from: daysAgo(13), to: daysAgo(0), level: "ad", ids: [e.metaId] }))[e.metaId] || kpis();
  const ctx = await brandContext(org, req.body.brandId);
  const data = await aiJSON(org, "ads_copy",
    `You are a Meta ads copywriter. Suggest better ad copy based on the current copy and its performance. Return JSON: {"diagnosis":"","variants":[{"primaryText":"","headline":"","description":"","cta":"","why":""}],"creativeIdeas":[""]}. ${GROUNDING}`,
    `${ctx.text}\nCURRENT AD: ${JSON.stringify({ name: e.name, title: e.creative?.title, body: e.creative?.body, cta: e.creative?.call_to_action_type })}\nLAST 14 DAYS: ${JSON.stringify(pick(m, ["spend", "impressions", "ctr", "cpc", "cpl", "roas", "frequency"]))}\nLANGUAGE: ${LANG[req.body.language] || "same as current ad"}`);
  res.json({ success: true, ...data });
}));

/* =====================================================
   BUDGET & MARKETING EXPENSE (1.8)
   ===================================================== */
const monthDays = (m) => new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0).getDate();

async function budgetSummary(org, month) {
  const s = await getSettings(org);
  const today = todayIn(s.timezone);
  const isCurrent = today.startsWith(month);
  const elapsed = isCurrent ? Number(today.slice(8, 10)) : monthDays(month);
  const accs = await SocialAccount.find({ organizationId: org, platform: "Meta Ads" }).lean();
  const mMatch = { organizationId: org, date: { $gte: `${month}-01`, $lte: `${month}-31` } };
  const [daily, byCamp, byAdset, plans] = await Promise.all([
    AdInsight.aggregate([{ $match: mMatch }, { $group: { _id: { a: "$adAccountId", d: "$date" }, spend: { $sum: "$spend" } } }]),
    AdInsight.aggregate([{ $match: mMatch }, { $group: { _id: "$campaignId", adAccountId: { $first: "$adAccountId" }, ...sumGroup } }]),
    AdInsight.aggregate([{ $match: mMatch }, { $group: { _id: "$adsetId", campaignId: { $first: "$campaignId" }, ...sumGroup } }]),
    BudgetPlan.find({ organizationId: org, month }).lean(),
  ]);
  const ents = await AdEntity.find({ organizationId: org, metaId: { $in: [...byCamp.map((c) => c._id), ...byAdset.map((x) => x._id)] } }).lean();
  const E = Object.fromEntries(ents.map((e) => [e.metaId, e]));
  const campIds = byCamp.map((c) => c._id);
  const campNames = campIds.map((id) => E[id]?.name).filter(Boolean);
  const attributed = await Order.aggregate([
    { $match: { organizationId: org, status: { $ne: "cancelled" }, createdAt: { $gte: new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7) - 1, 1)), $lt: new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 1)) }, "attribution.campaign": { $in: [...campIds, ...campNames] } } },
    { $group: { _id: "$attribution.campaign", revenue: { $sum: "$total" }, orders: { $sum: 1 } } },
  ]);
  const attr = Object.fromEntries(attributed.map((a) => [a._id, a]));
  const accounts = accs.map((a) => {
    const days = daily.filter((d) => d._id.a === a.accountId).map((d) => ({ date: d._id.d, spend: round(d.spend) })).sort((x, y) => x.date.localeCompare(y.date));
    const mtd = round(days.reduce((t, d) => t + d.spend, 0));
    const todaySpend = days.find((d) => d.date === today)?.spend || 0;
    const plan = plans.find((p) => p.adAccountId === a.accountId);
    const forecast = isCurrent ? round((mtd / Math.max(elapsed, 1)) * monthDays(month)) : mtd;
    return { adAccountId: a.accountId, name: a.accountName, currency: a.currency, clientName: a.clientName, mtd, today: todaySpend, dailyAvg: round(mtd / Math.max(elapsed, 1)), forecast, plan: plan || null, consumption: plan?.monthlyLimit ? round((mtd / plan.monthlyLimit) * 100, 1) : null, forecastOver: plan?.monthlyLimit ? forecast > plan.monthlyLimit : false, days };
  });
  const campaigns = byCamp.map((c) => {
    const e = E[c._id] || {};
    const k = kpis(c);
    const a = attr[c._id] || attr[e.name] || { revenue: 0, orders: 0 };
    const revenue = round((c.purchaseValue || 0) + a.revenue);
    return { id: c._id, name: e.name || c._id, adAccountId: c.adAccountId, status: e.effectiveStatus, dailyBudget: e.dailyBudget, lifetimeBudget: e.lifetimeBudget, spend: k.spend, leads: k.leads, purchases: k.purchases, metaRevenue: round(c.purchaseValue || 0), orderRevenue: a.revenue, attributedOrders: a.orders, revenue, roi: k.spend ? round(((revenue - k.spend) / k.spend) * 100, 1) : null, roas: k.spend ? round(revenue / k.spend) : 0 };
  }).sort((a, b) => b.spend - a.spend);
  const adsets = byAdset.map((x) => ({ id: x._id, name: E[x._id]?.name || x._id, campaign: E[x.campaignId]?.name, dailyBudget: E[x._id]?.dailyBudget, spend: round(x.spend), status: E[x._id]?.effectiveStatus })).sort((a, b) => b.spend - a.spend);
  const clients = {};
  for (const a of accounts) { const k = a.clientName || "Own business"; clients[k] = clients[k] || { client: k, spend: 0, forecast: 0, accounts: 0 }; clients[k].spend = round(clients[k].spend + a.mtd); clients[k].forecast = round(clients[k].forecast + a.forecast); clients[k].accounts++; }
  const totalPlan = plans.find((p) => p.adAccountId === "all");
  const total = round(accounts.reduce((t, a) => t + a.mtd, 0));
  return { month, today, elapsed, daysInMonth: monthDays(month), total, totalForecast: round(accounts.reduce((t, a) => t + a.forecast, 0)), totalPlan: totalPlan || null, accounts, campaigns, adsets, clients: Object.values(clients), plans };
}

async function checkBudgets(org) {
  const s = await getSettings(org);
  const month = todayIn(s.timezone).slice(0, 7);
  const sum = await budgetSummary(org, month);
  const plans = await BudgetPlan.find({ organizationId: org, month });
  for (const p of plans) {
    let spend, todaySpend;
    if (p.adAccountId === "all") { spend = sum.total; todaySpend = sum.accounts.reduce((t, a) => t + a.today, 0); }
    else if (p.clientName && p.adAccountId === "client") { const xs = sum.accounts.filter((a) => a.clientName === p.clientName); spend = xs.reduce((t, a) => t + a.mtd, 0); todaySpend = xs.reduce((t, a) => t + a.today, 0); }
    else { const a = sum.accounts.find((x) => x.adAccountId === p.adAccountId); spend = a?.mtd || 0; todaySpend = a?.today || 0; }
    const label = p.adAccountId === "all" ? "All ad accounts" : p.adAccountId === "client" ? `Client ${p.clientName}` : sum.accounts.find((a) => a.adAccountId === p.adAccountId)?.name || p.adAccountId;
    if (p.monthlyLimit > 0) {
      const used = (spend / p.monthlyLimit) * 100;
      for (const th of [...p.alertAt].sort((a, b) => a - b)) {
        const key = `m:${th}`;
        if (used >= th && !p.alertsSent.includes(key)) { p.alertsSent.push(key); await notify(org, "budget", `${label}: ${th}% of monthly budget used`, `Spent ${round(spend)} of ${p.monthlyLimit} (${round(used, 1)}%) in ${month}.`, "budget"); }
      }
    }
    if (p.dailyLimit > 0 && todaySpend > p.dailyLimit) {
      const key = `d:${sum.today}`;
      if (!p.alertsSent.includes(key)) { p.alertsSent.push(key); await notify(org, "budget", `${label}: daily budget exceeded`, `Spent ${round(todaySpend)} today vs limit ${p.dailyLimit}.`, "budget"); }
    }
    await p.save();
  }
}

app.get("/api/budget/summary", wrap(async (req, res) => {
  const s = await getSettings(tid(req));
  res.json(await budgetSummary(tid(req), req.query.month || todayIn(s.timezone).slice(0, 7)));
}));
app.get("/api/budget/plans", wrap(async (req, res) => res.json(await BudgetPlan.find({ organizationId: tid(req), ...(req.query.month ? { month: req.query.month } : {}) }).sort({ month: -1 }))));
app.post("/api/budget/plans", wrap(async (req, res) => {
  const d = pick(req.body, ["adAccountId", "clientName", "month", "monthlyLimit", "dailyLimit", "alertAt"]);
  if (!/^\d{4}-\d{2}$/.test(d.month || "")) throw fail(400, "month must be YYYY-MM");
  if (d.alertAt) d.alertAt = lines(d.alertAt).map(Number).filter((n) => n > 0);
  const p = await BudgetPlan.findOneAndUpdate({ organizationId: tid(req), adAccountId: d.adAccountId || "all", month: d.month, clientName: d.clientName || null }, { ...d, organizationId: tid(req) }, { upsert: true, new: true, setDefaultsOnInsert: true });
  await checkBudgets(tid(req)).catch(() => { });
  res.json({ success: true, plan: p });
}));
app.delete("/api/budget/plans/:id", wrap(async (req, res) => { await BudgetPlan.deleteOne({ _id: req.params.id, organizationId: tid(req) }); res.json({ success: true }); }));

app.get("/api/budget/report.csv", wrap(async (req, res) => {
  const s = await getSettings(tid(req));
  const sum = await budgetSummary(tid(req), req.query.month || todayIn(s.timezone).slice(0, 7));
  const rows = [["Campaign", "Ad account", "Status", "Daily budget", "Spend", "Leads", "Purchases", "Meta revenue", "Order revenue", "ROI %", "ROAS"],
  ...sum.campaigns.map((c) => [c.name, c.adAccountId, c.status, c.dailyBudget ?? "", c.spend, c.leads, c.purchases, c.metaRevenue, c.orderRevenue, c.roi ?? "", c.roas])];
  sendCsv(res, `marketing-expense-${sum.month}.csv`, rows);
}));
function sendCsv(res, name, rows) {
  const csv = rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  res.send("﻿" + csv); // BOM so Excel reads Bangla correctly
}

/* =====================================================
   A/B TESTING & EXPERIMENTS (1.9)
   ===================================================== */
const normCdf = (z) => { const t = 1 / (1 + 0.2316419 * Math.abs(z)); const d = 0.3989423 * Math.exp((-z * z) / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; };
function zConfidence(s1, n1, s2, n2) {
  if (!n1 || !n2) return null;
  const p1 = s1 / n1, p2 = s2 / n2, p = (s1 + s2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (!se) return null;
  return round(normCdf(Math.abs(p1 - p2) / se) * 100, 1);
}
const METRIC = {
  ctr: { better: "high", rate: (m) => [m.linkClicks, m.impressions] }, cvr: { better: "high", rate: (m) => [m.results, m.linkClicks] },
  engagement_rate: { better: "high", rate: (m) => [m.engagement, m.reach] }, cpc: { better: "low" }, cpl: { better: "low" }, roas: { better: "high" },
};
async function variantMetrics(org, v, from, to) {
  if (v.refType === "content") {
    const c = await ContentItem.findOne({ _id: v.refId, organizationId: org }).lean();
    const m = (c?.targets || []).reduce((a, t) => ({ reach: a.reach + (t.metrics?.reach || 0), engagement: a.engagement + (t.metrics?.engagement || 0), clicks: a.clicks + (t.metrics?.clicks || 0) }), { reach: 0, engagement: 0, clicks: 0 });
    return { ...m, impressions: m.reach, linkClicks: m.clicks, engagement_rate: m.reach ? round((m.engagement / m.reach) * 100) : 0 };
  }
  const [r] = await AdInsight.aggregate([{ $match: { organizationId: org, adId: v.refId, date: { $gte: from, $lte: to } } }, { $group: { _id: null, ...sumGroup } }]);
  return kpis(r || {});
}
async function evaluateExperiment(org, ex) {
  const from = ymd(ex.startedAt || ex.createdAt), to = ymd(ex.endedAt || new Date());
  const cfg = METRIC[ex.metric] || METRIC.ctr;
  for (const v of ex.variants) v.results = await variantMetrics(org, v, from, to);
  const val = (v) => Number(v.results[ex.metric] ?? 0);
  const sorted = [...ex.variants].filter((v) => (v.results.impressions || 0) > 0).sort((a, b) => (cfg.better === "high" ? val(b) - val(a) : (val(a) || Infinity) - (val(b) || Infinity)));
  let confidence = null, winner = null, note = "";
  if (sorted.length >= 2) {
    const [a, b] = sorted;
    if (cfg.rate) { const [s1, n1] = cfg.rate(a.results), [s2, n2] = cfg.rate(b.results); confidence = zConfidence(s1, n1, s2, n2); }
    const enough = sorted.every((v) => (v.results.impressions || 0) >= 1000);
    if (confidence != null && confidence >= 95 && enough) winner = a.label;
    else if (confidence == null && enough && val(b) && Math.abs(val(a) - val(b)) / val(b) >= 0.15) { winner = a.label; note = "Cost/return metric: no significance test, difference ≥15%."; }
    else note = enough ? "Not significant yet. Keep the test running." : "Each variant needs at least 1,000 impressions.";
  } else note = "Need data for at least two variants.";
  ex.confidence = confidence;
  ex.markModified("variants");
  return { leader: sorted[0]?.label || null, winner, confidence, note, from, to };
}

app.get("/api/experiments", wrap(async (req, res) => res.json(await Experiment.find({ organizationId: tid(req) }).sort({ createdAt: -1 }))));
app.post("/api/experiments", wrap(async (req, res) => {
  const d = pick(req.body, ["name", "type", "hypothesis", "metric", "variants", "brandId"]);
  if (!d.name) throw fail(400, "Experiment name is required");
  if (!Array.isArray(d.variants) || d.variants.length < 2) throw fail(400, "Add at least two variants");
  res.json({ success: true, experiment: await Experiment.create({ ...d, organizationId: tid(req) }) });
}));
app.put("/api/experiments/:id", wrap(async (req, res) => {
  const ex = await Experiment.findOneAndUpdate({ _id: req.params.id, organizationId: tid(req) }, pick(req.body, ["name", "type", "hypothesis", "metric", "variants"]), { new: true });
  if (!ex) throw fail(404, "Experiment not found");
  res.json({ success: true, experiment: ex });
}));
app.delete("/api/experiments/:id", wrap(async (req, res) => { await Experiment.deleteOne({ _id: req.params.id, organizationId: tid(req) }); res.json({ success: true }); }));
app.post("/api/experiments/:id/start", wrap(async (req, res) => {
  const ex = await Experiment.findOneAndUpdate({ _id: req.params.id, organizationId: tid(req) }, { status: "running", startedAt: req.body.startedAt ? new Date(req.body.startedAt) : new Date(), endedAt: null, winner: null }, { new: true });
  if (!ex) throw fail(404, "Experiment not found");
  res.json({ success: true, experiment: ex });
}));
app.post("/api/experiments/:id/evaluate", wrap(async (req, res) => {
  const ex = await Experiment.findOne({ _id: req.params.id, organizationId: tid(req) });
  if (!ex) throw fail(404, "Experiment not found");
  const result = await evaluateExperiment(tid(req), ex);
  await ex.save();
  res.json({ success: true, experiment: ex, result });
}));
app.post("/api/experiments/:id/complete", wrap(async (req, res) => {
  const ex = await Experiment.findOne({ _id: req.params.id, organizationId: tid(req) });
  if (!ex) throw fail(404, "Experiment not found");
  const result = await evaluateExperiment(tid(req), ex);
  ex.status = "completed"; ex.endedAt = new Date(); ex.winner = req.body.winner || result.winner || result.leader;
  await ex.save();
  res.json({ success: true, experiment: ex, result });
}));
app.post("/api/experiments/:id/ai", wrap(async (req, res) => {
  const org = tid(req);
  const ex = await Experiment.findOne({ _id: req.params.id, organizationId: org });
  if (!ex) throw fail(404, "Experiment not found");
  const result = await evaluateExperiment(org, ex);
  const data = await aiChat(org, "experiment_notes", {
    json: false, temperature: 0.4,
    system: "You are a marketing experimentation expert. Explain the A/B test results in plain language (max 180 words): who is winning, whether it is statistically reliable, what to do next and one follow-up test idea. Use only the numbers given.",
    user: JSON.stringify({ name: ex.name, type: ex.type, hypothesis: ex.hypothesis, metric: ex.metric, result, variants: ex.variants.map((v) => ({ label: v.label, description: v.description, results: v.results })) }),
  });
  ex.aiNotes = data; await ex.save();
  res.json({ success: true, experiment: ex, notes: data });
}));
app.post("/api/experiments/suggest", wrap(async (req, res) => {
  const org = tid(req);
  const ads = await perfBy(org, { from: daysAgo(29), to: daysAgo(0), level: "ad" });
  const ents = await AdEntity.find({ organizationId: org, metaId: { $in: Object.keys(ads) } }).lean();
  const top = ents.map((e) => ({ name: e.name, title: e.creative?.title, body: (e.creative?.body || "").slice(0, 120), ...pick(ads[e.metaId], ["spend", "ctr", "cpl", "roas"]) })).sort((a, b) => b.spend - a.spend).slice(0, 15);
  const ctx = await brandContext(org, req.body.brandId, { products: false });
  const data = await aiJSON(org, "experiment_ideas",
    `You are a growth marketer. Suggest 5 A/B tests for Meta ads and organic posts. Return JSON: {"tests":[{"name":"","type":"copy|creative|cta|audience|landing_page","hypothesis":"","metric":"ctr|cpc|cpl|cvr|roas|engagement_rate","variants":[{"label":"A","description":""},{"label":"B","description":""}],"why":""}]}`,
    `${ctx.text}\nCURRENT ADS (30d): ${JSON.stringify(top)}`);
  res.json({ success: true, ...data });
}));

/* =====================================================
   LEAD GENERATION & CRM (1.10)
   ===================================================== */
// n8n flows (existing)
app.post("/api/leads/check-duplicate", wrap(async (req, res) => {
  const { tenantId, eventId } = req.body;
  if (await WebhookEvent.findOne({ externalEventId: eventId })) return res.json({ isDuplicate: true });
  await WebhookEvent.create({ tenantId, externalEventId: eventId, provider: "n8n", processingStatus: "processed" });
  res.json({ isDuplicate: false });
}));
app.post("/api/leads/create", wrap(async (req, res) => {
  const { tenantId, leadId, name, email, aiScore, aiStatus, aiReason } = req.body;
  const lead = await Lead.create({
    _id: leadId, organizationId: tenantId, name, email, source: "n8n",
    aiScore: parseInt(aiScore, 10) || 0, aiStatus: aiStatus || "Cold", aiReason,
  });
  res.json({ success: true, lead });
}));
app.post("/api/tasks/create", wrap(async (req, res) => {
  const { tenantId, leadId, title, priority } = req.body;
  const task = await Task.create({ organizationId: tenantId, leadId: leadId || null, title, priority: priority || "High" });
  res.json({ success: true, task });
}));

const normPhone = (p) => {
  if (!p) return null;
  let d = String(p).replace(/[^\d]/g, "");
  if (d.startsWith("880")) d = "0" + d.slice(3);
  return d || null;
};

// Rules-based score (works without AI). 0-100
function ruleScore(l) {
  const t = `${l.message || ""} ${JSON.stringify(l.fields || {})}`.toLowerCase();
  let s = 20; const why = [];
  if (l.phone) { s += 15; why.push("has phone"); }
  if (l.email) { s += 10; why.push("has email"); }
  if (/\d{4,}|budget|taka|tk|৳|টাকা|বাজেট/.test(t)) { s += 20; why.push("mentions budget"); }
  if (/urgent|asap|today|this week|now|আজ|এখনই|জরুরি/.test(t)) { s += 15; why.push("urgency"); }
  if (/price|buy|order|book|quote|wholesale|দাম|কিনতে|অর্ডার|বুক/.test(t)) { s += 10; why.push("buying intent"); }
  if (l.source === "facebook_lead_ad") { s += 10; why.push("filled a lead form"); }
  s = Math.min(s, 100);
  return { score: s, status: s >= 70 ? "Hot" : s >= 40 ? "Warm" : "Cold", reason: `Rule score: ${why.join(", ") || "little information"}`, category: /wholesale|bulk|b2b|পাইকারি/.test(t) ? "Wholesale / B2B" : /service|সার্ভিস/.test(t) ? "Service inquiry" : "Product inquiry", qualified: s >= 60 };
}

async function scoreLead(org, l) {
  if (!aiConfigured()) return ruleScore(l);
  try {
    const s = await getSettings(org);
    const ctx = await brandContext(org, null, { products: false });
    const r = await aiJSON(org, "lead_score",
      `You qualify sales leads. Return JSON: {"score":0-100,"status":"Hot|Warm|Cold","category":"one of: ${s.leadCategories.join(", ")}","qualified":true|false,"reason":"one short sentence","nextAction":"one short sentence"}. Hot = clear need + budget/urgency + contact. Be strict; don't invent facts.`,
      `${ctx.text}\nLEAD: ${JSON.stringify({ name: l.name, email: !!l.email, phone: !!l.phone, source: l.source, campaign: l.campaignName, message: l.message, answers: l.fields })}`,
      { temperature: 0.2, maxTokens: 400 });
    return { score: Math.max(0, Math.min(100, Number(r.score) || 0)), status: ["Hot", "Warm", "Cold"].includes(r.status) ? r.status : "Cold", category: r.category || "Other", qualified: !!r.qualified, reason: [r.reason, r.nextAction && `Next: ${r.nextAction}`].filter(Boolean).join(" ") };
  } catch (e) { console.warn("AI lead score failed, using rules:", e.message); return ruleScore(l); }
}

async function nextAssignee(org) {
  const o = await Organization.findOneAndUpdate({ _id: org }, { $inc: { "marketingSettings.rrIndex": 1 } }, { new: false }).lean();
  const team = (o?.marketingSettings?.salesTeam || []).filter((m) => m.active !== false);
  if (!team.length) return null;
  const m = team[(o.marketingSettings.rrIndex || 0) % team.length];
  return m.name || m.email;
}

// Single entry point for every new lead: dedup -> score -> categorise -> assign -> notify
async function ingestLead(org, data, opts = {}) {
  const email = data.email ? String(data.email).trim().toLowerCase() : null;
  const phone = normPhone(data.phone);
  const or = [];
  if (data.externalId) or.push({ externalId: data.externalId });
  if (email) or.push({ email });
  if (phone) or.push({ phone });
  const existing = or.length ? await Lead.findOne({ organizationId: org, $or: or }) : null;
  if (existing) {
    existing.duplicateCount += 1;
    existing.notes.push({ text: `Repeat inquiry via ${data.source || "manual"}${data.campaignName ? ` (${data.campaignName})` : ""}: ${data.message || "-"}`, by: "system" });
    for (const k of ["email", "phone", "campaignId", "campaignName", "adId", "formId"]) if (!existing[k] && (k === "email" ? email : k === "phone" ? phone : data[k])) existing[k] = k === "email" ? email : k === "phone" ? phone : data[k];
    if (["lost"].includes(existing.stage)) existing.stage = "new";
    await existing.save();
    return { lead: existing, duplicate: true };
  }
  const lead = new Lead({ ...pick(data, ["name", "message", "source", "externalId", "formId", "pageId", "adId", "adsetId", "campaignId", "campaignName", "fields"]), email, phone, organizationId: org, name: data.name || email || phone || "Unknown" });
  const sc = opts.skipAi ? ruleScore(lead) : await scoreLead(org, lead);
  Object.assign(lead, { aiScore: sc.score, aiStatus: sc.status, aiReason: sc.reason, category: sc.category, qualified: sc.qualified });
  lead.assignedTo = data.assignedTo || (await nextAssignee(org));
  if (lead.aiStatus === "Hot") lead.followUpAt = new Date(Date.now() + 2 * 3600e3);
  await lead.save();
  if (!opts.quiet) await notify(org, "lead", `New ${lead.aiStatus} lead: ${lead.name}`, `${lead.category} · ${lead.source}${lead.campaignName ? ` · ${lead.campaignName}` : ""}${lead.assignedTo ? ` · assigned to ${lead.assignedTo}` : ""}`, "leads");
  if (process.env.SALES_WEBHOOK_URL) fetch(process.env.SALES_WEBHOOK_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tenantId: org, lead: lead.toJSON() }) }).catch((e) => console.warn("Sales webhook:", e.message));
  return { lead, duplicate: false };
}

app.get("/api/leads", wrap(async (req, res) => {
  const q = { organizationId: tid(req) };
  for (const k of ["stage", "source", "aiStatus", "assignedTo", "category", "campaignId"]) if (req.query[k]) q[k] = { $in: String(req.query[k]).split(",") };
  if (req.query.q) { const re = new RegExp(escRe(req.query.q), "i"); q.$or = [{ name: re }, { email: re }, { phone: re }, { message: re }]; }
  if (req.query.due === "1") q.followUpAt = { $lte: new Date() };
  res.json(await Lead.find(q).sort({ createdAt: -1 }).limit(Math.min(Number(req.query.limit) || 300, 1000)));
}));
app.post("/api/leads", wrap(async (req, res) => {
  const b = req.body;
  if (!b.name && !b.email && !b.phone) throw fail(400, "Name, email or phone is required");
  const r = await ingestLead(tid(req), { ...b, source: b.source || "manual" });
  res.json({ success: true, ...r });
}));
app.put("/api/leads/:id", wrap(async (req, res) => {
  const p = pick(req.body, ["name", "email", "phone", "stage", "assignedTo", "followUpAt", "category", "value", "aiStatus"]);
  if ("followUpAt" in p) { p.followUpAt = p.followUpAt ? new Date(p.followUpAt) : null; p.followUpNotified = false; }
  if ("phone" in p) p.phone = normPhone(p.phone);
  if (p.stage === "won") p.convertedAt = new Date();
  const l = await Lead.findOneAndUpdate({ _id: req.params.id, organizationId: tid(req) }, p, { new: true, runValidators: true });
  if (!l) throw fail(404, "Lead not found");
  res.json({ success: true, lead: l });
}));
app.post("/api/leads/:id/notes", wrap(async (req, res) => {
  if (!req.body.text) throw fail(400, "Note text is required");
  const l = await Lead.findOneAndUpdate({ _id: req.params.id, organizationId: tid(req) }, { $push: { notes: { text: req.body.text, by: actor(req) } } }, { new: true });
  if (!l) throw fail(404, "Lead not found");
  res.json({ success: true, lead: l });
}));
app.post("/api/leads/:id/rescore", wrap(async (req, res) => {
  const l = await Lead.findOne({ _id: req.params.id, organizationId: tid(req) });
  if (!l) throw fail(404, "Lead not found");
  const sc = await scoreLead(tid(req), l);
  Object.assign(l, { aiScore: sc.score, aiStatus: sc.status, aiReason: sc.reason, category: sc.category, qualified: sc.qualified });
  await l.save();
  res.json({ success: true, lead: l });
}));
// Conversion tracking
app.post("/api/leads/:id/convert", wrap(async (req, res) => {
  const l = await Lead.findOneAndUpdate({ _id: req.params.id, organizationId: tid(req) }, { stage: "won", convertedAt: new Date(), value: Number(req.body.value) || 0, orderId: req.body.orderId || null, $push: { notes: { text: `Converted${req.body.value ? ` (value ${req.body.value})` : ""}`, by: actor(req) } } }, { new: true });
  if (!l) throw fail(404, "Lead not found");
  if (l.orderId) await Order.updateOne({ _id: l.orderId, organizationId: tid(req) }, { "attribution.leadId": l.id, "attribution.campaign": l.campaignId || l.campaignName, "attribution.adId": l.adId, "attribution.source": l.source });
  res.json({ success: true, lead: l });
}));
app.delete("/api/leads/:id", wrap(async (req, res) => { await Lead.deleteOne({ _id: req.params.id, organizationId: tid(req) }); res.json({ success: true }); }));

// Lead form management (Meta instant forms)
async function pageAccount(org, pageId) {
  const a = await SocialAccount.findOne({ organizationId: org, platform: "Facebook", ...(pageId ? { accountId: pageId } : {}) }).select("+accessToken");
  if (!a) throw fail(400, "Connect a Facebook Page first");
  return a;
}
app.get("/api/leads/forms", wrap(async (req, res) => {
  const a = await pageAccount(tid(req), req.query.pageId);
  res.json(await graphAll(`/${a.accountId}/leadgen_forms`, { token: tok(a), params: { fields: "id,name,status,leads_count,created_time,locale", limit: 100 } }));
}));
async function leadFromMeta(org, a, raw, extra = {}) {
  const f = Object.fromEntries((raw.field_data || []).map((x) => [x.name, (x.values || []).join(", ")]));
  const name = f.full_name || [f.first_name, f.last_name].filter(Boolean).join(" ") || f.name || "Lead";
  return ingestLead(org, {
    name, email: f.email, phone: f.phone_number || f.phone, message: f.message || f.comments || Object.entries(f).filter(([k]) => !["full_name", "first_name", "last_name", "email", "phone_number"].includes(k)).map(([k, v]) => `${k}: ${v}`).join("; "),
    source: "facebook_lead_ad", externalId: raw.id, formId: raw.form_id || extra.formId, pageId: a.accountId, adId: raw.ad_id, adsetId: raw.adset_id, campaignId: raw.campaign_id, campaignName: raw.campaign_name, fields: f,
  });
}
// Backfill: pull existing leads from a form
app.post("/api/leads/forms/:formId/sync", wrap(async (req, res) => {
  const org = tid(req);
  const a = await pageAccount(org, req.body.pageId);
  const rows = await graphAll(`/${req.params.formId}/leads`, { token: tok(a), params: { fields: "id,created_time,field_data,ad_id,adset_id,campaign_id,campaign_name,form_id", limit: 100 } }, 2000);
  let created = 0, dup = 0;
  for (const r of rows) { const x = await leadFromMeta(org, a, r, { formId: req.params.formId }); x.duplicate ? dup++ : created++; }
  res.json({ success: true, fetched: rows.length, created, duplicates: dup });
}));
// Subscribe the Page to the app so Meta sends leadgen webhooks
app.post("/api/leads/subscribe-page", wrap(async (req, res) => {
  const a = await pageAccount(tid(req), req.body.pageId);
  const r = await graph(`/${a.accountId}/subscribed_apps`, { token: tok(a), method: "POST", body: { subscribed_fields: ["leadgen"] } });
  res.json({ success: !!r.success });
}));

// Campaign-based lead attribution
app.get("/api/leads/attribution", wrap(async (req, res) => {
  const org = tid(req);
  const { from, to } = range(req.query, 30);
  const rows = await Lead.aggregate([
    { $match: { organizationId: org, createdAt: { $gte: new Date(from), $lte: new Date(to + "T23:59:59Z") } } },
    { $group: { _id: { c: { $ifNull: ["$campaignId", "$source"] }, n: "$campaignName", s: "$source" }, leads: { $sum: 1 }, hot: { $sum: { $cond: [{ $eq: ["$aiStatus", "Hot"] }, 1, 0] } }, qualified: { $sum: { $cond: ["$qualified", 1, 0] } }, won: { $sum: { $cond: [{ $eq: ["$stage", "won"] }, 1, 0] } }, value: { $sum: "$value" } } },
  ]);
  const spend = await perfBy(org, { from, to, level: "campaign" });
  res.json({
    from, to, rows: rows.map((r) => {
      const s = spend[r._id.c]?.spend || 0;
      return { campaignId: r._id.c, campaign: r._id.n || r._id.c, source: r._id.s, leads: r.leads, hot: r.hot, qualified: r.qualified, won: r.won, conversionRate: r.leads ? round((r.won / r.leads) * 100, 1) : 0, value: r.value, spend: s, cpl: r.leads && s ? round(s / r.leads) : null, costPerWin: r.won && s ? round(s / r.won) : null };
    }).sort((a, b) => b.leads - a.leads)
  });
}));

app.get("/api/leads/:id", wrap(async (req, res) => {
  const l = await Lead.findOne({ _id: req.params.id, organizationId: tid(req) });
  if (!l) throw fail(404, "Lead not found");
  res.json(l);
}));

/* ---------- Meta webhooks: lead ads + Instagram DMs ---------- */
app.get("/webhooks/meta", (req, res) => {
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === process.env.META_WEBHOOK_VERIFY_TOKEN) return res.status(200).send(req.query["hub.challenge"]);
  res.sendStatus(403);
});
app.post("/webhooks/meta", (req, res) => {
  if (FB_APP_SECRET) {
    const sig = req.headers["x-hub-signature-256"] || "";
    const exp = "sha256=" + crypto.createHmac("sha256", FB_APP_SECRET).update(req.rawBody || "").digest("hex");
    if (sig.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) return res.sendStatus(401);
  }
  res.sendStatus(200); // answer fast; process after
  handleMetaWebhook(req.body).catch((e) => console.error("Meta webhook:", e));
});
async function followUpReminders() {
  const due = await Lead.find({ followUpAt: { $lte: new Date() }, followUpNotified: false, stage: { $nin: ["won", "lost"] } }).limit(200);
  for (const l of due) {
    await notify(l.organizationId, "follow_up", `Follow up: ${l.name}`, `${l.aiStatus} lead${l.assignedTo ? ` · ${l.assignedTo}` : ""}${l.phone ? ` · ${l.phone}` : ""}`, "leads");
    l.followUpNotified = true;
    await l.save();
  }
}

/* =====================================================
   MARKETING ANALYTICS & REPORTING (1.11)
   ===================================================== */
// Metric names change between Graph API versions: each metric is requested separately and
// failures are skipped, so one deprecated metric never breaks the sync. Override in .env.
const FB_PAGE_METRICS = lines(process.env.FB_PAGE_METRICS || "page_impressions_unique,page_post_engagements,page_daily_follows_unique,page_views_total,page_media_view");
const IG_METRICS = lines(process.env.IG_METRICS || "reach,views,accounts_engaged,total_interactions,profile_views");
const FB_POST_METRICS = lines(process.env.FB_POST_METRICS || "post_impressions_unique,post_clicks");
const IG_MEDIA_METRICS = lines(process.env.IG_MEDIA_METRICS || "reach,saved,shares,views,total_interactions");

async function setDayMetric(org, acc, date, key, value) {
  await AccountInsight.updateOne({ organizationId: org, accountId: acc.id, date }, { $set: { platform: acc.platform, [`metrics.${key}`]: value } }, { upsert: true });
}

async function syncAccountInsights(org, acc, days = 7) {
  const token = tok(acc);
  const errors = [];
  if (acc.platform === "Facebook") {
    const p = await graph(`/${acc.accountId}`, { token, params: { fields: "followers_count,fan_count" } });
    await setDayMetric(org, acc, ymd(new Date()), "followers", p.followers_count ?? p.fan_count ?? 0);
    const since = Math.floor((Date.now() - days * DAY) / 1000), until = Math.floor(Date.now() / 1000);
    for (const m of FB_PAGE_METRICS) {
      try {
        const r = await graph(`/${acc.accountId}/insights`, { token, params: { metric: m, period: "day", since, until } });
        for (const v of r.data?.[0]?.values || []) await setDayMetric(org, acc, ymd(new Date(v.end_time).getTime() - DAY), m, typeof v.value === "number" ? v.value : Object.values(v.value || {}).reduce((a, b) => a + (Number(b) || 0), 0));
      } catch (e) { errors.push(`${m}: ${e.message}`); }
    }
  }
  if (acc.platform === "Instagram") {
    const p = await graph(`/${acc.accountId}`, { token, params: { fields: "followers_count,media_count" } });
    await setDayMetric(org, acc, ymd(new Date()), "followers", p.followers_count || 0);
    await setDayMetric(org, acc, ymd(new Date()), "media_count", p.media_count || 0);
    for (let d = Math.min(days, 7); d >= 1; d--) {
      const start = startOfDay(Date.now() - d * DAY);
      const since = Math.floor(start.getTime() / 1000), until = since + 86400;
      for (const m of IG_METRICS) {
        try {
          const r = await graph(`/${acc.accountId}/insights`, { token, params: { metric: m, period: "day", metric_type: "total_value", since, until } });
          const v = r.data?.[0]?.total_value?.value ?? r.data?.[0]?.values?.[0]?.value;
          if (v != null) await setDayMetric(org, acc, ymd(start), m, Number(v) || 0);
        } catch (e) { if (d === 1) errors.push(`${m}: ${e.message}`); }
      }
    }
  }
  await SocialAccount.updateOne({ _id: acc.id }, { lastSyncedAt: new Date() });
  return errors;
}

async function syncPostMetrics(org, item) {
  for (const t of item.targets.filter((x) => x.status === "published" && x.providerPostId)) {
    const acc = await SocialAccount.findOne({ _id: t.accountId, organizationId: org }).select("+accessToken");
    if (!acc) continue;
    const token = tok(acc), m = { ...(t.metrics || {}) };
    try {
      if (acc.platform === "Facebook") {
        const p = await graph(`/${t.providerPostId}`, { token, params: { fields: "shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)" } }).catch(() => ({}));
        m.likes = p.reactions?.summary?.total_count ?? m.likes ?? 0;
        m.comments = p.comments?.summary?.total_count ?? m.comments ?? 0;
        m.shares = p.shares?.count ?? m.shares ?? 0;
        for (const k of FB_POST_METRICS) {
          try { const r = await graph(`/${t.providerPostId}/insights`, { token, params: { metric: k } }); const v = r.data?.[0]?.values?.[0]?.value; if (v != null) m[k === "post_impressions_unique" ? "reach" : k === "post_clicks" ? "clicks" : k] = Number(v) || 0; } catch { }
        }
      } else {
        const p = await graph(`/${t.providerPostId}`, { token, params: { fields: "like_count,comments_count" } }).catch(() => ({}));
        m.likes = p.like_count ?? m.likes ?? 0;
        m.comments = p.comments_count ?? m.comments ?? 0;
        for (const k of IG_MEDIA_METRICS) {
          try { const r = await graph(`/${t.providerPostId}/insights`, { token, params: { metric: k } }); const v = r.data?.[0]?.values?.[0]?.value ?? r.data?.[0]?.total_value?.value; if (v != null) m[k === "saved" ? "saves" : k] = Number(v) || 0; } catch { }
        }
      }
      m.engagement = (m.likes || 0) + (m.comments || 0) + (m.shares || 0) + (m.saves || 0) + (m.clicks || 0);
      t.metrics = m; t.metricsAt = new Date();
    } catch (e) { console.warn("post metrics:", e.message); }
  }
  item.markModified("targets");
  await item.save();
}

async function syncOrganic(org) {
  const accs = await SocialAccount.find({ organizationId: org, platform: { $in: ["Facebook", "Instagram"] }, status: { $nin: ["expired", "revoked"] } }).select("+accessToken");
  const errors = {};
  for (const a of accs) errors[a.accountName] = await syncAccountInsights(org, a).catch((e) => [e.message]);
  const posts = await ContentItem.find({ organizationId: org, status: { $in: ["Published", "Partially Published"] }, publishedAt: { $gte: new Date(Date.now() - 30 * DAY) } }).limit(150);
  for (const p of posts) await syncPostMetrics(org, p).catch(() => { });
  return { accounts: accs.length, posts: posts.length, errors };
}

app.post("/api/analytics/sync", wrap(async (req, res) => res.json({ success: true, ...(await syncOrganic(tid(req))) })));
app.post("/api/content/:id/sync-metrics", wrap(async (req, res) => {
  const c = await ContentItem.findOne({ _id: req.params.id, organizationId: tid(req) });
  if (!c) throw fail(404, "Content not found");
  await syncPostMetrics(tid(req), c);
  res.json({ success: true, content: c });
}));
app.get("/api/analytics/accounts/:id/series", wrap(async (req, res) => {
  const { from, to } = range(req.query, 30);
  res.json(await AccountInsight.find({ organizationId: tid(req), accountId: req.params.id, date: { $gte: from, $lte: to } }).sort({ date: 1 }).lean());
}));

async function buildReport(org, from, to) {
  const fromD = new Date(from + "T00:00:00Z"), toD = new Date(to + "T23:59:59Z");
  const accs = await SocialAccount.find({ organizationId: org }).lean();
  const [posts, ins, paid, campPerf, leads, leadsBySource, leadsByStage, orders] = await Promise.all([
    ContentItem.find({ organizationId: org, publishedAt: { $gte: fromD, $lte: toD } }).lean(),
    AccountInsight.find({ organizationId: org, date: { $gte: from, $lte: to } }).lean(),
    totals(org, { date: { $gte: from, $lte: to } }),
    perfBy(org, { from, to, level: "campaign" }),
    Lead.countDocuments({ organizationId: org, createdAt: { $gte: fromD, $lte: toD } }),
    Lead.aggregate([{ $match: { organizationId: org, createdAt: { $gte: fromD, $lte: toD } } }, { $group: { _id: "$source", n: { $sum: 1 } } }]),
    Lead.aggregate([{ $match: { organizationId: org, createdAt: { $gte: fromD, $lte: toD } } }, { $group: { _id: "$stage", n: { $sum: 1 }, value: { $sum: "$value" } } }]),
    Order.aggregate([{ $match: { organizationId: org, createdAt: { $gte: fromD, $lte: toD }, status: { $ne: "cancelled" }, "attribution.campaign": { $ne: null } } }, { $group: { _id: null, n: { $sum: 1 }, revenue: { $sum: "$total" } } }]),
  ]);
  const t = (p) => (p.targets || []).reduce((a, x) => { for (const k of ["reach", "likes", "comments", "shares", "saves", "clicks", "views", "engagement"]) a[k] = (a[k] || 0) + (x.metrics?.[k] || 0); return a; }, {});
  const postRows = posts.map((p) => ({ id: p._id, title: p.title, format: p.format, platforms: [...new Set((p.targets || []).map((x) => x.platform))], status: p.status, publishedAt: p.publishedAt, permalink: (p.targets || []).find((x) => x.permalink)?.permalink, ...t(p) }));
  const organic = postRows.reduce((a, p) => { for (const k of ["reach", "engagement", "likes", "comments", "shares", "saves", "clicks", "views"]) a[k] = (a[k] || 0) + (p[k] || 0); return a; }, { posts: posts.length, published: posts.filter((p) => p.status === "Published").length, failed: posts.filter((p) => ["Failed", "Partially Published"].includes(p.status)).length });
  organic.engagementRate = organic.reach ? round((organic.engagement / organic.reach) * 100) : 0;
  const accounts = accs.filter((a) => ["Facebook", "Instagram"].includes(a.platform)).map((a) => {
    const rows = ins.filter((r) => r.accountId === String(a._id) && r.date >= from && r.date <= to).sort((x, y) => x.date.localeCompare(y.date));
    const f = rows.filter((r) => r.metrics?.followers != null);
    const sums = {};
    for (const r of rows) for (const [k, v] of Object.entries(r.metrics || {})) if (!["followers", "media_count"].includes(k)) sums[k] = (sums[k] || 0) + (Number(v) || 0);
    return { id: String(a._id), name: a.accountName, platform: a.platform, followersStart: f[0]?.metrics.followers ?? null, followersEnd: f[f.length - 1]?.metrics.followers ?? null, growth: f.length > 1 ? f[f.length - 1].metrics.followers - f[0].metrics.followers : null, metrics: sums };
  });
  const ents = await AdEntity.find({ organizationId: org, level: "campaign", metaId: { $in: Object.keys(campPerf) } }).lean();
  const campaigns = Object.entries(campPerf).map(([id, m]) => ({ id, name: ents.find((e) => e.metaId === id)?.name || id, objective: ents.find((e) => e.metaId === id)?.objective, ...m })).sort((a, b) => b.spend - a.spend);
  return {
    from, to, generatedAt: new Date(), organic, topPosts: [...postRows].sort((a, b) => (b.engagement || 0) - (a.engagement || 0)).slice(0, 10), posts: postRows, accounts,
    paid, campaigns, leads: { total: leads, bySource: leadsBySource.map((x) => ({ source: x._id, n: x.n })), byStage: leadsByStage.map((x) => ({ stage: x._id, n: x.n, value: x.value })) },
    conversions: { attributedOrders: orders[0]?.n || 0, attributedRevenue: orders[0]?.revenue || 0 },
  };
}

app.get("/api/reports/marketing", wrap(async (req, res) => { const { from, to } = range(req.query, 7); res.json(await buildReport(tid(req), from, to)); }));
app.get("/api/reports/marketing.csv", wrap(async (req, res) => {
  const { from, to } = range(req.query, 7);
  const r = await buildReport(tid(req), from, to);
  const rows = [
    ["MarketingFlow AI marketing report", `${from} to ${to}`], [],
    ["ORGANIC"], ["Posts", "Published", "Failed", "Reach", "Engagement", "Engagement rate %"], [r.organic.posts, r.organic.published, r.organic.failed, r.organic.reach || 0, r.organic.engagement || 0, r.organic.engagementRate], [],
    ["ACCOUNTS"], ["Account", "Platform", "Followers start", "Followers end", "Growth", ...new Set(r.accounts.flatMap((a) => Object.keys(a.metrics)))],
    ...r.accounts.map((a) => [a.name, a.platform, a.followersStart ?? "", a.followersEnd ?? "", a.growth ?? "", ...Object.values(a.metrics)]), [],
    ["PAID ADS"], ["Spend", "Impressions", "Reach", "Link clicks", "CTR %", "CPC", "CPM", "Leads", "CPL", "Purchases", "Purchase value", "ROAS"],
    [r.paid.spend, r.paid.impressions, r.paid.reach, r.paid.linkClicks, r.paid.ctr, r.paid.cpc, r.paid.cpm, r.paid.leads, r.paid.cpl, r.paid.purchases, r.paid.purchaseValue, r.paid.roas], [],
    ["CAMPAIGNS"], ["Campaign", "Objective", "Spend", "Impressions", "CTR %", "CPC", "Leads", "CPL", "Purchases", "ROAS"],
    ...r.campaigns.map((c) => [c.name, c.objective, c.spend, c.impressions, c.ctr, c.cpc, c.leads, c.cpl, c.purchases, c.roas]), [],
    ["POSTS"], ["Title", "Platforms", "Published", "Reach", "Likes", "Comments", "Shares", "Saves", "Engagement", "Link"],
    ...r.posts.map((p) => [p.title, p.platforms.join("/"), p.publishedAt ? ymd(p.publishedAt) : "", p.reach || 0, p.likes || 0, p.comments || 0, p.shares || 0, p.saves || 0, p.engagement || 0, p.permalink || ""]), [],
    ["LEADS"], ["Total", r.leads.total], ...r.leads.bySource.map((x) => [x.source, x.n]),
  ];
  sendCsv(res, `marketing-report-${from}-to-${to}.csv`, rows);
}));
app.post("/api/reports/marketing/summary", wrap(async (req, res) => {
  const org = tid(req);
  const { from, to } = range(req.body, 7);
  const r = await buildReport(org, from, to);
  const ctx = await brandContext(org, req.body.brandId, { products: false });
  const data = await aiJSON(org, "report_summary",
    `You write marketing performance summaries for business owners. Use ONLY the numbers given. Return JSON: {"headline":"","summary":"3-5 sentences","wins":[""],"concerns":[""],"nextSteps":[""]}. Language: ${LANG[req.body.language] || "English"}.`,
    `${ctx.text}\nREPORT ${from}..${to}: ${JSON.stringify({ ...r, posts: undefined, topPosts: r.topPosts.slice(0, 5) })}`, { temperature: 0.4 });
  res.json({ success: true, summary: data });
}));

/* =====================================================
   COMPETITOR & MARKET INTELLIGENCE (1.12) - public data only
   ===================================================== */
const OFFER_RE = /(\d+\s?%|ছাড়|অফার|ডিসকাউন্ট|discount|off\b|sale|free delivery|ফ্রি ডেলিভারি|buy\s?1|bogo|cashback|ক্যাশব্যাক|combo|কম্বো|promo|coupon)/i;

async function snapshotCompetitor(org, c) {
  if (!c.igUsername) throw fail(400, "Add the competitor's Instagram username (business/creator account) to fetch public data");
  const ig = await SocialAccount.findOne({ organizationId: org, platform: "Instagram" }).select("+accessToken");
  if (!ig) throw fail(400, "Connect your own Instagram professional account first (needed for Business Discovery)");
  const u = c.igUsername.replace(/^@/, "").trim();
  const r = await graph(`/${ig.accountId}`, { token: tok(ig), params: { fields: `business_discovery.username(${u}){username,name,followers_count,media_count,media.limit(30){caption,like_count,comments_count,timestamp,permalink,media_type}}` } });
  const bd = r.business_discovery || {};
  const posts = (bd.media?.data || []).map((p) => ({ caption: p.caption || "", like_count: p.like_count || 0, comments_count: p.comments_count || 0, timestamp: p.timestamp, permalink: p.permalink, media_type: p.media_type }));
  const last28 = posts.filter((p) => new Date(p.timestamp) > new Date(Date.now() - 28 * DAY));
  const avgEngagement = posts.length ? Math.round(posts.reduce((t, p) => t + p.like_count + p.comments_count, 0) / posts.length) : 0;
  const offers = posts.filter((p) => OFFER_RE.test(p.caption)).slice(0, 10).map((p) => `${ymd(p.timestamp)}: ${p.caption.slice(0, 160)}`);
  const byType = posts.reduce((a, p) => ({ ...a, [p.media_type]: (a[p.media_type] || 0) + 1 }), {});
  const snap = await CompetitorSnapshot.create({ organizationId: org, competitorId: c.id, followers: bd.followers_count, mediaCount: bd.media_count, postsPerWeek: round(last28.length / 4, 1), avgEngagement, offers, posts });
  c.latest = { followers: bd.followers_count, mediaCount: bd.media_count, postsPerWeek: snap.postsPerWeek, avgEngagement, engagementRate: bd.followers_count ? round((avgEngagement / bd.followers_count) * 100) : null, offers, byType, posts: posts.slice(0, 12) };
  c.lastSnapshotAt = new Date();
  await c.save();
  return c;
}

app.get("/api/competitors", wrap(async (req, res) => res.json(await Competitor.find({ organizationId: tid(req) }).sort({ name: 1 }))));
app.post("/api/competitors", wrap(async (req, res) => {
  const d = pick(req.body, ["name", "igUsername", "facebookUrl", "website", "brandId"]);
  if (!d.name) throw fail(400, "Competitor name is required");
  res.json({ success: true, competitor: await Competitor.create({ ...d, organizationId: tid(req) }) });
}));
app.put("/api/competitors/:id", wrap(async (req, res) => {
  const c = await Competitor.findOneAndUpdate({ _id: req.params.id, organizationId: tid(req) }, pick(req.body, ["name", "igUsername", "facebookUrl", "website"]), { new: true });
  if (!c) throw fail(404, "Competitor not found");
  res.json({ success: true, competitor: c });
}));
app.delete("/api/competitors/:id", wrap(async (req, res) => {
  await Competitor.deleteOne({ _id: req.params.id, organizationId: tid(req) });
  await CompetitorSnapshot.deleteMany({ organizationId: tid(req), competitorId: req.params.id });
  res.json({ success: true });
}));
app.post("/api/competitors/:id/snapshot", wrap(async (req, res) => {
  const c = await Competitor.findOne({ _id: req.params.id, organizationId: tid(req) });
  if (!c) throw fail(404, "Competitor not found");
  res.json({ success: true, competitor: await snapshotCompetitor(tid(req), c) });
}));
app.get("/api/competitors/:id/snapshots", wrap(async (req, res) => res.json(await CompetitorSnapshot.find({ organizationId: tid(req), competitorId: req.params.id }).select("-posts").sort({ createdAt: 1 }).limit(120))));
// Manual observations (offers seen, posts, notes) for anything the API can't read
app.post("/api/competitors/:id/notes", wrap(async (req, res) => {
  if (!req.body.text) throw fail(400, "Note text is required");
  const c = await Competitor.findOneAndUpdate({ _id: req.params.id, organizationId: tid(req) }, { $push: { notes: { type: req.body.type || "note", text: req.body.text } } }, { new: true });
  if (!c) throw fail(404, "Competitor not found");
  res.json({ success: true, competitor: c });
}));
app.post("/api/competitors/ai-summary", wrap(async (req, res) => {
  const org = tid(req);
  const comps = await Competitor.find({ organizationId: org }).lean();
  if (!comps.length) throw fail(400, "Add competitors to the watchlist first");
  const ctx = await brandContext(org, req.body.brandId, { products: false });
  const own = await performanceDigest(org, req.body.brandId, 5);
  const data = await aiJSON(org, "competitor_summary",
    `You are a competitive intelligence analyst. Use ONLY the public data and notes given. Return JSON: {"summary":"","competitors":[{"name":"","strategy":"","contentMix":"","postingFrequency":"","engagement":"","offers":"","strengths":[""],"weaknesses":[""]}],"marketTrends":[""],"opportunities":[{"opportunity":"","why":"","action":""}],"threats":[""]}`,
    `${ctx.text}\nOUR TOP POSTS: ${JSON.stringify(own.top)}\nCOMPETITORS: ${JSON.stringify(comps.map((c) => ({ name: c.name, latest: c.latest ? { ...c.latest, posts: (c.latest.posts || []).slice(0, 10).map((p) => ({ caption: p.caption.slice(0, 220), likes: p.like_count, comments: p.comments_count, type: p.media_type, date: p.timestamp })) } : null, notes: (c.notes || []).slice(-15) })))}`,
    { maxTokens: 3000, temperature: 0.4 });
  const plan = await savePlan(org, { brandId: req.body.brandId || null, kind: "research", title: `Competitor strategy summary ${ymd(new Date())}`, input: { kind: "competitor_summary" }, data });
  res.json({ success: true, plan });
}));

/* =====================================================
   MARKETING SETTINGS + NOTIFICATIONS
   ===================================================== */
app.get("/api/marketing/settings", wrap(async (req, res) => res.json(await getSettings(tid(req)))));
app.put("/api/marketing/settings", wrap(async (req, res) => {
  const b = pick(req.body, ["requireApproval", "creativeApproval", "optimizationMode", "maxBudgetDeltaPct", "maxDailyBudget", "guardrailAllowlist", "salesTeam", "leadCategories", "timezone"]);
  if (b.optimizationMode && !["recommend", "approval", "guardrailed"].includes(b.optimizationMode)) throw fail(400, "Unknown optimization mode");
  if ("guardrailAllowlist" in b) b.guardrailAllowlist = lines(b.guardrailAllowlist);
  if ("leadCategories" in b) b.leadCategories = linesNL(b.leadCategories);
  if ("salesTeam" in b && !Array.isArray(b.salesTeam)) b.salesTeam = lines(String(b.salesTeam).replace(/,/g, "\n")).map((l) => { const m = l.match(/^(.*?)\s*<(.+)>$/); return m ? { name: m[1].trim(), email: m[2].trim(), active: true } : { name: l, email: "", active: true }; });
  if ("maxBudgetDeltaPct" in b) b.maxBudgetDeltaPct = Math.max(1, Math.min(100, Number(b.maxBudgetDeltaPct) || 20));
  const set = Object.fromEntries(Object.entries(b).map(([k, v]) => [`marketingSettings.${k}`, v]));
  await Organization.updateOne({ _id: tid(req) }, { $set: set }, { upsert: true });
  res.json({ success: true, settings: await getSettings(tid(req)) });
}));

app.get("/api/notifications", wrap(async (req, res) => {
  const org = tid(req);
  const [rows, unread] = await Promise.all([Notification.find({ organizationId: org }).sort({ createdAt: -1 }).limit(50), Notification.countDocuments({ organizationId: org, read: false })]);
  res.json({ unread, rows });
}));
app.put("/api/notifications/read-all", wrap(async (req, res) => { await Notification.updateMany({ organizationId: tid(req), read: false }, { read: true }); res.json({ success: true }); }));
app.put("/api/notifications/:id/read", wrap(async (req, res) => { await Notification.updateOne({ _id: req.params.id, organizationId: tid(req) }, { read: true }); res.json({ success: true }); }));


/* =====================================================
   CUSTOMER INBOX + AI SALES AGENT (2.1, 2.3, 2.4, 2.5, 2.14)
   Messenger / Instagram DMs / post comments -> AI reply -> order draft -> confirm -> COD order
   ===================================================== */
const WINDOW_MS = 24 * 3600e3; // Meta standard messaging window
const isSim = (c) => String(c.psid).startsWith("sim_");
const windowOpen = (c) => isSim(c) || (!!c.lastCustomerAt && Date.now() - new Date(c.lastCustomerAt).getTime() < WINDOW_MS);
const CONFIRM_RE = /^\s*(confirm(ed)?|yes|yeah|yep|ok(ay)?|done|sure|place (the )?order|হ্যাঁ|হ্যা|হা|জি|জ্বি|ঠিক আছে|কনফার্ম|ওকে|ji|hae|ha)\s*[.!✅👍]*\s*$/i;
const HANDOFF_RE = /(human|real person|agent|manush|মানুষ|কারো সাথে কথা|complain|অভিযোগ|refund|রিফান্ড|ফেরত দিতে|damaged|broken|নষ্ট|ভাঙা|fraud|প্রতারণা|scam)/i;
const DEFAULT_AGENT = { enabled: true, autoConfirm: true, tone: "friendly", escalateBelow: 60, deliveryInside: 80, deliveryOutside: 130, deliveryTime: "24-48 hours inside Dhaka, 3-5 days outside", handoffMessage: "Thanks! I'm connecting you with our team. They'll reply shortly 🙏", commentAutoReply: true, commentPrivateReply: "Hi {name}! 👋 Thanks for your comment on our post. Tell me which product, size/colour and quantity you'd like and I'll get your order ready right here.", commentPublicReply: "", knowledge: "", paymentNote: "" };
const tk = (n) => "৳" + Number(n || 0).toLocaleString("en-IN");

async function agentConfig(org) {
  const c = await AgentConfig.findOneAndUpdate({ organizationId: org }, { $setOnInsert: {} }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
  return { ...DEFAULT_AGENT, ...Object.fromEntries(Object.entries(c || {}).filter(([, v]) => v !== undefined && v !== null)) };
}

// Messages for the same customer are processed one at a time
const CONV_LOCKS = new Map();
function withLock(key, fn) {
  const prev = CONV_LOCKS.get(key) || Promise.resolve();
  const next = prev.catch(() => { }).then(fn);
  CONV_LOCKS.set(key, next);
  next.finally(() => { if (CONV_LOCKS.get(key) === next) CONV_LOCKS.delete(key); }).catch(() => { });
  return next;
}

function pushMsg(c, from, text, extra = {}) {
  c.messages.push({ from, text: String(text || "").slice(0, 4000) || "(empty)", ...extra });
  if (c.messages.length > 400) c.messages.splice(0, c.messages.length - 400);
  if (from !== "system") c.lastMessage = String(text || "").slice(0, 200);
  return c.messages[c.messages.length - 1];
}

async function pageForConv(org, c) {
  return SocialAccount.findOne({ organizationId: org, platform: "Facebook", ...(c.pageId ? { accountId: c.pageId } : {}) }).select("+accessToken");
}

// Sends through the Page (works for Messenger and Instagram DMs linked to the Page)
async function sendToCustomer(org, c, text, { quickReplies = [], commentId } = {}) {
  if (isSim(c)) return { simulated: true };
  const page = await pageForConv(org, c);
  if (!page) {
    if (process.env.N8N_REPLY_URL) { // legacy n8n sender
      const r = await fetch(N8N_REPLY, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ psid: c.psid, text }) });
      if (!r.ok) throw fail(502, "n8n reply webhook failed");
      return { via: "n8n" };
    }
    throw fail(400, "Facebook Page is not connected");
  }
  if (!commentId && !windowOpen(c)) throw fail(400, "Messenger 24-hour window is closed. The customer must message first.");
  const message = { text: String(text).slice(0, 2000) };
  if (quickReplies.length) message.quick_replies = quickReplies.slice(0, 13).map((q) => ({ content_type: "text", title: String(q.title).slice(0, 20), payload: q.payload || q.title }));
  const body = commentId ? { recipient: { comment_id: commentId }, message } : { recipient: { id: c.psid }, messaging_type: "RESPONSE", message };
  return graph(`/${page.accountId}/messages`, { token: tok(page), method: "POST", body });
}

// AI/system reply: store it, then try to deliver it
async function say(org, c, text, opts = {}) {
  const m = pushMsg(c, "ai", text, { quickReplies: opts.quickReplies?.map((q) => q.title), privateReply: opts.commentId ? true : undefined });
  try { const r = await sendToCustomer(org, c, text, opts); if (r?.message_id) m.mid = r.message_id; }
  catch (e) { m.error = e.message; console.warn("send failed:", e.message); }
  c.aiHandled = (c.aiHandled || 0) + 1;
  return m;
}

/* ---------- knowledge + agent ---------- */
async function agentKnowledge(org, text, draft) {
  const cfg = await agentConfig(org);
  const ctx = await brandContext(org, null, { products: false });
  const all = await Product.find({ organizationId: org }).lean();
  const words = String(text || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);
  const inDraft = new Set((draft?.items || []).map((i) => String(i.productId)));
  const scored = all.map((p) => ({ p, s: words.reduce((t, w) => t + (`${p.name} ${p.category} ${p.sku}`.toLowerCase().includes(w) ? 1 : 0), 0) + (inDraft.has(String(p._id)) ? 100 : 0) }));
  const picked = scored.sort((a, b) => b.s - a.s).slice(0, 40).map((x) => x.p);
  const text2 = [
    ctx.text,
    `DELIVERY: inside Dhaka ${tk(cfg.deliveryInside)}, outside Dhaka ${tk(cfg.deliveryOutside)}. Delivery time: ${cfg.deliveryTime}. Payment: cash on delivery (COD).${cfg.paymentNote ? " " + cfg.paymentNote : ""}`,
    cfg.knowledge ? `BUSINESS INFO / POLICIES / FAQ (approved):\n${cfg.knowledge}` : "",
    `PRODUCTS (id | name | price | stock | category):\n${picked.map((p) => `${p._id} | ${p.name} | ${tk(p.price)} | ${p.stock > 0 ? p.stock + " in stock" : "OUT OF STOCK"} | ${p.category}`).join("\n") || "(no products in the catalogue)"}`,
  ].filter(Boolean).join("\n");
  return { cfg, text: text2, products: all };
}

const AGENT_SHAPE = `{"reply":"","intent":"question|order|confirm|change|handoff|smalltalk|other","confidence":0,"needsHuman":false,"handoffReason":"","draft":{"items":[{"productId":"","name":"","variant":"","qty":1}],"name":"","phone":"","address":"","area":"inside|outside|"},"readyToConfirm":false}`;

async function runAgent(org, c, latestText) {
  const recent = (c.messages || []).filter((m) => m.from === "customer").slice(-6).map((m) => m.text).join(" ");
  const k = await agentKnowledge(org, `${recent} ${latestText}`, c.orderDraft);
  const history = (c.messages || []).slice(-16).filter((m) => m.from !== "system").map((m) => `${m.from === "customer" ? "CUSTOMER" : m.from === "agent" ? "HUMAN AGENT" : "YOU"}: ${m.text}`).join("\n");
  const d = c.orderDraft || {};
  const out = await aiJSON(org, "inbox_agent",
    `You are the AI sales assistant of this business, chatting with customers on Facebook Messenger / Instagram in Bangladesh.
Reply in the customer's language and script (Bangla, Banglish or English). Keep it short and warm (max 3-4 short lines). Tone: ${k.cfg.tone}.
RULES
- Use ONLY the business info and PRODUCTS given. Never invent prices, stock, discounts, delivery times or policies. If the answer is not there, say you'll check with the team and set needsHuman=true.
- To take an order collect: product(s) from PRODUCTS (use the exact productId), size/colour when relevant, quantity, customer name, phone (Bangladesh format 01XXXXXXXXX), full delivery address, and whether it is inside or outside Dhaka.
- Ask only for what is still missing, one or two things at a time. Don't repeat questions already answered.
- If a product is OUT OF STOCK say so and suggest an in-stock alternative from PRODUCTS.
- When everything is collected set readyToConfirm=true. The system then sends the order summary with Confirm/Change buttons, so your reply should be just a short lead-in like "Here's your order summary 👇".
- Never say the order is placed or confirmed. The system does that after the customer confirms.
- Set needsHuman=true for complaints, refunds, damaged items, angry customers, a request for a human, bulk/wholesale negotiation, or anything you are unsure about.
- "draft" must contain the FULL current draft (keep known values, add new info). Leave unknown fields empty.
- confidence = how sure you are that your reply is correct and grounded (0-100).
Return JSON only: ${AGENT_SHAPE}`,
    `${k.text}\n\n${d.status === "placed" ? `PREVIOUS ORDER #${d.orderNo || ""} IS ALREADY PLACED. Only add items if the customer wants a NEW order.\n` : ""}CURRENT ORDER DRAFT: ${JSON.stringify({ items: d.status === "placed" ? [] : (d.items || []).map((i) => ({ productId: i.productId, name: i.name, variant: i.variant, qty: i.qty })), name: d.name || "", phone: d.phone || "", address: d.address || "", area: d.area || "", status: d.status === "placed" ? "new" : d.status || "collecting" })}\n\nCONVERSATION SO FAR:\n${history || "(new conversation)"}\n\nCUSTOMER (latest message): ${latestText}`,
    { temperature: 0.3, maxTokens: 900 });
  return { out, k };
}

function mergeDraft(c, out, products) {
  const d = { items: [], status: "collecting", ...(c.orderDraft || {}) };
  const x = out?.draft || {};
  for (const f of ["name", "address"]) if (x[f] && String(x[f]).trim().length > 1) d[f] = String(x[f]).trim().slice(0, 300);
  if (x.phone) { const p = normPhone(x.phone); if (p && p.length >= 11) d.phone = p; }
  if (["inside", "outside"].includes(x.area)) d.area = x.area;
  if (Array.isArray(x.items) && x.items.length) {
    const items = x.items.map((i) => {
      const p = products.find((pp) => String(pp._id) === String(i.productId)) || products.find((pp) => pp.name.toLowerCase() === String(i.name || "").toLowerCase());
      return p ? { productId: String(p._id), name: p.name, variant: String(i.variant || "").slice(0, 80), qty: Math.max(1, Math.min(99, parseInt(i.qty, 10) || 1)), price: p.price, stock: p.stock } : null; // price always from the database
    }).filter(Boolean);
    if (items.length) d.items = items;
  }
  c.orderDraft = d;
  c.markModified("orderDraft");
  return d;
}
function draftTotals(d, cfg) {
  const subtotal = (d.items || []).reduce((s, i) => s + i.price * i.qty, 0);
  const fee = d.area === "outside" ? cfg.deliveryOutside : cfg.deliveryInside;
  return { subtotal, fee, total: subtotal + fee };
}
function draftMissing(d) {
  const m = [];
  if (!d.items?.length) m.push("product");
  if (!d.name) m.push("name");
  if (!/^01[3-9]\d{8}$/.test(d.phone || "")) m.push("phone");
  if (!d.address || d.address.length < 6) m.push("address");
  if (!d.area) m.push("inside/outside Dhaka");
  const oos = (d.items || []).filter((i) => (i.stock ?? 0) < i.qty);
  if (oos.length) m.push(`stock for ${oos.map((i) => i.name).join(", ")}`);
  return m;
}
function summaryText(d, cfg) {
  const t = draftTotals(d, cfg);
  return [
    "🧾 Order summary",
    ...d.items.map((i) => `• ${i.name}${i.variant ? ` (${i.variant})` : ""} × ${i.qty} = ${tk(i.price * i.qty)}`),
    "",
    `Subtotal: ${tk(t.subtotal)}`,
    `Delivery fee (${d.area === "outside" ? "Outside Dhaka" : "Inside Dhaka"}): ${tk(t.fee)}`,
    `Total payable on delivery (COD): ${tk(t.total)}`,
    "",
    `👤 Name: ${d.name}`, `📞 Phone: ${d.phone}`, `📍 Address: ${d.address}`,
    "",
    'Is everything correct? Type "Confirm" or "Yes" to place the order.',
  ].join("\n");
}
const CONFIRM_BUTTONS = [{ title: "✅ Confirm", payload: "CONFIRM_ORDER" }, { title: "✏️ Change", payload: "CHANGE_ORDER" }];

async function handoff(org, c, reason, message) {
  c.aiPaused = true;
  c.status = "needs_review";
  c.handoffReason = reason;
  pushMsg(c, "system", `Handed to a human: ${reason}`);
  if (message) await say(org, c, message);
  await notify(org, "inbox", `${c.customerName} needs a human`, reason, "inbox");
}

async function ensureLead(org, c, text) {
  if (c.leadId) return;
  const ig = c.channel === "Instagram";
  const r = await ingestLead(org, { name: c.customerName, message: text, source: isSim(c) ? "manual" : ig ? "instagram_dm" : "messenger", externalId: `${ig ? "ig" : "fb"}:${c.psid}`, pageId: c.pageId }, { skipAi: true, quiet: true }).catch((e) => { console.warn("lead:", e.message); return null; });
  if (r?.lead) c.leadId = r.lead.id;
}

async function placeOrderFromDraft(org, c, cfg, by = "AI") {
  const d = c.orderDraft || {};
  const miss = draftMissing(d);
  if (miss.length) throw fail(400, "Order draft is missing: " + miss.join(", "));
  const t = draftTotals(d, cfg);
  const order = await createOrder(org, {
    customerName: d.name, phone: d.phone, address: `${d.address}${d.area === "outside" ? " (outside Dhaka)" : " (inside Dhaka)"}`,
    items: d.items.map((i) => ({ productId: i.productId, name: i.variant ? `${i.name} (${i.variant})` : i.name, qty: i.qty, price: i.price })),
    total: t.total, deliveryFee: t.fee, paymentMethod: "COD", isAI: by === "AI",
    channel: c.source?.type === "comment" ? "Facebook Comment" : c.channel === "Instagram" ? "Instagram AI" : "Messenger AI",
    status: cfg.autoConfirm ? "confirmed" : "pending", conversationId: c.id, psid: c.psid,
    attribution: { source: c.channel === "Instagram" ? "instagram" : "facebook", medium: c.source?.type || "messenger", content: c.source?.postId || null, leadId: c.leadId || null },
  });
  d.status = "placed";
  d.orderId = order.id;
  d.orderNo = order.orderNo;
  c.orderDraft = d; c.markModified("orderDraft");
  c.orderId = order.id; c.orderNo = order.orderNo;
  pushMsg(c, "system", `Order #${order.orderNo} created by ${by} · ${tk(t.total)} COD${order.status === "on_hold" ? " · ON HOLD (risk " + order.riskScore + ")" : ""}`);
  if (c.leadId) await Lead.updateOne({ _id: c.leadId, organizationId: org }, { stage: "won", convertedAt: new Date(), value: t.total, orderId: order.id, phone: d.phone, name: d.name });
  if (order.status === "on_hold") {
    c.status = "needs_review";
    await notify(org, "inbox", `Order #${order.orderNo} on hold`, `Risk ${order.riskScore}: ${(order.riskReasons || []).join(", ")}`, "fraud");
  }
  return { order, totals: t };
}

function orderPlacedText(order, t, cfg) {
  if (order.status === "on_hold") return `✅ We've received your order #${order.orderNo} (${tk(t.total)}). Our team will call you to verify it before dispatch. Thank you 🙏`;
  if (order.status === "pending") return `✅ Your order #${order.orderNo} (${tk(t.total)}, cash on delivery) is received. Our team will call you to confirm shortly. Thank you 🙏`;
  return `✅ Your order #${order.orderNo} has been placed! Total ${tk(t.total)}, pay cash on delivery. Expected delivery: ${cfg.deliveryTime}. Thank you for shopping with us 🙏`;
}

// Core brain: called after the customer's message has been pushed to c.messages
async function processCustomerMessage(org, c, text, payload) {
  try {
    const cfg = await agentConfig(org);
    c.lastCustomerAt = new Date();
    c.unread = (c.unread || 0) + 1;
    if (c.status === "closed") c.status = "open";
    if (!cfg.enabled || c.aiPaused) return;
    const d = c.orderDraft || { items: [], status: "collecting" };

    // Confirmation and change are deterministic: the AI never places orders by itself
    const plain = String(text || "").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
    if (d.status === "awaiting_confirm" && (payload === "CONFIRM_ORDER" || CONFIRM_RE.test(text) || CONFIRM_RE.test(plain))) {
      try {
        const { order, totals } = await placeOrderFromDraft(org, c, cfg, "AI");
        await say(org, c, orderPlacedText(order, totals, cfg));
      } catch (e) { await handoff(org, c, `Couldn't place order: ${e.message}`, "Sorry, I couldn't place the order automatically. Our team will finish it for you shortly 🙏"); }
      return;
    }
    if (d.status === "awaiting_confirm" && (payload === "CHANGE_ORDER" || /^(change|edit|বদল|পরিবর্তন)/i.test(plain))) {
      c.orderDraft = { ...d, status: "collecting" }; c.markModified("orderDraft");
      await say(org, c, "No problem! What would you like to change? Product, size, quantity, name, phone or address?");
      return;
    }
    if (HANDOFF_RE.test(text)) return handoff(org, c, `Customer said: "${text.slice(0, 80)}"`, cfg.handoffMessage);
    if (!aiConfigured()) return handoff(org, c, "AI is not configured", cfg.handoffMessage);

    let res;
    try { res = await runAgent(org, c, text); }
    catch (e) { return handoff(org, c, `AI error: ${e.message}`, cfg.handoffMessage); }
    const { out, k } = res;
    if (d.status === "awaiting_confirm" && out.intent === "confirm" && !draftMissing(d).length) {
      try {
        const { order, totals } = await placeOrderFromDraft(org, c, cfg, "AI");
        await say(org, c, orderPlacedText(order, totals, cfg));
      } catch (e) { await handoff(org, c, `Couldn't place order: ${e.message}`, "Sorry, I couldn't place the order automatically. Our team will finish it for you shortly 🙏"); }
      return;
    }
    if (d.status === "placed" && ["order", "question"].includes(out.intent) && out.draft?.items?.length) {
      c.orderDraft = { name: d.name, phone: d.phone, address: d.address, area: d.area, items: [], status: "collecting" }; // new order
    } else if (d.status === "awaiting_confirm") c.orderDraft = { ...d, status: "collecting" }; // customer is still editing
    const nd = mergeDraft(c, out, k.products);
    if (out.needsHuman || (Number(out.confidence) || 0) < cfg.escalateBelow) {
      return handoff(org, c, out.handoffReason || `Low AI confidence (${out.confidence ?? 0}%)`, out.reply || cfg.handoffMessage);
    }
    if (out.readyToConfirm && nd.status !== "placed") {
      const miss = draftMissing(nd);
      if (!miss.length) {
        c.orderDraft = { ...nd, status: "awaiting_confirm" }; c.markModified("orderDraft");
        if (out.reply) await say(org, c, out.reply);
        await say(org, c, summaryText(nd, cfg), { quickReplies: CONFIRM_BUTTONS });
        return;
      }
      if (miss.some((m) => m.startsWith("stock"))) { await say(org, c, `Sorry, we don't have enough ${miss.find((m) => m.startsWith("stock")).replace("stock for ", "")} in stock right now. Would you like another option?`); return; }
    }
    await say(org, c, out.reply || cfg.handoffMessage);
  } finally {
    await c.save();
  }
}

/* ---------- Meta webhooks: Messenger, Instagram DMs, comments, lead ads ---------- */
async function profileOf(org, page, id, ig) {
  try {
    const p = await graph(`/${id}`, { token: tok(page), params: { fields: ig ? "name,username,profile_pic" : "first_name,last_name,profile_pic" } });
    return { name: ig ? p.name || (p.username ? "@" + p.username : null) : [p.first_name, p.last_name].filter(Boolean).join(" ") || null, avatar: p.profile_pic || null };
  } catch { return { name: null, avatar: null }; }
}

async function handleMessaging(page, ev, { channel = "Messenger", pageId }) {
  const org = page.organizationId;
  const msg = ev.message, pb = ev.postback;
  if (msg?.is_echo) {
    if (FB_APP_ID && String(msg.app_id || "") === String(FB_APP_ID)) return; // our own send
    // A person replied from Meta Business Suite: record it and pause the AI
    const psid = String(ev.recipient?.id);
    await withLock(`${org}:${psid}`, async () => {
      const c = await Conversation.findOne({ organizationId: org, psid });
      if (!c || (msg.mid && c.messages.some((m) => m.mid === msg.mid))) return;
      pushMsg(c, "agent", msg.text || "[attachment]", { mid: msg.mid, by: "Business Suite" });
      c.aiPaused = true;
      await c.save();
    });
    return;
  }
  const psid = String(ev.sender?.id || "");
  if (!psid || psid === String(pageId)) return;
  const text = msg?.text || pb?.title || (msg?.attachments?.length ? `[${msg.attachments.map((a) => a.type).join(", ")}]` : "");
  if (!text) return;
  const payload = msg?.quick_reply?.payload || pb?.payload || null;
  const mid = msg?.mid || `pb:${ev.timestamp}:${psid}`;
  try { await WebhookEvent.create({ provider: "meta", externalEventId: `msg:${mid}`, tenantId: org, processingStatus: "processed" }); }
  catch (e) { if (e.code === 11000) return; throw e; }
  await withLock(`${org}:${psid}`, async () => {
    let c = await Conversation.findOne({ organizationId: org, psid });
    if (!c) {
      const prof = await profileOf(org, page, psid, channel === "Instagram");
      c = new Conversation({ organizationId: org, psid, channel, pageId: page.accountId, customerName: prof.name || "Customer", avatar: prof.avatar });
    }
    pushMsg(c, "customer", text, { mid });
    await ensureLead(org, c, text);
    await processCustomerMessage(org, c, text, payload);
  });
}

async function handleComment(page, v) {
  if (v.item !== "comment" || v.verb !== "add" || !v.message) return;
  if (String(v.from?.id) === String(page.accountId)) return; // our own comment
  if (v.parent_id && v.post_id && v.parent_id !== v.post_id) return; // only top-level comments
  const org = page.organizationId;
  const cfg = await agentConfig(org);
  if (!cfg.enabled || !cfg.commentAutoReply) return;
  try { await WebhookEvent.create({ provider: "meta", externalEventId: `comment:${v.comment_id}`, tenantId: org, processingStatus: "processed" }); }
  catch (e) { if (e.code === 11000) return; throw e; }
  const first = String(v.from?.name || "").split(" ")[0] || "there";
  let text = cfg.commentPrivateReply.replace(/\{name\}/g, first), draftOut = null;
  if (aiConfigured()) {
    try {
      const { out } = await runAgent(org, { messages: [], orderDraft: { items: [], status: "collecting" } }, `(Public comment on our post) ${v.message}`);
      if (!out.needsHuman && (Number(out.confidence) || 0) >= cfg.escalateBelow && out.reply) { text = `Hi ${first}! 👋 ${out.reply}`; draftOut = out; }
    } catch (e) { console.warn("comment AI:", e.message); }
  }
  let sent;
  try { sent = await graph(`/${page.accountId}/messages`, { token: tok(page), method: "POST", body: { recipient: { comment_id: v.comment_id }, message: { text: text.slice(0, 2000) } } }); }
  catch (e) { await notify(org, "inbox", "Couldn't private-reply to a comment", `${v.from?.name}: ${e.message}`, "inbox"); return; }
  if (cfg.commentPublicReply) graph(`/${v.comment_id}/comments`, { token: tok(page), method: "POST", body: { message: cfg.commentPublicReply } }).catch((e) => console.warn("public reply:", e.message));
  const psid = String(sent.recipient_id || `comment_${v.comment_id}`);
  await withLock(`${org}:${psid}`, async () => {
    let c = await Conversation.findOne({ organizationId: org, psid });
    if (!c) c = new Conversation({ organizationId: org, psid, channel: "Messenger", pageId: page.accountId, customerName: v.from?.name || "Customer" });
    c.source = { type: "comment", commentId: v.comment_id, postId: v.post_id, text: v.message };
    c.markModified("source");
    pushMsg(c, "customer", v.message, { fromComment: true });
    pushMsg(c, "ai", text, { privateReply: true, mid: sent.message_id });
    c.aiHandled = (c.aiHandled || 0) + 1;
    if (draftOut) mergeDraft(c, draftOut, await Product.find({ organizationId: org }).lean());
    c.unread = (c.unread || 0) + 1;
    await ensureLead(org, c, v.message);
    await c.save();
  });
}

async function handleMetaWebhook(body) {
  for (const entry of body.entry || []) {
    if (body.object === "page") {
      const page = await SocialAccount.findOne({ platform: "Facebook", accountId: String(entry.id) }).select("+accessToken");
      for (const ev of entry.messaging || []) {
        if (!page) break;
        await handleMessaging(page, ev, { channel: "Messenger", pageId: page.accountId }).catch((e) => console.error("messaging:", e));
      }
      for (const ch of entry.changes || []) {
        if (ch.field === "feed" && page) await handleComment(page, ch.value || {}).catch((e) => console.error("comment:", e));
        if (ch.field !== "leadgen") continue;
        const v = ch.value || {};
        const a = page || await SocialAccount.findOne({ platform: "Facebook", accountId: String(v.page_id) }).select("+accessToken");
        if (!a) { console.warn("leadgen for unknown page", v.page_id); continue; }
        const org = a.organizationId;
        try { await WebhookEvent.create({ provider: "meta", externalEventId: `leadgen:${v.leadgen_id}`, tenantId: org, processingStatus: "processing" }); }
        catch (e) { if (e.code === 11000) continue; throw e; }
        try {
          const raw = await graph(`/${v.leadgen_id}`, { token: tok(a), params: { fields: "id,created_time,field_data,ad_id,adset_id,campaign_id,campaign_name,form_id" } });
          await leadFromMeta(org, a, raw, { formId: v.form_id });
          await WebhookEvent.updateOne({ externalEventId: `leadgen:${v.leadgen_id}` }, { processingStatus: "processed" });
        } catch (e) {
          await WebhookEvent.updateOne({ externalEventId: `leadgen:${v.leadgen_id}` }, { processingStatus: "failed" });
          await notify(org, "lead", "Couldn't fetch a Facebook lead", e.message, "leads");
        }
      }
    }
    if (body.object === "instagram") {
      const ig = await SocialAccount.findOne({ platform: "Instagram", accountId: String(entry.id) });
      if (!ig) continue;
      const page = await SocialAccount.findOne({ organizationId: ig.organizationId, platform: "Facebook", accountId: ig.pageId }).select("+accessToken");
      if (!page) continue;
      for (const ev of entry.messaging || []) await handleMessaging(page, ev, { channel: "Instagram", pageId: ig.accountId }).catch((e) => console.error("ig messaging:", e));
    }
  }
}

/* ---------- inbox API ---------- */
const convRow = (c) => ({
  id: String(c._id), customer: c.customerName, avatar: c.avatar, channel: c.channel, last: c.lastMessage, status: c.status, unread: c.unread,
  time: c.updatedAt, aiPaused: !!c.aiPaused, orderNo: c.orderNo, leadId: c.leadId, windowOpen: windowOpen(c), source: c.source?.type || null,
  draftStatus: c.orderDraft?.status || null, simulated: isSim(c),
});

app.get("/api/inbox/stats", wrap(async (req, res) => {
  const org = tid(req);
  const [agg] = await Conversation.aggregate([{ $match: { organizationId: org } }, { $group: { _id: null, handled: { $sum: { $ifNull: ["$aiHandled", 0] } }, open: { $sum: { $cond: [{ $ne: ["$status", "closed"] }, 1, 0] } }, human: { $sum: { $cond: [{ $eq: ["$status", "needs_review"] }, 1, 0] } }, bot: { $sum: { $cond: [{ $and: [{ $ne: ["$status", "closed"] }, { $ne: ["$aiPaused", true] }] }, 1, 0] } } } }]);
  const cfg = await agentConfig(org);
  res.json({ handledByAi: agg?.handled || 0, open: agg?.open || 0, needsHuman: agg?.human || 0, botActive: agg?.bot || 0, aiEnabled: cfg.enabled, aiConfigured: aiConfigured() });
}));

app.get("/api/conversations", wrap(async (req, res) => {
  const q = { organizationId: tid(req) };
  const tab = req.query.tab || "";
  if (tab === "human") q.status = "needs_review";
  else if (tab === "bot") { q.status = { $ne: "closed" }; q.aiPaused = { $ne: true }; }
  else if (tab === "closed") q.status = "closed";
  else if (tab === "open" || tab === "all") q.status = { $ne: "closed" };
  if (req.query.status) q.status = req.query.status;
  if (req.query.q) { const re = new RegExp(escRe(req.query.q), "i"); q.$or = [{ customerName: re }, { lastMessage: re }, { orderNo: re }, { "orderDraft.phone": re }]; }
  const rows = await Conversation.find(q).select("-messages").sort({ updatedAt: -1 }).limit(300);
  res.json(rows.map(convRow));
}));

app.get("/api/conversations/:id", wrap(async (req, res) => {
  const org = tid(req);
  const c = await Conversation.findOneAndUpdate({ _id: req.params.id, organizationId: org }, { unread: 0 }, { new: true });
  if (!c) return res.status(404).json({ error: "Conversation not found" });
  const phone = c.orderDraft?.phone;
  const [orders, page, cfg] = await Promise.all([
    Order.find({ organizationId: org, $or: [{ psid: c.psid }, ...(phone ? [{ phone }] : [])] }).sort({ createdAt: -1 }).limit(10),
    c.pageId ? SocialAccount.findOne({ organizationId: org, platform: "Facebook", accountId: c.pageId }).lean() : null,
    agentConfig(org),
  ]);
  const d = c.orderDraft || { items: [] };
  res.json({ ...c.toJSON(), windowOpen: windowOpen(c), simulated: isSim(c), pageName: page?.accountName || null, orders: orders.map(orderRow), totals: draftTotals(d, cfg), missing: d.status === "placed" ? [] : draftMissing(d), aiEnabled: cfg.enabled });
}));

// Human reply (auto-pauses the AI so the two don't talk over each other; send keepAi:true to keep it on)
app.post("/api/conversations/:id/reply", wrap(async (req, res) => {
  const org = tid(req);
  const text = String(req.body.text || "").trim();
  if (!text) return res.status(400).json({ error: "Reply text is required" });
  await withLock(`${org}:conv:${req.params.id}`, async () => {
    const c = await Conversation.findOne({ _id: req.params.id, organizationId: org });
    if (!c) throw fail(404, "Conversation not found");
    const r = await sendToCustomer(org, c, text);
    pushMsg(c, "agent", text, { by: actor(req), mid: r?.message_id || null });
    if (!req.body.keepAi) c.aiPaused = true;
    if (c.status === "needs_review" || c.status === "closed") c.status = "open";
    await c.save();
  });
  res.json({ success: true });
}));

app.put("/api/conversations/:id", wrap(async (req, res) => {
  const p = pick(req.body, ["status", "customerName"]);
  if (p.status && !["open", "needs_review", "closed"].includes(p.status)) throw fail(400, "Invalid status");
  const c = await Conversation.findOneAndUpdate({ _id: req.params.id, organizationId: tid(req) }, p, { new: true });
  if (!c) return res.status(404).json({ error: "Conversation not found" });
  res.json({ success: true });
}));

// AI auto-pilot on/off for one conversation (human takeover)
app.post("/api/conversations/:id/ai", wrap(async (req, res) => {
  const org = tid(req);
  const c = await Conversation.findOne({ _id: req.params.id, organizationId: org });
  if (!c) throw fail(404, "Conversation not found");
  c.aiPaused = !req.body.enabled;
  pushMsg(c, "system", req.body.enabled ? `AI auto-pilot turned on by ${actor(req)}` : `${actor(req)} took over (AI paused)`);
  if (req.body.enabled && c.status === "needs_review") { c.status = "open"; c.handoffReason = null; }
  await c.save();
  res.json({ success: true });
}));

// Edit the order draft by hand
app.put("/api/conversations/:id/draft", wrap(async (req, res) => {
  const org = tid(req);
  const c = await Conversation.findOne({ _id: req.params.id, organizationId: org });
  if (!c) throw fail(404, "Conversation not found");
  const products = await Product.find({ organizationId: org }).lean();
  const b = req.body;
  const prev = c.orderDraft || {};
  const d = { ...prev, status: prev.status === "placed" ? "collecting" : prev.status || "collecting" };
  for (const f of ["name", "address"]) if (f in b) d[f] = String(b[f] || "").trim();
  if ("phone" in b) d.phone = normPhone(b.phone) || "";
  if ("area" in b) d.area = ["inside", "outside"].includes(b.area) ? b.area : "";
  if (Array.isArray(b.items)) d.items = b.items.map((i) => { const p = products.find((x) => String(x._id) === String(i.productId)); return p ? { productId: String(p._id), name: p.name, variant: String(i.variant || ""), qty: Math.max(1, parseInt(i.qty, 10) || 1), price: p.price, stock: p.stock } : null; }).filter(Boolean);
  if (prev.status === "placed" && !Array.isArray(b.items)) d.items = [];
  c.orderDraft = d; c.markModified("orderDraft");
  await c.save();
  res.json({ success: true });
}));

// Agent places the order from the draft (optionally tells the customer)
app.post("/api/conversations/:id/place-order", wrap(async (req, res) => {
  const org = tid(req);
  let out;
  await withLock(`${org}:conv:${req.params.id}`, async () => {
    const c = await Conversation.findOne({ _id: req.params.id, organizationId: org });
    if (!c) throw fail(404, "Conversation not found");
    const cfg = await agentConfig(org);
    const { order, totals } = await placeOrderFromDraft(org, c, cfg, actor(req));
    if (req.body.notify !== false && windowOpen(c)) {
      const t = orderPlacedText(order, totals, cfg);
      try { await sendToCustomer(org, c, t); pushMsg(c, "agent", t, { by: actor(req) }); } catch (e) { pushMsg(c, "system", `Couldn't message the customer: ${e.message}`); }
    }
    await c.save();
    out = order;
  });
  res.json({ success: true, order: orderRow(out) });
}));

// Agent assist: suggested reply + conversation summary
app.post("/api/conversations/:id/suggest", wrap(async (req, res) => {
  const org = tid(req);
  const c = await Conversation.findOne({ _id: req.params.id, organizationId: org });
  if (!c) throw fail(404, "Conversation not found");
  const k = await agentKnowledge(org, c.messages.slice(-6).map((m) => m.text).join(" "), c.orderDraft);
  const history = c.messages.slice(-20).map((m) => `${m.from.toUpperCase()}: ${m.text}`).join("\n");
  const data = await aiJSON(org, "inbox_suggest",
    `You help a human support agent. Use ONLY the business info. Return JSON: {"summary":"2-3 sentences about what the customer wants and the current status","suggestion":"a reply the agent can send, in the customer's language","nextStep":""}`,
    `${k.text}\n\nORDER DRAFT: ${JSON.stringify(c.orderDraft || {})}\nHANDOFF REASON: ${c.handoffReason || "-"}\n\nCONVERSATION:\n${history}`, { temperature: 0.4, maxTokens: 600 });
  res.json({ success: true, ...data });
}));

app.delete("/api/conversations/:id", wrap(async (req, res) => {
  await Conversation.deleteOne({ _id: req.params.id, organizationId: tid(req) });
  res.json({ success: true });
}));

// Simulator: test the AI agent without Facebook (psid starts with "sim_", nothing is sent to Meta)
app.post("/api/inbox/simulate", wrap(async (req, res) => {
  const org = tid(req);
  const text = String(req.body.text || "").trim();
  if (!text && !req.body.payload) throw fail(400, "Message text is required");
  let id = req.body.conversationId;
  if (!id) {
    const c = await Conversation.create({ organizationId: org, psid: `sim_${crypto.randomBytes(6).toString("hex")}`, channel: "Simulator", customerName: req.body.name || "Test customer", source: req.body.fromComment ? { type: "comment", text } : null });
    id = c.id;
  }
  await withLock(`${org}:conv:${id}`, async () => {
    const c = await Conversation.findOne({ _id: id, organizationId: org });
    if (!c || !isSim(c)) throw fail(404, "Simulator conversation not found");
    const shown = text || (req.body.payload === "CONFIRM_ORDER" ? "✅ Confirm" : "✏️ Change");
    pushMsg(c, "customer", shown, { fromComment: req.body.fromComment || undefined });
    await ensureLead(org, c, shown);
    await processCustomerMessage(org, c, shown, req.body.payload || null);
  });
  res.json({ success: true, conversationId: id });
}));

// Subscribe a Page to messages, comments and lead webhooks
app.post("/api/inbox/subscribe-page", wrap(async (req, res) => {
  const a = await pageAccount(tid(req), req.body.pageId);
  const r = await graph(`/${a.accountId}/subscribed_apps`, { token: tok(a), method: "POST", body: { subscribed_fields: ["messages", "messaging_postbacks", "message_echoes", "feed", "leadgen"] } });
  res.json({ success: !!r.success });
}));

// n8n flow (legacy): store a message that n8n handled
app.post("/api/inbox/inbound", needSecret, wrap(async (req, res) => {
  const { psid, customerName, text, channel, needsReview, aiReply } = req.body;
  if (!psid || !text) return res.status(400).json({ error: "psid and text are required" });
  const org = tid(req);
  let c = await Conversation.findOne({ organizationId: org, psid });
  if (!c) c = new Conversation({ organizationId: org, psid, customerName: customerName || "Customer", channel: channel || "Messenger" });
  pushMsg(c, "customer", text);
  if (aiReply) { pushMsg(c, "ai", aiReply); c.aiHandled = (c.aiHandled || 0) + 1; }
  c.lastCustomerAt = new Date();
  c.unread = (c.unread || 0) + 1;
  if (customerName) c.customerName = customerName;
  if (needsReview) c.status = "needs_review"; else if (c.status === "closed") c.status = "open";
  await c.save();
  res.json({ success: true, id: String(c._id) });
}));


/* =====================================================
   LEGAL PAGES + META DATA-DELETION CALLBACK (needed to publish the Meta app)
   Set BUSINESS_NAME, SUPPORT_EMAIL, BUSINESS_ADDRESS in .env
   ===================================================== */
const LEGAL = {
  name: process.env.BUSINESS_NAME || "MarketingFlow AI",
  email: process.env.SUPPORT_EMAIL || "support@example.com",
  address: process.env.BUSINESS_ADDRESS || "Dhaka, Bangladesh",
  updated: process.env.LEGAL_UPDATED || "9 November 2026",
};
const legalPage = (title, body) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · ${LEGAL.name}</title>
<style>body{font-family:Inter,system-ui,sans-serif;max-width:820px;margin:40px auto;padding:0 20px;color:#14211a;line-height:1.65}h1{font-size:30px;margin-bottom:4px}h2{font-size:19px;margin-top:30px}.muted{color:#5f6b63}a{color:#0b7a2b}code{background:#eef1ea;padding:2px 6px;border-radius:6px}footer{margin-top:50px;border-top:1px solid #e3e7df;padding-top:16px;font-size:13px}</style></head>
<body><h1>${title}</h1><p class="muted">${LEGAL.name} · Last updated ${LEGAL.updated}</p>${body}
<footer class="muted"><a href="/privacy">Privacy Policy</a> · <a href="/terms">Terms of Service</a> · <a href="/data-deletion">Data Deletion</a> · Contact: <a href="mailto:${LEGAL.email}">${LEGAL.email}</a></footer></body></html>`;

app.get("/privacy", (_req, res) => res.send(legalPage("Privacy Policy", `
<p>${LEGAL.name} ("we", "us") provides software that helps businesses manage their Facebook Pages, Instagram professional accounts, Messenger conversations, ads, leads and orders. This policy explains what data we process and why.</p>
<h2>1. Who this applies to</h2>
<p><b>Business users</b> who sign in and connect their Meta accounts, and <b>their customers</b> who message or comment on those businesses' Facebook Pages or Instagram accounts.</p>
<h2>2. Data we collect</h2>
<ul>
<li><b>From Facebook Login (business users):</b> your name, the Pages, Instagram professional accounts, ad accounts and Business portfolios you choose to connect, and access tokens that let us act for you. Tokens are encrypted at rest.</li>
<li><b>Page and Instagram content:</b> posts, media, publishing results and insights (reach, engagement, followers) of the accounts you connect.</li>
<li><b>Ads data:</b> campaign structure, budgets and performance metrics of the ad accounts you connect.</li>
<li><b>Messages and comments:</b> when a customer messages or comments on a connected Page or Instagram account, we receive the message text, the page-scoped ID, name and profile picture provided by Meta, and the conversation history.</li>
<li><b>Order and lead details</b> that customers give in a conversation or lead form: name, phone number, delivery address, products and quantities.</li>
<li><b>Technical data:</b> logs needed to run and secure the service.</li>
</ul>
<h2>3. How we use data</h2>
<ul>
<li>To publish and schedule content, show analytics and manage ads for the business that connected the account.</li>
<li>To reply to customer messages and comments (automatically with AI or by the business's staff), prepare orders and pass leads to the business's sales team.</li>
<li>To detect fraud risk on cash-on-delivery orders (risk scores are shown to the business and reviewed by people; we never label a person a fraudster automatically).</li>
<li>To keep the service secure and fix problems.</li>
</ul>
<p>We do <b>not</b> sell personal data and do not use Meta Platform Data for advertising outside the business's own account.</p>
<h2>4. AI processing</h2>
<p>Message text and business information may be sent to our AI provider to generate replies, content and analysis. Providers process the data only to return the result to us. AI answers use only information the business has approved.</p>
<h2>5. Sharing</h2>
<p>Data is shared only with: the business that owns the connected account and its staff; service providers that host or process data for us (cloud hosting, database, AI provider, courier services chosen by the business); and authorities when the law requires it.</p>
<h2>6. Retention</h2>
<p>We keep data while the business account is active. When a business disconnects an account or deletes its workspace, related tokens and data are deleted within 30 days, except where the law requires us to keep records (for example invoices).</p>
<h2>7. Your rights and data deletion</h2>
<p>You can ask to access, correct or delete your data. See <a href="/data-deletion">Data Deletion Instructions</a> or email <a href="mailto:${LEGAL.email}">${LEGAL.email}</a>. Customers of a business can also contact that business directly.</p>
<h2>8. Security</h2>
<p>Access tokens are encrypted (AES-256-GCM), connections use HTTPS, and access to data is limited to the business that owns it.</p>
<h2>9. Children</h2>
<p>The service is for businesses and is not directed at children under 13.</p>
<h2>10. Changes and contact</h2>
<p>We may update this policy and will change the date above. Questions: <a href="mailto:${LEGAL.email}">${LEGAL.email}</a> · ${LEGAL.address}</p>`)));

app.get("/terms", (_req, res) => res.send(legalPage("Terms of Service", `
<h2>1. The service</h2><p>${LEGAL.name} provides tools to plan, create and publish social media content, manage Meta ads, handle customer messages with AI assistance, and manage leads and orders.</p>
<h2>2. Your account</h2><p>You must have the right to connect each Page, Instagram account and ad account you connect, and you are responsible for activity in your workspace.</p>
<h2>3. Acceptable use</h2><p>You must follow Meta's Platform Terms, Community Standards, Advertising Policies and Messenger Platform policies, and applicable law. Do not use the service for spam, misleading claims, or to collect data you are not allowed to collect.</p>
<h2>4. AI features</h2><p>AI-generated content and replies can be wrong. You are responsible for reviewing approvals, prices, offers and orders. Live ad changes require approval unless you enable bounded automation.</p>
<h2>5. Payments</h2><p>Paid plans are billed as shown in the app. Ad spend is charged by Meta directly to your ad account, not by us.</p>
<h2>6. Liability</h2><p>The service is provided "as is". To the extent the law allows, we are not liable for indirect losses, lost profits or losses caused by third-party platforms.</p>
<h2>7. Termination</h2><p>You can stop using the service at any time. We may suspend accounts that break these terms.</p>
<h2>8. Contact</h2><p><a href="mailto:${LEGAL.email}">${LEGAL.email}</a> · ${LEGAL.address}</p>`)));

app.get("/data-deletion", async (req, res) => {
  let status = "";
  if (req.query.code) {
    const ev = await WebhookEvent.findOne({ externalEventId: `deletion:${String(req.query.code).slice(0, 40)}` }).lean().catch(() => null);
    status = ev ? `<p style="background:#e9f8df;padding:12px;border-radius:10px">Request <code>${esc0(req.query.code)}</code> received on ${new Date(ev.receivedAt).toDateString()}. Status: <b>${ev.processingStatus}</b>.</p>` : `<p style="background:#fff4e5;padding:12px;border-radius:10px">No request found with code <code>${esc0(req.query.code)}</code>.</p>`;
  }
  res.send(legalPage("Data Deletion Instructions", `${status}
<h2>Business users (Facebook Login)</h2><ol>
<li>In the app, open <b>Meta Accounts</b> and press <b>Disconnect</b> on each account. Its encrypted token is deleted immediately.</li>
<li>Remove the app from Facebook: <b>Settings &amp; privacy → Settings → Business integrations</b> (or Apps and websites) → select ${LEGAL.name} → <b>Remove</b>. We receive a deletion request automatically and delete your remaining data within 30 days.</li>
<li>Or email <a href="mailto:${LEGAL.email}">${LEGAL.email}</a> with the subject "Delete my data".</li></ol>
<h2>Customers who messaged a business</h2>
<p>Email <a href="mailto:${LEGAL.email}">${LEGAL.email}</a> with the name of the business and the Facebook/Instagram name you used. We will delete your conversation, lead and personal order details (except records the business must keep by law) within 30 days.</p>`));
});
const esc0 = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Meta "Data deletion request callback" (App settings > Basic). Receives a signed_request.
function parseSignedRequest(sr) {
  if (!sr || !FB_APP_SECRET) return null;
  const [sig, payload] = String(sr).split(".");
  const b64 = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const expected = crypto.createHmac("sha256", FB_APP_SECRET).update(payload).digest();
  const got = b64(sig);
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return null;
  return JSON.parse(b64(payload).toString("utf8"));
}
app.post("/api/meta/data-deletion", express.urlencoded({ extended: false }), async (req, res) => {
  const data = parseSignedRequest(req.body?.signed_request);
  if (!data) return res.status(400).json({ error: "Invalid signed_request" });
  const code = crypto.randomBytes(8).toString("hex");
  await WebhookEvent.create({ provider: "meta_data_deletion", externalEventId: `deletion:${code}`, tenantId: "all", processingStatus: "pending" }).catch(() => { });
  // Business users are linked by Page/ad tokens, not by Facebook user id: flag it for the team to process
  const orgs = await SocialAccount.distinct("organizationId", { connectedVia: "oauth" }).catch(() => []);
  for (const o of orgs) await notify(o, "token", "Meta data deletion request", `A user removed the app (app-scoped id ${data.user_id}). Confirmation code ${code}. Delete their data within 30 days.`, "pages");
  res.json({ url: `${PUBLIC_BASE_URL || ""}/data-deletion?code=${code}`, confirmation_code: code });
});
// Meta "Deauthorize callback": a user removed the app
app.post("/api/meta/deauthorize", express.urlencoded({ extended: false }), async (req, res) => {
  const data = parseSignedRequest(req.body?.signed_request);
  if (!data) return res.sendStatus(400);
  console.log("Meta deauthorize for app-scoped user", data.user_id);
  res.sendStatus(200);
});

/* =====================================================
   COMMERCE (existing)
   ===================================================== */
/* =====================================================
   PRODUCTS (Inventory)
   ===================================================== */
app.get("/api/products", wrap(async (req, res) => {
  const q = { organizationId: tid(req) };
  if (req.query.q) q.name = new RegExp(String(req.query.q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  res.json(await Product.find(q).sort({ createdAt: -1 }).limit(500));
}));

app.post("/api/products", wrap(async (req, res) => {
  const { name, sku, price, stock, lowStockAt, category, imageUrl } = req.body;
  const p = await Product.create({ organizationId: tid(req), name, sku, price: Number(price), stock: Number(stock) || 0, lowStockAt, category, imageUrl });
  res.json({ success: true, product: p });
}));

app.put("/api/products/:id", wrap(async (req, res) => {
  const allowed = ["name", "sku", "price", "stock", "lowStockAt", "category", "imageUrl"];
  const patch = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  const p = await Product.findOneAndUpdate({ _id: req.params.id, organizationId: tid(req) }, patch, { new: true });
  if (!p) return res.status(404).json({ error: "Product not found" });
  res.json({ success: true, product: p });
}));

app.delete("/api/products/:id", wrap(async (req, res) => {
  const r = await Product.deleteOne({ _id: req.params.id, organizationId: tid(req) });
  if (!r.deletedCount) return res.status(404).json({ error: "Product not found" });
  res.json({ success: true });
}));

/* =====================================================
   ORDERS  (the AI agent in n8n also uses POST /api/orders with isAI:true)
   ===================================================== */
app.get("/api/orders", wrap(async (req, res) => {
  const q = { organizationId: tid(req) };
  if (req.query.status) q.status = req.query.status;
  if (req.query.ai === "1") q.isAI = true;
  if (req.query.today === "1") q.createdAt = { $gte: startOfDay(new Date()) };
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const rows = await Order.find(q).sort({ createdAt: -1 }).limit(limit);
  res.json(rows.map(orderRow));
}));

// Shared by the dashboard, n8n and the AI sales agent: reserves stock, scores fraud risk, creates the order
async function createOrder(org, b) {
  const items = (Array.isArray(b.items) ? b.items : []).map((i) => ({ ...i, qty: Number(i.qty) || 1 }));
  const taken = [];
  for (const it of items) {
    if (!it.productId) continue;
    const p = await Product.findOneAndUpdate({ _id: it.productId, organizationId: org, stock: { $gte: it.qty } }, { $inc: { stock: -it.qty } });
    if (!p) {
      for (const t of taken) await Product.updateOne({ _id: t.productId }, { $inc: { stock: t.qty } });
      throw fail(409, `Not enough stock for ${it.name || it.productId}`);
    }
    taken.push(it);
  }
  const total = b.total != null && b.total !== "" ? Number(b.total) : items.reduce((s, i) => s + (i.price || 0) * i.qty, 0);
  const paymentMethod = b.paymentMethod || "COD";
  const risk = await scoreRisk(org, { phone: b.phone, total, paymentMethod });
  try {
    return await Order.create({
      organizationId: org, orderNo: await nextOrderNo(org),
      customerName: b.customerName, phone: b.phone, address: b.address,
      items, total, paymentMethod, deliveryFee: Number(b.deliveryFee) || 0,
      paymentStatus: b.paymentStatus || (paymentMethod === "COD" ? "unpaid" : "paid"),
      channel: b.channel || (b.isAI ? "Messenger AI" : "Manual"), isAI: !!b.isAI,
      status: risk.score >= 80 ? "on_hold" : b.status || "pending",
      riskScore: risk.score, riskReasons: risk.reasons,
      conversationId: b.conversationId || null, psid: b.psid || null, ...(b.attribution ? { attribution: b.attribution } : {}),
    });
  } catch (e) {
    for (const t of taken) await Product.updateOne({ _id: t.productId }, { $inc: { stock: t.qty } });
    throw e;
  }
}

app.post("/api/orders", wrap(async (req, res) => {
  const order = await createOrder(tid(req), req.body);
  res.json({ success: true, order: orderRow(order) });
}));

app.put("/api/orders/:id", wrap(async (req, res) => {
  const org = tid(req);
  const order = await Order.findOne({ _id: req.params.id, organizationId: org });
  if (!order) return res.status(404).json({ error: "Order not found" });
  const { status, paymentStatus } = req.body;
  if (status === "cancelled" && order.status !== "cancelled") {
    for (const it of order.items) if (it.productId) await Product.updateOne({ _id: it.productId }, { $inc: { stock: it.qty } });
  }
  if (status) order.status = status;
  if (paymentStatus) order.paymentStatus = paymentStatus;
  await order.save();
  res.json({ success: true, order: orderRow(order) });
}));

app.post("/api/orders/:id/ship", wrap(async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, organizationId: tid(req) });
  if (!order) return res.status(404).json({ error: "Order not found" });
  if (order.status === "cancelled" || order.status === "on_hold") return res.status(400).json({ error: `Can't ship an order that is ${order.status}` });
  const booking = await bookCourier(req.body.courier || "Pathao", order);
  order.courier = { ...booking, shippedAt: new Date() };
  order.status = "shipped";
  await order.save();
  res.json({ success: true, order: orderRow(order) });
}));

/* =====================================================
   FRAUD SHIELD
   ===================================================== */
app.get("/api/fraud/orders", wrap(async (req, res) => {
  const rows = await Order.find({ organizationId: tid(req), riskScore: { $gte: 30 } }).sort({ createdAt: -1 }).limit(100);
  res.json(rows.map(orderRow));
}));

app.get("/api/fraud/blacklist", wrap(async (req, res) => {
  res.json(await Blacklist.find({ organizationId: tid(req) }).sort({ createdAt: -1 }));
}));

app.post("/api/fraud/blacklist", wrap(async (req, res) => {
  const org = tid(req);
  const { phone, reason } = req.body;
  if (!phone) return res.status(400).json({ error: "phone is required" });
  await Blacklist.updateOne({ organizationId: org, phone }, { $setOnInsert: { reason: reason || "Blocked manually" } }, { upsert: true });
  await Order.updateMany({ organizationId: org, phone, status: "pending" }, { status: "on_hold" });
  res.json({ success: true });
}));

app.delete("/api/fraud/blacklist/:id", wrap(async (req, res) => {
  await Blacklist.deleteOne({ _id: req.params.id, organizationId: tid(req) });
  res.json({ success: true });
}));

/* =====================================================
   COURIER HUB
   ===================================================== */
app.get("/api/courier/shipments", wrap(async (req, res) => {
  const rows = await Order.find({
    organizationId: tid(req),
    status: { $in: ["confirmed", "processing", "shipped", "delivered"] },
  }).sort({ createdAt: -1 }).limit(100);
  res.json(rows.map(orderRow));
}));

/* =====================================================
   AI AGENT SETTINGS
   ===================================================== */
app.get("/api/agent", wrap(async (req, res) => {
  const org = tid(req);
  const c = await AgentConfig.findOneAndUpdate({ organizationId: org }, { $setOnInsert: {} }, { upsert: true, new: true, setDefaultsOnInsert: true });
  res.json(c);
}));

app.put("/api/agent", wrap(async (req, res) => {
  const allowed = ["enabled", "autoConfirm", "tone", "escalateBelow", "greeting", "deliveryInside", "deliveryOutside", "deliveryTime", "paymentNote", "knowledge", "handoffMessage", "commentAutoReply", "commentPrivateReply", "commentPublicReply"];
  const patch = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  const c = await AgentConfig.findOneAndUpdate({ organizationId: tid(req) }, patch, { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true });
  res.json({ success: true, config: c });
}));

/* =====================================================
   ANALYTICS
   ===================================================== */
app.get("/api/analytics", wrap(async (req, res) => {
  const org = tid(req);
  const from = startOfDay(Date.now() - 6 * DAY);
  const base = { organizationId: org, status: { $ne: "cancelled" } };
  const [daily, channels, statuses] = await Promise.all([
    Order.aggregate([
      { $match: { ...base, createdAt: { $gte: from } } },
      { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, revenue: { $sum: "$total" }, orders: { $sum: 1 } } },
    ]),
    Order.aggregate([{ $match: base }, { $group: { _id: "$channel", orders: { $sum: 1 }, revenue: { $sum: "$total" } } }, { $sort: { revenue: -1 } }]),
    Order.aggregate([{ $match: { organizationId: org } }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
  ]);
  const byDay = Object.fromEntries(daily.map((d) => [d._id, d]));
  const days = Array.from({ length: 7 }, (_, i) => {
    const key = new Date(from.getTime() + i * DAY).toLocaleDateString("en-CA"); // YYYY-MM-DD, local
    return { date: key, revenue: byDay[key]?.revenue || 0, orders: byDay[key]?.orders || 0 };
  });
  res.json({
    daily: days,
    channels: channels.map((c) => ({ channel: c._id, orders: c.orders, revenue: c.revenue })),
    statuses: statuses.map((s) => ({ status: s._id, count: s.count })),
  });
}));

/* =====================================================
   SUBSCRIPTION  (hook up bKash / SSLCommerz / Stripe before charging real money)
   ===================================================== */
app.get("/api/subscription", wrap(async (req, res) => {
  const org = tid(req);
  const o = (await Organization.findById(org)) || { plan: "free", planStatus: "active", planRenewsAt: null };
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const [aiOrders, pages] = await Promise.all([
    Order.countDocuments({ organizationId: org, isAI: true, createdAt: { $gte: monthStart } }),
    SocialAccount.countDocuments({ organizationId: org, platform: { $in: ["Facebook", "Instagram"] } }),
  ]);
  res.json({ plan: o.plan, status: o.planStatus, renewsAt: o.planRenewsAt, limits: PLANS[o.plan], usage: { aiOrders, pages }, plans: PLANS });
}));

app.put("/api/subscription", wrap(async (req, res) => {
  const { plan } = req.body;
  if (!PLANS[plan]) return res.status(400).json({ error: "Unknown plan" });
  const renewsAt = plan === "free" ? null : new Date(Date.now() + 30 * DAY);
  await Organization.updateOne({ _id: tid(req) }, { plan, planStatus: "active", planRenewsAt: renewsAt }, { upsert: true });
  res.json({ success: true });
}));

/* =====================================================
   OVERVIEW (feeds every KPI card on the dashboard)
   ===================================================== */
app.get("/api/overview", wrap(async (req, res) => {
  const org = tid(req);
  const today = startOfDay(new Date());
  const yest = startOfDay(Date.now() - DAY);
  const T = { createdAt: { $gte: today } };
  const Y = { createdAt: { $gte: yest, $lt: today } };
  const weekAgo = new Date(Date.now() - 7 * DAY);

  const [
    tAll, yAll, tAI, yAI, total, paidNow, paidBefore,
    openThreads, needsReview, products, b2bLeads,
    threadsD, reviewD, productsD, leadsD,
  ] = await Promise.all([
    sumOrders(org, T), sumOrders(org, Y),
    sumOrders(org, { ...T, isAI: true }), sumOrders(org, { ...Y, isAI: true }),
    sumOrders(org),
    sumOrders(org, { paymentStatus: "paid" }),
    sumOrders(org, { paymentStatus: "paid", createdAt: { $lt: weekAgo } }),
    Conversation.countDocuments({ organizationId: org, status: { $ne: "closed" } }),
    Conversation.countDocuments({ organizationId: org, status: "needs_review" }),
    Product.countDocuments({ organizationId: org }),
    Lead.countDocuments({ organizationId: org }),
    weekDelta(Conversation, org), weekDelta(Conversation, org, { status: "needs_review" }),
    weekDelta(Product, org), weekDelta(Lead, org),
  ]);

  res.json({
    revenueToday: tAll.revenue, revenueDelta: pct(tAll.revenue, yAll.revenue),
    ordersTodayNote: `${tAll.count} orders recorded today`,
    ordersToday: tAll.count, ordersTotal: total.count, ordersDelta: pct(tAll.count, yAll.count),
    aiOrders: tAI.count, aiDelta: pct(tAI.count, yAI.count),
    collected: paidNow.revenue, collectedDelta: pct(paidNow.revenue, paidBefore.revenue),
    openThreads, threadsDelta: threadsD,
    needsReview, reviewDelta: reviewD,
    products, productsDelta: productsD,
    b2bLeads, leadsDelta: leadsD,
  });
}));

app.get("/api/stats", wrap(async (req, res) => {
  const org = tid(req);
  const [totalLeads, hotLeads, totalContent, publishedContent] = await Promise.all([
    Lead.countDocuments({ organizationId: org }),
    Lead.countDocuments({ organizationId: org, aiStatus: "Hot" }),
    ContentItem.countDocuments({ organizationId: org }),
    ContentItem.countDocuments({ organizationId: org, status: { $in: ["Approved", "Published"] } }),
  ]);
  res.json({ totalLeads, hotLeads, totalContent, publishedContent });
}));

/* ---------- video upload to n8n (existing) ---------- */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
});

app.post("/upload", upload.single("data"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No video." });
    if (!req.body.caption) return res.status(400).json({ error: "No caption." });

    const form = new FormData();
    form.append("data", new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname);
    form.append("caption", req.body.caption);

    const r = await fetch(process.env.N8N_UPLOAD_URL || `${N8N_BASE}/webhook-test/upload-video`, {
      method: "POST",
      body: form,
    });

    if (!r.ok) {
      console.error("n8n error:", await r.text());
      return res.status(502).json({ error: "n8n rejected the request." });
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

/* =====================================================
   BACKGROUND JOBS
   ===================================================== */
const RUNNING = new Set();
async function runJob(name, fn) {
  if (RUNNING.has(name)) return;
  RUNNING.add(name);
  try { await fn(); } catch (e) { console.error(`job ${name}:`, e.message); } finally { RUNNING.delete(name); }
}
async function syncAll() {
  const orgs = await SocialAccount.distinct("organizationId");
  for (const org of orgs) {
    await checkTokens(org).catch((e) => console.warn("tokens:", e.message));
    const ads = await SocialAccount.find({ organizationId: org, platform: "Meta Ads", status: { $nin: ["expired", "revoked"] } }).select("+accessToken");
    for (const a of ads) await syncAdAccount(org, a, 30).catch((e) => console.warn(`ads ${a.accountId}:`, e.message));
    if (ads.length) { await runAdRules(org).catch((e) => console.warn("rules:", e.message)); await checkBudgets(org).catch((e) => console.warn("budget:", e.message)); }
    await syncOrganic(org).catch((e) => console.warn("organic:", e.message));
    const comps = await Competitor.find({ organizationId: org, igUsername: { $ne: null }, $or: [{ lastSnapshotAt: null }, { lastSnapshotAt: { $lt: new Date(Date.now() - 20 * 3600e3) } }] });
    for (const c of comps) { await snapshotCompetitor(org, c).catch((e) => console.warn(`competitor ${c.name}:`, e.message)); await sleep(1500); }
  }
}
function startJobs() {
  if (process.env.JOBS === "off") return console.log("⏸️  Background jobs disabled (JOBS=off)");
  setInterval(() => runJob("publish", publishDue), 30e3);
  setInterval(() => runJob("followups", followUpReminders), 5 * 60e3);
  setInterval(() => runJob("sync", syncAll), 6 * 3600e3);
  setTimeout(() => runJob("sync", syncAll), 90e3);
  console.log("⏱️  Background jobs: publishing every 30s, Meta sync every 6h");
}
app.post("/api/jobs/sync-all", wrap(async (_req, res) => { runJob("sync", syncAll); res.json({ success: true, started: true }); }));

/* ---------- start ---------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Backend running on http://localhost:${PORT}`));