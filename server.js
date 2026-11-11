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
  Organization,
  Lead,
  Task,
  Brand,
  ContentItem,
  ContentPlan,
  MediaAsset,
  CreativeTemplate,
  AdEntity,
  AdInsight,
  AdBreakdown,
  CampaignDraft,
  ChangeRequest,
  Recommendation,
  BudgetPlan,
  Experiment,
  AccountInsight,
  Competitor,
  CompetitorSnapshot,
  Product,
  Order,
  Conversation,
  Blacklist,
  AgentConfig,
  WebhookEvent,
  SocialAccount,
  Notification,
  AiUsage,
  nextOrderNo,
  StockMovement,
  User,
  Membership,
  Session,
  AuditLog,
  Comment,
  PostProduct,
  CourierAccount,
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
AUTH=on                                              (login + roles; "off" only for local testing)
SANDBOX_TOOLS=off                                    ("on" shows simulators to every owner; default: super admin only)
-------------------------------------- */
const DEFAULT_TENANT = process.env.DEFAULT_TENANT || "org_123";
const N8N_BASE = process.env.N8N_BASE_URL || "http://localhost:5678";
const N8N_REPLY =
  process.env.N8N_REPLY_URL || `${N8N_BASE}/webhook/messenger-reply`;
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
app.use(
  express.json({
    limit: "10mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);
app.use("/uploads", express.static(UPLOAD_DIR, { maxAge: "7d" }));
// Only the dashboard and its assets are public (never serve server.js / schema.js / .env)
app.get(["/", "/index.html"], (_req, res) =>
  res.sendFile(path.join(__dirname, "index.html")),
);
app.get(
  /^\/[\w-]+\.(png|jpg|jpeg|svg|ico|webp|css|js|woff2?)$/,
  (req, res, next) => {
    if (/^\/(server|schema)\.js$/.test(req.path)) return next();
    const f = path.join(__dirname, path.basename(req.path));
    fs.existsSync(f) ? res.sendFile(f) : next();
  },
);

/* ---------- helpers ---------- */
// Throw fail(400, "message") inside any route: the message is returned to the browser.
const fail = (http, message, meta) =>
  Object.assign(new Error(message), { http, meta });

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    if (err && err.code === 11000)
      return res.status(409).json({ error: "Already exists" });
    if (err && err.http)
      return res.status(err.http).json({ error: err.message, meta: err.meta });
    if (err && err.name === "ValidationError")
      return res.status(400).json({ error: err.message });
    console.error(`${req.method} ${req.path}:`, err);
    res.status(500).json({ error: "Internal Server Error" });
  });

// Tenant and user always come from the login session (set by the auth middleware), never from the request
const tid = (req) => String(req.ctx?.org || DEFAULT_TENANT);
const actor = (req) => String(req.ctx?.user?.name || "Admin").slice(0, 80);

// Protects routes that only n8n should call (skipped if WEBHOOK_SECRET is not set).
const needSecret = (req, res, next) => {
  const s = process.env.WEBHOOK_SECRET;
  if (s && req.headers["x-webhook-secret"] !== s)
    return res.status(401).json({ error: "Unauthorized" });
  next();
};

const startOfDay = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};
const DAY = 86400000;
const pct = (cur, prev) =>
  prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : cur > 0 ? 100 : 0;
const ymd = (d) => new Date(d).toISOString().slice(0, 10);
const daysAgo = (n) => ymd(Date.now() - n * DAY);
const round = (n, d = 2) => Math.round((Number(n) || 0) * 10 ** d) / 10 ** d;
const pick = (obj, keys) =>
  Object.fromEntries(
    Object.entries(obj || {}).filter(([k]) => keys.includes(k)),
  );
const lines = (v) =>
  (Array.isArray(v) ? v : String(v || "").split(/\r?\n|,/))
    .map((s) => String(s).trim())
    .filter(Boolean);
const linesNL = (v) =>
  (Array.isArray(v) ? v : String(v || "").split(/\r?\n/))
    .map((s) => String(s).trim())
    .filter(Boolean); // keeps commas
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const todayIn = (tz) => {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(
      new Date(),
    );
  } catch {
    return ymd(new Date());
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Accepts "2026-11-01" or "7" (days back). Returns { from, to } as YYYY-MM-DD.
function range(q, defDays = 7) {
  const to = q.to || ymd(new Date());
  const from =
    q.from ||
    ymd(new Date(to).getTime() - (Number(q.days) || defDays - 1) * DAY);
  return { from, to };
}

async function ensureWorkspace() {
  await Organization.updateOne(
    { _id: DEFAULT_TENANT },
    { $setOnInsert: { name: process.env.WORKSPACE_NAME || "Test" } },
    { upsert: true },
  );
  await AgentConfig.updateOne(
    { organizationId: DEFAULT_TENANT },
    { $setOnInsert: {} },
    { upsert: true },
  );
}

/* ---------- token encryption (AES-256-GCM) ---------- */
const ENC_KEY = (() => {
  const hex = process.env.TOKEN_ENC_KEY || "";
  if (/^[0-9a-f]{64}$/i.test(hex)) return Buffer.from(hex, "hex");
  console.warn(
    "⚠️  TOKEN_ENC_KEY missing/invalid: using a derived dev key. Set a 64-hex TOKEN_ENC_KEY in production.",
  );
  return crypto
    .createHash("sha256")
    .update(process.env.WEBHOOK_SECRET || "marketingflow-dev-key")
    .digest();
})();
function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", ENC_KEY, iv);
  const data = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return [
    "enc:v1",
    iv.toString("hex"),
    c.getAuthTag().toString("hex"),
    data.toString("hex"),
  ].join(":");
}
function decrypt(stored) {
  if (!stored || !String(stored).startsWith("enc:v1:")) return stored; // legacy plain-text token
  const [, , iv, tag, data] = String(stored).split(":");
  try {
    const d = crypto.createDecipheriv(
      "aes-256-gcm",
      ENC_KEY,
      Buffer.from(iv, "hex"),
    );
    d.setAuthTag(Buffer.from(tag, "hex"));
    return Buffer.concat([
      d.update(Buffer.from(data, "hex")),
      d.final(),
    ]).toString("utf8");
  } catch {
    // Happens when TOKEN_ENC_KEY changed after the token was saved
    throw fail(
      401,
      "Saved token can't be decrypted (TOKEN_ENC_KEY changed). Reconnect Facebook in Meta Accounts.",
    );
  }
}
const tok = (acc) => decrypt(acc.accessToken);

/* ---------- settings + notifications ---------- */
const DEFAULT_SETTINGS = {
  requireApproval: true,
  creativeApproval: false,
  optimizationMode: "recommend",
  maxBudgetDeltaPct: 20,
  maxDailyBudget: 0,
  guardrailAllowlist: [],
  salesTeam: [],
  rrIndex: 0,
  timezone: "Asia/Dhaka",
  leadCategories: [
    "Product inquiry",
    "Service inquiry",
    "Wholesale / B2B",
    "Support",
    "Other",
  ],
};
async function getSettings(org) {
  const o = await Organization.findById(org).lean();
  return { ...DEFAULT_SETTINGS, ...(o?.marketingSettings || {}) };
}

async function notify(org, type, title, message, view = null) {
  await Notification.create({
    organizationId: org,
    type,
    title,
    message,
    view,
  }).catch((e) => console.warn("notify:", e.message));
  const url = process.env.ALERT_WEBHOOK_URL;
  if (url) {
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId: org, type, title, message }),
    }).catch((e) => console.warn("Alert webhook failed:", e.message));
  }
}

/* =====================================================
   AUTH, TENANCY, ROLES & AUDIT (SRS v2 §6, R1)
   - Session cookie (HttpOnly, SameSite=Lax, Secure on https), stored hashed in MongoDB
   - Tenant always comes from the session, never from the request (BR-01)
   - Every /api request is checked against the role matrix (SRS §3.2)
   Set AUTH=off in .env only for local development without login.
   ===================================================== */
const AUTH_ON = process.env.AUTH !== "off";
const SESSION_DAYS = 30;
const COOKIE = "mf_sid";
app.set("trust proxy", true);

// Role matrix: "<module>.<read|write>", "*" = everything, "-x" = explicitly denied
const ROLES = {
  owner: ["*"],
  manager: [
    "*.read",
    "*.write",
    "customers.pii",
    "-users.write",
    "-billing.write",
  ],
  agent: [
    "inbox.*",
    "comments.*",
    "orders.read",
    "orders.write",
    "inventory.read",
    "leads.*",
    "analytics.read",
    "marketing.read",
    "agent.read",
    "pages.read",
    "notifications.*",
    "customers.pii",
  ],
  fulfilment: [
    "orders.*",
    "courier.*",
    "inventory.*",
    "fraud.read",
    "analytics.read",
    "notifications.*",
    "customers.pii",
  ],
  lead_exec: [
    "leads.*",
    "marketing.read",
    "analytics.read",
    "inventory.read",
    "notifications.*",
  ],
  viewer: ["*.read", "notifications.*"],
};
const ROLE_LABEL = {
  owner: "Owner",
  manager: "Manager",
  agent: "Sales / Support Agent",
  fulfilment: "Fulfilment Staff",
  lead_exec: "Lead Executive",
  viewer: "Analyst / Viewer",
};
function can(role, perm) {
  const list = ROLES[role] || [];
  if (list.includes("-" + perm)) return false;
  const [mod, act] = perm.split(".");
  return list.some(
    (p) => p === "*" || p === perm || p === `${mod}.*` || p === `*.${act}`,
  );
}
const MODULE_OF = [
  [/^\/api\/(team|audit)\b/, "users"],
  [/^\/api\/(workspace|marketing\/settings)\b/, "settings"],
  [/^\/api\/orders\b/, "orders"],
  [/^\/api\/(products|inventory)\b/, "inventory"],
  [/^\/api\/fraud\b/, "fraud"],
  [/^\/api\/courier\b/, "courier"],
  [/^\/api\/(conversations|inbox)\b/, "inbox"],
  [/^\/api\/comments\b/, "comments"],
  [/^\/api\/leads\b/, "leads"],
  [/^\/api\/(overview|metrics|stats)\b/, "analytics"],
  [/^\/api\/analytics$/, "analytics"],
  [/^\/api\/agent\b/, "agent"],
  [/^\/api\/(integrations|meta)\b/, "pages"],
  [/^\/api\/subscription\b/, "billing"],
  [/^\/api\/notifications\b/, "notifications"],
  [/^\/api\//, "marketing"],
];
const moduleOf = (p) => (MODULE_OF.find(([re]) => re.test(p)) || [])[1] || null;
const PUBLIC_API = [
  /^\/auth\//,
  /^\/health$/,
  /^\/meta\/data-deletion$/,
  /^\/meta\/deauthorize$/,
];
const SERVICE_API = [
  /^\/leads\/check-duplicate$/,
  /^\/leads\/create$/,
  /^\/tasks\/create$/,
  /^\/content\/create$/,
  /^\/inbox\/inbound$/,
];

const sha256 = (s) =>
  crypto.createHash("sha256").update(String(s)).digest("hex");
const cookiesOf = (req) =>
  Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
      .map((c) => c.trim())
      .filter(Boolean)
      .map((c) => {
        const i = c.indexOf("=");
        return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))];
      }),
  );
const isHttps = (req) =>
  req.secure ||
  String(req.headers["x-forwarded-proto"] || "").includes("https");
function setSessionCookie(req, res, token, maxAgeSec) {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${maxAgeSec}; SameSite=Lax${isHttps(req) ? "; Secure" : ""}`,
  );
}
const hashPassword = (pw) =>
  new Promise((ok, no) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(String(pw), salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) =>
      e ? no(e) : ok(`scrypt$${salt.toString("hex")}$${k.toString("hex")}`),
    );
  });
const verifyPassword = (pw, stored) =>
  new Promise((ok) => {
    const [, s, h] = String(stored || "").split("$");
    if (!s || !h) return ok(false);
    crypto.scrypt(
      String(pw),
      Buffer.from(s, "hex"),
      64,
      { N: 16384, r: 8, p: 1 },
      (e, k) =>
        ok(
          !e &&
            k.length === Buffer.from(h, "hex").length &&
            crypto.timingSafeEqual(k, Buffer.from(h, "hex")),
        ),
    );
  });

async function audit(reqOrCtx, action, target = null, meta = {}) {
  const ctx = reqOrCtx?.ctx || reqOrCtx || {};
  AuditLog.create({
    organizationId: ctx.org || null,
    userId: ctx.user?.id || null,
    userName: ctx.user?.name || "system",
    action,
    target: target ? String(target) : null,
    meta,
    ip: reqOrCtx?.ip || null,
  }).catch((e) => console.warn("audit:", e.message));
}

async function createSession(req, res, user, orgId) {
  const token = crypto.randomBytes(32).toString("hex");
  await Session.create({
    _id: sha256(token),
    userId: user.id,
    organizationId: orgId,
    expiresAt: new Date(Date.now() + SESSION_DAYS * DAY),
    ip: req.ip,
    ua: String(req.headers["user-agent"] || "").slice(0, 200),
  });
  setSessionCookie(req, res, token, SESSION_DAYS * 86400);
  await User.updateOne(
    { _id: user.id },
    {
      lastLoginAt: new Date(),
      failedLogins: 0,
      lockedUntil: null,
      lastOrgId: orgId,
    },
  );
}

async function loadSession(req, res) {
  const token = cookiesOf(req)[COOKIE];
  if (!token) return null;
  const s = await Session.findById(sha256(token));
  if (!s || s.expiresAt < new Date()) return null;
  const user = await User.findById(s.userId).lean();
  if (!user) return null;
  let m = s.organizationId
    ? await Membership.findOne({
        organizationId: s.organizationId,
        userId: user._id,
        status: "active",
      }).lean()
    : null;
  if (!m) {
    m = await Membership.findOne({ userId: user._id, status: "active" })
      .sort({ createdAt: 1 })
      .lean();
    if (!m) return null;
    await Session.updateOne(
      { _id: s._id },
      { organizationId: m.organizationId },
    );
  }
  if (s.expiresAt - Date.now() < (SESSION_DAYS - 1) * DAY) {
    // sliding expiry, at most once a day
    await Session.updateOne(
      { _id: s._id },
      { expiresAt: new Date(Date.now() + SESSION_DAYS * DAY) },
    );
    setSessionCookie(req, res, token, SESSION_DAYS * 86400);
  }
  return {
    user: { id: user._id, name: user.name, email: user.email },
    org: m.organizationId,
    role: m.role,
    superAdmin: !!user.isSuperAdmin,
    pii: can(m.role, "customers.pii"),
    membershipId: m._id,
    pageIds: m.pageIds || [],
    sessionId: s._id,
  };
}

// Applied to every /api route
app.use("/api", async (req, res, next) => {
  try {
    if (PUBLIC_API.some((r) => r.test(req.path))) return next();
    if (SERVICE_API.some((r) => r.test(req.path))) {
      const s = process.env.WEBHOOK_SECRET;
      const local =
        ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
          req.socket?.remoteAddress,
        ) && !req.headers["x-forwarded-for"];
      if (AUTH_ON && (s ? req.headers["x-webhook-secret"] !== s : !local))
        return res
          .status(401)
          .json({
            error:
              "Unauthorized: set WEBHOOK_SECRET and send it as x-webhook-secret",
          });
      req.ctx = {
        service: true,
        org: String(req.body?.tenantId || req.query.tenantId || DEFAULT_TENANT),
        role: "owner",
        pii: true,
        user: { id: "n8n", name: "n8n" },
      };
      return next();
    }
    if (!AUTH_ON) {
      req.ctx = {
        org: String(
          req.headers["x-tenant-id"] || req.query.tenantId || DEFAULT_TENANT,
        ),
        role: "owner",
        superAdmin: true,
        pii: true,
        user: {
          id: "dev",
          name: String(req.headers["x-user-name"] || "Admin"),
        },
      };
      return next();
    }
    const ctx = await loadSession(req, res);
    if (!ctx)
      return res
        .status(401)
        .json({ error: "Please log in", code: "AUTH_REQUIRED" });
    req.ctx = ctx;
    const mod = moduleOf("/api" + req.path);
    const act = ["GET", "HEAD"].includes(req.method) ? "read" : "write";
    if (mod && !can(ctx.role, `${mod}.${act}`)) {
      audit(req, "auth.forbidden", req.path, { method: req.method });
      return res
        .status(403)
        .json({
          error: `Your role (${ROLE_LABEL[ctx.role] || ctx.role}) can't ${act === "read" ? "view" : "change"} ${mod}.`,
        });
    }
    next();
  } catch (e) {
    next(e);
  }
});
// Non-/api routes that need a logged-in user
app.use(["/upload", "/uploads"], async (req, res, next) => {
  if (!AUTH_ON || req.path.match(/\.(png|jpe?g|webp|gif|mp4|mov|webm)$/i))
    return next(); // media must stay public for Meta
  const ctx = await loadSession(req, res).catch(() => null);
  if (!ctx) return res.status(401).json({ error: "Please log in" });
  req.ctx = ctx;
  next();
});

/* ---------- PII masking (FR-AUTH-007) ---------- */
const maskPhone = (p) =>
  p && String(p).length > 6
    ? String(p).slice(0, 3) + "•••••" + String(p).slice(-3)
    : p;
const maskAddress = (a) =>
  a
    ? "••• " +
      String(a)
        .split(/[,\s]+/)
        .filter(Boolean)
        .slice(-2)
        .join(", ")
    : a;
const canSeePii = (req) => !req.ctx || req.ctx.pii;

/* ---------- login throttling (FR-AUTH-002): 5 failures / 15 min per account and per IP ---------- */
const FAILS = new Map();
const failKey = (k) =>
  (FAILS.get(k) || []).filter((t) => Date.now() - t < 15 * 60e3);
function tooMany(req, email) {
  return (
    failKey("e:" + email).length >= 5 || failKey("ip:" + req.ip).length >= 5
  );
}
function noteFail(req, email) {
  for (const k of ["e:" + email, "ip:" + req.ip])
    FAILS.set(k, [...failKey(k), Date.now()]);
}

/* ---------- auth routes ---------- */
const meView = async (ctx) => {
  const [org, mems] = await Promise.all([
    Organization.findById(ctx.org).lean(),
    Membership.find({ userId: ctx.user.id, status: "active" }).lean(),
  ]);
  const orgNames = Object.fromEntries(
    (
      await Organization.find({
        _id: { $in: mems.map((m) => m.organizationId) },
      })
        .select("name")
        .lean()
    ).map((o) => [o._id, o.name]),
  );
  return {
    authOn: AUTH_ON,
    user: ctx.user,
    role: ctx.role,
    roleLabel: ROLE_LABEL[ctx.role] || ctx.role,
    superAdmin: !!ctx.superAdmin,
    pii: !!ctx.pii,
    org: {
      id: ctx.org,
      name: org?.name || "Workspace",
      logoUrl: org?.logoUrl || null,
    },
    memberships: mems.map((m) => ({
      orgId: m.organizationId,
      name: orgNames[m.organizationId] || m.organizationId,
      role: m.role,
    })),
    sandbox: !!ctx.superAdmin || process.env.SANDBOX_TOOLS === "on",
    can: Object.fromEntries(
      [
        "orders",
        "inventory",
        "fraud",
        "courier",
        "inbox",
        "comments",
        "leads",
        "analytics",
        "agent",
        "pages",
        "billing",
        "users",
        "settings",
        "marketing",
      ].flatMap((m) => [
        [`${m}.read`, can(ctx.role, `${m}.read`)],
        [`${m}.write`, can(ctx.role, `${m}.write`)],
      ]),
    ),
  };
};

app.get(
  "/api/auth/me",
  wrap(async (req, res) => {
    const ctx = !AUTH_ON
      ? {
          org: DEFAULT_TENANT,
          role: "owner",
          superAdmin: true,
          pii: true,
          user: { id: "dev", name: "Admin", email: "dev@local" },
        }
      : await loadSession(req, res);
    if (!ctx)
      return res
        .status(401)
        .json({
          error: "Please log in",
          code: "AUTH_REQUIRED",
          hasUsers: !!(await User.exists({})),
        });
    res.json(await meView(ctx));
  }),
);

app.post(
  "/api/auth/signup",
  wrap(async (req, res) => {
    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();
    const name = String(req.body.name || "").trim();
    const password = String(req.body.password || "");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      throw fail(400, "Enter a valid email");
    if (name.length < 2) throw fail(400, "Enter your name");
    if (password.length < 8)
      throw fail(400, "Password must be at least 8 characters");
    if (await User.exists({ email }))
      throw fail(
        409,
        "An account with this email already exists. Log in instead.",
      );
    const first = !(await User.exists({}));
    const user = await User.create({
      email,
      name,
      passwordHash: await hashPassword(password),
      isSuperAdmin: first,
    });
    let orgId;
    const invite = req.body.inviteToken
      ? await Membership.findOne({
          inviteTokenHash: sha256(req.body.inviteToken),
          status: "invited",
          inviteExpiresAt: { $gt: new Date() },
        }).select("+inviteTokenHash")
      : null;
    if (invite && invite.email === email) {
      invite.userId = user.id;
      invite.status = "active";
      invite.inviteTokenHash = null;
      await invite.save();
      orgId = invite.organizationId;
    } else if (first) {
      orgId = DEFAULT_TENANT; // the very first account owns the existing workspace and its data
      await Organization.updateOne(
        { _id: orgId },
        {
          $setOnInsert: {
            name:
              req.body.workspace || process.env.WORKSPACE_NAME || "My business",
          },
        },
        { upsert: true },
      );
      if (req.body.workspace)
        await Organization.updateOne(
          { _id: orgId },
          { name: req.body.workspace },
        );
      await Membership.create({
        organizationId: orgId,
        userId: user.id,
        email,
        role: "owner",
        status: "active",
      });
    } else {
      const org = await Organization.create({
        name: String(req.body.workspace || `${name}'s business`).slice(0, 80),
      });
      orgId = org.id;
      await AgentConfig.create({ organizationId: orgId });
      await Membership.create({
        organizationId: orgId,
        userId: user.id,
        email,
        role: "owner",
        status: "active",
      });
    }
    await createSession(req, res, user, orgId);
    audit(
      { ctx: { org: orgId, user: { id: user.id, name } }, ip: req.ip },
      "auth.signup",
      user.id,
      { first, invited: !!invite },
    );
    res.json({ success: true });
  }),
);

app.post(
  "/api/auth/login",
  wrap(async (req, res) => {
    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();
    if (tooMany(req, email)) {
      audit({ ctx: {}, ip: req.ip }, "auth.lockout", email);
      throw fail(429, "Too many failed attempts. Try again in 15 minutes.");
    }
    const user = await User.findOne({ email }).select("+passwordHash");
    if (
      !user ||
      (user.lockedUntil && user.lockedUntil > new Date()) ||
      !(await verifyPassword(req.body.password, user.passwordHash))
    ) {
      noteFail(req, email);
      if (user) {
        user.failedLogins += 1;
        if (user.failedLogins >= 5)
          user.lockedUntil = new Date(Date.now() + 15 * 60e3);
        await user.save();
      }
      audit({ ctx: {}, ip: req.ip }, "auth.login_failed", email);
      throw fail(401, "Wrong email or password");
    }
    const m =
      (user.lastOrgId &&
        (await Membership.findOne({
          organizationId: user.lastOrgId,
          userId: user.id,
          status: "active",
        }))) ||
      (await Membership.findOne({ userId: user.id, status: "active" }));
    if (!m) throw fail(403, "Your account isn't part of any active workspace");
    if (req.body.inviteToken)
      await acceptInvite(user, req.body.inviteToken).catch(() => {});
    await createSession(req, res, user, m.organizationId);
    audit(
      {
        ctx: { org: m.organizationId, user: { id: user.id, name: user.name } },
        ip: req.ip,
      },
      "auth.login",
      user.id,
    );
    res.json({ success: true });
  }),
);

app.post(
  "/api/auth/logout",
  wrap(async (req, res) => {
    const token = cookiesOf(req)[COOKIE];
    if (token) await Session.deleteOne({ _id: sha256(token) });
    setSessionCookie(req, res, "", 0);
    res.json({ success: true });
  }),
);

app.post(
  "/api/auth/switch",
  wrap(async (req, res) => {
    const ctx = await loadSession(req, res);
    if (!ctx) throw fail(401, "Please log in");
    const m = await Membership.findOne({
      organizationId: req.body.organizationId,
      userId: ctx.user.id,
      status: "active",
    });
    if (!m) throw fail(403, "You are not a member of that workspace");
    await Session.updateOne(
      { _id: ctx.sessionId },
      { organizationId: m.organizationId },
    );
    await User.updateOne({ _id: ctx.user.id }, { lastOrgId: m.organizationId });
    res.json({ success: true });
  }),
);

app.post(
  "/api/auth/password",
  wrap(async (req, res) => {
    const ctx = await loadSession(req, res);
    if (!ctx) throw fail(401, "Please log in");
    const user = await User.findById(ctx.user.id).select("+passwordHash");
    if (!(await verifyPassword(req.body.current, user.passwordHash)))
      throw fail(400, "Current password is wrong");
    if (String(req.body.next || "").length < 8)
      throw fail(400, "New password must be at least 8 characters");
    user.passwordHash = await hashPassword(req.body.next);
    await user.save();
    await Session.deleteMany({ userId: user.id, _id: { $ne: ctx.sessionId } }); // sign out other devices
    audit({ ctx }, "auth.password_changed", user.id);
    res.json({ success: true });
  }),
);

async function acceptInvite(user, token) {
  const m = await Membership.findOne({
    inviteTokenHash: sha256(token),
    status: "invited",
    inviteExpiresAt: { $gt: new Date() },
  }).select("+inviteTokenHash");
  if (!m) throw fail(400, "This invitation is invalid or has expired");
  if (m.email !== user.email)
    throw fail(403, `This invitation was sent to ${m.email}`);
  m.userId = user.id;
  m.status = "active";
  m.inviteTokenHash = null;
  await m.save();
  audit(
    { ctx: { org: m.organizationId, user: { id: user.id, name: user.name } } },
    "member.joined",
    m.id,
    { role: m.role },
  );
  return m;
}
app.get(
  "/api/auth/invite/:token",
  wrap(async (req, res) => {
    const m = await Membership.findOne({
      inviteTokenHash: sha256(req.params.token),
      status: "invited",
      inviteExpiresAt: { $gt: new Date() },
    }).lean();
    if (!m) throw fail(404, "This invitation is invalid or has expired");
    const org = await Organization.findById(m.organizationId).lean();
    res.json({
      email: m.email,
      role: ROLE_LABEL[m.role] || m.role,
      orgName: org?.name || "a workspace",
      hasAccount: !!(await User.exists({ email: m.email })),
    });
  }),
);
app.post(
  "/api/auth/accept-invite",
  wrap(async (req, res) => {
    const ctx = await loadSession(req, res);
    if (!ctx) throw fail(401, "Please log in");
    const user = await User.findById(ctx.user.id).lean();
    const m = await acceptInvite(
      { id: user._id, email: user.email, name: user.name },
      req.body.token,
    );
    await Session.updateOne(
      { _id: ctx.sessionId },
      { organizationId: m.organizationId },
    );
    res.json({ success: true });
  }),
);

/* ---------- team (FR-AUTH-006) ---------- */
app.get(
  "/api/team",
  wrap(async (req, res) => {
    const mems = await Membership.find({
      organizationId: tid(req),
      status: { $ne: "removed" },
    })
      .sort({ createdAt: 1 })
      .lean();
    const users = Object.fromEntries(
      (
        await User.find({
          _id: { $in: mems.map((m) => m.userId).filter(Boolean) },
        })
          .select("name email lastLoginAt")
          .lean()
      ).map((u) => [u._id, u]),
    );
    res.json({
      roles: Object.entries(ROLE_LABEL).map(([id, label]) => ({ id, label })),
      members: mems.map((m) => ({
        id: m._id,
        email: m.email,
        name: users[m.userId]?.name || null,
        role: m.role,
        roleLabel: ROLE_LABEL[m.role],
        status: m.status,
        lastLoginAt: users[m.userId]?.lastLoginAt || null,
        inviteExpiresAt: m.inviteExpiresAt,
        isYou: m.userId === req.ctx.user.id,
      })),
    });
  }),
);
app.post(
  "/api/team/invite",
  wrap(async (req, res) => {
    const org = tid(req);
    const email = String(req.body.email || "")
      .trim()
      .toLowerCase();
    const role = req.body.role;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
      throw fail(400, "Enter a valid email");
    if (!ROLES[role]) throw fail(400, "Pick a role");
    if (role === "owner" && req.ctx.role !== "owner")
      throw fail(403, "Only an owner can invite another owner");
    const token = crypto.randomBytes(24).toString("hex");
    const existing = await Membership.findOne({ organizationId: org, email });
    if (existing && existing.status === "active")
      throw fail(409, "This person is already a member");
    const data = {
      organizationId: org,
      email,
      role,
      status: "invited",
      inviteTokenHash: sha256(token),
      inviteExpiresAt: new Date(Date.now() + 7 * DAY),
      invitedBy: req.ctx.user.id,
    };
    if (existing) await Membership.updateOne({ _id: existing.id }, data);
    else await Membership.create(data);
    audit(req, "member.invite", email, { role });
    const base = PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
    res.json({
      success: true,
      link: `${base}/?invite=${token}`,
      expiresInDays: 7,
    });
  }),
);
app.put(
  "/api/team/:id",
  wrap(async (req, res) => {
    const org = tid(req);
    const m = await Membership.findOne({
      _id: req.params.id,
      organizationId: org,
    });
    if (!m) throw fail(404, "Member not found");
    const p = pick(req.body, ["role", "status", "pageIds"]);
    if (p.role && !ROLES[p.role]) throw fail(400, "Unknown role");
    if (p.status && !["active", "suspended"].includes(p.status))
      throw fail(400, "Status must be active or suspended");
    if (
      m.role === "owner" &&
      ((p.role && p.role !== "owner") || p.status === "suspended") &&
      (await Membership.countDocuments({
        organizationId: org,
        role: "owner",
        status: "active",
      })) <= 1
    )
      throw fail(400, "A workspace needs at least one active owner");
    if (p.role === "owner" && req.ctx.role !== "owner")
      throw fail(403, "Only an owner can make someone an owner");
    Object.assign(m, p);
    await m.save();
    if (p.status === "suspended" && m.userId)
      await Session.deleteMany({ userId: m.userId, organizationId: org });
    audit(req, "member.update", m.email, p);
    res.json({ success: true });
  }),
);
app.delete(
  "/api/team/:id",
  wrap(async (req, res) => {
    const org = tid(req);
    const m = await Membership.findOne({
      _id: req.params.id,
      organizationId: org,
    });
    if (!m) throw fail(404, "Member not found");
    if (m.userId === req.ctx.user.id)
      throw fail(400, "You can't remove yourself");
    if (
      m.role === "owner" &&
      (await Membership.countDocuments({
        organizationId: org,
        role: "owner",
        status: "active",
      })) <= 1
    )
      throw fail(400, "A workspace needs at least one owner");
    m.status = "removed";
    m.inviteTokenHash = null;
    await m.save();
    if (m.userId)
      await Session.deleteMany({ userId: m.userId, organizationId: org });
    audit(req, "member.remove", m.email);
    res.json({ success: true });
  }),
);
app.get(
  "/api/audit",
  wrap(async (req, res) => {
    const q = { organizationId: tid(req) };
    if (req.query.action) q.action = new RegExp("^" + escRe(req.query.action));
    res.json(
      await AuditLog.find(q)
        .sort({ createdAt: -1 })
        .limit(Math.min(Number(req.query.limit) || 200, 1000)),
    );
  }),
);

/* ---------- connect ---------- */
mongoose
  .connect(process.env.DATABASE_URL)
  .then(async () => {
    console.log("✅ MongoDB connected");
    const missing = [
      ["Conversation", Conversation, "orderDraft"],
      ["Conversation", Conversation, "aiHandled"],
      ["Brand", Brand, "facts"],
      ["Product", Product, "variants"],
      ["Order", Order, "events"],
      ["User", User, "email"],
      ["Comment", Comment, "intent"],
    ]
      .filter(([, M, p]) => !M || !M.schema.path(p))
      .map(([n, , p]) => `${n}.${p}`);
    if (missing.length)
      console.error(
        `\n❌ schema.js is OUTDATED (missing ${missing.join(", ")}). Replace schema.js with the new one or data will not be saved.\n`,
      );
    await ensureWorkspace();
    await migrateProducts().catch((e) =>
      console.error("product migration:", e.message),
    );
    startJobs();
  })
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err);
    process.exit(1);
  });

app.get("/api/health", (_req, res) =>
  res.json({
    ok: mongoose.connection.readyState === 1,
    ai: aiConfigured(),
    meta: !!process.env.FB_APP_ID,
    publicUrl: !!PUBLIC_BASE_URL,
    auth: AUTH_ON,
  }),
);

/* =====================================================
   META GRAPH API HELPERS
   ===================================================== */
const FB_APP_ID = process.env.FB_APP_ID;
const FB_APP_SECRET = process.env.FB_APP_SECRET;
const FB_REDIRECT_URI =
  process.env.FB_REDIRECT_URI ||
  `http://localhost:${process.env.PORT || 3000}/auth/facebook/callback`;
const GRAPH_VER = process.env.FB_GRAPH_VERSION || "v23.0";
const GRAPH = `https://graph.facebook.com/${GRAPH_VER}`;
const GRAPH_VIDEO = `https://graph-video.facebook.com/${GRAPH_VER}`;

// GET params go in the query string, POST bodies are sent as JSON (nested objects allowed).
async function graph(
  p,
  { token, params = {}, method = "GET", body, base = GRAPH } = {},
) {
  const url = new URL(p.startsWith("http") ? p : base + p);
  const q = { ...params };
  if (token) q.access_token = token;
  Object.entries(q).forEach(
    ([k, v]) =>
      v != null &&
      url.searchParams.set(
        k,
        typeof v === "object" ? JSON.stringify(v) : String(v),
      ),
  );
  const opts = { method };
  if (body && method !== "GET") {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(
      Object.fromEntries(
        Object.entries(body).filter(([, v]) => v !== undefined),
      ),
    );
  }
  const r = await fetch(url, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    const e = j.error || {};
    throw fail(
      502,
      e.error_user_msg || e.message || `Meta API error ${r.status}`,
      {
        code: e.code,
        subcode: e.error_subcode,
        type: e.type,
        fbtrace_id: e.fbtrace_id,
      },
    );
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
const NO_MINOR = new Set([
  "JPY",
  "KRW",
  "CLP",
  "COP",
  "CRC",
  "HUF",
  "ISK",
  "IDR",
  "PYG",
  "TWD",
  "VND",
]);
const minorDiv = (cur) =>
  NO_MINOR.has(String(cur || "").toUpperCase()) ? 1 : 100;

// Permissions each feature needs (shown as "missing" in the accounts screen)
const REQUIRED_SCOPES = {
  Facebook: [
    "pages_show_list",
    "pages_read_engagement",
    "pages_manage_posts",
    "read_insights",
    "pages_manage_metadata",
    "leads_retrieval",
  ],
  Instagram: [
    "instagram_basic",
    "instagram_content_publish",
    "instagram_manage_insights",
  ],
  "Meta Ads": ["ads_read", "ads_management"],
};
const OAUTH_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "pages_manage_metadata",
  "read_insights",
  "instagram_basic",
  "instagram_content_publish",
  "instagram_manage_insights",
  "instagram_manage_messages",
  "business_management",
  "ads_read",
  "ads_management",
  "leads_retrieval",
].join(",");

const publicUrl = (u) =>
  !u
    ? null
    : /^https?:\/\//.test(u)
      ? u
      : PUBLIC_BASE_URL
        ? PUBLIC_BASE_URL + u
        : null;
const isPublicBase = () =>
  !!PUBLIC_BASE_URL && !/localhost|127\.0\.0\.1/.test(PUBLIC_BASE_URL);

const accView = (a) => {
  const o = a.toJSON ? a.toJSON() : { ...a };
  delete o.accessToken;
  const need = REQUIRED_SCOPES[o.platform] || [];
  o.missingScopes = o.scopes?.length
    ? need.filter((s) => !o.scopes.includes(s))
    : null; // null = unknown
  return o;
};

async function adAccountFor(org, adAccountId) {
  const acc = await SocialAccount.findOne({
    organizationId: org,
    platform: "Meta Ads",
    ...(adAccountId ? { accountId: adAccountId } : {}),
  }).select("+accessToken");
  if (!acc)
    throw fail(
      400,
      "No Meta ad account connected. Connect Facebook with ads permissions first.",
    );
  return acc;
}

/* =====================================================
   FACEBOOK LOGIN (OAuth) + ACCOUNT HUB
   ===================================================== */
const OAUTH_STATES = new Map(); // state -> { org, at }  (single-server; move to Mongo/Redis when scaling)

app.get("/api/meta/connect", (req, res) => {
  if (req.ctx && !can(req.ctx.role, "pages.write"))
    return res
      .status(403)
      .send("Only an Owner or Manager can connect Facebook.");
  if (!FB_APP_ID || !FB_APP_SECRET)
    return res
      .status(400)
      .send("Set FB_APP_ID and FB_APP_SECRET in .env first.");
  const state = crypto.randomBytes(24).toString("hex");
  OAUTH_STATES.set(state, { org: tid(req), at: Date.now() });
  for (const [k, v] of OAUTH_STATES)
    if (Date.now() - v.at > 15 * 60e3) OAUTH_STATES.delete(k);
  const u = new URL(`https://www.facebook.com/${GRAPH_VER}/dialog/oauth`);
  u.searchParams.set("client_id", FB_APP_ID);
  u.searchParams.set("redirect_uri", FB_REDIRECT_URI);
  u.searchParams.set("state", state);
  u.searchParams.set("response_type", "code");
  if (process.env.FB_CONFIG_ID)
    u.searchParams.set("config_id", process.env.FB_CONFIG_ID);
  else u.searchParams.set("scope", OAUTH_SCOPES);
  res.redirect(u.toString());
});

app.get("/auth/facebook/callback", async (req, res) => {
  const back = (q) => res.redirect(`/?view=pages&${q}`);
  try {
    const { code, state, error, error_description } = req.query;
    if (error)
      return back("error=" + encodeURIComponent(error_description || error));
    const st = OAUTH_STATES.get(state);
    if (!st)
      return back(
        "error=" +
          encodeURIComponent("Login expired or invalid state. Try again."),
      );
    OAUTH_STATES.delete(state);
    const org = st.org;

    const short = await graph("/oauth/access_token", {
      params: {
        client_id: FB_APP_ID,
        client_secret: FB_APP_SECRET,
        redirect_uri: FB_REDIRECT_URI,
        code,
      },
    });
    const long = await graph("/oauth/access_token", {
      params: {
        grant_type: "fb_exchange_token",
        client_id: FB_APP_ID,
        client_secret: FB_APP_SECRET,
        fb_exchange_token: short.access_token,
      },
    });
    const userToken = long.access_token;
    const userExpires = long.expires_in
      ? new Date(Date.now() + long.expires_in * 1000)
      : null;

    const perms = await graph("/me/permissions", { token: userToken });
    const scopes = (perms.data || [])
      .filter((p) => p.status === "granted")
      .map((p) => p.permission);

    const upsert = (platform, accountId, set) =>
      SocialAccount.findOneAndUpdate(
        { organizationId: org, platform, accountId },
        {
          $set: {
            ...set,
            platform,
            accountId,
            organizationId: org,
            scopes,
            connectedVia: "oauth",
            status: "active",
            healthNote: null,
            lastCheckedAt: new Date(),
          },
        },
        { upsert: true, new: true },
      );

    // Pages + linked Instagram professional accounts (page tokens from a long-lived user token do not expire)
    const pages = await graphAll("/me/accounts", {
      token: userToken,
      params: {
        fields:
          "id,name,access_token,tasks,picture{url},instagram_business_account{id,username,profile_picture_url}",
        limit: 100,
      },
    });
    let nPages = 0,
      nIg = 0,
      nAds = 0;
    for (const p of pages) {
      await upsert("Facebook", p.id, {
        accountName: p.name,
        accessToken: encrypt(p.access_token),
        tasks: p.tasks || [],
        pictureUrl: p.picture?.data?.url || null,
        tokenExpiresAt: null,
      });
      nPages++;
      const ig = p.instagram_business_account;
      if (ig) {
        await upsert("Instagram", ig.id, {
          accountName: ig.username || p.name,
          username: ig.username,
          pageId: p.id,
          pictureUrl: ig.profile_picture_url || null,
          accessToken: encrypt(p.access_token),
          tasks: p.tasks || [],
          tokenExpiresAt: null,
        });
        nIg++;
      }
    }
    // Ad accounts (Marketing API uses the user token, ~60 days; reconnect before it expires)
    if (scopes.includes("ads_read") || scopes.includes("ads_management")) {
      const ads = await graphAll("/me/adaccounts", {
        token: userToken,
        params: {
          fields:
            "id,name,account_status,currency,timezone_name,business{id,name}",
          limit: 100,
        },
      }).catch(() => []);
      for (const a of ads) {
        await upsert("Meta Ads", a.id, {
          accountName: a.name || a.id,
          currency: a.currency,
          timezone: a.timezone_name,
          businessId: a.business?.id || null,
          businessName: a.business?.name || null,
          accessToken: encrypt(userToken),
          tokenExpiresAt: userExpires,
          healthNote:
            a.account_status === 1
              ? null
              : `Ad account status ${a.account_status}`,
        });
        nAds++;
      }
    }
    // Business portfolios
    if (scopes.includes("business_management")) {
      const biz = await graphAll("/me/businesses", {
        token: userToken,
        params: { fields: "id,name" },
      }).catch(() => []);
      await Organization.updateOne(
        { _id: org },
        { metaBusinesses: biz.map((b) => ({ id: b.id, name: b.name })) },
      );
    }
    back(`connected=1&pages=${nPages}&ig=${nIg}&ads=${nAds}`);
  } catch (e) {
    console.error("Facebook callback:", e.meta || e);
    back("error=" + encodeURIComponent(e.message));
  }
});

// List accounts (tokens never leave the server)
app.get(
  "/api/integrations",
  wrap(async (req, res) => {
    const q = { organizationId: tid(req) };
    if (req.query.platform) q.platform = req.query.platform;
    if (req.query.brandId) q.brandId = req.query.brandId;
    const rows = await SocialAccount.find(q).sort({
      platform: 1,
      createdAt: -1,
    });
    res.json(rows.map(accView));
  }),
);

// Manual connect (advanced: paste a page token)
app.post(
  "/api/integrations/connect",
  wrap(async (req, res) => {
    const {
      organizationId,
      platform,
      accountName,
      accountId,
      accessToken,
      pageId,
      brandId,
      clientName,
    } = req.body;
    if (!platform || !accountName || !accountId || !accessToken)
      throw fail(
        400,
        "platform, accountName, accountId and accessToken are required",
      );
    const a = await SocialAccount.create({
      organizationId: organizationId || tid(req),
      platform,
      accountName,
      accountId,
      pageId: pageId || null,
      brandId: brandId || null,
      clientName: clientName || null,
      accessToken: encrypt(accessToken),
    });
    res.json({ success: true, account: accView(a) });
  }),
);

// Assign brand / agency client
app.put(
  "/api/integrations/:id",
  wrap(async (req, res) => {
    const patch = pick(req.body, ["brandId", "clientName", "accountName"]);
    const a = await SocialAccount.findOneAndUpdate(
      { _id: req.params.id, organizationId: tid(req) },
      patch,
      { new: true },
    );
    if (!a) throw fail(404, "Account not found");
    res.json({ success: true, account: accView(a) });
  }),
);

app.delete(
  "/api/integrations/:id",
  wrap(async (req, res) => {
    const r = await SocialAccount.deleteOne({
      _id: req.params.id,
      organizationId: tid(req),
    });
    if (!r.deletedCount)
      return res.status(404).json({ error: "Account not found" });
    res.json({ success: true });
  }),
);

// Token health monitoring (debug_token)
async function checkTokens(org) {
  const accs = await SocialAccount.find({
    organizationId: org,
    platform: { $in: ["Facebook", "Instagram", "Meta Ads"] },
  }).select("+accessToken");
  const out = [];
  for (const a of accs) {
    const before = a.status;
    try {
      if (FB_APP_ID && FB_APP_SECRET) {
        const d =
          (
            await graph("/debug_token", {
              params: {
                input_token: tok(a),
                access_token: `${FB_APP_ID}|${FB_APP_SECRET}`,
              },
            })
          ).data || {};
        if (d.scopes?.length) a.scopes = d.scopes;
        a.tokenExpiresAt = d.expires_at ? new Date(d.expires_at * 1000) : null;
        a.status = !d.is_valid
          ? "expired"
          : a.tokenExpiresAt && a.tokenExpiresAt - Date.now() < 7 * DAY
            ? "expiring"
            : "active";
        a.healthNote =
          d.error?.message ||
          (a.status === "expiring"
            ? "Token expires soon. Reconnect Facebook."
            : null);
      } else {
        await graph("/me", { token: tok(a), params: { fields: "id" } });
        a.status = "active";
        a.healthNote = "Set FB_APP_ID/SECRET for full token checks";
      }
    } catch (e) {
      a.status = /expired|session|validat/i.test(e.message)
        ? "expired"
        : "error";
      a.healthNote = e.message;
    }
    a.lastCheckedAt = new Date();
    await a.save();
    if (
      before !== a.status &&
      ["expired", "expiring", "error"].includes(a.status)
    ) {
      await notify(
        org,
        "token",
        `${a.platform} account needs attention`,
        `${a.accountName}: ${a.healthNote || a.status}`,
        "pages",
      );
    }
    out.push(accView(a));
  }
  return out;
}
app.post(
  "/api/integrations/health",
  wrap(async (req, res) => res.json(await checkTokens(tid(req)))),
);

// Business portfolios and their assets
app.get(
  "/api/meta/businesses",
  wrap(async (req, res) => {
    const o = await Organization.findById(tid(req)).lean();
    res.json(o?.metaBusinesses || []);
  }),
);
app.get(
  "/api/meta/businesses/:id/assets",
  wrap(async (req, res) => {
    const acc =
      (await adAccountFor(tid(req)).catch(() => null)) ||
      (await SocialAccount.findOne({
        organizationId: tid(req),
        connectedVia: "oauth",
      }).select("+accessToken"));
    if (!acc) throw fail(400, "Connect Facebook first");
    const token = tok(acc),
      id = req.params.id;
    const safe = (p, f) =>
      graphAll(`/${id}/${p}`, {
        token,
        params: { fields: f, limit: 100 },
      }).catch((e) => ({ error: e.message }));
    const [pages, adAccounts, clientAdAccounts] = await Promise.all([
      safe("owned_pages", "id,name"),
      safe("owned_ad_accounts", "id,name,currency,account_status"),
      safe("client_ad_accounts", "id,name,currency,account_status"),
    ]);
    res.json({ pages, adAccounts, clientAdAccounts });
  }),
);

/* =====================================================
   AI GATEWAY (OpenAI-compatible: OpenAI, Groq, OpenRouter, Ollama, vLLM...)
   ===================================================== */
const AI_BASE = (
  process.env.AI_BASE_URL || "https://api.openai.com/v1"
).replace(/\/$/, "");
const AI_MODEL = process.env.AI_MODEL || "gpt-4o-mini";
const aiConfigured = () =>
  !!(process.env.AI_API_KEY || process.env.AI_BASE_URL);
const aiHeaders = () => ({
  "Content-Type": "application/json",
  ...(process.env.AI_API_KEY
    ? { Authorization: `Bearer ${process.env.AI_API_KEY}` }
    : {}),
});

function parseJSON(text) {
  const t = String(text || "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  try {
    return JSON.parse(t);
  } catch {}
  const a = t.indexOf("{"),
    b = t.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try {
      return JSON.parse(t.slice(a, b + 1));
    } catch {}
  }
  throw fail(
    502,
    "AI returned invalid JSON. Try again or use a stronger model.",
  );
}

async function aiChat(
  org,
  task,
  { system, user, json = true, temperature = 0.7, maxTokens = 3000 },
) {
  if (!aiConfigured())
    throw fail(
      503,
      "AI is not configured. Set AI_BASE_URL, AI_API_KEY and AI_MODEL in .env",
    );
  const body = {
    model: AI_MODEL,
    temperature,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
  if (json) body.response_format = { type: "json_object" };
  let r = await fetch(`${AI_BASE}/chat/completions`, {
    method: "POST",
    headers: aiHeaders(),
    body: JSON.stringify(body),
  });
  if (!r.ok && json && r.status === 400) {
    // some providers don't support response_format
    delete body.response_format;
    r = await fetch(`${AI_BASE}/chat/completions`, {
      method: "POST",
      headers: aiHeaders(),
      body: JSON.stringify(body),
    });
  }
  const j = await r.json().catch(() => ({}));
  const usage = j.usage || {};
  AiUsage.create({
    organizationId: org,
    task,
    model: AI_MODEL,
    promptTokens: usage.prompt_tokens || 0,
    completionTokens: usage.completion_tokens || 0,
    ok: r.ok,
  }).catch(() => {});
  if (!r.ok)
    throw fail(502, `AI provider error: ${j.error?.message || r.status}`);
  const text = j.choices?.[0]?.message?.content || "";
  return json ? parseJSON(text) : text;
}
const aiJSON = (org, task, system, user, opts = {}) =>
  aiChat(org, task, { system, user, ...opts });

const LANG = {
  bn: "Bangla (Bengali script, natural Bangladeshi style)",
  en: "English",
  banglish: "Banglish (Bangla written with English letters, casual)",
  mixed:
    "Bangla mixed with common English words, the way Bangladeshi brands write online",
};

/* ---------- brand context = the "approved knowledge" every prompt is grounded in ---------- */
async function getBrand(org, brandId) {
  if (brandId) {
    const b = await Brand.findOne({ _id: brandId, organizationId: org });
    if (b) return b;
  }
  return Brand.findOne({ organizationId: org }).sort({
    isDefault: -1,
    createdAt: 1,
  });
}
async function brandContext(org, brandId, { products = true } = {}) {
  const b = await getBrand(org, brandId);
  const prods = products
    ? await Product.find({ organizationId: org })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean()
    : [];
  const parts = [];
  if (b) {
    parts.push(
      `BRAND: ${b.name}${b.industry ? ` (industry: ${b.industry})` : ""}`,
    );
    if (b.description) parts.push(`ABOUT: ${b.description}`);
    if (b.website) parts.push(`WEBSITE: ${b.website}`);
    parts.push(`TONE: ${b.tone}${b.voice ? `. VOICE GUIDE: ${b.voice}` : ""}`);
    if (b.audience) parts.push(`TARGET AUDIENCE: ${b.audience}`);
    if (b.pillars?.length)
      parts.push(
        `CONTENT PILLARS: ${b.pillars.map((p) => `${p.name}${p.description ? ` (${p.description})` : ""}`).join("; ")}`,
      );
    if (b.offerings) parts.push(`PRODUCTS/SERVICES: ${b.offerings}`);
    if (b.facts?.length)
      parts.push(
        `APPROVED FACTS (the ONLY facts you may state about prices, offers, delivery, policies):\n- ${b.facts.join("\n- ")}`,
      );
    if (b.prohibited?.length)
      parts.push(`NEVER SAY / PROHIBITED CLAIMS: ${b.prohibited.join("; ")}`);
    if (b.hashtags?.length)
      parts.push(`BRAND HASHTAGS: ${b.hashtags.join(" ")}`);
    if (b.defaultCta) parts.push(`DEFAULT CTA: ${b.defaultCta}`);
  } else
    parts.push(
      "BRAND: (no brand profile yet; write generic but professional content)",
    );
  if (prods.length)
    parts.push(
      `CATALOGUE (name | price BDT | category | stock):\n${prods.map((p) => `- ${p.name} | ${p.price} | ${p.category} | ${p.stock > 0 ? "in stock" : "out of stock"}`).join("\n")}`,
    );
  return { brand: b, text: parts.join("\n") };
}
const GROUNDING =
  "Rules: use only the approved facts and catalogue for prices, discounts, delivery and policies. If a detail is missing, do not invent it; write around it or use a placeholder like [price]. Never use prohibited claims. No fake reviews, fake urgency or misleading claims. Follow Meta advertising policies.";

// Bangladesh + global marketing calendar hints (lunar dates shift every year: AI is told to flag them)
const SEASONAL = {
  1: "New Year; winter sale; Thirty-First Night aftermath; Bishwa Ijtema",
  2: "21 Feb International Mother Language Day; Pohela Falgun (13 Feb); Valentine's Day (14 Feb); Ekushey Boi Mela",
  3: "26 Mar Independence Day; Ramadan / Eid-ul-Fitr may fall here (lunar)",
  4: "14 Apr Pohela Boishakh (Bangla New Year); Eid season (lunar)",
  5: "Mother's Day (2nd Sunday); Eid-ul-Adha may fall here (lunar); summer",
  6: "Father's Day (3rd Sunday); national budget; monsoon begins",
  7: "Monsoon; back-to-school; HSC exams",
  8: "Monsoon; 15 Aug National Mourning Day (avoid celebratory tone)",
  9: "Durga Puja may begin (lunar); autumn",
  10: "Durga Puja (lunar); Halloween (urban youth)",
  11: "11.11 sale; Black Friday; winter collection launch",
  12: "16 Dec Victory Day; 12.12 sale; Christmas; year-end sale; winter",
};
const seasonalFor = (start, months = 1) =>
  Array.from({ length: months }, (_, i) => {
    const m = ((new Date(start).getMonth() + i) % 12) + 1;
    return `Month ${m}: ${SEASONAL[m]}`;
  }).join("\n");

app.get(
  "/api/ai/status",
  wrap(async (req, res) => {
    const since = new Date(Date.now() - 30 * DAY);
    const [u] = await AiUsage.aggregate([
      { $match: { organizationId: tid(req), createdAt: { $gte: since } } },
      {
        $group: {
          _id: null,
          calls: { $sum: 1 },
          prompt: { $sum: "$promptTokens" },
          completion: { $sum: "$completionTokens" },
        },
      },
    ]);
    const byTask = await AiUsage.aggregate([
      { $match: { organizationId: tid(req), createdAt: { $gte: since } } },
      {
        $group: {
          _id: "$task",
          calls: { $sum: 1 },
          tokens: { $sum: { $add: ["$promptTokens", "$completionTokens"] } },
        },
      },
      { $sort: { calls: -1 } },
    ]);
    res.json({
      configured: aiConfigured(),
      model: AI_MODEL,
      imageModel: process.env.AI_IMAGE_MODEL || null,
      last30d: u || { calls: 0, prompt: 0, completion: 0 },
      byTask,
    });
  }),
);

/* =====================================================
   BRANDS (multiple brands, agency clients, voice, colours, logo)
   ===================================================== */
const BRAND_FIELDS = [
  "name",
  "clientName",
  "industry",
  "description",
  "website",
  "tone",
  "voice",
  "audience",
  "pillars",
  "offerings",
  "facts",
  "prohibited",
  "hashtags",
  "languages",
  "defaultCta",
  "colors",
  "logoUrl",
  "isDefault",
];
function cleanBrand(b) {
  const p = pick(b, BRAND_FIELDS);
  for (const k of ["facts", "prohibited"]) if (k in p) p[k] = linesNL(p[k]);
  if ("languages" in p) p.languages = lines(p.languages);
  if ("hashtags" in p)
    p.hashtags = lines(String(p.hashtags).replace(/\s+/g, ",")).map((h) =>
      h.startsWith("#") ? h : "#" + h,
    );
  if ("pillars" in p)
    p.pillars = (Array.isArray(p.pillars) ? p.pillars : linesNL(p.pillars)).map(
      (x) => {
        if (typeof x === "object") return x;
        const [name, ...rest] = String(x).split(/[:\-–—]/);
        return { name: name.trim(), description: rest.join("-").trim() };
      },
    );
  return p;
}
app.get(
  "/api/brands",
  wrap(async (req, res) =>
    res.json(
      await Brand.find({ organizationId: tid(req) }).sort({
        isDefault: -1,
        name: 1,
      }),
    ),
  ),
);
app.get(
  "/api/brands/:id",
  wrap(async (req, res) => {
    const b = await Brand.findOne({
      _id: req.params.id,
      organizationId: tid(req),
    });
    if (!b) throw fail(404, "Brand not found");
    res.json(b);
  }),
);
app.post(
  "/api/brands",
  wrap(async (req, res) => {
    const org = tid(req);
    const data = cleanBrand(req.body);
    if (!data.name) throw fail(400, "Brand name is required");
    if (!(await Brand.exists({ organizationId: org }))) data.isDefault = true;
    if (data.isDefault)
      await Brand.updateMany({ organizationId: org }, { isDefault: false });
    res.json({
      success: true,
      brand: await Brand.create({ ...data, organizationId: org }),
    });
  }),
);
app.put(
  "/api/brands/:id",
  wrap(async (req, res) => {
    const org = tid(req);
    const data = cleanBrand(req.body);
    if (data.isDefault)
      await Brand.updateMany({ organizationId: org }, { isDefault: false });
    const b = await Brand.findOneAndUpdate(
      { _id: req.params.id, organizationId: org },
      data,
      { new: true, runValidators: true },
    );
    if (!b) throw fail(404, "Brand not found");
    res.json({ success: true, brand: b });
  }),
);
app.delete(
  "/api/brands/:id",
  wrap(async (req, res) => {
    const org = tid(req);
    await Brand.deleteOne({ _id: req.params.id, organizationId: org });
    await SocialAccount.updateMany(
      { organizationId: org, brandId: req.params.id },
      { brandId: null },
    );
    res.json({ success: true });
  }),
);

/* =====================================================
   AI CONTENT STRATEGY & PLANNING (1.2)
   ===================================================== */
async function performanceDigest(org, brandId, limit = 8) {
  const q = {
    organizationId: org,
    status: { $in: ["Published", "Partially Published"] },
  };
  if (brandId) q.brandId = brandId;
  const items = await ContentItem.find(q)
    .sort({ publishedAt: -1 })
    .limit(60)
    .lean();
  const scored = items
    .map((i) => {
      const m = (i.targets || []).reduce(
        (a, t) => ({
          reach: a.reach + (t.metrics?.reach || 0),
          eng: a.eng + (t.metrics?.engagement || 0),
        }),
        { reach: 0, eng: 0 },
      );
      return {
        title: i.title,
        type: i.type,
        format: i.format,
        pillar: i.pillar,
        reach: m.reach,
        engagement: m.eng,
        rate: m.reach ? round((m.eng / m.reach) * 100) : 0,
        text: (i.body || "").slice(0, 140),
      };
    })
    .filter((x) => x.reach > 0)
    .sort((a, b) => b.rate - a.rate);
  return {
    top: scored.slice(0, limit),
    bottom: scored
      .slice(-Math.min(limit, Math.floor(scored.length / 2)))
      .reverse(),
    total: items.length,
  };
}

async function businessDigest(org) {
  const since = new Date(Date.now() - 90 * DAY);
  const [orders, leadsBySource, topProducts] = await Promise.all([
    Order.aggregate([
      {
        $match: {
          organizationId: org,
          createdAt: { $gte: since },
          status: { $ne: "cancelled" },
        },
      },
      {
        $group: {
          _id: "$channel",
          n: { $sum: 1 },
          revenue: { $sum: "$total" },
          avg: { $avg: "$total" },
        },
      },
    ]),
    Lead.aggregate([
      { $match: { organizationId: org, createdAt: { $gte: since } } },
      {
        $group: {
          _id: {
            source: "$source",
            status: "$aiStatus",
            category: "$category",
          },
          n: { $sum: 1 },
        },
      },
    ]),
    Order.aggregate([
      { $match: { organizationId: org, createdAt: { $gte: since } } },
      { $unwind: "$items" },
      { $group: { _id: "$items.name", qty: { $sum: "$items.qty" } } },
      { $sort: { qty: -1 } },
      { $limit: 10 },
    ]),
  ]);
  const areas = await Order.aggregate([
    { $match: { organizationId: org, createdAt: { $gte: since } } },
    { $project: { a: { $arrayElemAt: [{ $split: ["$address", ","] }, -1] } } },
    { $group: { _id: { $trim: { input: "$a" } }, n: { $sum: 1 } } },
    { $sort: { n: -1 } },
    { $limit: 8 },
  ]);
  return {
    ordersByChannel: orders,
    leadsBySource,
    topProducts,
    topAreas: areas,
  };
}

async function savePlan(org, data) {
  return ContentPlan.create({ organizationId: org, ...data });
}

const STRATEGY_SHAPE = `{"summary":"","objectives":[{"objective":"","kpi":"","target":""}],"audienceSegments":[{"name":"","needs":"","message":""}],"positioning":"","pillars":[{"name":"","share":"30%","ideas":[""]}],"channelMix":[{"platform":"","role":"","cadence":""}],"campaignIdeas":[{"name":"","timing":"","concept":"","offer":"","channels":[""]}],"paidStrategy":{"budgetSplit":"","objectives":"","audiences":""},"contentFormats":[""],"kpis":[""],"risks":[""],"next30Days":[""]}`;

app.post(
  "/api/ai/strategy",
  wrap(async (req, res) => {
    const org = tid(req);
    const { brandId, goal, period = "next 3 months", budget, extra } = req.body;
    const ctx = await brandContext(org, brandId);
    const [perf, biz] = await Promise.all([
      performanceDigest(org, brandId, 5),
      businessDigest(org),
    ]);
    const data = await aiJSON(
      org,
      "strategy",
      `You are a senior digital marketing strategist for Bangladeshi and global SMEs on Facebook and Instagram. Return JSON only in this shape: ${STRATEGY_SHAPE}. ${GROUNDING}`,
      `${ctx.text}\n\nGOAL: ${goal || "grow sales and leads"}\nPERIOD: ${period}\nMONTHLY AD BUDGET: ${budget || "not given"}\nEXTRA NOTES: ${extra || "-"}\n\nRECENT CONTENT PERFORMANCE: ${JSON.stringify(perf.top)}\nBUSINESS DATA (90 days): ${JSON.stringify(biz)}\nSEASONAL CONTEXT:\n${seasonalFor(new Date(), 3)}\nIndustry: tailor the strategy to the brand's industry.`,
      { maxTokens: 3500 },
    );
    const plan = await savePlan(org, {
      brandId: ctx.brand?.id || null,
      kind: "strategy",
      title: `Strategy: ${goal || "Growth"} (${period})`,
      input: req.body,
      data,
    });
    res.json({ success: true, plan });
  }),
);

// Monthly plan / weekly calendar / seasonal campaign / product-based plan
app.post(
  "/api/ai/plan",
  wrap(async (req, res) => {
    const org = tid(req);
    const {
      brandId,
      kind = "monthly",
      startDate,
      platforms = ["Facebook", "Instagram"],
      postsPerWeek = 5,
      goal,
      campaignName,
      productIds = [],
      includeSeasonal = true,
      language = "bn",
    } = req.body;
    const start = startDate ? new Date(startDate) : new Date(Date.now() + DAY);
    const days =
      kind === "weekly"
        ? 7
        : kind === "campaign"
          ? Number(req.body.days) || 14
          : 30;
    const end = new Date(start.getTime() + (days - 1) * DAY);
    const ctx = await brandContext(org, brandId);
    const focus = productIds.length
      ? await Product.find({
          organizationId: org,
          _id: { $in: productIds },
        }).lean()
      : [];
    const perf = await performanceDigest(org, brandId, 5);
    const count = Math.max(1, Math.round((postsPerWeek * days) / 7));
    const data = await aiJSON(
      org,
      "plan_" + kind,
      `You are a social media content planner. Return JSON only: {"theme":"","summary":"","items":[{"date":"YYYY-MM-DD","platform":"Facebook|Instagram","format":"post|carousel|reel|story","pillar":"","topic":"","angle":"","caption":"short draft caption in the requested language","cta":""}]}. Spread posts sensibly across the period (best times for Bangladesh audiences are usually evenings), balance pillars, mix formats per platform. ${GROUNDING}`,
      `${ctx.text}\n\nPLAN TYPE: ${kind}${campaignName ? ` (campaign: ${campaignName})` : ""}\nPERIOD: ${ymd(start)} to ${ymd(end)}\nPLATFORMS: ${platforms.join(", ")}\nNUMBER OF POSTS: about ${count}\nGOAL: ${goal || "engagement and sales"}\nLANGUAGE FOR CAPTIONS: ${LANG[language] || language}\n${focus.length ? `FOCUS PRODUCTS: ${focus.map((p) => `${p.name} (${p.price} BDT)`).join(", ")}\n` : ""}${includeSeasonal ? `SEASONAL CONTEXT (verify lunar dates):\n${seasonalFor(start, Math.ceil(days / 30))}\n` : ""}BEST PERFORMING PAST POSTS: ${JSON.stringify(perf.top)}`,
      { maxTokens: 4000 },
    );
    const items = (data.items || []).map((i) => ({
      ...i,
      date: i.date ? new Date(i.date + "T18:00:00") : start,
    }));
    const plan = await savePlan(org, {
      brandId: ctx.brand?.id || null,
      kind,
      title:
        campaignName ||
        `${kind === "weekly" ? "Weekly calendar" : kind === "campaign" ? "Campaign plan" : "Monthly plan"} ${ymd(start)}`,
      input: req.body,
      data: { theme: data.theme, summary: data.summary },
      items,
      startDate: start,
      endDate: end,
    });
    res.json({ success: true, plan });
  }),
);

app.post(
  "/api/ai/audience",
  wrap(async (req, res) => {
    const org = tid(req);
    const ctx = await brandContext(org, req.body.brandId);
    const biz = await businessDigest(org);
    const data = await aiJSON(
      org,
      "audience",
      `You are a marketing analyst. Analyse the target audience. Return JSON: {"summary":"","segments":[{"name":"","size":"small|medium|large","demographics":"","interests":[""],"painPoints":[""],"buyingTriggers":[""],"bestChannels":[""],"messageAngle":"","metaTargetingIdeas":[""]}],"insightsFromData":[""],"gaps":[""]}. Base data-driven insights only on the supplied numbers; label assumptions clearly.`,
      `${ctx.text}\n\nBUSINESS DATA (90 days): ${JSON.stringify(biz)}`,
    );
    const plan = await savePlan(org, {
      brandId: ctx.brand?.id || null,
      kind: "audience",
      title: `Audience analysis ${ymd(new Date())}`,
      input: req.body,
      data,
    });
    res.json({ success: true, plan });
  }),
);

// trends | competitors | seasonal | performance | industry
app.post(
  "/api/ai/research",
  wrap(async (req, res) => {
    const org = tid(req);
    const { brandId, kind = "trends", notes } = req.body;
    const ctx = await brandContext(org, brandId);
    let extra = "";
    if (kind === "competitors") {
      const comps = await Competitor.find({ organizationId: org }).lean();
      extra = `COMPETITOR DATA (public): ${JSON.stringify(comps.map((c) => ({ name: c.name, latest: c.latest ? { ...c.latest, posts: (c.latest.posts || []).slice(0, 8).map((p) => ({ caption: (p.caption || "").slice(0, 200), likes: p.like_count, comments: p.comments_count, type: p.media_type })) } : null, notes: (c.notes || []).slice(-10) })))}`;
    }
    if (kind === "performance")
      extra = `OWN CONTENT PERFORMANCE: ${JSON.stringify(await performanceDigest(org, brandId, 10))}`;
    if (kind === "seasonal")
      extra = `SEASONAL CONTEXT (next 3 months, verify lunar dates):\n${seasonalFor(new Date(), 3)}`;
    const shapes = {
      trends: `{"summary":"","topics":[{"topic":"","whyNow":"","contentIdea":"","format":"","confidence":"low|medium|high"}],"hashtagIdeas":[""],"note":"These are AI-suggested themes, not live trend data"}`,
      competitors: `{"summary":"","patterns":[{"competitor":"","whatTheyPost":"","frequency":"","whatWorks":"","offers":""}],"gaps":[""],"ideasForUs":[{"idea":"","why":""}]}`,
      seasonal: `{"summary":"","campaigns":[{"name":"","dates":"","concept":"","offerIdea":"","contentPlan":[""],"adAngle":"","prepareBy":""}]}`,
      performance: `{"summary":"","whatWorks":[""],"whatDoesnt":[""],"recommendations":[{"action":"","evidence":"","expectedImpact":"low|medium|high"}],"postIdeas":[""]}`,
      industry: `{"summary":"","bestPractices":[""],"contentMix":[{"type":"","share":""}],"kpis":[""],"pitfalls":[""]}`,
    };
    if (!shapes[kind]) throw fail(400, "Unknown research kind");
    const data = await aiJSON(
      org,
      "research_" + kind,
      `You are a marketing research analyst for Facebook and Instagram. Return JSON only: ${shapes[kind]}. Use only the supplied data for claims about competitors or performance. ${GROUNDING}`,
      `${ctx.text}\n\n${extra}\nNOTES: ${notes || "-"}\nDATE: ${ymd(new Date())}`,
    );
    const titles = {
      trends: "Trending topic ideas",
      competitors: "Competitor content research",
      seasonal: "Seasonal campaign plan",
      performance: "Performance-based recommendations",
      industry: "Industry content strategy",
    };
    const plan = await savePlan(org, {
      brandId: ctx.brand?.id || null,
      kind: "research",
      title: `${titles[kind]} ${ymd(new Date())}`,
      input: req.body,
      data,
    });
    res.json({ success: true, plan });
  }),
);

app.get(
  "/api/plans",
  wrap(async (req, res) => {
    const q = { organizationId: tid(req) };
    if (req.query.kind) q.kind = { $in: String(req.query.kind).split(",") };
    if (req.query.brandId) q.brandId = req.query.brandId;
    res.json(await ContentPlan.find(q).sort({ createdAt: -1 }).limit(100));
  }),
);
app.get(
  "/api/plans/:id",
  wrap(async (req, res) => {
    const p = await ContentPlan.findOne({
      _id: req.params.id,
      organizationId: tid(req),
    });
    if (!p) throw fail(404, "Plan not found");
    res.json(p);
  }),
);
app.delete(
  "/api/plans/:id",
  wrap(async (req, res) => {
    await ContentPlan.deleteOne({
      _id: req.params.id,
      organizationId: tid(req),
    });
    res.json({ success: true });
  }),
);

// Turn plan ideas into draft content items (dated, ready for the calendar)
app.post(
  "/api/plans/:id/drafts",
  wrap(async (req, res) => {
    const org = tid(req);
    const p = await ContentPlan.findOne({
      _id: req.params.id,
      organizationId: org,
    });
    if (!p) throw fail(404, "Plan not found");
    const ids = req.body.itemIds?.length
      ? req.body.itemIds
      : p.items.map((i) => i.id);
    const lang = p.input?.language || "bn";
    let created = 0;
    for (const it of p.items) {
      if (!ids.includes(it.id) || it.contentItemId) continue;
      const c = await ContentItem.create({
        organizationId: org,
        brandId: p.brandId,
        planId: p.id,
        title: it.topic || "Planned post",
        body: it.caption || it.angle || it.topic || "Draft",
        type: it.format === "reel" ? "reel_script" : "post",
        format: ["reel", "story"].includes(it.format) ? it.format : "post",
        pillar: it.pillar,
        cta: it.cta,
        language: lang,
        scheduledAt: it.date || null,
        variants: it.platform
          ? [{ platform: it.platform, caption: it.caption || it.topic || "" }]
          : [],
        versions: [],
        approvals: [
          {
            action: "created",
            by: actor(req),
            comment: `From plan: ${p.title}`,
          },
        ],
      });
      it.contentItemId = c.id;
      created++;
    }
    await p.save();
    res.json({ success: true, created, plan: p });
  }),
);

/* =====================================================
   AI CONTENT GENERATION (1.3)
   ===================================================== */
const CONTENT_TYPES = {
  facebook_post:
    "A complete Facebook post: scroll-stopping first line, short paragraphs, emojis in moderation, one clear CTA, 3-5 hashtags in hashtags[].",
  instagram_post:
    "An Instagram caption: strong first line (visible before 'more'), line breaks, CTA, 8-15 relevant hashtags in hashtags[] (max 30), under 2200 characters.",
  caption: "A short social caption of 1-3 sentences.",
  hashtags:
    "Only hashtags: put 15-25 relevant hashtags in hashtags[] mixing broad, niche and local (Bangladesh/Dhaka) tags. body = one line explaining the mix.",
  ad_copy:
    "Meta ad copy. body = primary text (ideally under 125 characters, max 300), headline = max 40 characters, description = max 30 characters, cta = a Meta CTA type (SHOP_NOW, LEARN_MORE, SIGN_UP, ORDER_NOW, CONTACT_US, MESSAGE_PAGE, GET_OFFER, BOOK_NOW).",
  headline:
    "Headlines only. Each variant: headline = one punchy headline (max 40 characters), body = the same headline with a one-line supporting sentence.",
  cta: "Call-to-action lines only. Each variant: cta = short CTA button text, body = one CTA sentence for a caption.",
  product_description:
    "A product description for social/e-commerce: hook, key benefits, features/specs, who it is for, approved price only, CTA.",
  promotional:
    "A promotional/offer post. Mention only offers that exist in the approved facts or the brief.",
  video_script:
    "A video ad/explainer script. Fill scenes[] (scene, duration, visual, voiceover, onScreenText). body = the full script as readable text.",
  reel_script:
    "A 15-30 second Reel script: hook in the first 2 seconds, scenes[] with timing, on-screen text, audio/trend suggestion. body = readable script; hashtags[] for the caption.",
  story:
    "A 3-5 frame Story sequence. scenes[] = frames (onScreenText, visual, sticker idea like poll/question/link). body = summary.",
  video_concept:
    "3 short video concepts. Each variant: headline = concept name, body = concept (idea, hook, format, length, why it works).",
  storyboard:
    "A storyboard. scenes[] with shot type, visual description, duration, voiceover and on-screen text. body = summary of the story arc.",
  voiceover:
    "A voice-over script with natural pauses marked as (pause). body = the script. Include approximate duration in headline.",
  translate:
    "Translate the SOURCE TEXT into the target language. Keep tone, emojis, line breaks and hashtag meaning. Natural, not literal.",
  rewrite:
    "Rewrite the SOURCE TEXT following the instruction. Keep all facts unchanged.",
  adapt:
    "Adapt the SOURCE TEXT for each requested platform. One variant per platform with the platform field set (Facebook: conversational, fewer hashtags; Instagram: caption style, hashtags in hashtags[]).",
};
const VARIANT_SHAPE = `{"variants":[{"platform":"Facebook|Instagram|null","headline":"","body":"","description":"","hashtags":["#tag"],"cta":"","scenes":[{"scene":1,"duration":"3s","visual":"","voiceover":"","onScreenText":""}]}]}`;

async function generateContent(org, input) {
  const {
    brandId,
    type = "facebook_post",
    platform = "Facebook",
    language = "bn",
    topic = "",
    productId,
    tone,
    count = 3,
    extra = "",
    sourceText = "",
    targetLanguage,
    instruction,
  } = input;
  if (!CONTENT_TYPES[type]) throw fail(400, "Unknown content type");
  if (["translate", "rewrite", "adapt"].includes(type) && !sourceText)
    throw fail(400, "Source text is required");
  const ctx = await brandContext(org, brandId);
  const product = productId
    ? await Product.findOne({ _id: productId, organizationId: org }).lean()
    : null;
  const platforms =
    platform === "Both" ? ["Facebook", "Instagram"] : [platform];
  const n =
    type === "adapt"
      ? platforms.length
      : Math.min(Math.max(Number(count) || 1, 1), 5);
  const lang =
    type === "translate"
      ? LANG[targetLanguage] || targetLanguage || "English"
      : LANG[language] || language;
  return aiJSON(
    org,
    "content_" + type,
    `You are an expert social media copywriter for Facebook and Instagram in Bangladesh. TASK: ${CONTENT_TYPES[type]} Write ${n} distinct variant(s). Language: ${lang}. ${tone ? `Tone override: ${tone}.` : ""} Platform(s): ${platforms.join(", ")}. Return JSON only: ${VARIANT_SHAPE}. Leave unused fields empty. ${GROUNDING}`,
    `${ctx.text}\n\n${product ? `PRODUCT: ${product.name} | price ${product.price} BDT | ${product.category} | ${product.stock > 0 ? "in stock" : "out of stock"}\n` : ""}TOPIC / BRIEF: ${topic || "-"}\nEXTRA (offer, keywords, notes): ${extra || "-"}\n${instruction ? `INSTRUCTION: ${instruction}\n` : ""}${sourceText ? `SOURCE TEXT:\n${sourceText}` : ""}`,
    { temperature: ["translate", "adapt"].includes(type) ? 0.3 : 0.8 },
  );
}

app.post(
  "/api/ai/content",
  wrap(async (req, res) => {
    const out = await generateContent(tid(req), req.body);
    res.json({
      success: true,
      variants: (out.variants || []).map((v) => ({
        ...v,
        hashtags: (v.hashtags || []).map((h) =>
          String(h).startsWith("#") ? h : "#" + h,
        ),
      })),
    });
  }),
);

/* =====================================================
   CONTENT ITEMS: drafts, approval workflow, versions (1.5)
   ===================================================== */
// n8n flow (existing): saves a generated draft
app.post(
  "/api/content/create",
  wrap(async (req, res) => {
    const { tenantId, platform, topic, generatedText } = req.body;
    const content = await ContentItem.create({
      organizationId: tenantId,
      title: topic,
      body: generatedText,
      status: "Draft",
      type: platform === "Instagram" ? "instagram_post" : "facebook_post",
      variants: [{ platform, caption: generatedText }],
    });
    res.json({ success: true, content });
  }),
);

const EDITABLE = [
  "title",
  "body",
  "type",
  "format",
  "pillar",
  "headline",
  "cta",
  "hashtags",
  "language",
  "variants",
  "mediaIds",
  "link",
  "brandId",
  "scheduledAt",
];
const LOCKED = ["Publishing", "Published", "Partially Published"];

async function buildTargets(org, accountIds = []) {
  if (!accountIds.length) return [];
  const accs = await SocialAccount.find({
    organizationId: org,
    _id: { $in: accountIds },
    platform: { $in: ["Facebook", "Instagram"] },
  });
  return accs.map((a) => ({
    accountId: a.id,
    platform: a.platform,
    accountName: a.accountName,
    status: "pending",
  }));
}
function cleanContent(b) {
  const p = pick(b, EDITABLE);
  if ("hashtags" in p)
    p.hashtags = lines(
      String(
        Array.isArray(p.hashtags) ? p.hashtags.join(" ") : p.hashtags,
      ).replace(/\s+/g, ","),
    ).map((h) => (h.startsWith("#") ? h : "#" + h));
  if ("variants" in p)
    p.variants = (p.variants || []).filter((v) => v && v.platform && v.caption);
  if ("scheduledAt" in p)
    p.scheduledAt = p.scheduledAt ? new Date(p.scheduledAt) : null;
  return p;
}
const snapshot = (c, by, note) => ({
  body: c.body,
  headline: c.headline,
  hashtags: c.hashtags,
  cta: c.cta,
  variants: (c.variants || []).map((v) => ({
    platform: v.platform,
    caption: v.caption,
  })),
  by,
  note,
});

app.get(
  "/api/content",
  wrap(async (req, res) => {
    const q = { organizationId: tid(req) };
    if (req.query.status)
      q.status = { $in: String(req.query.status).split(",") };
    if (req.query.brandId) q.brandId = req.query.brandId;
    if (req.query.type) q.type = { $in: String(req.query.type).split(",") };
    if (req.query.from || req.query.to)
      q.scheduledAt = {
        ...(req.query.from ? { $gte: new Date(req.query.from) } : {}),
        ...(req.query.to ? { $lte: new Date(req.query.to) } : {}),
      };
    if (req.query.unscheduled === "1") q.scheduledAt = null;
    if (req.query.q)
      q.$or = [
        { title: new RegExp(escRe(req.query.q), "i") },
        { body: new RegExp(escRe(req.query.q), "i") },
      ];
    const sort =
      req.query.sort === "schedule"
        ? { scheduledAt: 1 }
        : req.query.sort === "published"
          ? { publishedAt: -1 }
          : { createdAt: -1 };
    res.json(
      await ContentItem.find(q)
        .select("-versions")
        .sort(sort)
        .limit(Math.min(Number(req.query.limit) || 300, 1000)),
    );
  }),
);

app.get(
  "/api/content/:id",
  wrap(async (req, res) => {
    const c = await ContentItem.findOne({
      _id: req.params.id,
      organizationId: tid(req),
    });
    if (!c) throw fail(404, "Content not found");
    const media = await MediaAsset.find({
      _id: { $in: c.mediaIds },
      organizationId: c.organizationId,
    });
    res.json({ ...c.toJSON(), media });
  }),
);

app.post(
  "/api/content",
  wrap(async (req, res) => {
    const org = tid(req);
    const data = cleanContent(req.body);
    if (!data.body) throw fail(400, "Content body is required");
    data.title = data.title || data.body.slice(0, 60);
    const c = await ContentItem.create({
      ...data,
      organizationId: org,
      ownerId: actor(req),
      status: "Draft",
      targets: await buildTargets(org, req.body.accountIds || []),
      planId: req.body.planId || null,
      approvals: [{ action: "created", by: actor(req) }],
    });
    res.json({ success: true, content: c });
  }),
);

app.put(
  "/api/content/:id",
  wrap(async (req, res) => {
    const org = tid(req);
    const c = await ContentItem.findOne({
      _id: req.params.id,
      organizationId: org,
    });
    if (!c) throw fail(404, "Content not found");
    if (LOCKED.includes(c.status))
      throw fail(400, `Can't edit content that is ${c.status}`);
    const data = cleanContent(req.body);
    // Compare plain values: saved variants carry an _id and empty fields may be "" or null
    const norm = (k, v) =>
      k === "variants"
        ? (v || []).map((x) => ({
            platform: x.platform,
            caption: String(x.caption || "").trim(),
          }))
        : k === "hashtags"
          ? [...(v || [])].map(String)
          : v == null
            ? ""
            : String(v).trim();
    const textChanged = [
      "body",
      "headline",
      "hashtags",
      "cta",
      "variants",
    ].some(
      (k) =>
        k in data &&
        JSON.stringify(norm(k, data[k])) !== JSON.stringify(norm(k, c[k])),
    );
    if (textChanged) {
      c.versions.push(snapshot(c, actor(req), req.body.versionNote || "edit"));
      if (c.versions.length > 30) c.versions.shift();
    }
    Object.assign(c, data);
    if (req.body.accountIds)
      c.targets = await buildTargets(org, req.body.accountIds);
    // editing approved/scheduled content sends it back for review when approval is required
    const s = await getSettings(org);
    if (
      textChanged &&
      s.requireApproval &&
      ["Approved", "Scheduled", "Failed"].includes(c.status)
    ) {
      c.status = "In Review";
      c.approvals.push({
        action: "resubmitted",
        by: actor(req),
        comment: "Edited after approval",
      });
    }
    await c.save();
    res.json({ success: true, content: c });
  }),
);

app.post(
  "/api/content/:id/restore/:idx",
  wrap(async (req, res) => {
    const c = await ContentItem.findOne({
      _id: req.params.id,
      organizationId: tid(req),
    });
    if (!c) throw fail(404, "Content not found");
    if (LOCKED.includes(c.status))
      throw fail(400, `Can't edit content that is ${c.status}`);
    const v = c.versions[Number(req.params.idx)];
    if (!v) throw fail(404, "Version not found");
    c.versions.push(snapshot(c, actor(req), "before restore"));
    Object.assign(c, {
      body: v.body,
      headline: v.headline,
      hashtags: v.hashtags,
      cta: v.cta,
      variants: v.variants,
    });
    if (["Approved", "Scheduled"].includes(c.status)) c.status = "In Review";
    await c.save();
    res.json({ success: true, content: c });
  }),
);

app.delete(
  "/api/content/:id",
  wrap(async (req, res) => {
    const c = await ContentItem.findOne({
      _id: req.params.id,
      organizationId: tid(req),
    });
    if (!c) throw fail(404, "Content not found");
    if (c.status === "Publishing")
      throw fail(400, "Content is publishing right now");
    await c.deleteOne();
    res.json({ success: true });
  }),
);

// Draft -> In Review (or straight to Approved when approval is off)
app.post(
  "/api/content/:id/submit",
  wrap(async (req, res) => {
    const org = tid(req);
    const c = await ContentItem.findOne({
      _id: req.params.id,
      organizationId: org,
    });
    if (!c) throw fail(404, "Content not found");
    if (!["Draft", "Rejected", "Failed"].includes(c.status))
      throw fail(400, `Content is already ${c.status}`);
    const s = await getSettings(org);
    c.status = s.requireApproval ? "In Review" : "Approved";
    c.approvals.push({
      action: s.requireApproval ? "submitted" : "auto-approved",
      by: actor(req),
      comment: req.body.comment || "",
    });
    await c.save();
    if (s.requireApproval)
      await notify(
        org,
        "approval",
        "Content waiting for approval",
        c.title,
        "calendar",
      );
    res.json({ success: true, content: c });
  }),
);

// Approver decision: approve | reject | changes
app.post(
  "/api/content/:id/review",
  wrap(async (req, res) => {
    const c = await ContentItem.findOne({
      _id: req.params.id,
      organizationId: tid(req),
    });
    if (!c) throw fail(404, "Content not found");
    const { action, comment = "" } = req.body;
    if (!["approve", "reject", "changes"].includes(action))
      throw fail(400, "action must be approve, reject or changes");
    if (!["In Review", "Draft"].includes(c.status))
      throw fail(400, `Content is ${c.status}`);
    c.status =
      action === "approve"
        ? "Approved"
        : action === "reject"
          ? "Rejected"
          : "Draft";
    c.approvals.push({
      action: action === "changes" ? "changes requested" : action + "d",
      by: actor(req),
      comment,
    });
    await c.save();
    res.json({ success: true, content: c });
  }),
);

// Schedule an approved item (or set a planned date on a draft)
app.post(
  "/api/content/:id/schedule",
  wrap(async (req, res) => {
    const org = tid(req);
    const c = await ContentItem.findOne({
      _id: req.params.id,
      organizationId: org,
    });
    if (!c) throw fail(404, "Content not found");
    if (LOCKED.includes(c.status)) throw fail(400, `Content is ${c.status}`);
    if (req.body.accountIds)
      c.targets = await buildTargets(org, req.body.accountIds);
    const when = req.body.scheduledAt ? new Date(req.body.scheduledAt) : null;
    if (!when || isNaN(when))
      throw fail(400, "A valid scheduledAt is required");
    c.scheduledAt = when;
    const s = await getSettings(org);
    if (
      c.status === "Approved" ||
      c.status === "Scheduled" ||
      (!s.requireApproval && ["Draft", "Rejected", "Failed"].includes(c.status))
    ) {
      if (!c.targets.length)
        throw fail(400, "Pick at least one Page or Instagram account");
      await preflight(c);
      c.status = "Scheduled";
      c.targets.forEach((t) => {
        if (t.status !== "published") {
          t.status = "pending";
          t.attempts = 0;
          t.error = null;
        }
      });
      c.nextAttemptAt = null;
      c.approvals.push({
        action: "scheduled",
        by: actor(req),
        comment: when.toISOString(),
      });
    }
    await c.save();
    res.json({ success: true, content: c });
  }),
);

// Calendar drag-and-drop: move the date, keep the status
app.put(
  "/api/content/:id/date",
  wrap(async (req, res) => {
    const c = await ContentItem.findOne({
      _id: req.params.id,
      organizationId: tid(req),
    });
    if (!c) throw fail(404, "Content not found");
    if (LOCKED.includes(c.status)) throw fail(400, `Content is ${c.status}`);
    const when = new Date(req.body.scheduledAt);
    if (isNaN(when)) throw fail(400, "Invalid date");
    if (c.status === "Scheduled" && when < new Date())
      throw fail(400, "Can't move a scheduled post into the past");
    c.scheduledAt = when;
    await c.save();
    res.json({ success: true, content: c });
  }),
);

app.post(
  "/api/content/:id/cancel",
  wrap(async (req, res) => {
    const c = await ContentItem.findOne({
      _id: req.params.id,
      organizationId: tid(req),
    });
    if (!c) throw fail(404, "Content not found");
    if (c.status !== "Scheduled")
      throw fail(400, "Only scheduled content can be unscheduled");
    c.status = "Approved";
    c.approvals.push({ action: "unscheduled", by: actor(req) });
    await c.save();
    res.json({ success: true, content: c });
  }),
);

// Publish now (approved content)
app.post(
  "/api/content/:id/publish",
  wrap(async (req, res) => {
    const org = tid(req);
    const c = await ContentItem.findOne({
      _id: req.params.id,
      organizationId: org,
    });
    if (!c) throw fail(404, "Content not found");
    if (req.body.accountIds)
      c.targets = await buildTargets(org, req.body.accountIds);
    const s = await getSettings(org);
    if (
      s.requireApproval &&
      !["Approved", "Scheduled", "Failed", "Partially Published"].includes(
        c.status,
      )
    )
      throw fail(400, "Content must be approved before publishing");
    if (!c.targets.length)
      throw fail(400, "Pick at least one Page or Instagram account");
    await preflight(c);
    c.status = "Scheduled";
    c.scheduledAt = new Date();
    c.nextAttemptAt = null;
    c.targets.forEach((t) => {
      if (t.status !== "published") {
        t.status = "pending";
        t.attempts = 0;
        t.error = null;
      }
    });
    c.approvals.push({ action: "publish now", by: actor(req) });
    await c.save();
    await runJob("publish", publishDue);
    res.json({ success: true, content: await ContentItem.findById(c.id) });
  }),
);

app.post(
  "/api/content/:id/retry",
  wrap(async (req, res) => {
    const c = await ContentItem.findOne({
      _id: req.params.id,
      organizationId: tid(req),
    });
    if (!c) throw fail(404, "Content not found");
    if (!["Failed", "Partially Published"].includes(c.status))
      throw fail(400, "Nothing to retry");
    c.targets.forEach((t) => {
      if (t.status === "failed") {
        t.status = "pending";
        t.attempts = 0;
        t.error = null;
      }
    });
    c.status = "Scheduled";
    c.scheduledAt = new Date();
    c.nextAttemptAt = null;
    await c.save();
    await runJob("publish", publishDue);
    res.json({ success: true, content: await ContentItem.findById(c.id) });
  }),
);

// Back-compat with the old dashboard button: approve + publish to the platform's accounts
app.put(
  "/api/content/:id/approve",
  wrap(async (req, res) => {
    const org = tid(req);
    const c = await ContentItem.findOne({
      _id: req.params.id,
      organizationId: org,
    });
    if (!c) return res.status(404).json({ error: "Content not found" });
    if (!c.targets.length) {
      const accs = await SocialAccount.find({
        organizationId: org,
        platform: req.body.platform || "Facebook",
      });
      if (!accs.length)
        return res
          .status(400)
          .json({ error: "No account connected for this platform" });
      c.targets = accs.map((a) => ({
        accountId: a.id,
        platform: a.platform,
        accountName: a.accountName,
      }));
    }
    c.approvals.push({ action: "approved", by: actor(req) });
    c.status = "Scheduled";
    c.scheduledAt = new Date();
    await c.save();
    await runJob("publish", publishDue);
    res.json({ success: true });
  }),
);

// Bulk scheduling: rows of { date, time, platform, caption, mediaUrl }
app.post(
  "/api/content/bulk",
  wrap(async (req, res) => {
    const org = tid(req);
    const s = await getSettings(org);
    const rows = Array.isArray(req.body.rows)
      ? req.body.rows.slice(0, 500)
      : [];
    const accounts = await SocialAccount.find({
      organizationId: org,
      _id: { $in: req.body.accountIds || [] },
    });
    if (!accounts.length)
      throw fail(400, "Pick at least one Page or Instagram account");
    const created = [],
      errors = [];
    for (const [i, r] of rows.entries()) {
      try {
        const when = new Date(`${r.date}T${r.time || "19:00"}`);
        if (isNaN(when)) throw new Error("invalid date/time");
        if (!r.caption) throw new Error("caption missing");
        const plat =
          r.platform && r.platform !== "Both"
            ? [r.platform]
            : ["Facebook", "Instagram"];
        const targets = accounts
          .filter((a) => plat.includes(a.platform))
          .map((a) => ({
            accountId: a.id,
            platform: a.platform,
            accountName: a.accountName,
          }));
        if (!targets.length)
          throw new Error(`no selected account for ${plat.join("/")}`);
        let mediaIds = [];
        if (r.mediaUrl) {
          const m = await MediaAsset.create({
            organizationId: org,
            brandId: req.body.brandId || null,
            name: r.mediaUrl.split("/").pop().slice(0, 80),
            kind: /\.(mp4|mov|webm)(\?|$)/i.test(r.mediaUrl)
              ? "video"
              : "image",
            url: r.mediaUrl,
            source: "url",
            status: "approved",
          });
          mediaIds = [m.id];
        }
        const c = await ContentItem.create({
          organizationId: org,
          brandId: req.body.brandId || null,
          title: r.caption.slice(0, 60),
          body: r.caption,
          format: r.format || "post",
          mediaIds,
          targets,
          scheduledAt: when,
          status: s.requireApproval ? "In Review" : "Scheduled",
          approvals: [{ action: "bulk import", by: actor(req) }],
        });
        created.push(c.id);
      } catch (e) {
        errors.push(`Row ${i + 1}: ${e.message}`);
      }
    }
    if (s.requireApproval && created.length)
      await notify(
        org,
        "approval",
        `${created.length} bulk posts waiting for approval`,
        "Review them in the content calendar",
        "calendar",
      );
    res.json({
      success: true,
      created: created.length,
      errors,
      needsApproval: s.requireApproval,
    });
  }),
);

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
  if (["expired", "revoked"].includes(acc.status))
    e.push(`${acc.accountName}: token ${acc.status}, reconnect Facebook`);
  if (settings.creativeApproval && media.some((m) => m.status !== "approved"))
    e.push("All media must be approved first");
  const vids = media.filter((m) => m.kind === "video");
  if (item.format === "reel" && !vids.length) e.push("Reels need a video");
  if (item.format === "story" && !media.length)
    e.push("Stories need an image or video");
  if (acc.platform === "Facebook") {
    if (
      acc.tasks?.length &&
      !acc.tasks.some((t) => ["CREATE_CONTENT", "MANAGE"].includes(t))
    )
      e.push(
        `${acc.accountName}: you don't have permission to post on this Page`,
      );
    if (!text && !media.length) e.push("Facebook post needs text or media");
    if (item.format === "story" && media[0]?.kind === "video")
      e.push("Facebook video stories aren't supported here; use a photo story");
  }
  if (acc.platform === "Instagram") {
    if (!media.length) e.push("Instagram needs at least one image or video");
    if (text.length > 2200)
      e.push("Instagram caption is longer than 2200 characters");
    if (hashtagCount(text) > 30) e.push("Instagram allows max 30 hashtags");
    if (media.length > 10) e.push("Instagram carousel allows max 10 items");
    if (
      media.some(
        (m) => m.kind === "image" && m.mimeType && !/jpe?g/i.test(m.mimeType),
      )
    )
      e.push(
        "Instagram accepts JPEG images only. Convert in Creative Studio > Resize & convert",
      );
    if (
      media.some((m) => !publicUrl(m.url)) ||
      (!isPublicBase() && media.some((m) => !/^https?:/.test(m.url)))
    )
      e.push(
        "Instagram needs public media URLs: set PUBLIC_BASE_URL (e.g. an ngrok https URL)",
      );
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
    const acc = await SocialAccount.findOne({
      _id: t.accountId,
      organizationId: org,
    });
    if (!acc) {
      errs.push(`${t.accountName || t.accountId}: account disconnected`);
      continue;
    }
    errs.push(...validateTarget(item, acc, media, settings));
  }
  if (errs.length) throw fail(400, [...new Set(errs)].join(" · "));
}
async function orderedMedia(item) {
  const media = await MediaAsset.find({
    _id: { $in: item.mediaIds || [] },
    organizationId: item.organizationId,
  });
  return (item.mediaIds || [])
    .map((id) => media.find((m) => m.id === id))
    .filter(Boolean);
}
const localFile = (m) => (m.file ? path.join(UPLOAD_DIR, m.file) : null);

// Upload to Facebook by public URL, or by sending the file bytes when the server isn't public
async function fbUpload(pathname, token, m, fields, video = false) {
  const pub =
    isPublicBase() || /^https?:/.test(m.url) ? publicUrl(m.url) : null;
  const base = video ? GRAPH_VIDEO : GRAPH;
  if (pub)
    return graph(pathname, {
      token,
      method: "POST",
      base,
      body: { ...fields, [video ? "file_url" : "url"]: pub },
    });
  const f = localFile(m);
  if (!f || !fs.existsSync(f)) throw fail(400, `Media file missing: ${m.name}`);
  const form = new FormData();
  Object.entries(fields).forEach(
    ([k, v]) =>
      v != null &&
      form.append(k, typeof v === "object" ? JSON.stringify(v) : String(v)),
  );
  form.append(
    "source",
    new Blob([fs.readFileSync(f)], {
      type: m.mimeType || "application/octet-stream",
    }),
    m.file,
  );
  const r = await fetch(
    `${base}${pathname}?access_token=${encodeURIComponent(token)}`,
    { method: "POST", body: form },
  );
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error)
    throw fail(
      502,
      j.error?.error_user_msg ||
        j.error?.message ||
        `Upload failed (${r.status})`,
    );
  return j;
}

async function fbReel(page, token, m, text) {
  const start = await graph(`/${page}/video_reels`, {
    token,
    method: "POST",
    body: { upload_phase: "start" },
  });
  const url = `https://rupload.facebook.com/video-upload/${GRAPH_VER}/${start.video_id}`;
  const pub =
    isPublicBase() || /^https?:/.test(m.url) ? publicUrl(m.url) : null;
  let r;
  if (pub)
    r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `OAuth ${token}`, file_url: pub },
    });
  else {
    const buf = fs.readFileSync(localFile(m));
    r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `OAuth ${token}`,
        offset: "0",
        file_size: String(buf.length),
      },
      body: buf,
    });
  }
  if (!r.ok)
    throw fail(502, `Reel upload failed: ${(await r.text()).slice(0, 200)}`);
  await graph(`/${page}/video_reels`, {
    token,
    method: "POST",
    body: {
      upload_phase: "finish",
      video_id: start.video_id,
      video_state: "PUBLISHED",
      description: text,
    },
  });
  return start.video_id;
}

async function publishFB(item, t, acc, media) {
  const token = tok(acc),
    page = acc.accountId,
    text = captionFor(item, "Facebook");
  const vids = media.filter((m) => m.kind === "video"),
    imgs = media.filter((m) => m.kind === "image");
  let id;
  if (item.format === "reel" && vids[0])
    id = await fbReel(page, token, vids[0], text);
  else if (item.format === "story") {
    const ph = await fbUpload(`/${page}/photos`, token, imgs[0], {
      published: false,
    });
    id =
      (
        await graph(`/${page}/photo_stories`, {
          token,
          method: "POST",
          body: { photo_id: ph.id },
        })
      ).post_id || ph.id;
  } else if (vids[0])
    id = (
      await fbUpload(
        `/${page}/videos`,
        token,
        vids[0],
        { description: text },
        true,
      )
    ).id;
  else if (imgs.length === 1) {
    const r = await fbUpload(`/${page}/photos`, token, imgs[0], {
      message: text,
    });
    id = r.post_id || r.id;
  } else if (imgs.length > 1) {
    const ids = [];
    for (const m of imgs.slice(0, 10))
      ids.push(
        (await fbUpload(`/${page}/photos`, token, m, { published: false })).id,
      );
    id = (
      await graph(`/${page}/feed`, {
        token,
        method: "POST",
        body: {
          message: text,
          attached_media: ids.map((x) => ({ media_fbid: x })),
        },
      })
    ).id;
  } else
    id = (
      await graph(`/${page}/feed`, {
        token,
        method: "POST",
        body: { message: text, link: item.link || undefined },
      })
    ).id;
  let permalink = null;
  try {
    const p = await graph(`/${id}`, {
      token,
      params: { fields: "permalink_url" },
    });
    permalink = p.permalink_url
      ? p.permalink_url.startsWith("http")
        ? p.permalink_url
        : "https://www.facebook.com" + p.permalink_url
      : null;
  } catch {}
  return { id, permalink };
}

async function publishIG(item, t, acc, media) {
  const token = tok(acc),
    ig = acc.accountId,
    text = captionFor(item, "Instagram");
  if (!t.creationId) {
    const u = media.map((m) => ({ m, url: publicUrl(m.url) }));
    let body;
    if (item.format === "story")
      body = {
        media_type: "STORIES",
        [u[0].m.kind === "video" ? "video_url" : "image_url"]: u[0].url,
      };
    else if (
      item.format === "reel" ||
      (u.length === 1 && u[0].m.kind === "video")
    )
      body = {
        media_type: "REELS",
        video_url: u.find((x) => x.m.kind === "video").url,
        caption: text,
        share_to_feed: true,
      };
    else if (u.length > 1) {
      const kids = [];
      for (const x of u.slice(0, 10))
        kids.push(
          (
            await graph(`/${ig}/media`, {
              token,
              method: "POST",
              body:
                x.m.kind === "video"
                  ? {
                      media_type: "VIDEO",
                      video_url: x.url,
                      is_carousel_item: true,
                    }
                  : { image_url: x.url, is_carousel_item: true },
            })
          ).id,
        );
      t.childIds = kids;
      body = {
        media_type: "CAROUSEL",
        children: kids.join(","),
        caption: text,
      };
    } else body = { image_url: u[0].url, caption: text };
    t.creationId = (
      await graph(`/${ig}/media`, { token, method: "POST", body })
    ).id;
  }
  const s = await graph(`/${t.creationId}`, {
    token,
    params: { fields: "status_code,status" },
  });
  if (s.status_code === "IN_PROGRESS") return { processing: true };
  if (["ERROR", "EXPIRED"].includes(s.status_code)) {
    t.creationId = null;
    throw fail(
      502,
      `Instagram media processing failed: ${s.status || s.status_code}`,
    );
  }
  const p = await graph(`/${ig}/media_publish`, {
    token,
    method: "POST",
    body: { creation_id: t.creationId },
  });
  let permalink = null;
  try {
    permalink = (
      await graph(`/${p.id}`, { token, params: { fields: "permalink" } })
    ).permalink;
  } catch {}
  return { id: p.id, permalink };
}

async function processPublish(item) {
  const org = item.organizationId;
  const settings = await getSettings(org);
  const media = await orderedMedia(item);
  let again = false,
    processing = false;
  for (const t of item.targets) {
    if (
      t.status === "published" ||
      (t.status === "failed" && t.attempts >= MAX_ATTEMPTS)
    )
      continue;
    const acc = await SocialAccount.findOne({
      _id: t.accountId,
      organizationId: org,
    }).select("+accessToken");
    try {
      if (!acc) throw fail(400, "Account disconnected");
      const errs = validateTarget(item, acc, media, settings);
      if (errs.length) {
        t.status = "failed";
        t.attempts = MAX_ATTEMPTS;
        t.error = errs.join("; ");
        continue;
      }
      const r =
        acc.platform === "Instagram"
          ? await publishIG(item, t, acc, media)
          : await publishFB(item, t, acc, media);
      if (r.processing) {
        t.status = "processing";
        processing = true;
      } else
        Object.assign(t, {
          status: "published",
          providerPostId: r.id,
          permalink: r.permalink,
          publishedAt: new Date(),
          error: null,
        });
    } catch (e) {
      t.attempts = (t.attempts || 0) + 1;
      t.error = e.message;
      t.status = t.attempts >= MAX_ATTEMPTS ? "failed" : "pending";
      if (t.status === "pending") again = true;
    }
  }
  if (processing || again) {
    item.status = "Publishing";
    const maxAttempts = Math.max(
      1,
      ...item.targets.map((t) => t.attempts || 0),
    );
    item.nextAttemptAt = new Date(
      Date.now() +
        (processing && !again ? 20e3 : 60e3 * 2 ** (maxAttempts - 1)),
    );
  } else {
    const ok = item.targets.filter((t) => t.status === "published").length;
    item.status =
      ok === item.targets.length
        ? "Published"
        : ok
          ? "Partially Published"
          : "Failed";
    item.publishedAt = ok ? new Date() : null;
    item.nextAttemptAt = null;
    const failed = item.targets.filter((t) => t.status === "failed");
    item.lastError =
      failed.map((t) => `${t.accountName}: ${t.error}`).join(" | ") || null;
    if (failed.length)
      await notify(
        org,
        "publish_failed",
        `Publishing failed: ${item.title}`,
        item.lastError,
        "calendar",
      );
  }
  item.lockUntil = null;
  await item.save();
}

async function publishDue() {
  const now = new Date();
  for (let i = 0; i < 20; i++) {
    const item = await ContentItem.findOneAndUpdate(
      {
        status: { $in: ["Scheduled", "Publishing"] },
        scheduledAt: { $lte: now },
        $and: [
          { $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] },
          { $or: [{ lockUntil: null }, { lockUntil: { $lt: now } }] },
        ],
      },
      {
        $set: {
          status: "Publishing",
          lockUntil: new Date(Date.now() + 5 * 60e3),
        },
      },
      { new: true, sort: { scheduledAt: 1 } },
    );
    if (!item) break;
    try {
      await processPublish(item);
    } catch (e) {
      console.error("publish:", e);
      await ContentItem.updateOne(
        { _id: item.id },
        { lockUntil: null, nextAttemptAt: new Date(Date.now() + 120e3) },
      );
    }
  }
}

/* =====================================================
   AI CREATIVE & MEDIA STUDIO (1.4)
   ===================================================== */
const assetUpload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      const ext = (
        path.extname(file.originalname) ||
        (file.mimetype.includes("video") ? ".mp4" : ".jpg")
      )
        .toLowerCase()
        .replace(/[^.a-z0-9]/g, "");
      cb(null, `${Date.now()}-${crypto.randomBytes(5).toString("hex")}${ext}`);
    },
  }),
  limits: { fileSize: 300 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    cb(null, /^(image|video)\//.test(file.mimetype)),
});

async function saveBufferAsset(
  org,
  buf,
  { name, mimeType = "image/png", ext = ".png", ...rest },
) {
  const file = `${Date.now()}-${crypto.randomBytes(5).toString("hex")}${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, file), buf);
  return MediaAsset.create({
    organizationId: org,
    name: name || file,
    kind: mimeType.startsWith("video") ? "video" : "image",
    mimeType,
    size: buf.length,
    file,
    url: `/uploads/${file}`,
    ...rest,
  });
}

app.get(
  "/api/assets",
  wrap(async (req, res) => {
    const q = { organizationId: tid(req) };
    if (req.query.status) q.status = req.query.status;
    if (req.query.kind) q.kind = req.query.kind;
    if (req.query.brandId) q.brandId = req.query.brandId;
    if (req.query.ids) q._id = { $in: String(req.query.ids).split(",") };
    res.json(await MediaAsset.find(q).sort({ createdAt: -1 }).limit(500));
  }),
);

// Multiple files: field "files". Optional body: brandId, source, parentId, width, height, tags
app.post(
  "/api/assets/upload",
  assetUpload.array("files", 20),
  wrap(async (req, res) => {
    const org = tid(req);
    const s = await getSettings(org);
    if (!req.files?.length) throw fail(400, "No image/video files received");
    const out = [];
    for (const f of req.files) {
      out.push(
        await MediaAsset.create({
          organizationId: org,
          brandId: req.body.brandId || null,
          name: req.body.name || f.originalname,
          kind: f.mimetype.startsWith("video") ? "video" : "image",
          mimeType: f.mimetype,
          size: f.size,
          file: f.filename,
          url: `/uploads/${f.filename}`,
          source: req.body.source || "upload",
          parentId: req.body.parentId || null,
          width: Number(req.body.width) || undefined,
          height: Number(req.body.height) || undefined,
          tags: lines(req.body.tags),
          status: s.creativeApproval ? "pending" : "approved",
          prompt: req.body.prompt || null,
        }),
      );
    }
    if (s.creativeApproval)
      await notify(
        org,
        "approval",
        `${out.length} creative(s) waiting for approval`,
        out.map((a) => a.name).join(", "),
        "creative",
      );
    res.json({ success: true, assets: out });
  }),
);

app.post(
  "/api/assets/from-url",
  wrap(async (req, res) => {
    const org = tid(req);
    const { url, name, brandId } = req.body;
    if (!/^https?:\/\//.test(url || ""))
      throw fail(400, "A full http(s) URL is required");
    const r = await fetch(url);
    if (!r.ok) throw fail(400, `Couldn't download (${r.status})`);
    const type = r.headers.get("content-type") || "image/jpeg";
    if (!/^(image|video)\//.test(type))
      throw fail(400, "URL is not an image or video");
    const buf = Buffer.from(await r.arrayBuffer());
    const ext =
      "." +
      (type.split("/")[1] || "jpg")
        .replace("jpeg", "jpg")
        .replace(/[^a-z0-9]/g, "");
    const s = await getSettings(org);
    res.json({
      success: true,
      asset: await saveBufferAsset(org, buf, {
        name: name || url.split("/").pop().slice(0, 80),
        mimeType: type,
        ext,
        brandId,
        source: "url",
        status: s.creativeApproval ? "pending" : "approved",
      }),
    });
  }),
);

app.put(
  "/api/assets/:id",
  wrap(async (req, res) => {
    const a = await MediaAsset.findOneAndUpdate(
      { _id: req.params.id, organizationId: tid(req) },
      pick(
        { ...req.body, tags: req.body.tags ? lines(req.body.tags) : undefined },
        ["name", "tags", "brandId"],
      ),
      { new: true },
    );
    if (!a) throw fail(404, "Asset not found");
    res.json({ success: true, asset: a });
  }),
);

// Creative approval
app.post(
  "/api/assets/:id/review",
  wrap(async (req, res) => {
    const { action, note } = req.body;
    if (!["approve", "reject"].includes(action))
      throw fail(400, "action must be approve or reject");
    const a = await MediaAsset.findOneAndUpdate(
      { _id: req.params.id, organizationId: tid(req) },
      {
        status: action === "approve" ? "approved" : "rejected",
        reviewNote: note || null,
      },
      { new: true },
    );
    if (!a) throw fail(404, "Asset not found");
    res.json({ success: true, asset: a });
  }),
);

app.delete(
  "/api/assets/:id",
  wrap(async (req, res) => {
    const org = tid(req);
    const a = await MediaAsset.findOne({
      _id: req.params.id,
      organizationId: org,
    });
    if (!a) throw fail(404, "Asset not found");
    if (
      await ContentItem.exists({
        organizationId: org,
        mediaIds: a.id,
        status: { $in: ["Scheduled", "Publishing"] },
      })
    )
      throw fail(400, "This media is used by a scheduled post");
    if (a.file)
      fs.promises.unlink(path.join(UPLOAD_DIR, a.file)).catch(() => {});
    await a.deleteOne();
    res.json({ success: true });
  }),
);

// AI image generation (OpenAI-compatible /images/generations). kind: image | ad_creative | product_promo | banner | post_design
app.post(
  "/api/creative/ai-image",
  wrap(async (req, res) => {
    const org = tid(req);
    if (!process.env.AI_IMAGE_MODEL)
      throw fail(
        503,
        "AI image generation is off. Set AI_IMAGE_MODEL (and AI_API_KEY) in .env",
      );
    const {
      prompt = "",
      kind = "image",
      productId,
      brandId,
      style = "",
      size = process.env.AI_IMAGE_SIZE || "1024x1024",
      offer = "",
    } = req.body;
    const brand = await getBrand(org, brandId);
    const product = productId
      ? await Product.findOne({ _id: productId, organizationId: org }).lean()
      : null;
    const kindText =
      {
        image: "",
        ad_creative: "A high-converting social media advertisement creative,",
        product_promo: "A product promotional image,",
        banner: "A wide promotional web/social banner,",
        post_design: "A clean social media post design,",
      }[kind] || "";
    const full = [
      kindText,
      prompt,
      product
        ? `Featuring the product: ${product.name} (${product.category}).`
        : "",
      offer ? `Offer theme: ${offer}.` : "",
      brand
        ? `Brand colours ${brand.colors?.primary}, ${brand.colors?.secondary}, ${brand.colors?.accent}. Brand style: ${brand.tone}.`
        : "",
      style ? `Style: ${style}.` : "",
      "Leave clean empty space for text overlay; do not render any text, letters, logos or watermarks.",
    ]
      .filter(Boolean)
      .join(" ");
    const r = await fetch(`${AI_BASE}/images/generations`, {
      method: "POST",
      headers: aiHeaders(),
      body: JSON.stringify({
        model: process.env.AI_IMAGE_MODEL,
        prompt: full,
        size,
        n: 1,
      }),
    });
    const j = await r.json().catch(() => ({}));
    AiUsage.create({
      organizationId: org,
      task: "image_" + kind,
      model: process.env.AI_IMAGE_MODEL,
      ok: r.ok,
    }).catch(() => {});
    if (!r.ok)
      throw fail(502, `Image provider error: ${j.error?.message || r.status}`);
    const d = j.data?.[0] || {};
    let buf;
    if (d.b64_json) buf = Buffer.from(d.b64_json, "base64");
    else if (d.url) buf = Buffer.from(await (await fetch(d.url)).arrayBuffer());
    else throw fail(502, "Image provider returned no image");
    const s = await getSettings(org);
    const asset = await saveBufferAsset(org, buf, {
      name: `AI ${kind} ${ymd(new Date())}`,
      mimeType: "image/png",
      ext: ".png",
      brandId: brand?.id || null,
      source: "ai",
      prompt: full,
      tags: ["ai", kind],
      status: s.creativeApproval ? "pending" : "approved",
    });
    res.json({ success: true, asset });
  }),
);

// Creative templates (rendered to PNG in the browser banner maker)
app.get(
  "/api/creative/templates",
  wrap(async (req, res) =>
    res.json(
      await CreativeTemplate.find({ organizationId: tid(req) }).sort({
        createdAt: -1,
      }),
    ),
  ),
);
app.post(
  "/api/creative/templates",
  wrap(async (req, res) => {
    const { name, format, layout, brandId } = req.body;
    if (!name) throw fail(400, "Template name is required");
    res.json({
      success: true,
      template: await CreativeTemplate.create({
        organizationId: tid(req),
        name,
        format,
        layout,
        brandId: brandId || null,
      }),
    });
  }),
);
app.delete(
  "/api/creative/templates/:id",
  wrap(async (req, res) => {
    await CreativeTemplate.deleteOne({
      _id: req.params.id,
      organizationId: tid(req),
    });
    res.json({ success: true });
  }),
);

/* =====================================================
   META ADS: sync, structure, insights (1.6)
   ===================================================== */
const MKEYS = [
  "spend",
  "impressions",
  "reach",
  "clicks",
  "linkClicks",
  "leads",
  "purchases",
  "purchaseValue",
];
const LEAD_TYPES = [
  "lead",
  "onsite_conversion.lead_grouped",
  "offsite_conversion.fb_pixel_lead",
  "leadgen_grouped",
];
const PURCHASE_TYPES = [
  "purchase",
  "omni_purchase",
  "offsite_conversion.fb_pixel_purchase",
  "onsite_web_purchase",
];
// Meta reports the same conversion under several action types; take the largest instead of summing (avoids double counting)
const actionVal = (arr, types) =>
  Math.max(
    0,
    ...(arr || [])
      .filter((a) => types.includes(a.action_type))
      .map((a) => Number(a.value) || 0),
  );

// CTR/CPC here use LINK clicks (inline_link_clicks). Reach summed over days over-counts unique people, so frequency is approximate.
function kpis(m = {}) {
  const s = m.spend || 0,
    i = m.impressions || 0,
    lc = m.linkClicks || 0,
    conv = (m.leads || 0) + (m.purchases || 0);
  return {
    ...pick(m, MKEYS),
    spend: round(s),
    ctr: i ? round((lc / i) * 100) : 0,
    cpc: lc ? round(s / lc) : 0,
    cpm: i ? round((s / i) * 1000) : 0,
    cpl: m.leads ? round(s / m.leads) : 0,
    cpa: conv ? round(s / conv) : 0,
    roas: s ? round((m.purchaseValue || 0) / s) : 0,
    frequency: m.reach ? round(i / m.reach) : 0,
    cvr: lc ? round((conv / lc) * 100) : 0,
    results: conv,
  };
}
const sumGroup = Object.fromEntries(MKEYS.map((k) => [k, { $sum: "$" + k }]));

async function perfBy(org, { adAccountId, from, to, level = "campaign", ids }) {
  const key =
    level === "ad"
      ? "$adId"
      : level === "adset"
        ? "$adsetId"
        : level === "account"
          ? "$adAccountId"
          : "$campaignId";
  const match = { organizationId: org, date: { $gte: from, $lte: to } };
  if (adAccountId) match.adAccountId = adAccountId;
  if (ids?.length) match[key.slice(1)] = { $in: ids };
  const rows = await AdInsight.aggregate([
    { $match: match },
    { $group: { _id: key, ...sumGroup } },
  ]);
  return Object.fromEntries(rows.map((r) => [r._id, kpis(r)]));
}
async function totals(org, match) {
  const [r] = await AdInsight.aggregate([
    { $match: { organizationId: org, ...match } },
    { $group: { _id: null, ...sumGroup } },
  ]);
  return kpis(r || {});
}

async function syncAdAccount(org, acc, days = 30) {
  const token = tok(acc);
  const act = acc.accountId.startsWith("act_")
    ? acc.accountId
    : "act_" + acc.accountId;
  const info = await graph(`/${act}`, {
    token,
    params: { fields: "name,currency,timezone_name,account_status" },
  });
  const div = minorDiv(info.currency);
  const money = (v) => (v != null && v !== "" ? Number(v) / div : null);
  const now = new Date();
  const ent = (level, x, extra) => ({
    updateOne: {
      filter: { organizationId: org, metaId: x.id },
      update: {
        $set: {
          organizationId: org,
          adAccountId: acc.accountId,
          level,
          metaId: x.id,
          name: x.name,
          status: x.status,
          effectiveStatus: x.effective_status,
          syncedAt: now,
          ...extra,
        },
      },
      upsert: true,
    },
  });
  const [camps, sets, ads] = await Promise.all([
    graphAll(`/${act}/campaigns`, {
      token,
      params: {
        fields:
          "id,name,objective,status,effective_status,daily_budget,lifetime_budget,start_time,stop_time",
        limit: 200,
      },
    }),
    graphAll(`/${act}/adsets`, {
      token,
      params: {
        fields:
          "id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,optimization_goal,start_time,end_time,targeting",
        limit: 200,
      },
    }),
    graphAll(`/${act}/ads`, {
      token,
      params: {
        fields:
          "id,name,adset_id,campaign_id,status,effective_status,creative{id,title,body,image_url,thumbnail_url,call_to_action_type,object_story_spec}",
        limit: 200,
      },
    }),
  ]);
  const ops = [
    ...camps.map((c) =>
      ent("campaign", c, {
        objective: c.objective,
        dailyBudget: money(c.daily_budget),
        lifetimeBudget: money(c.lifetime_budget),
        startTime: c.start_time || null,
        stopTime: c.stop_time || null,
        campaignId: c.id,
      }),
    ),
    ...sets.map((s) =>
      ent("adset", s, {
        parentId: s.campaign_id,
        campaignId: s.campaign_id,
        dailyBudget: money(s.daily_budget),
        lifetimeBudget: money(s.lifetime_budget),
        optimizationGoal: s.optimization_goal,
        startTime: s.start_time || null,
        stopTime: s.end_time || null,
        targeting: s.targeting || null,
      }),
    ),
    ...ads.map((a) =>
      ent("ad", a, {
        parentId: a.adset_id,
        campaignId: a.campaign_id,
        creative: a.creative || null,
      }),
    ),
  ];
  if (ops.length) await AdEntity.bulkWrite(ops, { ordered: false });

  // Daily ad-level insights
  const timeRange = { since: daysAgo(days - 1), until: daysAgo(0) };
  const ins = await graphAll(
    `/${act}/insights`,
    {
      token,
      params: {
        level: "ad",
        time_increment: 1,
        time_range: timeRange,
        limit: 500,
        fields:
          "ad_id,adset_id,campaign_id,spend,impressions,reach,clicks,inline_link_clicks,frequency,actions,action_values",
      },
    },
    20000,
  );
  const iops = ins.map((r) => ({
    updateOne: {
      filter: { organizationId: org, adId: r.ad_id, date: r.date_start },
      update: {
        $set: {
          organizationId: org,
          adAccountId: acc.accountId,
          date: r.date_start,
          adId: r.ad_id,
          adsetId: r.adset_id,
          campaignId: r.campaign_id,
          spend: Number(r.spend) || 0,
          impressions: Number(r.impressions) || 0,
          reach: Number(r.reach) || 0,
          clicks: Number(r.clicks) || 0,
          linkClicks: Number(r.inline_link_clicks) || 0,
          frequency: Number(r.frequency) || 0,
          leads: actionVal(r.actions, LEAD_TYPES),
          purchases: actionVal(r.actions, PURCHASE_TYPES),
          purchaseValue: actionVal(r.action_values, PURCHASE_TYPES),
        },
      },
      upsert: true,
    },
  }));
  if (iops.length) await AdInsight.bulkWrite(iops, { ordered: false });

  // Placement + audience breakdowns (last 30 days, campaign level)
  const bfields =
    "campaign_id,spend,impressions,reach,clicks,inline_link_clicks,actions,action_values";
  for (const [kind, breakdowns, keyOf] of [
    [
      "placement",
      "publisher_platform,platform_position",
      (r) => `${r.publisher_platform} · ${r.platform_position}`,
    ],
    ["age_gender", "age,gender", (r) => `${r.age} · ${r.gender}`],
    ["region", "region", (r) => r.region],
  ]) {
    try {
      const rows = await graphAll(
        `/${act}/insights`,
        {
          token,
          params: {
            level: "campaign",
            breakdowns,
            date_preset: "last_30d",
            fields: bfields,
            limit: 500,
          },
        },
        5000,
      );
      await AdBreakdown.deleteMany({
        organizationId: org,
        adAccountId: acc.accountId,
        kind,
      });
      if (rows.length)
        await AdBreakdown.insertMany(
          rows.map((r) => ({
            organizationId: org,
            adAccountId: acc.accountId,
            kind,
            campaignId: r.campaign_id,
            key: keyOf(r),
            range: "last_30d",
            syncedAt: now,
            metrics: {
              spend: Number(r.spend) || 0,
              impressions: Number(r.impressions) || 0,
              reach: Number(r.reach) || 0,
              clicks: Number(r.clicks) || 0,
              linkClicks: Number(r.inline_link_clicks) || 0,
              leads: actionVal(r.actions, LEAD_TYPES),
              purchases: actionVal(r.actions, PURCHASE_TYPES),
              purchaseValue: actionVal(r.action_values, PURCHASE_TYPES),
            },
          })),
        );
    } catch (e) {
      console.warn(`breakdown ${kind}:`, e.message);
    }
  }
  await SocialAccount.updateOne(
    { _id: acc.id },
    {
      currency: info.currency,
      timezone: info.timezone_name,
      lastSyncedAt: now,
      healthNote:
        info.account_status === 1
          ? null
          : `Ad account status ${info.account_status}`,
    },
  );
  return {
    campaigns: camps.length,
    adsets: sets.length,
    ads: ads.length,
    insightRows: ins.length,
  };
}

app.get(
  "/api/ads/accounts",
  wrap(async (req, res) =>
    res.json(
      (
        await SocialAccount.find({
          organizationId: tid(req),
          platform: "Meta Ads",
        }).sort({ accountName: 1 })
      ).map(accView),
    ),
  ),
);

app.post(
  "/api/ads/sync",
  wrap(async (req, res) => {
    const org = tid(req);
    const accs = req.body.adAccountId
      ? [await adAccountFor(org, req.body.adAccountId)]
      : await SocialAccount.find({
          organizationId: org,
          platform: "Meta Ads",
        }).select("+accessToken");
    if (!accs.length) throw fail(400, "No ad account connected");
    const out = {};
    for (const a of accs) {
      out[a.accountId] = await syncAdAccount(
        org,
        a,
        Number(req.body.days) || 30,
      ).catch((e) => ({ error: e.message }));
    }
    await runAdRules(org).catch((e) => console.warn("rules:", e.message));
    await checkBudgets(org).catch((e) => console.warn("budgets:", e.message));
    res.json({ success: true, result: out });
  }),
);

// Campaign -> ad set -> ad tree with metrics for the range
app.get(
  "/api/ads/tree",
  wrap(async (req, res) => {
    const org = tid(req);
    const { adAccountId } = req.query;
    const { from, to } = range(req.query, 7);
    const q = { organizationId: org, ...(adAccountId ? { adAccountId } : {}) };
    if (req.query.active === "1")
      q.effectiveStatus = { $nin: ["DELETED", "ARCHIVED"] };
    const [ents, pc, ps, pa] = await Promise.all([
      AdEntity.find(q).lean(),
      perfBy(org, { adAccountId, from, to, level: "campaign" }),
      perfBy(org, { adAccountId, from, to, level: "adset" }),
      perfBy(org, { adAccountId, from, to, level: "ad" }),
    ]);
    const m = { campaign: pc, adset: ps, ad: pa };
    const view = (e) => ({
      id: e.metaId,
      level: e.level,
      name: e.name,
      status: e.status,
      effectiveStatus: e.effectiveStatus,
      objective: e.objective,
      dailyBudget: e.dailyBudget,
      lifetimeBudget: e.lifetimeBudget,
      optimizationGoal: e.optimizationGoal,
      adAccountId: e.adAccountId,
      creative: e.creative
        ? {
            title: e.creative.title,
            body: e.creative.body,
            image: e.creative.image_url || e.creative.thumbnail_url,
            cta: e.creative.call_to_action_type,
          }
        : null,
      metrics: m[e.level][e.metaId] || kpis(),
    });
    const camps = ents
      .filter((e) => e.level === "campaign")
      .map((c) => ({
        ...view(c),
        adsets: ents
          .filter((s) => s.level === "adset" && s.parentId === c.metaId)
          .map((s) => ({
            ...view(s),
            ads: ents
              .filter((a) => a.level === "ad" && a.parentId === s.metaId)
              .map(view),
          })),
      }))
      .sort((a, b) => b.metrics.spend - a.metrics.spend);
    res.json({ from, to, campaigns: camps });
  }),
);

app.get(
  "/api/ads/performance",
  wrap(async (req, res) => {
    const org = tid(req);
    const { adAccountId, level = "campaign" } = req.query;
    const { from, to } = range(req.query, 7);
    const ids = req.query.ids ? String(req.query.ids).split(",") : null;
    const [perf, ents, total] = await Promise.all([
      perfBy(org, { adAccountId, from, to, level, ids }),
      AdEntity.find({
        organizationId: org,
        level,
        ...(adAccountId ? { adAccountId } : {}),
        ...(ids ? { metaId: { $in: ids } } : {}),
      }).lean(),
      totals(org, {
        date: { $gte: from, $lte: to },
        ...(adAccountId ? { adAccountId } : {}),
      }),
    ]);
    const rows = ents
      .map((e) => ({
        id: e.metaId,
        name: e.name,
        status: e.effectiveStatus,
        objective: e.objective,
        dailyBudget: e.dailyBudget,
        campaignId: e.campaignId,
        metrics: perf[e.metaId] || kpis(),
      }))
      .filter((r) => ids || r.metrics.impressions > 0 || r.status === "ACTIVE")
      .sort((a, b) => b.metrics.spend - a.metrics.spend);
    res.json({ from, to, level, total, rows });
  }),
);

app.get(
  "/api/ads/daily",
  wrap(async (req, res) => {
    const org = tid(req);
    const { from, to } = range(req.query, 30);
    const match = { organizationId: org, date: { $gte: from, $lte: to } };
    if (req.query.adAccountId) match.adAccountId = req.query.adAccountId;
    for (const k of ["campaignId", "adsetId", "adId"])
      if (req.query[k]) match[k] = req.query[k];
    const rows = await AdInsight.aggregate([
      { $match: match },
      { $group: { _id: "$date", ...sumGroup } },
      { $sort: { _id: 1 } },
    ]);
    res.json(rows.map((r) => ({ date: r._id, ...kpis(r) })));
  }),
);

app.get(
  "/api/ads/breakdowns",
  wrap(async (req, res) => {
    const org = tid(req);
    const q = { organizationId: org, kind: req.query.kind || "placement" };
    if (req.query.adAccountId) q.adAccountId = req.query.adAccountId;
    if (req.query.campaignId) q.campaignId = req.query.campaignId;
    const rows = await AdBreakdown.find(q).lean();
    const agg = {};
    for (const r of rows) {
      agg[r.key] = agg[r.key] || {};
      for (const k of MKEYS)
        agg[r.key][k] = (agg[r.key][k] || 0) + (r.metrics[k] || 0);
    }
    res.json(
      Object.entries(agg)
        .map(([key, m]) => ({ key, ...kpis(m) }))
        .sort((a, b) => b.spend - a.spend),
    );
  }),
);

// Rename is low-impact and applied directly. Status/budget changes go through change requests.
app.put(
  "/api/ads/entities/:metaId",
  wrap(async (req, res) => {
    const org = tid(req);
    const e = await AdEntity.findOne({
      organizationId: org,
      metaId: req.params.metaId,
    });
    if (!e) throw fail(404, "Not found. Sync the ad account first.");
    if (!req.body.name) throw fail(400, "name is required");
    const acc = await adAccountFor(org, e.adAccountId);
    await graph(`/${e.metaId}`, {
      token: tok(acc),
      method: "POST",
      body: { name: req.body.name },
    });
    e.name = req.body.name;
    await e.save();
    res.json({ success: true });
  }),
);

app.get(
  "/api/ads/audiences",
  wrap(async (req, res) => {
    const acc = await adAccountFor(tid(req), req.query.adAccountId);
    const act = acc.accountId.startsWith("act_")
      ? acc.accountId
      : "act_" + acc.accountId;
    res.json(
      await graphAll(`/${act}/customaudiences`, {
        token: tok(acc),
        params: {
          fields:
            "id,name,subtype,approximate_count_lower_bound,approximate_count_upper_bound,operation_status,delivery_status,time_created",
          limit: 200,
        },
      }),
    );
  }),
);
app.post(
  "/api/ads/audiences/lookalike",
  wrap(async (req, res) => {
    const {
      adAccountId,
      sourceId,
      country = "BD",
      ratio = 0.01,
      name,
    } = req.body;
    if (!sourceId) throw fail(400, "Pick a source audience");
    const acc = await adAccountFor(tid(req), adAccountId);
    const act = acc.accountId.startsWith("act_")
      ? acc.accountId
      : "act_" + acc.accountId;
    const r = await graph(`/${act}/customaudiences`, {
      token: tok(acc),
      method: "POST",
      body: {
        name: name || `Lookalike ${country} ${Math.round(ratio * 100)}%`,
        subtype: "LOOKALIKE",
        origin_audience_id: sourceId,
        lookalike_spec: { type: "similarity", country, ratio: Number(ratio) },
      },
    });
    res.json({ success: true, id: r.id });
  }),
);
app.get(
  "/api/ads/pixels",
  wrap(async (req, res) => {
    const acc = await adAccountFor(tid(req), req.query.adAccountId);
    const act = acc.accountId.startsWith("act_")
      ? acc.accountId
      : "act_" + acc.accountId;
    res.json(
      await graphAll(`/${act}/adspixels`, {
        token: tok(acc),
        params: { fields: "id,name,last_fired_time,is_unavailable", limit: 50 },
      }),
    );
  }),
);
app.get(
  "/api/ads/geo",
  wrap(async (req, res) => {
    const acc = await adAccountFor(tid(req), req.query.adAccountId);
    const r = await graph("/search", {
      token: tok(acc),
      params: {
        type: "adgeolocation",
        q: req.query.q || "",
        location_types: JSON.stringify([req.query.type || "city"]),
        limit: 15,
      },
    });
    res.json(
      (r.data || []).map((g) => ({
        key: g.key,
        name: g.name,
        type: g.type,
        region: g.region,
        country: g.country_code,
      })),
    );
  }),
);

/* ---------- campaign drafts + approval workflow ---------- */
const DRAFT_FIELDS = [
  "brandId",
  "adAccountId",
  "name",
  "objective",
  "specialAdCategories",
  "dailyBudget",
  "startTime",
  "endTime",
  "targeting",
  "placements",
  "pixelId",
  "conversionEvent",
  "pageId",
  "leadFormId",
  "creative",
];
const OBJECTIVES = {
  OUTCOME_TRAFFIC: {
    optimization_goal: "LINK_CLICKS",
    destination_type: "WEBSITE",
  },
  OUTCOME_LEADS: {
    optimization_goal: "LEAD_GENERATION",
    destination_type: "ON_AD",
  },
  OUTCOME_SALES: {
    optimization_goal: "OFFSITE_CONVERSIONS",
    destination_type: "WEBSITE",
  },
  OUTCOME_AWARENESS: { optimization_goal: "REACH" },
};
function utmLink(link, utm = {}) {
  if (!link) return null;
  try {
    const u = new URL(link);
    for (const [k, v] of Object.entries({
      utm_source: utm.source,
      utm_medium: utm.medium,
      utm_campaign: utm.campaign,
      utm_content: utm.content,
    }))
      if (v) u.searchParams.set(k, v);
    return u.toString();
  } catch {
    return link;
  }
}
function validateDraft(d) {
  const e = [];
  if (!OBJECTIVES[d.objective])
    e.push(
      "Objective must be Traffic, Leads, Sales or Awareness (create others in Ads Manager)",
    );
  if (!(d.dailyBudget > 0)) e.push("Daily budget must be greater than 0");
  if (!d.pageId) e.push("Pick a Facebook Page");
  if (!d.creative?.mediaId) e.push("Pick an approved image for the ad");
  if (!d.creative?.primaryText) e.push("Primary text is required");
  if (d.objective === "OUTCOME_LEADS" && !d.leadFormId)
    e.push("Lead campaigns need an instant form");
  if (d.objective === "OUTCOME_SALES" && (!d.pixelId || !d.conversionEvent))
    e.push("Sales campaigns need a pixel and conversion event");
  if (
    ["OUTCOME_TRAFFIC", "OUTCOME_SALES"].includes(d.objective) &&
    !d.creative?.link
  )
    e.push("Website link is required");
  if (!d.targeting?.countries?.length && !d.targeting?.cities?.length)
    e.push("Add at least one location");
  return e;
}

app.get(
  "/api/ads/drafts",
  wrap(async (req, res) =>
    res.json(
      await CampaignDraft.find({ organizationId: tid(req) })
        .sort({ updatedAt: -1 })
        .limit(100),
    ),
  ),
);
app.post(
  "/api/ads/drafts",
  wrap(async (req, res) => {
    const d = pick(req.body, DRAFT_FIELDS);
    if (!d.name || !d.adAccountId)
      throw fail(400, "name and adAccountId are required");
    res.json({
      success: true,
      draft: await CampaignDraft.create({
        ...d,
        organizationId: tid(req),
        reviews: [{ action: "created", by: actor(req) }],
      }),
    });
  }),
);
app.put(
  "/api/ads/drafts/:id",
  wrap(async (req, res) => {
    const d = await CampaignDraft.findOne({
      _id: req.params.id,
      organizationId: tid(req),
    });
    if (!d) throw fail(404, "Draft not found");
    if (!["draft", "rejected", "error"].includes(d.status))
      throw fail(400, `Draft is ${d.status}; it can't be edited`);
    Object.assign(d, pick(req.body, DRAFT_FIELDS));
    d.status = "draft";
    await d.save();
    res.json({ success: true, draft: d });
  }),
);
app.delete(
  "/api/ads/drafts/:id",
  wrap(async (req, res) => {
    const d = await CampaignDraft.findOne({
      _id: req.params.id,
      organizationId: tid(req),
    });
    if (!d) throw fail(404, "Draft not found");
    if (d.meta?.campaignId)
      throw fail(
        400,
        "This draft already exists in Meta. Pause or delete it in Ads Manager.",
      );
    await d.deleteOne();
    res.json({ success: true });
  }),
);
app.post(
  "/api/ads/drafts/:id/submit",
  wrap(async (req, res) => {
    const org = tid(req);
    const d = await CampaignDraft.findOne({
      _id: req.params.id,
      organizationId: org,
    });
    if (!d) throw fail(404, "Draft not found");
    const errs = validateDraft(d);
    if (errs.length) throw fail(400, errs.join(" · "));
    d.status = "pending_approval";
    d.reviews.push({
      action: "submitted",
      by: actor(req),
      comment: req.body.comment || "",
    });
    await d.save();
    await notify(
      org,
      "approval",
      "Ad campaign waiting for approval",
      `${d.name}: ${d.dailyBudget}/day`,
      "ads",
    );
    res.json({ success: true, draft: d });
  }),
);
app.post(
  "/api/ads/drafts/:id/review",
  wrap(async (req, res) => {
    const d = await CampaignDraft.findOne({
      _id: req.params.id,
      organizationId: tid(req),
    });
    if (!d) throw fail(404, "Draft not found");
    if (d.status !== "pending_approval")
      throw fail(400, "Draft is not waiting for approval");
    const { action, comment = "" } = req.body;
    if (!["approve", "reject"].includes(action))
      throw fail(400, "action must be approve or reject");
    d.status = action === "approve" ? "approved" : "rejected";
    d.reviews.push({ action: action + "d", by: actor(req), comment });
    await d.save();
    res.json({ success: true, draft: d });
  }),
);

// Creates campaign + ad set + creative + ad in Meta, all PAUSED. Re-running continues where it stopped.
app.post(
  "/api/ads/drafts/:id/create",
  wrap(async (req, res) => {
    const org = tid(req);
    const d = await CampaignDraft.findOne({
      _id: req.params.id,
      organizationId: org,
    });
    if (!d) throw fail(404, "Draft not found");
    if (!["approved", "error"].includes(d.status))
      throw fail(400, "Only approved drafts can be created in Meta");
    const errs = validateDraft(d);
    if (errs.length) throw fail(400, errs.join(" · "));
    const acc = await adAccountFor(org, d.adAccountId);
    const token = tok(acc);
    const act = acc.accountId.startsWith("act_")
      ? acc.accountId
      : "act_" + acc.accountId;
    const div = minorDiv(acc.currency);
    d.meta = d.meta || {};
    try {
      if (!d.meta.campaignId) {
        const body = {
          name: d.name,
          objective: d.objective,
          status: "PAUSED",
          special_ad_categories: d.specialAdCategories || [],
          buying_type: "AUCTION",
        };
        if (process.env.META_ADSET_BUDGET_SHARING_FLAG !== "0")
          body.is_adset_budget_sharing_enabled = false; // required by newer API versions when budgets live on ad sets
        d.meta.campaignId = (
          await graph(`/${act}/campaigns`, { token, method: "POST", body })
        ).id;
        await d.save();
      }
      if (!d.meta.adsetId) {
        const t = d.targeting || {};
        const geo = t.cities?.length
          ? {
              cities: t.cities.map((c) => ({
                key: c.key,
                radius: c.radius || 10,
                distance_unit: "kilometer",
              })),
            }
          : { countries: t.countries };
        const targeting = {
          geo_locations: geo,
          age_min: t.ageMin || 18,
          age_max: t.ageMax || 65,
          targeting_automation: {
            advantage_audience: t.advantageAudience ? 1 : 0,
          },
        };
        if (t.genders?.length) targeting.genders = t.genders;
        if (t.customAudiences?.length)
          targeting.custom_audiences = t.customAudiences.map((a) => ({
            id: a.id,
          }));
        if (t.excludedAudiences?.length)
          targeting.excluded_custom_audiences = t.excludedAudiences.map(
            (a) => ({ id: a.id }),
          );
        const p = d.placements || {};
        if (!p.automatic && p.publisherPlatforms?.length) {
          targeting.publisher_platforms = p.publisherPlatforms;
          if (p.facebookPositions?.length)
            targeting.facebook_positions = p.facebookPositions;
          if (p.instagramPositions?.length)
            targeting.instagram_positions = p.instagramPositions;
        }
        const o = OBJECTIVES[d.objective];
        const body = {
          name: `${d.name} - Ad set`,
          campaign_id: d.meta.campaignId,
          daily_budget: Math.round(d.dailyBudget * div),
          billing_event: "IMPRESSIONS",
          optimization_goal: o.optimization_goal,
          bid_strategy: "LOWEST_COST_WITHOUT_CAP",
          targeting,
          status: "PAUSED",
          start_time: d.startTime
            ? new Date(d.startTime).toISOString()
            : undefined,
          end_time: d.endTime ? new Date(d.endTime).toISOString() : undefined,
        };
        if (o.destination_type) body.destination_type = o.destination_type;
        if (d.objective === "OUTCOME_LEADS")
          body.promoted_object = { page_id: d.pageId };
        if (d.objective === "OUTCOME_SALES")
          body.promoted_object = {
            pixel_id: d.pixelId,
            custom_event_type: d.conversionEvent,
          };
        d.meta.adsetId = (
          await graph(`/${act}/adsets`, { token, method: "POST", body })
        ).id;
        await d.save();
      }
      if (!d.meta.imageHash) {
        const m = await MediaAsset.findOne({
          _id: d.creative.mediaId,
          organizationId: org,
        });
        if (!m) throw fail(400, "Ad image not found");
        let buf;
        if (m.file && fs.existsSync(localFile(m)))
          buf = fs.readFileSync(localFile(m));
        else
          buf = Buffer.from(
            await (await fetch(publicUrl(m.url))).arrayBuffer(),
          );
        const r = await graph(`/${act}/adimages`, {
          token,
          method: "POST",
          body: { bytes: buf.toString("base64") },
        });
        d.meta.imageHash = Object.values(r.images || {})[0]?.hash;
        if (!d.meta.imageHash)
          throw fail(502, "Meta did not return an image hash");
        await d.save();
      }
      if (!d.meta.creativeId) {
        const c = d.creative;
        const link = utmLink(c.link, c.utm) || "https://fb.me/";
        const cta =
          d.objective === "OUTCOME_LEADS"
            ? {
                type: c.cta || "SIGN_UP",
                value: { lead_gen_form_id: d.leadFormId },
              }
            : { type: c.cta || "LEARN_MORE", value: { link } };
        const body = {
          name: `${d.name} - Creative`,
          object_story_spec: {
            page_id: d.pageId,
            link_data: {
              link,
              message: c.primaryText,
              name: c.headline || undefined,
              description: c.description || undefined,
              image_hash: d.meta.imageHash,
              call_to_action: cta,
            },
          },
        };
        d.meta.creativeId = (
          await graph(`/${act}/adcreatives`, { token, method: "POST", body })
        ).id;
        await d.save();
      }
      if (!d.meta.adId) {
        d.meta.adId = (
          await graph(`/${act}/ads`, {
            token,
            method: "POST",
            body: {
              name: `${d.name} - Ad`,
              adset_id: d.meta.adsetId,
              creative: { creative_id: d.meta.creativeId },
              status: "PAUSED",
            },
          })
        ).id;
      }
      d.status = "created";
      d.lastError = null;
      d.reviews.push({ action: "created in Meta (paused)", by: actor(req) });
      d.markModified("meta");
      await d.save();
      syncAdAccount(org, acc, 7).catch(() => {});
      res.json({ success: true, draft: d });
    } catch (e) {
      d.status = "error";
      d.lastError = e.message;
      d.markModified("meta");
      await d.save();
      throw e;
    }
  }),
);

// Ask to activate a created draft (goes through change-request approval)
app.post(
  "/api/ads/drafts/:id/activate",
  wrap(async (req, res) => {
    const org = tid(req);
    const d = await CampaignDraft.findOne({
      _id: req.params.id,
      organizationId: org,
    });
    if (!d || d.status !== "created")
      throw fail(400, "Only drafts created in Meta can be activated");
    const cr = await ChangeRequest.create({
      organizationId: org,
      adAccountId: d.adAccountId,
      level: "campaign",
      metaId: d.meta.campaignId,
      entityName: d.name,
      type: "activate_draft",
      from: "PAUSED",
      to: "ACTIVE",
      reason: req.body.reason || "Launch campaign",
      requestedBy: actor(req),
      draftId: d.id,
    });
    await notify(
      org,
      "approval",
      "Campaign activation needs approval",
      `${d.name}: ${d.dailyBudget}/day`,
      "ads",
    );
    res.json({ success: true, change: cr });
  }),
);

/* ---------- change requests (approval-based campaign changes) ---------- */
async function applyChange(org, cr) {
  const acc = await adAccountFor(org, cr.adAccountId);
  const token = tok(acc);
  if (cr.type === "status")
    await graph(`/${cr.metaId}`, {
      token,
      method: "POST",
      body: { status: cr.to },
    });
  else if (cr.type === "budget")
    await graph(`/${cr.metaId}`, {
      token,
      method: "POST",
      body: {
        daily_budget: Math.round(Number(cr.to) * minorDiv(acc.currency)),
      },
    });
  else if (cr.type === "activate_draft") {
    const d = await CampaignDraft.findOne({
      _id: cr.draftId,
      organizationId: org,
    });
    for (const id of [d.meta.campaignId, d.meta.adsetId, d.meta.adId])
      await graph(`/${id}`, {
        token,
        method: "POST",
        body: { status: "ACTIVE" },
      });
    d.status = "active";
    await d.save();
  } else throw fail(400, "Unknown change type");
  if (cr.type === "status")
    await AdEntity.updateOne(
      { organizationId: org, metaId: cr.metaId },
      { status: cr.to },
    );
  if (cr.type === "budget")
    await AdEntity.updateOne(
      { organizationId: org, metaId: cr.metaId },
      { dailyBudget: Number(cr.to) },
    );
  cr.status = "applied";
  cr.appliedAt = new Date();
  cr.error = null;
  await cr.save();
}
function withinGuardrails(s, cr, entity) {
  if (
    s.optimizationMode !== "guardrailed" ||
    cr.type !== "budget" ||
    !entity?.dailyBudget
  )
    return false;
  if (!s.guardrailAllowlist?.includes(entity.campaignId || entity.metaId))
    return false;
  const delta =
    Math.abs((Number(cr.to) - entity.dailyBudget) / entity.dailyBudget) * 100;
  return (
    delta <= s.maxBudgetDeltaPct &&
    (!s.maxDailyBudget || Number(cr.to) <= s.maxDailyBudget)
  );
}
async function requestChange(
  org,
  { metaId, type, to, reason, source = "user", by = "system" },
) {
  const e = await AdEntity.findOne({ organizationId: org, metaId });
  if (!e) throw fail(404, "Ad entity not found. Sync first.");
  if (type === "status" && !["ACTIVE", "PAUSED"].includes(to))
    throw fail(400, "status must be ACTIVE or PAUSED");
  if (type === "budget" && !(Number(to) > 0))
    throw fail(400, "Budget must be greater than 0");
  if (type === "budget" && e.dailyBudget == null)
    throw fail(
      400,
      "This item has no daily budget (budget is set at another level or is lifetime)",
    );
  const cr = await ChangeRequest.create({
    organizationId: org,
    adAccountId: e.adAccountId,
    level: e.level,
    metaId,
    entityName: e.name,
    type,
    from: type === "budget" ? e.dailyBudget : e.status,
    to: type === "budget" ? Number(to) : to,
    reason,
    source,
    requestedBy: by,
  });
  const s = await getSettings(org);
  if (withinGuardrails(s, cr, e)) {
    cr.status = "approved";
    cr.reviewedBy = "guardrail";
    cr.source = "guardrail";
    try {
      await applyChange(org, cr);
    } catch (err) {
      cr.status = "failed";
      cr.error = err.message;
      await cr.save();
    }
  } else
    await notify(
      org,
      "approval",
      "Campaign change needs approval",
      `${e.name}: ${type} ${cr.from} → ${cr.to}`,
      "ads",
    );
  return cr;
}
app.get(
  "/api/ads/changes",
  wrap(async (req, res) => {
    const q = { organizationId: tid(req) };
    if (req.query.status)
      q.status = { $in: String(req.query.status).split(",") };
    res.json(await ChangeRequest.find(q).sort({ createdAt: -1 }).limit(200));
  }),
);
app.post(
  "/api/ads/changes",
  wrap(async (req, res) => {
    const { metaId, type, to, reason } = req.body;
    res.json({
      success: true,
      change: await requestChange(tid(req), {
        metaId,
        type,
        to,
        reason,
        by: actor(req),
      }),
    });
  }),
);
app.post(
  "/api/ads/changes/:id/review",
  wrap(async (req, res) => {
    const org = tid(req);
    const cr = await ChangeRequest.findOne({
      _id: req.params.id,
      organizationId: org,
    });
    if (!cr) throw fail(404, "Change request not found");
    if (!["pending", "failed"].includes(cr.status))
      throw fail(400, `Change is ${cr.status}`);
    const { action, comment = "" } = req.body;
    if (!["approve", "reject"].includes(action))
      throw fail(400, "action must be approve or reject");
    cr.reviewedBy = actor(req);
    cr.reviewComment = comment;
    if (action === "reject") {
      cr.status = "rejected";
      await cr.save();
      return res.json({ success: true, change: cr });
    }
    cr.status = "approved";
    try {
      await applyChange(org, cr);
    } catch (e) {
      cr.status = "failed";
      cr.error = e.message;
      await cr.save();
      throw e;
    }
    res.json({ success: true, change: cr });
  }),
);

/* =====================================================
   AI ADS OPTIMIZATION (1.7): deterministic rules + AI analysis
   ===================================================== */
async function upsertRec(org, key, data) {
  const exists = await Recommendation.findOne({
    organizationId: org,
    key,
    status: "open",
  });
  if (exists) {
    Object.assign(exists, data);
    await exists.save();
    return { rec: exists, isNew: false };
  }
  return {
    rec: await Recommendation.create({ organizationId: org, key, ...data }),
    isNew: true,
  };
}

async function runAdRules(org) {
  const s = await getSettings(org);
  const accs = await SocialAccount.find({
    organizationId: org,
    platform: "Meta Ads",
  });
  const week =
    ymd(new Date()).slice(0, 8) + String(Math.ceil(new Date().getDate() / 7));
  let created = 0;
  for (const acc of accs) {
    const A = acc.accountId;
    const cur = { from: daysAgo(6), to: daysAgo(0) },
      prev = { from: daysAgo(13), to: daysAgo(7) };
    const [ad7, adPrev, c7, cPrev, s7, acct, ents, today] = await Promise.all([
      perfBy(org, { adAccountId: A, ...cur, level: "ad" }),
      perfBy(org, { adAccountId: A, ...prev, level: "ad" }),
      perfBy(org, { adAccountId: A, ...cur, level: "campaign" }),
      perfBy(org, { adAccountId: A, ...prev, level: "campaign" }),
      perfBy(org, { adAccountId: A, ...cur, level: "adset" }),
      totals(org, { adAccountId: A, date: { $gte: cur.from, $lte: cur.to } }),
      AdEntity.find({ organizationId: org, adAccountId: A }).lean(),
      perfBy(org, {
        adAccountId: A,
        from: daysAgo(0),
        to: daysAgo(0),
        level: "campaign",
      }),
    ]);
    const byId = Object.fromEntries(ents.map((e) => [e.metaId, e]));
    const cur$ = acc.currency || "";
    const add = async (key, data) => {
      const r = await upsertRec(org, `${key}:${week}`, {
        adAccountId: A,
        ...data,
      });
      if (r.isNew) {
        created++;
        if (data.severity === "high")
          await notify(org, "ads", data.title, data.detail, "optimize");
      }
    };

    for (const [id, m] of Object.entries(ad7)) {
      const e = byId[id];
      if (!e || e.effectiveStatus !== "ACTIVE" || m.impressions < 1000)
        continue;
      // Underperforming: CTR far below account average, or cost per lead far above it
      const lowCtr = acct.ctr > 0 && m.ctr < acct.ctr * 0.5;
      const highCpl =
        acct.cpl > 0 &&
        ((m.leads > 0 && m.cpl > acct.cpl * 1.5) ||
          (m.leads === 0 && m.spend > acct.cpl * 2));
      if (lowCtr || highCpl) {
        await add(`under:${id}`, {
          type: "underperforming",
          level: "ad",
          metaId: id,
          entityName: e.name,
          severity:
            acct.spend && m.spend / acct.spend > 0.2 ? "high" : "medium",
          title: `Underperforming ad: ${e.name}`,
          detail: lowCtr
            ? `Link CTR ${m.ctr}% vs account ${acct.ctr}% over the last 7 days.`
            : `Cost per lead ${m.cpl || "∞"} ${cur$} vs account ${acct.cpl} ${cur$}.`,
          evidence: {
            period: `${cur.from}..${cur.to}`,
            ad: m,
            account: pick(acct, ["ctr", "cpl", "cpc", "spend"]),
          },
          action: { type: "status", to: "PAUSED" },
        });
      }
      // Creative fatigue: high frequency and CTR dropping versus the previous week
      const p = adPrev[id];
      if (
        p &&
        p.impressions >= 1000 &&
        m.frequency >= 3 &&
        m.ctr < p.ctr * 0.7
      ) {
        await add(`fatigue:${id}`, {
          type: "fatigue",
          level: "ad",
          metaId: id,
          entityName: e.name,
          severity: "medium",
          title: `Creative fatigue: ${e.name}`,
          detail: `Frequency ${m.frequency} and link CTR fell from ${p.ctr}% to ${m.ctr}%. Refresh the creative or broaden the audience.`,
          evidence: { thisWeek: m, lastWeek: p },
        });
      }
    }
    for (const [id, m] of Object.entries(c7)) {
      const e = byId[id];
      if (!e) continue;
      const p = cPrev[id],
        t = today[id];
      if (t && e.dailyBudget && t.spend > e.dailyBudget * 1.2) {
        await add(`spendday:${id}:${daysAgo(0)}`, {
          type: "high_spend",
          level: "campaign",
          metaId: id,
          entityName: e.name,
          severity: "high",
          title: `High spend today: ${e.name}`,
          detail: `Spent ${t.spend} ${cur$} today vs daily budget ${e.dailyBudget} ${cur$}.`,
          evidence: { today: t, dailyBudget: e.dailyBudget },
        });
      }
      if (
        p &&
        p.spend > 0 &&
        m.spend > p.spend * 1.5 &&
        m.spend > 1000 &&
        (m.cpa === 0 || (p.cpa && m.cpa > p.cpa * 1.2))
      ) {
        await add(`spendweek:${id}`, {
          type: "high_spend",
          level: "campaign",
          metaId: id,
          entityName: e.name,
          severity: "medium",
          title: `Spend up ${pct(m.spend, p.spend)}%: ${e.name}`,
          detail: `Spend grew from ${p.spend} to ${m.spend} ${cur$} while cost per result went from ${p.cpa || "-"} to ${m.cpa || "-"}.`,
          evidence: { thisWeek: m, lastWeek: p },
        });
      }
    }
    // Budget suggestions where a daily budget exists (campaign budget or ad set budget)
    const avgCpa = acct.cpa || 0;
    const step = Math.min(s.maxBudgetDeltaPct || 20, 30) / 100;
    for (const e of ents.filter(
      (x) =>
        ["campaign", "adset"].includes(x.level) &&
        x.dailyBudget &&
        x.effectiveStatus === "ACTIVE",
    )) {
      const m = (e.level === "campaign" ? c7 : s7)[e.metaId];
      if (!m || m.results < 3 || !avgCpa) continue;
      if (m.cpa < avgCpa * 0.75) {
        const to = Math.round(e.dailyBudget * (1 + step));
        await add(`bud+:${e.metaId}`, {
          type: "budget_increase",
          level: e.level,
          metaId: e.metaId,
          entityName: e.name,
          severity: "low",
          title: `Scale ${e.name} by ${Math.round(step * 100)}%`,
          detail: `Cost per result ${m.cpa} ${cur$} is ${Math.round((1 - m.cpa / avgCpa) * 100)}% better than the account average (${avgCpa}). Suggested daily budget ${e.dailyBudget} → ${to}.`,
          evidence: { metrics: m, accountCpa: avgCpa },
          action: { type: "budget", to },
        });
      } else if (m.cpa > avgCpa * 1.5) {
        const to = Math.max(1, Math.round(e.dailyBudget * (1 - step)));
        await add(`bud-:${e.metaId}`, {
          type: "budget_decrease",
          level: e.level,
          metaId: e.metaId,
          entityName: e.name,
          severity: "medium",
          title: `Reduce budget on ${e.name}`,
          detail: `Cost per result ${m.cpa} ${cur$} is ${Math.round((m.cpa / avgCpa - 1) * 100)}% worse than the account average (${avgCpa}). Suggested daily budget ${e.dailyBudget} → ${to}.`,
          evidence: { metrics: m, accountCpa: avgCpa },
          action: { type: "budget", to },
        });
      }
    }
  }
  // Guardrailed automation: budget suggestions inside the guardrails are applied automatically
  if (s.optimizationMode === "guardrailed") {
    const recs = await Recommendation.find({
      organizationId: org,
      status: "open",
      "action.type": "budget",
    });
    for (const r of recs) {
      const e = await AdEntity.findOne({
        organizationId: org,
        metaId: r.metaId,
      }).lean();
      const probe = { type: "budget", to: r.action.to };
      if (withinGuardrails(s, probe, e)) {
        await requestChange(org, {
          metaId: r.metaId,
          type: "budget",
          to: r.action.to,
          reason: r.title,
          source: "guardrail",
          by: "guardrail",
        }).catch((err) => console.warn("guardrail:", err.message));
        r.status = "actioned";
        await r.save();
      }
    }
  }
  return created;
}

app.post(
  "/api/ads/rules/run",
  wrap(async (req, res) =>
    res.json({ success: true, created: await runAdRules(tid(req)) }),
  ),
);

app.get(
  "/api/ads/recommendations",
  wrap(async (req, res) => {
    const q = { organizationId: tid(req), status: req.query.status || "open" };
    if (req.query.adAccountId) q.adAccountId = req.query.adAccountId;
    res.json(await Recommendation.find(q).sort({ createdAt: -1 }).limit(200));
  }),
);
app.put(
  "/api/ads/recommendations/:id",
  wrap(async (req, res) => {
    const r = await Recommendation.findOneAndUpdate(
      { _id: req.params.id, organizationId: tid(req) },
      pick(req.body, ["status"]),
      { new: true },
    );
    if (!r) throw fail(404, "Recommendation not found");
    res.json({ success: true, recommendation: r });
  }),
);
// Turn a recommendation's action into a change request (approval flow)
app.post(
  "/api/ads/recommendations/:id/act",
  wrap(async (req, res) => {
    const org = tid(req);
    const r = await Recommendation.findOne({
      _id: req.params.id,
      organizationId: org,
    });
    if (!r?.action)
      throw fail(400, "This recommendation has no automatic action");
    const cr = await requestChange(org, {
      metaId: r.metaId,
      type: r.action.type,
      to: req.body.to ?? r.action.to,
      reason: r.title,
      source: r.source,
      by: actor(req),
    });
    r.status = "actioned";
    await r.save();
    res.json({ success: true, change: cr });
  }),
);

// AI analysis of campaigns/ads with explainable recommendations
app.post(
  "/api/ads/ai-analysis",
  wrap(async (req, res) => {
    const org = tid(req);
    const { adAccountId } = req.body;
    const { from, to } = range(req.body, 14);
    const [camps, ads, placements, demo, total] = await Promise.all([
      perfBy(org, { adAccountId, from, to, level: "campaign" }),
      perfBy(org, { adAccountId, from, to, level: "ad" }),
      AdBreakdown.find({
        organizationId: org,
        kind: "placement",
        ...(adAccountId ? { adAccountId } : {}),
      }).lean(),
      AdBreakdown.find({
        organizationId: org,
        kind: "age_gender",
        ...(adAccountId ? { adAccountId } : {}),
      }).lean(),
      totals(org, {
        date: { $gte: from, $lte: to },
        ...(adAccountId ? { adAccountId } : {}),
      }),
    ]);
    const ents = await AdEntity.find({
      organizationId: org,
      metaId: { $in: [...Object.keys(camps), ...Object.keys(ads)] },
    }).lean();
    const name = (id) => ents.find((e) => e.metaId === id);
    const table = (o) =>
      Object.entries(o)
        .filter(([, m]) => m.spend > 0)
        .sort((a, b) => b[1].spend - a[1].spend)
        .slice(0, 25)
        .map(([id, m]) => ({
          id,
          name: name(id)?.name,
          objective: name(id)?.objective,
          status: name(id)?.effectiveStatus,
          creative: name(id)?.creative
            ? {
                title: name(id).creative.title,
                body: (name(id).creative.body || "").slice(0, 160),
              }
            : undefined,
          ...pick(m, [
            "spend",
            "impressions",
            "ctr",
            "cpc",
            "cpm",
            "leads",
            "cpl",
            "purchases",
            "roas",
            "frequency",
          ]),
        }));
    const brk = (rows) =>
      rows
        .slice(0, 30)
        .map((r) => ({
          key: r.key,
          ...pick(kpis(r.metrics), [
            "spend",
            "impressions",
            "ctr",
            "cpl",
            "roas",
          ]),
        }));
    if (!total.spend)
      throw fail(400, "No ad spend in this period. Sync the ad account first.");
    const ctx = await brandContext(org, req.body.brandId, { products: false });
    const data = await aiJSON(
      org,
      "ads_analysis",
      `You are a senior Meta Ads performance analyst. Analyse ONLY the numbers provided. Every recommendation must cite the evidence (numbers) it is based on and a confidence. Return JSON: {"summary":"","highlights":[""],"recommendations":[{"type":"copy|creative|audience|placement|budget|general","targetId":"campaign or ad id or null","title":"","detail":"","evidence":"","confidence":"low|medium|high","priority":"low|medium|high"}],"copyIdeas":[{"forAdId":"","primaryText":"","headline":""}],"dataLimitations":[""]}`,
      `${ctx.text}\nPERIOD: ${from}..${to}\nACCOUNT TOTALS: ${JSON.stringify(pick(total, ["spend", "impressions", "ctr", "cpc", "cpm", "leads", "cpl", "purchases", "roas"]))}\nCAMPAIGNS: ${JSON.stringify(table(camps))}\nADS: ${JSON.stringify(table(ads))}\nPLACEMENTS (30d): ${JSON.stringify(brk(placements))}\nAGE/GENDER (30d): ${JSON.stringify(brk(demo))}`,
      { maxTokens: 3000, temperature: 0.4 },
    );
    for (const r of data.recommendations || []) {
      const e = r.targetId ? name(r.targetId) : null;
      await Recommendation.create({
        organizationId: org,
        adAccountId: adAccountId || e?.adAccountId,
        type: r.type || "general",
        level: e?.level,
        metaId: e?.metaId,
        entityName: e?.name,
        title: r.title,
        detail: `${r.detail}${r.evidence ? `\nEvidence: ${r.evidence}` : ""}`,
        evidence: { confidence: r.confidence, period: `${from}..${to}` },
        severity: r.priority || "medium",
        source: "ai",
      });
    }
    res.json({ success: true, from, to, analysis: data });
  }),
);

// AI copy recommendations for one ad
app.post(
  "/api/ads/ai-copy",
  wrap(async (req, res) => {
    const org = tid(req);
    const e = await AdEntity.findOne({
      organizationId: org,
      metaId: req.body.adId,
      level: "ad",
    }).lean();
    if (!e) throw fail(404, "Ad not found. Sync first.");
    const m =
      (
        await perfBy(org, {
          from: daysAgo(13),
          to: daysAgo(0),
          level: "ad",
          ids: [e.metaId],
        })
      )[e.metaId] || kpis();
    const ctx = await brandContext(org, req.body.brandId);
    const data = await aiJSON(
      org,
      "ads_copy",
      `You are a Meta ads copywriter. Suggest better ad copy based on the current copy and its performance. Return JSON: {"diagnosis":"","variants":[{"primaryText":"","headline":"","description":"","cta":"","why":""}],"creativeIdeas":[""]}. ${GROUNDING}`,
      `${ctx.text}\nCURRENT AD: ${JSON.stringify({ name: e.name, title: e.creative?.title, body: e.creative?.body, cta: e.creative?.call_to_action_type })}\nLAST 14 DAYS: ${JSON.stringify(pick(m, ["spend", "impressions", "ctr", "cpc", "cpl", "roas", "frequency"]))}\nLANGUAGE: ${LANG[req.body.language] || "same as current ad"}`,
    );
    res.json({ success: true, ...data });
  }),
);

/* =====================================================
   BUDGET & MARKETING EXPENSE (1.8)
   ===================================================== */
const monthDays = (m) =>
  new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0).getDate();

async function budgetSummary(org, month) {
  const s = await getSettings(org);
  const today = todayIn(s.timezone);
  const isCurrent = today.startsWith(month);
  const elapsed = isCurrent ? Number(today.slice(8, 10)) : monthDays(month);
  const accs = await SocialAccount.find({
    organizationId: org,
    platform: "Meta Ads",
  }).lean();
  const mMatch = {
    organizationId: org,
    date: { $gte: `${month}-01`, $lte: `${month}-31` },
  };
  const [daily, byCamp, byAdset, plans] = await Promise.all([
    AdInsight.aggregate([
      { $match: mMatch },
      {
        $group: {
          _id: { a: "$adAccountId", d: "$date" },
          spend: { $sum: "$spend" },
        },
      },
    ]),
    AdInsight.aggregate([
      { $match: mMatch },
      {
        $group: {
          _id: "$campaignId",
          adAccountId: { $first: "$adAccountId" },
          ...sumGroup,
        },
      },
    ]),
    AdInsight.aggregate([
      { $match: mMatch },
      {
        $group: {
          _id: "$adsetId",
          campaignId: { $first: "$campaignId" },
          ...sumGroup,
        },
      },
    ]),
    BudgetPlan.find({ organizationId: org, month }).lean(),
  ]);
  const ents = await AdEntity.find({
    organizationId: org,
    metaId: {
      $in: [...byCamp.map((c) => c._id), ...byAdset.map((x) => x._id)],
    },
  }).lean();
  const E = Object.fromEntries(ents.map((e) => [e.metaId, e]));
  const campIds = byCamp.map((c) => c._id);
  const campNames = campIds.map((id) => E[id]?.name).filter(Boolean);
  const attributed = await Order.aggregate([
    {
      $match: {
        organizationId: org,
        status: { $ne: "cancelled" },
        createdAt: {
          $gte: new Date(
            Date.UTC(+month.slice(0, 4), +month.slice(5, 7) - 1, 1),
          ),
          $lt: new Date(Date.UTC(+month.slice(0, 4), +month.slice(5, 7), 1)),
        },
        "attribution.campaign": { $in: [...campIds, ...campNames] },
      },
    },
    {
      $group: {
        _id: "$attribution.campaign",
        revenue: { $sum: "$total" },
        orders: { $sum: 1 },
      },
    },
  ]);
  const attr = Object.fromEntries(attributed.map((a) => [a._id, a]));
  const accounts = accs.map((a) => {
    const days = daily
      .filter((d) => d._id.a === a.accountId)
      .map((d) => ({ date: d._id.d, spend: round(d.spend) }))
      .sort((x, y) => x.date.localeCompare(y.date));
    const mtd = round(days.reduce((t, d) => t + d.spend, 0));
    const todaySpend = days.find((d) => d.date === today)?.spend || 0;
    const plan = plans.find((p) => p.adAccountId === a.accountId);
    const forecast = isCurrent
      ? round((mtd / Math.max(elapsed, 1)) * monthDays(month))
      : mtd;
    return {
      adAccountId: a.accountId,
      name: a.accountName,
      currency: a.currency,
      clientName: a.clientName,
      mtd,
      today: todaySpend,
      dailyAvg: round(mtd / Math.max(elapsed, 1)),
      forecast,
      plan: plan || null,
      consumption: plan?.monthlyLimit
        ? round((mtd / plan.monthlyLimit) * 100, 1)
        : null,
      forecastOver: plan?.monthlyLimit ? forecast > plan.monthlyLimit : false,
      days,
    };
  });
  const campaigns = byCamp
    .map((c) => {
      const e = E[c._id] || {};
      const k = kpis(c);
      const a = attr[c._id] || attr[e.name] || { revenue: 0, orders: 0 };
      const revenue = round((c.purchaseValue || 0) + a.revenue);
      return {
        id: c._id,
        name: e.name || c._id,
        adAccountId: c.adAccountId,
        status: e.effectiveStatus,
        dailyBudget: e.dailyBudget,
        lifetimeBudget: e.lifetimeBudget,
        spend: k.spend,
        leads: k.leads,
        purchases: k.purchases,
        metaRevenue: round(c.purchaseValue || 0),
        orderRevenue: a.revenue,
        attributedOrders: a.orders,
        revenue,
        roi: k.spend ? round(((revenue - k.spend) / k.spend) * 100, 1) : null,
        roas: k.spend ? round(revenue / k.spend) : 0,
      };
    })
    .sort((a, b) => b.spend - a.spend);
  const adsets = byAdset
    .map((x) => ({
      id: x._id,
      name: E[x._id]?.name || x._id,
      campaign: E[x.campaignId]?.name,
      dailyBudget: E[x._id]?.dailyBudget,
      spend: round(x.spend),
      status: E[x._id]?.effectiveStatus,
    }))
    .sort((a, b) => b.spend - a.spend);
  const clients = {};
  for (const a of accounts) {
    const k = a.clientName || "Own business";
    clients[k] = clients[k] || {
      client: k,
      spend: 0,
      forecast: 0,
      accounts: 0,
    };
    clients[k].spend = round(clients[k].spend + a.mtd);
    clients[k].forecast = round(clients[k].forecast + a.forecast);
    clients[k].accounts++;
  }
  const totalPlan = plans.find((p) => p.adAccountId === "all");
  const total = round(accounts.reduce((t, a) => t + a.mtd, 0));
  return {
    month,
    today,
    elapsed,
    daysInMonth: monthDays(month),
    total,
    totalForecast: round(accounts.reduce((t, a) => t + a.forecast, 0)),
    totalPlan: totalPlan || null,
    accounts,
    campaigns,
    adsets,
    clients: Object.values(clients),
    plans,
  };
}

async function checkBudgets(org) {
  const s = await getSettings(org);
  const month = todayIn(s.timezone).slice(0, 7);
  const sum = await budgetSummary(org, month);
  const plans = await BudgetPlan.find({ organizationId: org, month });
  for (const p of plans) {
    let spend, todaySpend;
    if (p.adAccountId === "all") {
      spend = sum.total;
      todaySpend = sum.accounts.reduce((t, a) => t + a.today, 0);
    } else if (p.clientName && p.adAccountId === "client") {
      const xs = sum.accounts.filter((a) => a.clientName === p.clientName);
      spend = xs.reduce((t, a) => t + a.mtd, 0);
      todaySpend = xs.reduce((t, a) => t + a.today, 0);
    } else {
      const a = sum.accounts.find((x) => x.adAccountId === p.adAccountId);
      spend = a?.mtd || 0;
      todaySpend = a?.today || 0;
    }
    const label =
      p.adAccountId === "all"
        ? "All ad accounts"
        : p.adAccountId === "client"
          ? `Client ${p.clientName}`
          : sum.accounts.find((a) => a.adAccountId === p.adAccountId)?.name ||
            p.adAccountId;
    if (p.monthlyLimit > 0) {
      const used = (spend / p.monthlyLimit) * 100;
      for (const th of [...p.alertAt].sort((a, b) => a - b)) {
        const key = `m:${th}`;
        if (used >= th && !p.alertsSent.includes(key)) {
          p.alertsSent.push(key);
          await notify(
            org,
            "budget",
            `${label}: ${th}% of monthly budget used`,
            `Spent ${round(spend)} of ${p.monthlyLimit} (${round(used, 1)}%) in ${month}.`,
            "budget",
          );
        }
      }
    }
    if (p.dailyLimit > 0 && todaySpend > p.dailyLimit) {
      const key = `d:${sum.today}`;
      if (!p.alertsSent.includes(key)) {
        p.alertsSent.push(key);
        await notify(
          org,
          "budget",
          `${label}: daily budget exceeded`,
          `Spent ${round(todaySpend)} today vs limit ${p.dailyLimit}.`,
          "budget",
        );
      }
    }
    await p.save();
  }
}

app.get(
  "/api/budget/summary",
  wrap(async (req, res) => {
    const s = await getSettings(tid(req));
    res.json(
      await budgetSummary(
        tid(req),
        req.query.month || todayIn(s.timezone).slice(0, 7),
      ),
    );
  }),
);
app.get(
  "/api/budget/plans",
  wrap(async (req, res) =>
    res.json(
      await BudgetPlan.find({
        organizationId: tid(req),
        ...(req.query.month ? { month: req.query.month } : {}),
      }).sort({ month: -1 }),
    ),
  ),
);
app.post(
  "/api/budget/plans",
  wrap(async (req, res) => {
    const d = pick(req.body, [
      "adAccountId",
      "clientName",
      "month",
      "monthlyLimit",
      "dailyLimit",
      "alertAt",
    ]);
    if (!/^\d{4}-\d{2}$/.test(d.month || ""))
      throw fail(400, "month must be YYYY-MM");
    if (d.alertAt)
      d.alertAt = lines(d.alertAt)
        .map(Number)
        .filter((n) => n > 0);
    const p = await BudgetPlan.findOneAndUpdate(
      {
        organizationId: tid(req),
        adAccountId: d.adAccountId || "all",
        month: d.month,
        clientName: d.clientName || null,
      },
      { ...d, organizationId: tid(req) },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    await checkBudgets(tid(req)).catch(() => {});
    res.json({ success: true, plan: p });
  }),
);
app.delete(
  "/api/budget/plans/:id",
  wrap(async (req, res) => {
    await BudgetPlan.deleteOne({
      _id: req.params.id,
      organizationId: tid(req),
    });
    res.json({ success: true });
  }),
);

app.get(
  "/api/budget/report.csv",
  wrap(async (req, res) => {
    const s = await getSettings(tid(req));
    const sum = await budgetSummary(
      tid(req),
      req.query.month || todayIn(s.timezone).slice(0, 7),
    );
    const rows = [
      [
        "Campaign",
        "Ad account",
        "Status",
        "Daily budget",
        "Spend",
        "Leads",
        "Purchases",
        "Meta revenue",
        "Order revenue",
        "ROI %",
        "ROAS",
      ],
      ...sum.campaigns.map((c) => [
        c.name,
        c.adAccountId,
        c.status,
        c.dailyBudget ?? "",
        c.spend,
        c.leads,
        c.purchases,
        c.metaRevenue,
        c.orderRevenue,
        c.roi ?? "",
        c.roas,
      ]),
    ];
    sendCsv(res, `marketing-expense-${sum.month}.csv`, rows);
  }),
);
const sendCsvObjects = (res, name, objs) =>
  sendCsv(
    res,
    name,
    objs.length
      ? [Object.keys(objs[0]), ...objs.map((o) => Object.values(o))]
      : [["no rows"]],
  );
function sendCsv(res, name, rows) {
  const csv = rows
    .map((r) =>
      r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(","),
    )
    .join("\r\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  res.send("﻿" + csv); // BOM so Excel reads Bangla correctly
}

/* =====================================================
   A/B TESTING & EXPERIMENTS (1.9)
   ===================================================== */
const normCdf = (z) => {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p =
    d *
    t *
    (0.3193815 +
      t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
};
function zConfidence(s1, n1, s2, n2) {
  if (!n1 || !n2) return null;
  const p1 = s1 / n1,
    p2 = s2 / n2,
    p = (s1 + s2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (!se) return null;
  return round(normCdf(Math.abs(p1 - p2) / se) * 100, 1);
}
const METRIC = {
  ctr: { better: "high", rate: (m) => [m.linkClicks, m.impressions] },
  cvr: { better: "high", rate: (m) => [m.results, m.linkClicks] },
  engagement_rate: { better: "high", rate: (m) => [m.engagement, m.reach] },
  cpc: { better: "low" },
  cpl: { better: "low" },
  roas: { better: "high" },
};
async function variantMetrics(org, v, from, to) {
  if (v.refType === "content") {
    const c = await ContentItem.findOne({
      _id: v.refId,
      organizationId: org,
    }).lean();
    const m = (c?.targets || []).reduce(
      (a, t) => ({
        reach: a.reach + (t.metrics?.reach || 0),
        engagement: a.engagement + (t.metrics?.engagement || 0),
        clicks: a.clicks + (t.metrics?.clicks || 0),
      }),
      { reach: 0, engagement: 0, clicks: 0 },
    );
    return {
      ...m,
      impressions: m.reach,
      linkClicks: m.clicks,
      engagement_rate: m.reach ? round((m.engagement / m.reach) * 100) : 0,
    };
  }
  const [r] = await AdInsight.aggregate([
    {
      $match: {
        organizationId: org,
        adId: v.refId,
        date: { $gte: from, $lte: to },
      },
    },
    { $group: { _id: null, ...sumGroup } },
  ]);
  return kpis(r || {});
}
async function evaluateExperiment(org, ex) {
  const from = ymd(ex.startedAt || ex.createdAt),
    to = ymd(ex.endedAt || new Date());
  const cfg = METRIC[ex.metric] || METRIC.ctr;
  for (const v of ex.variants)
    v.results = await variantMetrics(org, v, from, to);
  const val = (v) => Number(v.results[ex.metric] ?? 0);
  const sorted = [...ex.variants]
    .filter((v) => (v.results.impressions || 0) > 0)
    .sort((a, b) =>
      cfg.better === "high"
        ? val(b) - val(a)
        : (val(a) || Infinity) - (val(b) || Infinity),
    );
  let confidence = null,
    winner = null,
    note = "";
  if (sorted.length >= 2) {
    const [a, b] = sorted;
    if (cfg.rate) {
      const [s1, n1] = cfg.rate(a.results),
        [s2, n2] = cfg.rate(b.results);
      confidence = zConfidence(s1, n1, s2, n2);
    }
    const enough = sorted.every((v) => (v.results.impressions || 0) >= 1000);
    if (confidence != null && confidence >= 95 && enough) winner = a.label;
    else if (
      confidence == null &&
      enough &&
      val(b) &&
      Math.abs(val(a) - val(b)) / val(b) >= 0.15
    ) {
      winner = a.label;
      note = "Cost/return metric: no significance test, difference ≥15%.";
    } else
      note = enough
        ? "Not significant yet. Keep the test running."
        : "Each variant needs at least 1,000 impressions.";
  } else note = "Need data for at least two variants.";
  ex.confidence = confidence;
  ex.markModified("variants");
  return {
    leader: sorted[0]?.label || null,
    winner,
    confidence,
    note,
    from,
    to,
  };
}

app.get(
  "/api/experiments",
  wrap(async (req, res) =>
    res.json(
      await Experiment.find({ organizationId: tid(req) }).sort({
        createdAt: -1,
      }),
    ),
  ),
);
app.post(
  "/api/experiments",
  wrap(async (req, res) => {
    const d = pick(req.body, [
      "name",
      "type",
      "hypothesis",
      "metric",
      "variants",
      "brandId",
    ]);
    if (!d.name) throw fail(400, "Experiment name is required");
    if (!Array.isArray(d.variants) || d.variants.length < 2)
      throw fail(400, "Add at least two variants");
    res.json({
      success: true,
      experiment: await Experiment.create({ ...d, organizationId: tid(req) }),
    });
  }),
);
app.put(
  "/api/experiments/:id",
  wrap(async (req, res) => {
    const ex = await Experiment.findOneAndUpdate(
      { _id: req.params.id, organizationId: tid(req) },
      pick(req.body, ["name", "type", "hypothesis", "metric", "variants"]),
      { new: true },
    );
    if (!ex) throw fail(404, "Experiment not found");
    res.json({ success: true, experiment: ex });
  }),
);
app.delete(
  "/api/experiments/:id",
  wrap(async (req, res) => {
    await Experiment.deleteOne({
      _id: req.params.id,
      organizationId: tid(req),
    });
    res.json({ success: true });
  }),
);
app.post(
  "/api/experiments/:id/start",
  wrap(async (req, res) => {
    const ex = await Experiment.findOneAndUpdate(
      { _id: req.params.id, organizationId: tid(req) },
      {
        status: "running",
        startedAt: req.body.startedAt
          ? new Date(req.body.startedAt)
          : new Date(),
        endedAt: null,
        winner: null,
      },
      { new: true },
    );
    if (!ex) throw fail(404, "Experiment not found");
    res.json({ success: true, experiment: ex });
  }),
);
app.post(
  "/api/experiments/:id/evaluate",
  wrap(async (req, res) => {
    const ex = await Experiment.findOne({
      _id: req.params.id,
      organizationId: tid(req),
    });
    if (!ex) throw fail(404, "Experiment not found");
    const result = await evaluateExperiment(tid(req), ex);
    await ex.save();
    res.json({ success: true, experiment: ex, result });
  }),
);
app.post(
  "/api/experiments/:id/complete",
  wrap(async (req, res) => {
    const ex = await Experiment.findOne({
      _id: req.params.id,
      organizationId: tid(req),
    });
    if (!ex) throw fail(404, "Experiment not found");
    const result = await evaluateExperiment(tid(req), ex);
    ex.status = "completed";
    ex.endedAt = new Date();
    ex.winner = req.body.winner || result.winner || result.leader;
    await ex.save();
    res.json({ success: true, experiment: ex, result });
  }),
);
app.post(
  "/api/experiments/:id/ai",
  wrap(async (req, res) => {
    const org = tid(req);
    const ex = await Experiment.findOne({
      _id: req.params.id,
      organizationId: org,
    });
    if (!ex) throw fail(404, "Experiment not found");
    const result = await evaluateExperiment(org, ex);
    const data = await aiChat(org, "experiment_notes", {
      json: false,
      temperature: 0.4,
      system:
        "You are a marketing experimentation expert. Explain the A/B test results in plain language (max 180 words): who is winning, whether it is statistically reliable, what to do next and one follow-up test idea. Use only the numbers given.",
      user: JSON.stringify({
        name: ex.name,
        type: ex.type,
        hypothesis: ex.hypothesis,
        metric: ex.metric,
        result,
        variants: ex.variants.map((v) => ({
          label: v.label,
          description: v.description,
          results: v.results,
        })),
      }),
    });
    ex.aiNotes = data;
    await ex.save();
    res.json({ success: true, experiment: ex, notes: data });
  }),
);
app.post(
  "/api/experiments/suggest",
  wrap(async (req, res) => {
    const org = tid(req);
    const ads = await perfBy(org, {
      from: daysAgo(29),
      to: daysAgo(0),
      level: "ad",
    });
    const ents = await AdEntity.find({
      organizationId: org,
      metaId: { $in: Object.keys(ads) },
    }).lean();
    const top = ents
      .map((e) => ({
        name: e.name,
        title: e.creative?.title,
        body: (e.creative?.body || "").slice(0, 120),
        ...pick(ads[e.metaId], ["spend", "ctr", "cpl", "roas"]),
      }))
      .sort((a, b) => b.spend - a.spend)
      .slice(0, 15);
    const ctx = await brandContext(org, req.body.brandId, { products: false });
    const data = await aiJSON(
      org,
      "experiment_ideas",
      `You are a growth marketer. Suggest 5 A/B tests for Meta ads and organic posts. Return JSON: {"tests":[{"name":"","type":"copy|creative|cta|audience|landing_page","hypothesis":"","metric":"ctr|cpc|cpl|cvr|roas|engagement_rate","variants":[{"label":"A","description":""},{"label":"B","description":""}],"why":""}]}`,
      `${ctx.text}\nCURRENT ADS (30d): ${JSON.stringify(top)}`,
    );
    res.json({ success: true, ...data });
  }),
);

/* =====================================================
   LEAD GENERATION & CRM (1.10)
   ===================================================== */
// n8n flows (existing)
app.post(
  "/api/leads/check-duplicate",
  wrap(async (req, res) => {
    const { tenantId, eventId } = req.body;
    if (await WebhookEvent.findOne({ externalEventId: eventId }))
      return res.json({ isDuplicate: true });
    await WebhookEvent.create({
      tenantId,
      externalEventId: eventId,
      provider: "n8n",
      processingStatus: "processed",
    });
    res.json({ isDuplicate: false });
  }),
);
app.post(
  "/api/leads/create",
  wrap(async (req, res) => {
    const { tenantId, leadId, name, email, aiScore, aiStatus, aiReason } =
      req.body;
    const lead = await Lead.create({
      _id: leadId,
      organizationId: tenantId,
      name,
      email,
      source: "n8n",
      aiScore: parseInt(aiScore, 10) || 0,
      aiStatus: aiStatus || "Cold",
      aiReason,
    });
    res.json({ success: true, lead });
  }),
);
app.post(
  "/api/tasks/create",
  wrap(async (req, res) => {
    const { tenantId, leadId, title, priority } = req.body;
    const task = await Task.create({
      organizationId: tenantId,
      leadId: leadId || null,
      title,
      priority: priority || "High",
    });
    res.json({ success: true, task });
  }),
);

const normPhone = (p) => {
  if (!p) return null;
  let d = String(p).replace(/[^\d]/g, "");
  if (d.startsWith("880")) d = "0" + d.slice(3);
  return d || null;
};

// Rules-based score (works without AI). 0-100
function ruleScore(l) {
  const t =
    `${l.message || ""} ${JSON.stringify(l.fields || {})}`.toLowerCase();
  let s = 20;
  const why = [];
  if (l.phone) {
    s += 15;
    why.push("has phone");
  }
  if (l.email) {
    s += 10;
    why.push("has email");
  }
  if (/\d{4,}|budget|taka|tk|৳|টাকা|বাজেট/.test(t)) {
    s += 20;
    why.push("mentions budget");
  }
  if (/urgent|asap|today|this week|now|আজ|এখনই|জরুরি/.test(t)) {
    s += 15;
    why.push("urgency");
  }
  if (/price|buy|order|book|quote|wholesale|দাম|কিনতে|অর্ডার|বুক/.test(t)) {
    s += 10;
    why.push("buying intent");
  }
  if (l.source === "facebook_lead_ad") {
    s += 10;
    why.push("filled a lead form");
  }
  s = Math.min(s, 100);
  return {
    score: s,
    status: s >= 70 ? "Hot" : s >= 40 ? "Warm" : "Cold",
    reason: `Rule score: ${why.join(", ") || "little information"}`,
    category: /wholesale|bulk|b2b|পাইকারি/.test(t)
      ? "Wholesale / B2B"
      : /service|সার্ভিস/.test(t)
        ? "Service inquiry"
        : "Product inquiry",
    qualified: s >= 60,
  };
}

async function scoreLead(org, l) {
  if (!aiConfigured()) return ruleScore(l);
  try {
    const s = await getSettings(org);
    const ctx = await brandContext(org, null, { products: false });
    const r = await aiJSON(
      org,
      "lead_score",
      `You qualify sales leads. Return JSON: {"score":0-100,"status":"Hot|Warm|Cold","category":"one of: ${s.leadCategories.join(", ")}","qualified":true|false,"reason":"one short sentence","nextAction":"one short sentence"}. Hot = clear need + budget/urgency + contact. Be strict; don't invent facts.`,
      `${ctx.text}\nLEAD: ${JSON.stringify({ name: l.name, email: !!l.email, phone: !!l.phone, source: l.source, campaign: l.campaignName, message: l.message, answers: l.fields })}`,
      { temperature: 0.2, maxTokens: 400 },
    );
    return {
      score: Math.max(0, Math.min(100, Number(r.score) || 0)),
      status: ["Hot", "Warm", "Cold"].includes(r.status) ? r.status : "Cold",
      category: r.category || "Other",
      qualified: !!r.qualified,
      reason: [r.reason, r.nextAction && `Next: ${r.nextAction}`]
        .filter(Boolean)
        .join(" "),
    };
  } catch (e) {
    console.warn("AI lead score failed, using rules:", e.message);
    return ruleScore(l);
  }
}

async function nextAssignee(org) {
  const o = await Organization.findOneAndUpdate(
    { _id: org },
    { $inc: { "marketingSettings.rrIndex": 1 } },
    { new: false },
  ).lean();
  const team = (o?.marketingSettings?.salesTeam || []).filter(
    (m) => m.active !== false,
  );
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
  const existing = or.length
    ? await Lead.findOne({ organizationId: org, $or: or })
    : null;
  if (existing) {
    existing.duplicateCount += 1;
    existing.notes.push({
      text: `Repeat inquiry via ${data.source || "manual"}${data.campaignName ? ` (${data.campaignName})` : ""}: ${data.message || "-"}`,
      by: "system",
    });
    for (const k of [
      "email",
      "phone",
      "campaignId",
      "campaignName",
      "adId",
      "formId",
    ])
      if (
        !existing[k] &&
        (k === "email" ? email : k === "phone" ? phone : data[k])
      )
        existing[k] = k === "email" ? email : k === "phone" ? phone : data[k];
    if (["lost"].includes(existing.stage)) existing.stage = "new";
    await existing.save();
    return { lead: existing, duplicate: true };
  }
  const lead = new Lead({
    ...pick(data, [
      "name",
      "message",
      "source",
      "externalId",
      "formId",
      "pageId",
      "adId",
      "adsetId",
      "campaignId",
      "campaignName",
      "fields",
    ]),
    email,
    phone,
    organizationId: org,
    name: data.name || email || phone || "Unknown",
  });
  const sc = opts.skipAi ? ruleScore(lead) : await scoreLead(org, lead);
  Object.assign(lead, {
    aiScore: sc.score,
    aiStatus: sc.status,
    aiReason: sc.reason,
    category: sc.category,
    qualified: sc.qualified,
  });
  lead.assignedTo = data.assignedTo || (await nextAssignee(org));
  if (lead.aiStatus === "Hot")
    lead.followUpAt = new Date(Date.now() + 2 * 3600e3);
  await lead.save();
  if (!opts.quiet)
    await notify(
      org,
      "lead",
      `New ${lead.aiStatus} lead: ${lead.name}`,
      `${lead.category} · ${lead.source}${lead.campaignName ? ` · ${lead.campaignName}` : ""}${lead.assignedTo ? ` · assigned to ${lead.assignedTo}` : ""}`,
      "leads",
    );
  if (process.env.SALES_WEBHOOK_URL)
    fetch(process.env.SALES_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId: org, lead: lead.toJSON() }),
    }).catch((e) => console.warn("Sales webhook:", e.message));
  return { lead, duplicate: false };
}

app.get(
  "/api/leads",
  wrap(async (req, res) => {
    const q = { organizationId: tid(req) };
    for (const k of [
      "stage",
      "source",
      "aiStatus",
      "assignedTo",
      "category",
      "campaignId",
    ])
      if (req.query[k]) q[k] = { $in: String(req.query[k]).split(",") };
    if (req.query.q) {
      const re = new RegExp(escRe(req.query.q), "i");
      q.$or = [{ name: re }, { email: re }, { phone: re }, { message: re }];
    }
    if (req.query.due === "1") q.followUpAt = { $lte: new Date() };
    res.json(
      await Lead.find(q)
        .sort({ createdAt: -1 })
        .limit(Math.min(Number(req.query.limit) || 300, 1000)),
    );
  }),
);
app.post(
  "/api/leads",
  wrap(async (req, res) => {
    const b = req.body;
    if (!b.name && !b.email && !b.phone)
      throw fail(400, "Name, email or phone is required");
    const r = await ingestLead(tid(req), {
      ...b,
      source: b.source || "manual",
    });
    res.json({ success: true, ...r });
  }),
);
app.put(
  "/api/leads/:id",
  wrap(async (req, res) => {
    const p = pick(req.body, [
      "name",
      "email",
      "phone",
      "stage",
      "assignedTo",
      "followUpAt",
      "category",
      "value",
      "aiStatus",
    ]);
    if ("followUpAt" in p) {
      p.followUpAt = p.followUpAt ? new Date(p.followUpAt) : null;
      p.followUpNotified = false;
    }
    if ("phone" in p) p.phone = normPhone(p.phone);
    if (p.stage === "won") p.convertedAt = new Date();
    const l = await Lead.findOneAndUpdate(
      { _id: req.params.id, organizationId: tid(req) },
      p,
      { new: true, runValidators: true },
    );
    if (!l) throw fail(404, "Lead not found");
    res.json({ success: true, lead: l });
  }),
);
app.post(
  "/api/leads/:id/notes",
  wrap(async (req, res) => {
    if (!req.body.text) throw fail(400, "Note text is required");
    const l = await Lead.findOneAndUpdate(
      { _id: req.params.id, organizationId: tid(req) },
      { $push: { notes: { text: req.body.text, by: actor(req) } } },
      { new: true },
    );
    if (!l) throw fail(404, "Lead not found");
    res.json({ success: true, lead: l });
  }),
);
app.post(
  "/api/leads/:id/rescore",
  wrap(async (req, res) => {
    const l = await Lead.findOne({
      _id: req.params.id,
      organizationId: tid(req),
    });
    if (!l) throw fail(404, "Lead not found");
    const sc = await scoreLead(tid(req), l);
    Object.assign(l, {
      aiScore: sc.score,
      aiStatus: sc.status,
      aiReason: sc.reason,
      category: sc.category,
      qualified: sc.qualified,
    });
    await l.save();
    res.json({ success: true, lead: l });
  }),
);
// Conversion tracking
app.post(
  "/api/leads/:id/convert",
  wrap(async (req, res) => {
    const l = await Lead.findOneAndUpdate(
      { _id: req.params.id, organizationId: tid(req) },
      {
        stage: "won",
        convertedAt: new Date(),
        value: Number(req.body.value) || 0,
        orderId: req.body.orderId || null,
        $push: {
          notes: {
            text: `Converted${req.body.value ? ` (value ${req.body.value})` : ""}`,
            by: actor(req),
          },
        },
      },
      { new: true },
    );
    if (!l) throw fail(404, "Lead not found");
    if (l.orderId)
      await Order.updateOne(
        { _id: l.orderId, organizationId: tid(req) },
        {
          "attribution.leadId": l.id,
          "attribution.campaign": l.campaignId || l.campaignName,
          "attribution.adId": l.adId,
          "attribution.source": l.source,
        },
      );
    res.json({ success: true, lead: l });
  }),
);
app.delete(
  "/api/leads/:id",
  wrap(async (req, res) => {
    await Lead.deleteOne({ _id: req.params.id, organizationId: tid(req) });
    res.json({ success: true });
  }),
);

// Lead form management (Meta instant forms)
async function pageAccount(org, pageId) {
  const a = await SocialAccount.findOne({
    organizationId: org,
    platform: "Facebook",
    ...(pageId ? { accountId: pageId } : {}),
  }).select("+accessToken");
  if (!a) throw fail(400, "Connect a Facebook Page first");
  return a;
}
app.get(
  "/api/leads/forms",
  wrap(async (req, res) => {
    const a = await pageAccount(tid(req), req.query.pageId);
    res.json(
      await graphAll(`/${a.accountId}/leadgen_forms`, {
        token: tok(a),
        params: {
          fields: "id,name,status,leads_count,created_time,locale",
          limit: 100,
        },
      }),
    );
  }),
);
async function leadFromMeta(org, a, raw, extra = {}) {
  const f = Object.fromEntries(
    (raw.field_data || []).map((x) => [x.name, (x.values || []).join(", ")]),
  );
  const name =
    f.full_name ||
    [f.first_name, f.last_name].filter(Boolean).join(" ") ||
    f.name ||
    "Lead";
  return ingestLead(org, {
    name,
    email: f.email,
    phone: f.phone_number || f.phone,
    message:
      f.message ||
      f.comments ||
      Object.entries(f)
        .filter(
          ([k]) =>
            ![
              "full_name",
              "first_name",
              "last_name",
              "email",
              "phone_number",
            ].includes(k),
        )
        .map(([k, v]) => `${k}: ${v}`)
        .join("; "),
    source: "facebook_lead_ad",
    externalId: raw.id,
    formId: raw.form_id || extra.formId,
    pageId: a.accountId,
    adId: raw.ad_id,
    adsetId: raw.adset_id,
    campaignId: raw.campaign_id,
    campaignName: raw.campaign_name,
    fields: f,
  });
}
// Backfill: pull existing leads from a form
app.post(
  "/api/leads/forms/:formId/sync",
  wrap(async (req, res) => {
    const org = tid(req);
    const a = await pageAccount(org, req.body.pageId);
    const rows = await graphAll(
      `/${req.params.formId}/leads`,
      {
        token: tok(a),
        params: {
          fields:
            "id,created_time,field_data,ad_id,adset_id,campaign_id,campaign_name,form_id",
          limit: 100,
        },
      },
      2000,
    );
    let created = 0,
      dup = 0;
    for (const r of rows) {
      const x = await leadFromMeta(org, a, r, { formId: req.params.formId });
      x.duplicate ? dup++ : created++;
    }
    res.json({ success: true, fetched: rows.length, created, duplicates: dup });
  }),
);
// Subscribe the Page to the app so Meta sends leadgen webhooks
app.post(
  "/api/leads/subscribe-page",
  wrap(async (req, res) => {
    const a = await pageAccount(tid(req), req.body.pageId);
    const r = await graph(`/${a.accountId}/subscribed_apps`, {
      token: tok(a),
      method: "POST",
      body: { subscribed_fields: ["leadgen"] },
    });
    res.json({ success: !!r.success });
  }),
);

// Campaign-based lead attribution
app.get(
  "/api/leads/attribution",
  wrap(async (req, res) => {
    const org = tid(req);
    const { from, to } = range(req.query, 30);
    const rows = await Lead.aggregate([
      {
        $match: {
          organizationId: org,
          createdAt: {
            $gte: new Date(from),
            $lte: new Date(to + "T23:59:59Z"),
          },
        },
      },
      {
        $group: {
          _id: {
            c: { $ifNull: ["$campaignId", "$source"] },
            n: "$campaignName",
            s: "$source",
          },
          leads: { $sum: 1 },
          hot: { $sum: { $cond: [{ $eq: ["$aiStatus", "Hot"] }, 1, 0] } },
          qualified: { $sum: { $cond: ["$qualified", 1, 0] } },
          won: { $sum: { $cond: [{ $eq: ["$stage", "won"] }, 1, 0] } },
          value: { $sum: "$value" },
        },
      },
    ]);
    const spend = await perfBy(org, { from, to, level: "campaign" });
    res.json({
      from,
      to,
      rows: rows
        .map((r) => {
          const s = spend[r._id.c]?.spend || 0;
          return {
            campaignId: r._id.c,
            campaign: r._id.n || r._id.c,
            source: r._id.s,
            leads: r.leads,
            hot: r.hot,
            qualified: r.qualified,
            won: r.won,
            conversionRate: r.leads ? round((r.won / r.leads) * 100, 1) : 0,
            value: r.value,
            spend: s,
            cpl: r.leads && s ? round(s / r.leads) : null,
            costPerWin: r.won && s ? round(s / r.won) : null,
          };
        })
        .sort((a, b) => b.leads - a.leads),
    });
  }),
);

app.get(
  "/api/leads/:id",
  wrap(async (req, res) => {
    const l = await Lead.findOne({
      _id: req.params.id,
      organizationId: tid(req),
    });
    if (!l) throw fail(404, "Lead not found");
    res.json(l);
  }),
);

/* ---------- Meta webhooks: lead ads + Instagram DMs ---------- */
app.get("/webhooks/meta", (req, res) => {
  if (
    req.query["hub.mode"] === "subscribe" &&
    req.query["hub.verify_token"] === process.env.META_WEBHOOK_VERIFY_TOKEN
  )
    return res.status(200).send(req.query["hub.challenge"]);
  res.sendStatus(403);
});
app.post("/webhooks/meta", (req, res) => {
  if (FB_APP_SECRET) {
    const sig = req.headers["x-hub-signature-256"] || "";
    const exp =
      "sha256=" +
      crypto
        .createHmac("sha256", FB_APP_SECRET)
        .update(req.rawBody || "")
        .digest("hex");
    if (
      sig.length !== exp.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))
    )
      return res.sendStatus(401);
  }
  res.sendStatus(200); // answer fast; process after
  handleMetaWebhook(req.body).catch((e) => console.error("Meta webhook:", e));
});
async function followUpReminders() {
  const due = await Lead.find({
    followUpAt: { $lte: new Date() },
    followUpNotified: false,
    stage: { $nin: ["won", "lost"] },
  }).limit(200);
  for (const l of due) {
    await notify(
      l.organizationId,
      "follow_up",
      `Follow up: ${l.name}`,
      `${l.aiStatus} lead${l.assignedTo ? ` · ${l.assignedTo}` : ""}${l.phone ? ` · ${l.phone}` : ""}`,
      "leads",
    );
    l.followUpNotified = true;
    await l.save();
  }
}

/* =====================================================
   MARKETING ANALYTICS & REPORTING (1.11)
   ===================================================== */
// Metric names change between Graph API versions: each metric is requested separately and
// failures are skipped, so one deprecated metric never breaks the sync. Override in .env.
const FB_PAGE_METRICS = lines(
  process.env.FB_PAGE_METRICS ||
    "page_impressions_unique,page_post_engagements,page_daily_follows_unique,page_views_total,page_media_view",
);
const IG_METRICS = lines(
  process.env.IG_METRICS ||
    "reach,views,accounts_engaged,total_interactions,profile_views",
);
const FB_POST_METRICS = lines(
  process.env.FB_POST_METRICS || "post_impressions_unique,post_clicks",
);
const IG_MEDIA_METRICS = lines(
  process.env.IG_MEDIA_METRICS || "reach,saved,shares,views,total_interactions",
);

async function setDayMetric(org, acc, date, key, value) {
  await AccountInsight.updateOne(
    { organizationId: org, accountId: acc.id, date },
    { $set: { platform: acc.platform, [`metrics.${key}`]: value } },
    { upsert: true },
  );
}

async function syncAccountInsights(org, acc, days = 7) {
  const token = tok(acc);
  const errors = [];
  if (acc.platform === "Facebook") {
    const p = await graph(`/${acc.accountId}`, {
      token,
      params: { fields: "followers_count,fan_count" },
    });
    await setDayMetric(
      org,
      acc,
      ymd(new Date()),
      "followers",
      p.followers_count ?? p.fan_count ?? 0,
    );
    const since = Math.floor((Date.now() - days * DAY) / 1000),
      until = Math.floor(Date.now() / 1000);
    for (const m of FB_PAGE_METRICS) {
      try {
        const r = await graph(`/${acc.accountId}/insights`, {
          token,
          params: { metric: m, period: "day", since, until },
        });
        for (const v of r.data?.[0]?.values || [])
          await setDayMetric(
            org,
            acc,
            ymd(new Date(v.end_time).getTime() - DAY),
            m,
            typeof v.value === "number"
              ? v.value
              : Object.values(v.value || {}).reduce(
                  (a, b) => a + (Number(b) || 0),
                  0,
                ),
          );
      } catch (e) {
        errors.push(`${m}: ${e.message}`);
      }
    }
  }
  if (acc.platform === "Instagram") {
    const p = await graph(`/${acc.accountId}`, {
      token,
      params: { fields: "followers_count,media_count" },
    });
    await setDayMetric(
      org,
      acc,
      ymd(new Date()),
      "followers",
      p.followers_count || 0,
    );
    await setDayMetric(
      org,
      acc,
      ymd(new Date()),
      "media_count",
      p.media_count || 0,
    );
    for (let d = Math.min(days, 7); d >= 1; d--) {
      const start = startOfDay(Date.now() - d * DAY);
      const since = Math.floor(start.getTime() / 1000),
        until = since + 86400;
      for (const m of IG_METRICS) {
        try {
          const r = await graph(`/${acc.accountId}/insights`, {
            token,
            params: {
              metric: m,
              period: "day",
              metric_type: "total_value",
              since,
              until,
            },
          });
          const v =
            r.data?.[0]?.total_value?.value ?? r.data?.[0]?.values?.[0]?.value;
          if (v != null)
            await setDayMetric(org, acc, ymd(start), m, Number(v) || 0);
        } catch (e) {
          if (d === 1) errors.push(`${m}: ${e.message}`);
        }
      }
    }
  }
  await SocialAccount.updateOne({ _id: acc.id }, { lastSyncedAt: new Date() });
  return errors;
}

async function syncPostMetrics(org, item) {
  for (const t of item.targets.filter(
    (x) => x.status === "published" && x.providerPostId,
  )) {
    const acc = await SocialAccount.findOne({
      _id: t.accountId,
      organizationId: org,
    }).select("+accessToken");
    if (!acc) continue;
    const token = tok(acc),
      m = { ...(t.metrics || {}) };
    try {
      if (acc.platform === "Facebook") {
        const p = await graph(`/${t.providerPostId}`, {
          token,
          params: {
            fields:
              "shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)",
          },
        }).catch(() => ({}));
        m.likes = p.reactions?.summary?.total_count ?? m.likes ?? 0;
        m.comments = p.comments?.summary?.total_count ?? m.comments ?? 0;
        m.shares = p.shares?.count ?? m.shares ?? 0;
        for (const k of FB_POST_METRICS) {
          try {
            const r = await graph(`/${t.providerPostId}/insights`, {
              token,
              params: { metric: k },
            });
            const v = r.data?.[0]?.values?.[0]?.value;
            if (v != null)
              m[
                k === "post_impressions_unique"
                  ? "reach"
                  : k === "post_clicks"
                    ? "clicks"
                    : k
              ] = Number(v) || 0;
          } catch {}
        }
      } else {
        const p = await graph(`/${t.providerPostId}`, {
          token,
          params: { fields: "like_count,comments_count" },
        }).catch(() => ({}));
        m.likes = p.like_count ?? m.likes ?? 0;
        m.comments = p.comments_count ?? m.comments ?? 0;
        for (const k of IG_MEDIA_METRICS) {
          try {
            const r = await graph(`/${t.providerPostId}/insights`, {
              token,
              params: { metric: k },
            });
            const v =
              r.data?.[0]?.values?.[0]?.value ??
              r.data?.[0]?.total_value?.value;
            if (v != null) m[k === "saved" ? "saves" : k] = Number(v) || 0;
          } catch {}
        }
      }
      m.engagement =
        (m.likes || 0) +
        (m.comments || 0) +
        (m.shares || 0) +
        (m.saves || 0) +
        (m.clicks || 0);
      t.metrics = m;
      t.metricsAt = new Date();
    } catch (e) {
      console.warn("post metrics:", e.message);
    }
  }
  item.markModified("targets");
  await item.save();
}

async function syncOrganic(org) {
  const accs = await SocialAccount.find({
    organizationId: org,
    platform: { $in: ["Facebook", "Instagram"] },
    status: { $nin: ["expired", "revoked"] },
  }).select("+accessToken");
  const errors = {};
  for (const a of accs)
    errors[a.accountName] = await syncAccountInsights(org, a).catch((e) => [
      e.message,
    ]);
  const posts = await ContentItem.find({
    organizationId: org,
    status: { $in: ["Published", "Partially Published"] },
    publishedAt: { $gte: new Date(Date.now() - 30 * DAY) },
  }).limit(150);
  for (const p of posts) await syncPostMetrics(org, p).catch(() => {});
  return { accounts: accs.length, posts: posts.length, errors };
}

app.post(
  "/api/analytics/sync",
  wrap(async (req, res) =>
    res.json({ success: true, ...(await syncOrganic(tid(req))) }),
  ),
);
app.post(
  "/api/content/:id/sync-metrics",
  wrap(async (req, res) => {
    const c = await ContentItem.findOne({
      _id: req.params.id,
      organizationId: tid(req),
    });
    if (!c) throw fail(404, "Content not found");
    await syncPostMetrics(tid(req), c);
    res.json({ success: true, content: c });
  }),
);
app.get(
  "/api/analytics/accounts/:id/series",
  wrap(async (req, res) => {
    const { from, to } = range(req.query, 30);
    res.json(
      await AccountInsight.find({
        organizationId: tid(req),
        accountId: req.params.id,
        date: { $gte: from, $lte: to },
      })
        .sort({ date: 1 })
        .lean(),
    );
  }),
);

async function buildReport(org, from, to) {
  const fromD = new Date(from + "T00:00:00Z"),
    toD = new Date(to + "T23:59:59Z");
  const accs = await SocialAccount.find({ organizationId: org }).lean();
  const [
    posts,
    ins,
    paid,
    campPerf,
    leads,
    leadsBySource,
    leadsByStage,
    orders,
  ] = await Promise.all([
    ContentItem.find({
      organizationId: org,
      publishedAt: { $gte: fromD, $lte: toD },
    }).lean(),
    AccountInsight.find({
      organizationId: org,
      date: { $gte: from, $lte: to },
    }).lean(),
    totals(org, { date: { $gte: from, $lte: to } }),
    perfBy(org, { from, to, level: "campaign" }),
    Lead.countDocuments({
      organizationId: org,
      createdAt: { $gte: fromD, $lte: toD },
    }),
    Lead.aggregate([
      {
        $match: { organizationId: org, createdAt: { $gte: fromD, $lte: toD } },
      },
      { $group: { _id: "$source", n: { $sum: 1 } } },
    ]),
    Lead.aggregate([
      {
        $match: { organizationId: org, createdAt: { $gte: fromD, $lte: toD } },
      },
      { $group: { _id: "$stage", n: { $sum: 1 }, value: { $sum: "$value" } } },
    ]),
    Order.aggregate([
      {
        $match: {
          organizationId: org,
          createdAt: { $gte: fromD, $lte: toD },
          status: { $ne: "cancelled" },
          "attribution.campaign": { $ne: null },
        },
      },
      { $group: { _id: null, n: { $sum: 1 }, revenue: { $sum: "$total" } } },
    ]),
  ]);
  const t = (p) =>
    (p.targets || []).reduce((a, x) => {
      for (const k of [
        "reach",
        "likes",
        "comments",
        "shares",
        "saves",
        "clicks",
        "views",
        "engagement",
      ])
        a[k] = (a[k] || 0) + (x.metrics?.[k] || 0);
      return a;
    }, {});
  const postRows = posts.map((p) => ({
    id: p._id,
    title: p.title,
    format: p.format,
    platforms: [...new Set((p.targets || []).map((x) => x.platform))],
    status: p.status,
    publishedAt: p.publishedAt,
    permalink: (p.targets || []).find((x) => x.permalink)?.permalink,
    ...t(p),
  }));
  const organic = postRows.reduce(
    (a, p) => {
      for (const k of [
        "reach",
        "engagement",
        "likes",
        "comments",
        "shares",
        "saves",
        "clicks",
        "views",
      ])
        a[k] = (a[k] || 0) + (p[k] || 0);
      return a;
    },
    {
      posts: posts.length,
      published: posts.filter((p) => p.status === "Published").length,
      failed: posts.filter((p) =>
        ["Failed", "Partially Published"].includes(p.status),
      ).length,
    },
  );
  organic.engagementRate = organic.reach
    ? round((organic.engagement / organic.reach) * 100)
    : 0;
  const accounts = accs
    .filter((a) => ["Facebook", "Instagram"].includes(a.platform))
    .map((a) => {
      const rows = ins
        .filter(
          (r) =>
            r.accountId === String(a._id) && r.date >= from && r.date <= to,
        )
        .sort((x, y) => x.date.localeCompare(y.date));
      const f = rows.filter((r) => r.metrics?.followers != null);
      const sums = {};
      for (const r of rows)
        for (const [k, v] of Object.entries(r.metrics || {}))
          if (!["followers", "media_count"].includes(k))
            sums[k] = (sums[k] || 0) + (Number(v) || 0);
      return {
        id: String(a._id),
        name: a.accountName,
        platform: a.platform,
        followersStart: f[0]?.metrics.followers ?? null,
        followersEnd: f[f.length - 1]?.metrics.followers ?? null,
        growth:
          f.length > 1
            ? f[f.length - 1].metrics.followers - f[0].metrics.followers
            : null,
        metrics: sums,
      };
    });
  const ents = await AdEntity.find({
    organizationId: org,
    level: "campaign",
    metaId: { $in: Object.keys(campPerf) },
  }).lean();
  const campaigns = Object.entries(campPerf)
    .map(([id, m]) => ({
      id,
      name: ents.find((e) => e.metaId === id)?.name || id,
      objective: ents.find((e) => e.metaId === id)?.objective,
      ...m,
    }))
    .sort((a, b) => b.spend - a.spend);
  return {
    from,
    to,
    generatedAt: new Date(),
    organic,
    topPosts: [...postRows]
      .sort((a, b) => (b.engagement || 0) - (a.engagement || 0))
      .slice(0, 10),
    posts: postRows,
    accounts,
    paid,
    campaigns,
    leads: {
      total: leads,
      bySource: leadsBySource.map((x) => ({ source: x._id, n: x.n })),
      byStage: leadsByStage.map((x) => ({
        stage: x._id,
        n: x.n,
        value: x.value,
      })),
    },
    conversions: {
      attributedOrders: orders[0]?.n || 0,
      attributedRevenue: orders[0]?.revenue || 0,
    },
  };
}

app.get(
  "/api/reports/marketing",
  wrap(async (req, res) => {
    const { from, to } = range(req.query, 7);
    res.json(await buildReport(tid(req), from, to));
  }),
);
app.get(
  "/api/reports/marketing.csv",
  wrap(async (req, res) => {
    const { from, to } = range(req.query, 7);
    const r = await buildReport(tid(req), from, to);
    const rows = [
      ["MarketingFlow AI marketing report", `${from} to ${to}`],
      [],
      ["ORGANIC"],
      [
        "Posts",
        "Published",
        "Failed",
        "Reach",
        "Engagement",
        "Engagement rate %",
      ],
      [
        r.organic.posts,
        r.organic.published,
        r.organic.failed,
        r.organic.reach || 0,
        r.organic.engagement || 0,
        r.organic.engagementRate,
      ],
      [],
      ["ACCOUNTS"],
      [
        "Account",
        "Platform",
        "Followers start",
        "Followers end",
        "Growth",
        ...new Set(r.accounts.flatMap((a) => Object.keys(a.metrics))),
      ],
      ...r.accounts.map((a) => [
        a.name,
        a.platform,
        a.followersStart ?? "",
        a.followersEnd ?? "",
        a.growth ?? "",
        ...Object.values(a.metrics),
      ]),
      [],
      ["PAID ADS"],
      [
        "Spend",
        "Impressions",
        "Reach",
        "Link clicks",
        "CTR %",
        "CPC",
        "CPM",
        "Leads",
        "CPL",
        "Purchases",
        "Purchase value",
        "ROAS",
      ],
      [
        r.paid.spend,
        r.paid.impressions,
        r.paid.reach,
        r.paid.linkClicks,
        r.paid.ctr,
        r.paid.cpc,
        r.paid.cpm,
        r.paid.leads,
        r.paid.cpl,
        r.paid.purchases,
        r.paid.purchaseValue,
        r.paid.roas,
      ],
      [],
      ["CAMPAIGNS"],
      [
        "Campaign",
        "Objective",
        "Spend",
        "Impressions",
        "CTR %",
        "CPC",
        "Leads",
        "CPL",
        "Purchases",
        "ROAS",
      ],
      ...r.campaigns.map((c) => [
        c.name,
        c.objective,
        c.spend,
        c.impressions,
        c.ctr,
        c.cpc,
        c.leads,
        c.cpl,
        c.purchases,
        c.roas,
      ]),
      [],
      ["POSTS"],
      [
        "Title",
        "Platforms",
        "Published",
        "Reach",
        "Likes",
        "Comments",
        "Shares",
        "Saves",
        "Engagement",
        "Link",
      ],
      ...r.posts.map((p) => [
        p.title,
        p.platforms.join("/"),
        p.publishedAt ? ymd(p.publishedAt) : "",
        p.reach || 0,
        p.likes || 0,
        p.comments || 0,
        p.shares || 0,
        p.saves || 0,
        p.engagement || 0,
        p.permalink || "",
      ]),
      [],
      ["LEADS"],
      ["Total", r.leads.total],
      ...r.leads.bySource.map((x) => [x.source, x.n]),
    ];
    sendCsv(res, `marketing-report-${from}-to-${to}.csv`, rows);
  }),
);
app.post(
  "/api/reports/marketing/summary",
  wrap(async (req, res) => {
    const org = tid(req);
    const { from, to } = range(req.body, 7);
    const r = await buildReport(org, from, to);
    const ctx = await brandContext(org, req.body.brandId, { products: false });
    const data = await aiJSON(
      org,
      "report_summary",
      `You write marketing performance summaries for business owners. Use ONLY the numbers given. Return JSON: {"headline":"","summary":"3-5 sentences","wins":[""],"concerns":[""],"nextSteps":[""]}. Language: ${LANG[req.body.language] || "English"}.`,
      `${ctx.text}\nREPORT ${from}..${to}: ${JSON.stringify({ ...r, posts: undefined, topPosts: r.topPosts.slice(0, 5) })}`,
      { temperature: 0.4 },
    );
    res.json({ success: true, summary: data });
  }),
);

/* =====================================================
   COMPETITOR & MARKET INTELLIGENCE (1.12) - public data only
   ===================================================== */
const OFFER_RE =
  /(\d+\s?%|ছাড়|অফার|ডিসকাউন্ট|discount|off\b|sale|free delivery|ফ্রি ডেলিভারি|buy\s?1|bogo|cashback|ক্যাশব্যাক|combo|কম্বো|promo|coupon)/i;

async function snapshotCompetitor(org, c) {
  if (!c.igUsername)
    throw fail(
      400,
      "Add the competitor's Instagram username (business/creator account) to fetch public data",
    );
  const ig = await SocialAccount.findOne({
    organizationId: org,
    platform: "Instagram",
  }).select("+accessToken");
  if (!ig)
    throw fail(
      400,
      "Connect your own Instagram professional account first (needed for Business Discovery)",
    );
  const u = c.igUsername.replace(/^@/, "").trim();
  const r = await graph(`/${ig.accountId}`, {
    token: tok(ig),
    params: {
      fields: `business_discovery.username(${u}){username,name,followers_count,media_count,media.limit(30){caption,like_count,comments_count,timestamp,permalink,media_type}}`,
    },
  });
  const bd = r.business_discovery || {};
  const posts = (bd.media?.data || []).map((p) => ({
    caption: p.caption || "",
    like_count: p.like_count || 0,
    comments_count: p.comments_count || 0,
    timestamp: p.timestamp,
    permalink: p.permalink,
    media_type: p.media_type,
  }));
  const last28 = posts.filter(
    (p) => new Date(p.timestamp) > new Date(Date.now() - 28 * DAY),
  );
  const avgEngagement = posts.length
    ? Math.round(
        posts.reduce((t, p) => t + p.like_count + p.comments_count, 0) /
          posts.length,
      )
    : 0;
  const offers = posts
    .filter((p) => OFFER_RE.test(p.caption))
    .slice(0, 10)
    .map((p) => `${ymd(p.timestamp)}: ${p.caption.slice(0, 160)}`);
  const byType = posts.reduce(
    (a, p) => ({ ...a, [p.media_type]: (a[p.media_type] || 0) + 1 }),
    {},
  );
  const snap = await CompetitorSnapshot.create({
    organizationId: org,
    competitorId: c.id,
    followers: bd.followers_count,
    mediaCount: bd.media_count,
    postsPerWeek: round(last28.length / 4, 1),
    avgEngagement,
    offers,
    posts,
  });
  c.latest = {
    followers: bd.followers_count,
    mediaCount: bd.media_count,
    postsPerWeek: snap.postsPerWeek,
    avgEngagement,
    engagementRate: bd.followers_count
      ? round((avgEngagement / bd.followers_count) * 100)
      : null,
    offers,
    byType,
    posts: posts.slice(0, 12),
  };
  c.lastSnapshotAt = new Date();
  await c.save();
  return c;
}

app.get(
  "/api/competitors",
  wrap(async (req, res) =>
    res.json(
      await Competitor.find({ organizationId: tid(req) }).sort({ name: 1 }),
    ),
  ),
);
app.post(
  "/api/competitors",
  wrap(async (req, res) => {
    const d = pick(req.body, [
      "name",
      "igUsername",
      "facebookUrl",
      "website",
      "brandId",
    ]);
    if (!d.name) throw fail(400, "Competitor name is required");
    res.json({
      success: true,
      competitor: await Competitor.create({ ...d, organizationId: tid(req) }),
    });
  }),
);
app.put(
  "/api/competitors/:id",
  wrap(async (req, res) => {
    const c = await Competitor.findOneAndUpdate(
      { _id: req.params.id, organizationId: tid(req) },
      pick(req.body, ["name", "igUsername", "facebookUrl", "website"]),
      { new: true },
    );
    if (!c) throw fail(404, "Competitor not found");
    res.json({ success: true, competitor: c });
  }),
);
app.delete(
  "/api/competitors/:id",
  wrap(async (req, res) => {
    await Competitor.deleteOne({
      _id: req.params.id,
      organizationId: tid(req),
    });
    await CompetitorSnapshot.deleteMany({
      organizationId: tid(req),
      competitorId: req.params.id,
    });
    res.json({ success: true });
  }),
);
app.post(
  "/api/competitors/:id/snapshot",
  wrap(async (req, res) => {
    const c = await Competitor.findOne({
      _id: req.params.id,
      organizationId: tid(req),
    });
    if (!c) throw fail(404, "Competitor not found");
    res.json({
      success: true,
      competitor: await snapshotCompetitor(tid(req), c),
    });
  }),
);
app.get(
  "/api/competitors/:id/snapshots",
  wrap(async (req, res) =>
    res.json(
      await CompetitorSnapshot.find({
        organizationId: tid(req),
        competitorId: req.params.id,
      })
        .select("-posts")
        .sort({ createdAt: 1 })
        .limit(120),
    ),
  ),
);
// Manual observations (offers seen, posts, notes) for anything the API can't read
app.post(
  "/api/competitors/:id/notes",
  wrap(async (req, res) => {
    if (!req.body.text) throw fail(400, "Note text is required");
    const c = await Competitor.findOneAndUpdate(
      { _id: req.params.id, organizationId: tid(req) },
      {
        $push: {
          notes: { type: req.body.type || "note", text: req.body.text },
        },
      },
      { new: true },
    );
    if (!c) throw fail(404, "Competitor not found");
    res.json({ success: true, competitor: c });
  }),
);
app.post(
  "/api/competitors/ai-summary",
  wrap(async (req, res) => {
    const org = tid(req);
    const comps = await Competitor.find({ organizationId: org }).lean();
    if (!comps.length)
      throw fail(400, "Add competitors to the watchlist first");
    const ctx = await brandContext(org, req.body.brandId, { products: false });
    const own = await performanceDigest(org, req.body.brandId, 5);
    const data = await aiJSON(
      org,
      "competitor_summary",
      `You are a competitive intelligence analyst. Use ONLY the public data and notes given. Return JSON: {"summary":"","competitors":[{"name":"","strategy":"","contentMix":"","postingFrequency":"","engagement":"","offers":"","strengths":[""],"weaknesses":[""]}],"marketTrends":[""],"opportunities":[{"opportunity":"","why":"","action":""}],"threats":[""]}`,
      `${ctx.text}\nOUR TOP POSTS: ${JSON.stringify(own.top)}\nCOMPETITORS: ${JSON.stringify(comps.map((c) => ({ name: c.name, latest: c.latest ? { ...c.latest, posts: (c.latest.posts || []).slice(0, 10).map((p) => ({ caption: p.caption.slice(0, 220), likes: p.like_count, comments: p.comments_count, type: p.media_type, date: p.timestamp })) } : null, notes: (c.notes || []).slice(-15) })))}`,
      { maxTokens: 3000, temperature: 0.4 },
    );
    const plan = await savePlan(org, {
      brandId: req.body.brandId || null,
      kind: "research",
      title: `Competitor strategy summary ${ymd(new Date())}`,
      input: { kind: "competitor_summary" },
      data,
    });
    res.json({ success: true, plan });
  }),
);

/* =====================================================
   MARKETING SETTINGS + NOTIFICATIONS
   ===================================================== */
app.get(
  "/api/marketing/settings",
  wrap(async (req, res) => res.json(await getSettings(tid(req)))),
);
app.put(
  "/api/marketing/settings",
  wrap(async (req, res) => {
    const b = pick(req.body, [
      "requireApproval",
      "creativeApproval",
      "optimizationMode",
      "maxBudgetDeltaPct",
      "maxDailyBudget",
      "guardrailAllowlist",
      "salesTeam",
      "leadCategories",
      "timezone",
    ]);
    if (
      b.optimizationMode &&
      !["recommend", "approval", "guardrailed"].includes(b.optimizationMode)
    )
      throw fail(400, "Unknown optimization mode");
    if ("guardrailAllowlist" in b)
      b.guardrailAllowlist = lines(b.guardrailAllowlist);
    if ("leadCategories" in b) b.leadCategories = linesNL(b.leadCategories);
    if ("salesTeam" in b && !Array.isArray(b.salesTeam))
      b.salesTeam = lines(String(b.salesTeam).replace(/,/g, "\n")).map((l) => {
        const m = l.match(/^(.*?)\s*<(.+)>$/);
        return m
          ? { name: m[1].trim(), email: m[2].trim(), active: true }
          : { name: l, email: "", active: true };
      });
    if ("maxBudgetDeltaPct" in b)
      b.maxBudgetDeltaPct = Math.max(
        1,
        Math.min(100, Number(b.maxBudgetDeltaPct) || 20),
      );
    const set = Object.fromEntries(
      Object.entries(b).map(([k, v]) => [`marketingSettings.${k}`, v]),
    );
    await Organization.updateOne(
      { _id: tid(req) },
      { $set: set },
      { upsert: true },
    );
    res.json({ success: true, settings: await getSettings(tid(req)) });
  }),
);

app.get(
  "/api/notifications",
  wrap(async (req, res) => {
    const org = tid(req);
    const [rows, unread] = await Promise.all([
      Notification.find({ organizationId: org })
        .sort({ createdAt: -1 })
        .limit(50),
      Notification.countDocuments({ organizationId: org, read: false }),
    ]);
    res.json({ unread, rows });
  }),
);
app.put(
  "/api/notifications/read-all",
  wrap(async (req, res) => {
    await Notification.updateMany(
      { organizationId: tid(req), read: false },
      { read: true },
    );
    res.json({ success: true });
  }),
);
app.put(
  "/api/notifications/:id/read",
  wrap(async (req, res) => {
    await Notification.updateOne(
      { _id: req.params.id, organizationId: tid(req) },
      { read: true },
    );
    res.json({ success: true });
  }),
);

/* =====================================================
   CUSTOMER INBOX + AI SALES AGENT (2.1, 2.3, 2.4, 2.5, 2.14)
   Messenger / Instagram DMs / post comments -> AI reply -> order draft -> confirm -> COD order
   ===================================================== */
const WINDOW_MS = 24 * 3600e3; // Meta standard messaging window
const isSim = (c) => String(c.psid).startsWith("sim_");
const windowOpen = (c) =>
  isSim(c) ||
  (!!c.lastCustomerAt &&
    Date.now() - new Date(c.lastCustomerAt).getTime() < WINDOW_MS);
const CONFIRM_RE =
  /^\s*(confirm(ed)?|yes|yeah|yep|ok(ay)?|done|sure|place (the )?order|হ্যাঁ|হ্যা|হা|জি|জ্বি|ঠিক আছে|কনফার্ম|ওকে|ji|hae|ha)\s*[.!✅👍]*\s*$/i;
const HANDOFF_RE =
  /(human|real person|agent|manush|মানুষ|কারো সাথে কথা|complain|অভিযোগ|refund|রিফান্ড|ফেরত দিতে|damaged|broken|নষ্ট|ভাঙা|fraud|প্রতারণা|scam)/i;
const DEFAULT_AGENT = {
  enabled: true,
  autoConfirm: true,
  tone: "friendly",
  escalateBelow: 60,
  deliveryInside: 80,
  deliveryOutside: 130,
  deliveryTime: "24-48 hours inside Dhaka, 3-5 days outside",
  handoffMessage:
    "Thanks! I'm connecting you with our team. They'll reply shortly 🙏",
  commentAutoReply: true,
  commentPrivateReply:
    "Hi {name}! 👋 Thanks for your comment on our post. Tell me which product, size/colour and quantity you'd like and I'll get your order ready right here.",
  commentPublicReply: "",
  knowledge: "",
  paymentNote: "",
};
const tk = (n) => "৳" + Number(n || 0).toLocaleString("en-IN");

async function agentConfig(org) {
  const c = await AgentConfig.findOneAndUpdate(
    { organizationId: org },
    { $setOnInsert: {} },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
  return {
    ...DEFAULT_AGENT,
    ...Object.fromEntries(
      Object.entries(c || {}).filter(([, v]) => v !== undefined && v !== null),
    ),
  };
}

// Messages for the same customer are processed one at a time
const CONV_LOCKS = new Map();
function withLock(key, fn) {
  const prev = CONV_LOCKS.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  CONV_LOCKS.set(key, next);
  next
    .finally(() => {
      if (CONV_LOCKS.get(key) === next) CONV_LOCKS.delete(key);
    })
    .catch(() => {});
  return next;
}

function pushMsg(c, from, text, extra = {}) {
  c.messages.push({
    from,
    text: String(text || "").slice(0, 4000) || "(empty)",
    ...extra,
  });
  if (c.messages.length > 400) c.messages.splice(0, c.messages.length - 400);
  if (from !== "system") c.lastMessage = String(text || "").slice(0, 200);
  return c.messages[c.messages.length - 1];
}

async function pageForConv(org, c) {
  return SocialAccount.findOne({
    organizationId: org,
    platform: "Facebook",
    ...(c.pageId ? { accountId: c.pageId } : {}),
  }).select("+accessToken");
}

// Sends through the Page (works for Messenger and Instagram DMs linked to the Page)
async function sendToCustomer(
  org,
  c,
  text,
  { quickReplies = [], commentId } = {},
) {
  if (isSim(c)) return { simulated: true };
  const page = await pageForConv(org, c);
  if (!page) {
    if (process.env.N8N_REPLY_URL) {
      // legacy n8n sender
      const r = await fetch(N8N_REPLY, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ psid: c.psid, text }),
      });
      if (!r.ok) throw fail(502, "n8n reply webhook failed");
      return { via: "n8n" };
    }
    throw fail(400, "Facebook Page is not connected");
  }
  if (!commentId && !windowOpen(c))
    throw fail(
      400,
      "Messenger 24-hour window is closed. The customer must message first.",
    );
  const message = { text: String(text).slice(0, 2000) };
  if (quickReplies.length)
    message.quick_replies = quickReplies
      .slice(0, 13)
      .map((q) => ({
        content_type: "text",
        title: String(q.title).slice(0, 20),
        payload: q.payload || q.title,
      }));
  const body = commentId
    ? { recipient: { comment_id: commentId }, message }
    : { recipient: { id: c.psid }, messaging_type: "RESPONSE", message };
  return graph(`/${page.accountId}/messages`, {
    token: tok(page),
    method: "POST",
    body,
  });
}

// AI/system reply: store it, then try to deliver it
async function say(org, c, text, opts = {}) {
  const m = pushMsg(c, "ai", text, {
    quickReplies: opts.quickReplies?.map((q) => q.title),
    privateReply: opts.commentId ? true : undefined,
  });
  try {
    const r = await sendToCustomer(org, c, text, opts);
    if (r?.message_id) m.mid = r.message_id;
  } catch (e) {
    m.error = e.message;
    console.warn("send failed:", e.message);
  }
  c.aiHandled = (c.aiHandled || 0) + 1;
  return m;
}

/* ---------- knowledge + agent ---------- */
async function agentKnowledge(org, text, draft) {
  const cfg = await agentConfig(org);
  const ctx = await brandContext(org, null, { products: false });
  const [all, zones] = await Promise.all([
    Product.find({ organizationId: org, status: { $ne: "archived" } }).lean(),
    orgZones(org),
  ]);
  const words = String(text || "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1);
  const inDraft = new Set((draft?.items || []).map((i) => String(i.productId)));
  const scored = all.map((p) => ({
    p,
    s:
      words.reduce(
        (t, w) =>
          t +
          (`${p.name} ${p.category} ${p.sku}`.toLowerCase().includes(w)
            ? 1
            : 0),
        0,
      ) + (inDraft.has(String(p._id)) ? 100 : 0),
  }));
  const picked = scored
    .sort((a, b) => b.s - a.s)
    .slice(0, 40)
    .map((x) => x.p);
  const text2 = [
    ctx.text,
    `DELIVERY FEES (by zone): ${zones.map((z) => `${z.name} ${tk(z.fee)}${z.freeOver ? ` (free over ${tk(z.freeOver)})` : ""}`).join(", ")}. The system picks the zone from the district/area. Delivery time: ${cfg.deliveryTime}. Payment: cash on delivery (COD).${cfg.paymentNote ? " " + cfg.paymentNote : ""}`,
    cfg.knowledge
      ? `BUSINESS INFO / POLICIES / FAQ (approved):\n${cfg.knowledge}`
      : "",
    `PRODUCTS (productId | name | category | variants as variantId=name price stock):\n${picked.map((p) => `${p._id} | ${p.name}${p.nameBn ? " / " + p.nameBn : ""} | ${p.category} | ${(p.variants || []).map((v) => `${v._id}=${v.name} ${tk(priceOf(p, v))} ${v.available > 0 ? v.available + " in stock" : "OUT OF STOCK"}`).join("; ")}`).join("\n") || "(no products in the catalogue)"}`,
  ]
    .filter(Boolean)
    .join("\n");
  return { cfg, text: text2, products: all };
}

const AGENT_SHAPE = `{"reply":"","intent":"question|order|confirm|change|handoff|smalltalk|other","confidence":0,"needsHuman":false,"handoffReason":"","draft":{"items":[{"productId":"","variantId":"","name":"","variant":"","qty":1}],"name":"","phone":"","address":"","district":""},"readyToConfirm":false}`;

async function runAgent(org, c, latestText) {
  const recent = (c.messages || [])
    .filter((m) => m.from === "customer")
    .slice(-6)
    .map((m) => m.text)
    .join(" ");
  const k = await agentKnowledge(org, `${recent} ${latestText}`, c.orderDraft);
  const history = (c.messages || [])
    .slice(-16)
    .filter((m) => m.from !== "system")
    .map(
      (m) =>
        `${m.from === "customer" ? "CUSTOMER" : m.from === "agent" ? "HUMAN AGENT" : "YOU"}: ${m.text}`,
    )
    .join("\n");
  const d = c.orderDraft || {};
  const out = await aiJSON(
    org,
    "inbox_agent",
    `You are the AI sales assistant of this business, chatting with customers on Facebook Messenger / Instagram in Bangladesh.
Reply in the customer's language and script (Bangla, Banglish or English). Keep it short and warm (max 3-4 short lines). Tone: ${k.cfg.tone}.
RULES
- Use ONLY the business info and PRODUCTS given. Never invent prices, stock, discounts, delivery times or policies. If the answer is not there, say you'll check with the team and set needsHuman=true.
- To take an order collect: product(s) from PRODUCTS (use the exact productId and, when a product has several variants, the exact variantId of the size/colour the customer chose), quantity, customer name, phone (Bangladesh format 01XXXXXXXXX), full delivery address with area/thana, and the district (one of Bangladesh's 64 districts, e.g. Dhaka, Gazipur, Chattogram).
- Ask only for what is still missing, one or two things at a time. Don't repeat questions already answered.
- If a product or variant is OUT OF STOCK say so and suggest an in-stock alternative from PRODUCTS.
- Never offer discounts, free delivery or gifts unless they are written in the business info. Don't calculate totals yourself: the system shows the exact total.
- When everything is collected set readyToConfirm=true. The system then sends the order summary with Confirm/Change buttons, so your reply should be just a short lead-in like "Here's your order summary 👇".
- Never say the order is placed or confirmed. The system does that after the customer confirms.
- Set needsHuman=true for complaints, refunds, damaged items, angry customers, a request for a human, bulk/wholesale negotiation, or anything you are unsure about.
- "draft" must contain the FULL current draft (keep known values, add new info). Leave unknown fields empty.
- confidence = how sure you are that your reply is correct and grounded (0-100).
Return JSON only: ${AGENT_SHAPE}`,
    `${k.text}\n\n${d.status === "placed" ? `PREVIOUS ORDER #${d.orderNo || ""} IS ALREADY PLACED. Only add items if the customer wants a NEW order.\n` : ""}CURRENT ORDER DRAFT: ${JSON.stringify({ items: d.status === "placed" ? [] : (d.items || []).map((i) => ({ productId: i.productId, variantId: i.variantId || "", name: i.name, variant: i.variant, qty: i.qty })), name: d.name || "", phone: d.phone || "", address: d.address || "", district: d.district || "", status: d.status === "placed" ? "new" : d.status || "collecting" })}\n\nCONVERSATION SO FAR:\n${history || "(new conversation)"}\n\nCUSTOMER (latest message): ${latestText}`,
    { temperature: 0.3, maxTokens: 900 },
  );
  return { out, k };
}

// Turns an AI/agent item into a draft line. Prices and stock always come from the database.
function draftLine(products, i) {
  const p =
    products.find((pp) => String(pp._id) === String(i.productId)) ||
    products.find(
      (pp) => pp.name.toLowerCase() === String(i.name || "").toLowerCase(),
    );
  if (!p) return null;
  const vs = p.variants || [];
  let v =
    vs.find((x) => x._id === String(i.variantId || "")) ||
    (vs.length === 1 ? vs[0] : null);
  if (!v && i.variant) {
    const want = normText(i.variant);
    v =
      vs.find((x) => normText(x.name) === want) ||
      vs.find(
        (x) =>
          [x.size, x.color].filter(Boolean).length &&
          [x.size, x.color]
            .filter(Boolean)
            .every((a) => want.includes(normText(a).trim())),
      );
  }
  return {
    productId: String(p._id),
    variantId: v?._id || null,
    name: p.name,
    variant:
      v && v.name !== "Default" ? v.name : String(i.variant || "").slice(0, 80),
    variants: vs.length,
    qty: Math.max(1, Math.min(99, parseInt(i.qty, 10) || 1)),
    price: priceOf(p, v),
    stock: v ? v.available : vs.reduce((s, x) => s + x.available, 0),
  };
}
function mergeDraft(c, out, products) {
  const d = { items: [], status: "collecting", ...(c.orderDraft || {}) };
  const x = out?.draft || {};
  for (const f of ["name", "address"])
    if (x[f] && String(x[f]).trim().length > 1)
      d[f] = String(x[f]).trim().slice(0, 300);
  if (x.phone) {
    const p = normPhone(x.phone);
    if (p && p.length >= 11) d.phone = p;
  }
  if (x.district && canonicalDistrict(x.district))
    d.district = canonicalDistrict(x.district);
  if (Array.isArray(x.items) && x.items.length) {
    const items = x.items.map((i) => draftLine(products, i)).filter(Boolean);
    if (items.length) d.items = items;
  }
  d.v = (d.v || 0) + 1; // draft version, used as the order idempotency key
  c.orderDraft = d;
  c.markModified("orderDraft");
  return d;
}
// Zone + fee from the workspace delivery zones (FR-ORD-006)
async function refreshDraftZone(org, c) {
  const d = c.orderDraft || {};
  if (!d.address && !d.district) return d;
  const z = zoneFor(await orgZones(org), {
    address: d.address,
    district: d.district,
  });
  const subtotal = (d.items || []).reduce((s, i) => s + i.price * i.qty, 0);
  d.zone = {
    name: z.zone,
    fee: z.freeOver && subtotal >= z.freeOver ? 0 : z.fee,
    sure: z.sure,
  };
  if (!d.district && z.district) d.district = z.district;
  c.orderDraft = d;
  c.markModified("orderDraft");
  return d;
}
function draftTotals(d) {
  const subtotal = (d.items || []).reduce((s, i) => s + i.price * i.qty, 0);
  const fee = d.zone?.fee || 0;
  return { subtotal, fee, total: subtotal + fee, zone: d.zone?.name || null };
}
function draftMissing(d) {
  const m = [];
  if (!d.items?.length) m.push("product");
  const noVar = (d.items || []).filter((i) => !i.variantId && i.variants > 1);
  if (noVar.length)
    m.push(`size/colour for ${noVar.map((i) => i.name).join(", ")}`);
  if (!d.name) m.push("name");
  if (!/^01[3-9]\d{8}$/.test(d.phone || "")) m.push("phone");
  if (!d.address || d.address.length < 6) m.push("address");
  if (!d.zone || (!d.zone.sure && !d.district)) m.push("district");
  const oos = (d.items || []).filter((i) => (i.stock ?? 0) < i.qty);
  if (oos.length)
    m.push(
      `stock for ${oos.map((i) => i.name + (i.variant ? " " + i.variant : "")).join(", ")}`,
    );
  return m;
}
function summaryText(d, cfg) {
  const t = draftTotals(d);
  return [
    "🧾 Order summary",
    ...d.items.map(
      (i) =>
        `• ${i.name}${i.variant ? ` (${i.variant})` : ""} × ${i.qty} = ${tk(i.price * i.qty)}`,
    ),
    "",
    `Subtotal: ${tk(t.subtotal)}`,
    `Delivery fee (${t.zone || "-"}): ${tk(t.fee)}`,
    `Total payable on delivery (COD): ${tk(t.total)}`,
    "",
    `👤 Name: ${d.name}`,
    `📞 Phone: ${d.phone}`,
    `📍 Address: ${d.address}${d.district ? ", " + d.district : ""}`,
    "",
    'Is everything correct? Type "Confirm" or "Yes" to place the order.',
  ].join("\n");
}
const CONFIRM_BUTTONS = [
  { title: "✅ Confirm", payload: "CONFIRM_ORDER" },
  { title: "✏️ Change", payload: "CHANGE_ORDER" },
];

async function handoff(org, c, reason, message) {
  c.aiPaused = true;
  c.status = "needs_review";
  c.handoffReason = reason;
  pushMsg(c, "system", `Handed to a human: ${reason}`);
  if (message) await say(org, c, message);
  await notify(
    org,
    "inbox",
    `${c.customerName} needs a human`,
    reason,
    "inbox",
  );
}

async function ensureLead(org, c, text) {
  if (c.leadId) return;
  const ig = c.channel === "Instagram";
  const r = await ingestLead(
    org,
    {
      name: c.customerName,
      message: text,
      source: isSim(c) ? "manual" : ig ? "instagram_dm" : "messenger",
      externalId: `${ig ? "ig" : "fb"}:${c.psid}`,
      pageId: c.pageId,
    },
    { skipAi: true, quiet: true },
  ).catch((e) => {
    console.warn("lead:", e.message);
    return null;
  });
  if (r?.lead) c.leadId = r.lead.id;
}

async function placeOrderFromDraft(org, c, cfg, by = "AI") {
  if (c.orderDraft?.status === "placed")
    throw fail(
      409,
      `Order #${c.orderDraft.orderNo} was already placed. Edit the draft to start a new order.`,
    );
  await refreshDraftZone(org, c);
  const d = c.orderDraft || {};
  const miss = draftMissing(d);
  if (miss.length)
    throw fail(400, "Order draft is missing: " + miss.join(", "));
  const ai = by === "AI";
  const order = await createOrder(
    org,
    {
      customerName: d.name,
      phone: d.phone,
      address: d.address,
      district: d.district,
      items: d.items.map((i) => ({
        productId: i.productId,
        variantId: i.variantId,
        variant: i.variant,
        qty: i.qty,
      })),
      paymentMethod: "COD",
      channel:
        c.source?.type === "comment"
          ? "Facebook Comment"
          : c.channel === "Instagram"
            ? "Instagram AI"
            : c.channel === "Simulator"
              ? "Simulator"
              : "Messenger AI",
      status: cfg.autoConfirm ? "confirmed" : "pending",
      conversationId: c.id,
      psid: c.psid,
      sourceCommentId: c.source?.commentId || null,
      idemKey: `conv:${c.id}:v${d.v || 0}`,
      attribution: {
        source: c.channel === "Instagram" ? "instagram" : "facebook",
        medium: c.source?.type || "messenger",
        content: c.source?.postId || null,
        leadId: c.leadId || null,
      },
    },
    { by: ai ? "AI agent" : by, createdBy: ai ? "ai_agent" : "user" },
  );
  const t = {
    subtotal: order.subtotal,
    fee: order.deliveryFee,
    total: order.total,
  };
  d.status = "placed";
  d.orderId = order.id;
  d.orderNo = order.orderNo;
  c.orderDraft = d;
  c.markModified("orderDraft");
  c.orderId = order.id;
  c.orderNo = order.orderNo;
  pushMsg(
    c,
    "system",
    `Order #${order.orderNo} created by ${by} · ${tk(t.total)} COD${order.status === "on_hold" ? " · ON HOLD (risk " + order.riskScore + ")" : ""}`,
  );
  if (c.leadId)
    await Lead.updateOne(
      { _id: c.leadId, organizationId: org },
      {
        stage: "won",
        convertedAt: new Date(),
        value: t.total,
        orderId: order.id,
        phone: d.phone,
        name: d.name,
      },
    );
  if (order.status === "on_hold") c.status = "needs_review";
  return { order, totals: t };
}

function orderPlacedText(order, t, cfg) {
  if (order.status === "on_hold")
    return `✅ We've received your order #${order.orderNo} (${tk(t.total)}). Our team will call you to verify it before dispatch. Thank you 🙏`;
  if (order.status === "pending")
    return `✅ Your order #${order.orderNo} (${tk(t.total)}, cash on delivery) is received. Our team will call you to confirm shortly. Thank you 🙏`;
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
    const plain = String(text || "")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (
      d.status === "awaiting_confirm" &&
      (payload === "CONFIRM_ORDER" ||
        CONFIRM_RE.test(text) ||
        CONFIRM_RE.test(plain))
    ) {
      try {
        const { order, totals } = await placeOrderFromDraft(org, c, cfg, "AI");
        await say(org, c, orderPlacedText(order, totals, cfg));
      } catch (e) {
        await handoff(
          org,
          c,
          `Couldn't place order: ${e.message}`,
          "Sorry, I couldn't place the order automatically. Our team will finish it for you shortly 🙏",
        );
      }
      return;
    }
    if (
      d.status === "awaiting_confirm" &&
      (payload === "CHANGE_ORDER" || /^(change|edit|বদল|পরিবর্তন)/i.test(plain))
    ) {
      c.orderDraft = { ...d, status: "collecting" };
      c.markModified("orderDraft");
      await say(
        org,
        c,
        "No problem! What would you like to change? Product, size, quantity, name, phone or address?",
      );
      return;
    }
    if (await isBlocked(org, { phone: d.phone, psid: c.psid }))
      return handoff(
        org,
        c,
        "Customer is on the block list",
        cfg.handoffMessage,
      );
    if (HANDOFF_RE.test(text))
      return handoff(
        org,
        c,
        `Customer said: "${text.slice(0, 80)}"`,
        cfg.handoffMessage,
      );
    if (!aiConfigured())
      return handoff(org, c, "AI is not configured", cfg.handoffMessage);

    let res;
    try {
      res = await runAgent(org, c, text);
    } catch (e) {
      return handoff(org, c, `AI error: ${e.message}`, cfg.handoffMessage);
    }
    const { out, k } = res;
    if (
      d.status === "awaiting_confirm" &&
      out.intent === "confirm" &&
      !draftMissing(d).length
    ) {
      try {
        const { order, totals } = await placeOrderFromDraft(org, c, cfg, "AI");
        await say(org, c, orderPlacedText(order, totals, cfg));
      } catch (e) {
        await handoff(
          org,
          c,
          `Couldn't place order: ${e.message}`,
          "Sorry, I couldn't place the order automatically. Our team will finish it for you shortly 🙏",
        );
      }
      return;
    }
    if (
      d.status === "placed" &&
      ["order", "question"].includes(out.intent) &&
      out.draft?.items?.length
    ) {
      c.orderDraft = {
        name: d.name,
        phone: d.phone,
        address: d.address,
        district: d.district,
        zone: d.zone,
        v: (d.v || 0) + 1,
        items: [],
        status: "collecting",
      }; // new order
    } else if (d.status === "awaiting_confirm")
      c.orderDraft = { ...d, status: "collecting" }; // customer is still editing
    mergeDraft(c, out, k.products);
    const nd = await refreshDraftZone(org, c);
    if (out.needsHuman || (Number(out.confidence) || 0) < cfg.escalateBelow) {
      return handoff(
        org,
        c,
        out.handoffReason || `Low AI confidence (${out.confidence ?? 0}%)`,
        out.reply || cfg.handoffMessage,
      );
    }
    if (out.readyToConfirm && nd.status !== "placed") {
      const miss = draftMissing(nd);
      if (!miss.length) {
        c.orderDraft = { ...nd, status: "awaiting_confirm" };
        c.markModified("orderDraft");
        if (out.reply) await say(org, c, out.reply);
        await say(org, c, summaryText(nd, cfg), {
          quickReplies: CONFIRM_BUTTONS,
        });
        return;
      }
      if (miss.some((m) => m.startsWith("stock"))) {
        await say(
          org,
          c,
          `Sorry, we don't have enough ${miss.find((m) => m.startsWith("stock")).replace("stock for ", "")} in stock right now. Would you like another option?`,
        );
        return;
      }
    }
    await say(org, c, out.reply || cfg.handoffMessage);
  } finally {
    await c.save();
  }
}

/* ---------- Meta webhooks: Messenger, Instagram DMs, comments, lead ads ---------- */
async function profileOf(org, page, id, ig) {
  try {
    const p = await graph(`/${id}`, {
      token: tok(page),
      params: {
        fields: ig
          ? "name,username,profile_pic"
          : "first_name,last_name,profile_pic",
      },
    });
    return {
      name: ig
        ? p.name || (p.username ? "@" + p.username : null)
        : [p.first_name, p.last_name].filter(Boolean).join(" ") || null,
      avatar: p.profile_pic || null,
    };
  } catch {
    return { name: null, avatar: null };
  }
}

async function handleMessaging(page, ev, { channel = "Messenger", pageId }) {
  const org = page.organizationId;
  const msg = ev.message,
    pb = ev.postback;
  if (msg?.is_echo) {
    if (FB_APP_ID && String(msg.app_id || "") === String(FB_APP_ID)) return; // our own send
    // A person replied from Meta Business Suite: record it and pause the AI
    const psid = String(ev.recipient?.id);
    await withLock(`${org}:${psid}`, async () => {
      const c = await Conversation.findOne({ organizationId: org, psid });
      if (!c || (msg.mid && c.messages.some((m) => m.mid === msg.mid))) return;
      pushMsg(c, "agent", msg.text || "[attachment]", {
        mid: msg.mid,
        by: "Business Suite",
      });
      c.aiPaused = true;
      await c.save();
    });
    return;
  }
  const psid = String(ev.sender?.id || "");
  if (!psid || psid === String(pageId)) return;
  const text =
    msg?.text ||
    pb?.title ||
    (msg?.attachments?.length
      ? `[${msg.attachments.map((a) => a.type).join(", ")}]`
      : "");
  if (!text) return;
  const payload = msg?.quick_reply?.payload || pb?.payload || null;
  const mid = msg?.mid || `pb:${ev.timestamp}:${psid}`;
  try {
    await WebhookEvent.create({
      provider: "meta",
      externalEventId: `msg:${mid}`,
      tenantId: org,
      processingStatus: "processed",
    });
  } catch (e) {
    if (e.code === 11000) return;
    throw e;
  }
  await withLock(`${org}:${psid}`, async () => {
    let c = await Conversation.findOne({ organizationId: org, psid });
    if (!c) {
      const prof = await profileOf(org, page, psid, channel === "Instagram");
      c = new Conversation({
        organizationId: org,
        psid,
        channel,
        pageId: page.accountId,
        customerName: prof.name || "Customer",
        avatar: prof.avatar,
      });
    }
    pushMsg(c, "customer", text, { mid });
    await ensureLead(org, c, text);
    await processCustomerMessage(org, c, text, payload);
  });
}

async function handleMetaWebhook(body) {
  for (const entry of body.entry || []) {
    if (body.object === "page") {
      const page = await SocialAccount.findOne({
        platform: "Facebook",
        accountId: String(entry.id),
      }).select("+accessToken");
      if (page)
        SocialAccount.updateOne(
          { _id: page._id },
          { lastWebhookAt: new Date() },
        ).catch(() => {});
      for (const ev of entry.messaging || []) {
        if (!page) break;
        await handleMessaging(page, ev, {
          channel: "Messenger",
          pageId: page.accountId,
        }).catch((e) => console.error("messaging:", e));
      }
      for (const ch of entry.changes || []) {
        if (ch.field === "feed" && page)
          await handleComment(page, ch.value || {}).catch((e) =>
            console.error("comment:", e),
          );
        if (ch.field !== "leadgen") continue;
        const v = ch.value || {};
        const a =
          page ||
          (await SocialAccount.findOne({
            platform: "Facebook",
            accountId: String(v.page_id),
          }).select("+accessToken"));
        if (!a) {
          console.warn("leadgen for unknown page", v.page_id);
          continue;
        }
        const org = a.organizationId;
        try {
          await WebhookEvent.create({
            provider: "meta",
            externalEventId: `leadgen:${v.leadgen_id}`,
            tenantId: org,
            processingStatus: "processing",
          });
        } catch (e) {
          if (e.code === 11000) continue;
          throw e;
        }
        try {
          const raw = await graph(`/${v.leadgen_id}`, {
            token: tok(a),
            params: {
              fields:
                "id,created_time,field_data,ad_id,adset_id,campaign_id,campaign_name,form_id",
            },
          });
          await leadFromMeta(org, a, raw, { formId: v.form_id });
          await WebhookEvent.updateOne(
            { externalEventId: `leadgen:${v.leadgen_id}` },
            { processingStatus: "processed" },
          );
        } catch (e) {
          await WebhookEvent.updateOne(
            { externalEventId: `leadgen:${v.leadgen_id}` },
            { processingStatus: "failed" },
          );
          await notify(
            org,
            "lead",
            "Couldn't fetch a Facebook lead",
            e.message,
            "leads",
          );
        }
      }
    }
    if (body.object === "instagram") {
      const ig = await SocialAccount.findOne({
        platform: "Instagram",
        accountId: String(entry.id),
      });
      if (!ig) continue;
      const page = await SocialAccount.findOne({
        organizationId: ig.organizationId,
        platform: "Facebook",
        accountId: ig.pageId,
      }).select("+accessToken");
      if (!page) continue;
      for (const ev of entry.messaging || [])
        await handleMessaging(page, ev, {
          channel: "Instagram",
          pageId: ig.accountId,
        }).catch((e) => console.error("ig messaging:", e));
    }
  }
}

/* ---------- inbox API ---------- */
const convRow = (c) => ({
  id: String(c._id),
  customer: c.customerName,
  avatar: c.avatar,
  channel: c.channel,
  last: c.lastMessage,
  status: c.status,
  unread: c.unread,
  time: c.updatedAt,
  aiPaused: !!c.aiPaused,
  orderNo: c.orderNo,
  leadId: c.leadId,
  windowOpen: windowOpen(c),
  source: c.source?.type || null,
  draftStatus: c.orderDraft?.status || null,
  simulated: isSim(c),
});

app.get(
  "/api/inbox/stats",
  wrap(async (req, res) => {
    const org = tid(req);
    const [agg] = await Conversation.aggregate([
      { $match: { organizationId: org } },
      {
        $group: {
          _id: null,
          handled: { $sum: { $ifNull: ["$aiHandled", 0] } },
          open: { $sum: { $cond: [{ $ne: ["$status", "closed"] }, 1, 0] } },
          human: {
            $sum: { $cond: [{ $eq: ["$status", "needs_review"] }, 1, 0] },
          },
          bot: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $ne: ["$status", "closed"] },
                    { $ne: ["$aiPaused", true] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ]);
    const cfg = await agentConfig(org);
    res.json({
      handledByAi: agg?.handled || 0,
      open: agg?.open || 0,
      needsHuman: agg?.human || 0,
      botActive: agg?.bot || 0,
      aiEnabled: cfg.enabled,
      aiConfigured: aiConfigured(),
    });
  }),
);

app.get(
  "/api/conversations",
  wrap(async (req, res) => {
    const q = { organizationId: tid(req) };
    const tab = req.query.tab || "";
    if (tab === "human") q.status = "needs_review";
    else if (tab === "bot") {
      q.status = { $ne: "closed" };
      q.aiPaused = { $ne: true };
    } else if (tab === "closed") q.status = "closed";
    else if (tab === "open" || tab === "all") q.status = { $ne: "closed" };
    if (req.query.status) q.status = req.query.status;
    if (req.query.q) {
      const re = new RegExp(escRe(req.query.q), "i");
      q.$or = [
        { customerName: re },
        { lastMessage: re },
        { orderNo: re },
        { "orderDraft.phone": re },
      ];
    }
    const rows = await Conversation.find(q)
      .select("-messages")
      .sort({ updatedAt: -1 })
      .limit(300);
    res.json(rows.map(convRow));
  }),
);

app.get(
  "/api/conversations/:id",
  wrap(async (req, res) => {
    const org = tid(req);
    const c = await Conversation.findOneAndUpdate(
      { _id: req.params.id, organizationId: org },
      { unread: 0 },
      { new: true },
    );
    if (!c) return res.status(404).json({ error: "Conversation not found" });
    const phone = c.orderDraft?.phone;
    const [orders, page, cfg] = await Promise.all([
      Order.find({
        organizationId: org,
        $or: [{ psid: c.psid }, ...(phone ? [{ phone }] : [])],
      })
        .sort({ createdAt: -1 })
        .limit(10),
      c.pageId
        ? SocialAccount.findOne({
            organizationId: org,
            platform: "Facebook",
            accountId: c.pageId,
          }).lean()
        : null,
      agentConfig(org),
    ]);
    const d = c.orderDraft || { items: [] };
    const pii = canSeePii(req);
    const json = c.toJSON();
    if (!pii && json.orderDraft)
      json.orderDraft = {
        ...json.orderDraft,
        phone: maskPhone(json.orderDraft.phone),
        address: maskAddress(json.orderDraft.address),
      };
    res.json({
      ...json,
      windowOpen: windowOpen(c),
      simulated: isSim(c),
      pageName: page?.accountName || null,
      orders: orders.map((o) => orderRow(o, pii)),
      totals: draftTotals(d),
      missing: d.status === "placed" ? [] : draftMissing(d),
      aiEnabled: cfg.enabled,
      blocked: !!(await isBlocked(org, { phone: d.phone, psid: c.psid })),
    });
  }),
);

// Human reply (auto-pauses the AI so the two don't talk over each other; send keepAi:true to keep it on)
app.post(
  "/api/conversations/:id/reply",
  wrap(async (req, res) => {
    const org = tid(req);
    const text = String(req.body.text || "").trim();
    if (!text) return res.status(400).json({ error: "Reply text is required" });
    await withLock(`${org}:conv:${req.params.id}`, async () => {
      const c = await Conversation.findOne({
        _id: req.params.id,
        organizationId: org,
      });
      if (!c) throw fail(404, "Conversation not found");
      const r = await sendToCustomer(org, c, text);
      pushMsg(c, "agent", text, { by: actor(req), mid: r?.message_id || null });
      if (!req.body.keepAi) c.aiPaused = true;
      if (c.status === "needs_review" || c.status === "closed")
        c.status = "open";
      await c.save();
    });
    res.json({ success: true });
  }),
);

app.put(
  "/api/conversations/:id",
  wrap(async (req, res) => {
    const p = pick(req.body, ["status", "customerName"]);
    if (p.status && !["open", "needs_review", "closed"].includes(p.status))
      throw fail(400, "Invalid status");
    const c = await Conversation.findOneAndUpdate(
      { _id: req.params.id, organizationId: tid(req) },
      p,
      { new: true },
    );
    if (!c) return res.status(404).json({ error: "Conversation not found" });
    res.json({ success: true });
  }),
);

// AI auto-pilot on/off for one conversation (human takeover)
app.post(
  "/api/conversations/:id/ai",
  wrap(async (req, res) => {
    const org = tid(req);
    const c = await Conversation.findOne({
      _id: req.params.id,
      organizationId: org,
    });
    if (!c) throw fail(404, "Conversation not found");
    c.aiPaused = !req.body.enabled;
    pushMsg(
      c,
      "system",
      req.body.enabled
        ? `AI auto-pilot turned on by ${actor(req)}`
        : `${actor(req)} took over (AI paused)`,
    );
    if (req.body.enabled && c.status === "needs_review") {
      c.status = "open";
      c.handoffReason = null;
    }
    await c.save();
    res.json({ success: true });
  }),
);

// Edit the order draft by hand
app.put(
  "/api/conversations/:id/draft",
  wrap(async (req, res) => {
    const org = tid(req);
    const c = await Conversation.findOne({
      _id: req.params.id,
      organizationId: org,
    });
    if (!c) throw fail(404, "Conversation not found");
    const products = await Product.find({
      organizationId: org,
      status: { $ne: "archived" },
    }).lean();
    const b = req.body;
    const prev = c.orderDraft || {};
    const d = {
      ...prev,
      status:
        prev.status === "placed" ? "collecting" : prev.status || "collecting",
    };
    for (const f of ["name", "address"])
      if (f in b) d[f] = String(b[f] || "").trim();
    if ("phone" in b) d.phone = normPhone(b.phone) || "";
    if ("district" in b) d.district = canonicalDistrict(b.district) || "";
    if (Array.isArray(b.items))
      d.items = b.items.map((i) => draftLine(products, i)).filter(Boolean);
    if (prev.status === "placed" && !Array.isArray(b.items)) d.items = [];
    d.v = (d.v || 0) + 1;
    c.orderDraft = d;
    c.markModified("orderDraft");
    await refreshDraftZone(org, c);
    await c.save();
    res.json({ success: true });
  }),
);

// Agent places the order from the draft (optionally tells the customer)
app.post(
  "/api/conversations/:id/place-order",
  wrap(async (req, res) => {
    const org = tid(req);
    let out;
    await withLock(`${org}:conv:${req.params.id}`, async () => {
      const c = await Conversation.findOne({
        _id: req.params.id,
        organizationId: org,
      });
      if (!c) throw fail(404, "Conversation not found");
      const cfg = await agentConfig(org);
      const { order, totals } = await placeOrderFromDraft(
        org,
        c,
        cfg,
        actor(req),
      );
      if (req.body.notify !== false && windowOpen(c)) {
        const t = orderPlacedText(order, totals, cfg);
        try {
          await sendToCustomer(org, c, t);
          pushMsg(c, "agent", t, { by: actor(req) });
        } catch (e) {
          pushMsg(c, "system", `Couldn't message the customer: ${e.message}`);
        }
      }
      await c.save();
      out = order;
    });
    res.json({ success: true, order: orderRow(out) });
  }),
);

// Agent assist: suggested reply + conversation summary
app.post(
  "/api/conversations/:id/suggest",
  wrap(async (req, res) => {
    const org = tid(req);
    const c = await Conversation.findOne({
      _id: req.params.id,
      organizationId: org,
    });
    if (!c) throw fail(404, "Conversation not found");
    const k = await agentKnowledge(
      org,
      c.messages
        .slice(-6)
        .map((m) => m.text)
        .join(" "),
      c.orderDraft,
    );
    const history = c.messages
      .slice(-20)
      .map((m) => `${m.from.toUpperCase()}: ${m.text}`)
      .join("\n");
    const data = await aiJSON(
      org,
      "inbox_suggest",
      `You help a human support agent. Use ONLY the business info. Return JSON: {"summary":"2-3 sentences about what the customer wants and the current status","suggestion":"a reply the agent can send, in the customer's language","nextStep":""}`,
      `${k.text}\n\nORDER DRAFT: ${JSON.stringify(c.orderDraft || {})}\nHANDOFF REASON: ${c.handoffReason || "-"}\n\nCONVERSATION:\n${history}`,
      { temperature: 0.4, maxTokens: 600 },
    );
    res.json({ success: true, ...data });
  }),
);

app.delete(
  "/api/conversations/:id",
  wrap(async (req, res) => {
    await Conversation.deleteOne({
      _id: req.params.id,
      organizationId: tid(req),
    });
    res.json({ success: true });
  }),
);

// Simulator: test the AI agent without Facebook (psid starts with "sim_", nothing is sent to Meta)
app.post(
  "/api/inbox/simulate",
  wrap(async (req, res) => {
    if (!sandboxOk(req))
      throw fail(403, "The simulator is a sandbox tool for the platform admin");
    const org = tid(req);
    const text = String(req.body.text || "").trim();
    if (!text && !req.body.payload) throw fail(400, "Message text is required");
    let id = req.body.conversationId;
    if (!id) {
      const c = await Conversation.create({
        organizationId: org,
        psid: `sim_${crypto.randomBytes(6).toString("hex")}`,
        channel: "Simulator",
        customerName: req.body.name || "Test customer",
        source: req.body.fromComment ? { type: "comment", text } : null,
      });
      id = c.id;
    }
    await withLock(`${org}:conv:${id}`, async () => {
      const c = await Conversation.findOne({ _id: id, organizationId: org });
      if (!c || !isSim(c)) throw fail(404, "Simulator conversation not found");
      const shown =
        text ||
        (req.body.payload === "CONFIRM_ORDER" ? "✅ Confirm" : "✏️ Change");
      pushMsg(c, "customer", shown, {
        fromComment: req.body.fromComment || undefined,
      });
      await ensureLead(org, c, shown);
      await processCustomerMessage(org, c, shown, req.body.payload || null);
    });
    res.json({ success: true, conversationId: id });
  }),
);

// Subscribe a Page to messages, comments and lead webhooks
app.post(
  "/api/inbox/subscribe-page",
  wrap(async (req, res) => {
    const a = await pageAccount(tid(req), req.body.pageId);
    const r = await graph(`/${a.accountId}/subscribed_apps`, {
      token: tok(a),
      method: "POST",
      body: {
        subscribed_fields: [
          "messages",
          "messaging_postbacks",
          "message_echoes",
          "feed",
          "leadgen",
        ],
      },
    });
    res.json({ success: !!r.success });
  }),
);

// n8n flow (legacy): store a message that n8n handled
app.post(
  "/api/inbox/inbound",
  wrap(async (req, res) => {
    const { psid, customerName, text, channel, needsReview, aiReply } =
      req.body;
    if (!psid || !text)
      return res.status(400).json({ error: "psid and text are required" });
    const org = tid(req);
    let c = await Conversation.findOne({ organizationId: org, psid });
    if (!c)
      c = new Conversation({
        organizationId: org,
        psid,
        customerName: customerName || "Customer",
        channel: channel || "Messenger",
      });
    pushMsg(c, "customer", text);
    if (aiReply) {
      pushMsg(c, "ai", aiReply);
      c.aiHandled = (c.aiHandled || 0) + 1;
    }
    c.lastCustomerAt = new Date();
    c.unread = (c.unread || 0) + 1;
    if (customerName) c.customerName = customerName;
    if (needsReview) c.status = "needs_review";
    else if (c.status === "closed") c.status = "open";
    await c.save();
    res.json({ success: true, id: String(c._id) });
  }),
);

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
const legalPage = (
  title,
  body,
) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · ${LEGAL.name}</title>
<style>body{font-family:Inter,system-ui,sans-serif;max-width:820px;margin:40px auto;padding:0 20px;color:#14211a;line-height:1.65}h1{font-size:30px;margin-bottom:4px}h2{font-size:19px;margin-top:30px}.muted{color:#5f6b63}a{color:#0b7a2b}code{background:#eef1ea;padding:2px 6px;border-radius:6px}footer{margin-top:50px;border-top:1px solid #e3e7df;padding-top:16px;font-size:13px}</style></head>
<body><h1>${title}</h1><p class="muted">${LEGAL.name} · Last updated ${LEGAL.updated}</p>${body}
<footer class="muted"><a href="/privacy">Privacy Policy</a> · <a href="/terms">Terms of Service</a> · <a href="/data-deletion">Data Deletion</a> · Contact: <a href="mailto:${LEGAL.email}">${LEGAL.email}</a></footer></body></html>`;

app.get("/privacy", (_req, res) =>
  res.send(
    legalPage(
      "Privacy Policy",
      `
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
<p>We may update this policy and will change the date above. Questions: <a href="mailto:${LEGAL.email}">${LEGAL.email}</a> · ${LEGAL.address}</p>`,
    ),
  ),
);

app.get("/terms", (_req, res) =>
  res.send(
    legalPage(
      "Terms of Service",
      `
<h2>1. The service</h2><p>${LEGAL.name} provides tools to plan, create and publish social media content, manage Meta ads, handle customer messages with AI assistance, and manage leads and orders.</p>
<h2>2. Your account</h2><p>You must have the right to connect each Page, Instagram account and ad account you connect, and you are responsible for activity in your workspace.</p>
<h2>3. Acceptable use</h2><p>You must follow Meta's Platform Terms, Community Standards, Advertising Policies and Messenger Platform policies, and applicable law. Do not use the service for spam, misleading claims, or to collect data you are not allowed to collect.</p>
<h2>4. AI features</h2><p>AI-generated content and replies can be wrong. You are responsible for reviewing approvals, prices, offers and orders. Live ad changes require approval unless you enable bounded automation.</p>
<h2>5. Payments</h2><p>Paid plans are billed as shown in the app. Ad spend is charged by Meta directly to your ad account, not by us.</p>
<h2>6. Liability</h2><p>The service is provided "as is". To the extent the law allows, we are not liable for indirect losses, lost profits or losses caused by third-party platforms.</p>
<h2>7. Termination</h2><p>You can stop using the service at any time. We may suspend accounts that break these terms.</p>
<h2>8. Contact</h2><p><a href="mailto:${LEGAL.email}">${LEGAL.email}</a> · ${LEGAL.address}</p>`,
    ),
  ),
);

app.get("/data-deletion", async (req, res) => {
  let status = "";
  if (req.query.code) {
    const ev = await WebhookEvent.findOne({
      externalEventId: `deletion:${String(req.query.code).slice(0, 40)}`,
    })
      .lean()
      .catch(() => null);
    status = ev
      ? `<p style="background:#e9f8df;padding:12px;border-radius:10px">Request <code>${esc0(req.query.code)}</code> received on ${new Date(ev.receivedAt).toDateString()}. Status: <b>${ev.processingStatus}</b>.</p>`
      : `<p style="background:#fff4e5;padding:12px;border-radius:10px">No request found with code <code>${esc0(req.query.code)}</code>.</p>`;
  }
  res.send(
    legalPage(
      "Data Deletion Instructions",
      `${status}
<h2>Business users (Facebook Login)</h2><ol>
<li>In the app, open <b>Meta Accounts</b> and press <b>Disconnect</b> on each account. Its encrypted token is deleted immediately.</li>
<li>Remove the app from Facebook: <b>Settings &amp; privacy → Settings → Business integrations</b> (or Apps and websites) → select ${LEGAL.name} → <b>Remove</b>. We receive a deletion request automatically and delete your remaining data within 30 days.</li>
<li>Or email <a href="mailto:${LEGAL.email}">${LEGAL.email}</a> with the subject "Delete my data".</li></ol>
<h2>Customers who messaged a business</h2>
<p>Email <a href="mailto:${LEGAL.email}">${LEGAL.email}</a> with the name of the business and the Facebook/Instagram name you used. We will delete your conversation, lead and personal order details (except records the business must keep by law) within 30 days.</p>`,
    ),
  );
});
const esc0 = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

// Meta "Data deletion request callback" (App settings > Basic). Receives a signed_request.
function parseSignedRequest(sr) {
  if (!sr || !FB_APP_SECRET) return null;
  const [sig, payload] = String(sr).split(".");
  const b64 = (s) =>
    Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const expected = crypto
    .createHmac("sha256", FB_APP_SECRET)
    .update(payload)
    .digest();
  const got = b64(sig);
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected))
    return null;
  return JSON.parse(b64(payload).toString("utf8"));
}
app.post(
  "/api/meta/data-deletion",
  express.urlencoded({ extended: false }),
  async (req, res) => {
    const data = parseSignedRequest(req.body?.signed_request);
    if (!data) return res.status(400).json({ error: "Invalid signed_request" });
    const code = crypto.randomBytes(8).toString("hex");
    await WebhookEvent.create({
      provider: "meta_data_deletion",
      externalEventId: `deletion:${code}`,
      tenantId: "all",
      processingStatus: "pending",
    }).catch(() => {});
    // Business users are linked by Page/ad tokens, not by Facebook user id: flag it for the team to process
    const orgs = await SocialAccount.distinct("organizationId", {
      connectedVia: "oauth",
    }).catch(() => []);
    for (const o of orgs)
      await notify(
        o,
        "token",
        "Meta data deletion request",
        `A user removed the app (app-scoped id ${data.user_id}). Confirmation code ${code}. Delete their data within 30 days.`,
        "pages",
      );
    res.json({
      url: `${PUBLIC_BASE_URL || ""}/data-deletion?code=${code}`,
      confirmation_code: code,
    });
  },
);
// Meta "Deauthorize callback": a user removed the app
app.post(
  "/api/meta/deauthorize",
  express.urlencoded({ extended: false }),
  async (req, res) => {
    const data = parseSignedRequest(req.body?.signed_request);
    if (!data) return res.sendStatus(400);
    console.log("Meta deauthorize for app-scoped user", data.user_id);
    res.sendStatus(200);
  },
);

/* =====================================================
   COMMERCE ENGINE R1 (SRS v2 §10, §11, A.7, A.8)
   Places & delivery zones · variant stock · order state machine · fraud shield
   All money and stock maths is rule-based. The AI never computes prices or places orders.
   ===================================================== */

/* ---------- Bangladesh places: 64 districts + Dhaka areas (FR-ORD-007) ---------- */
const DISTRICTS = [
  ["Dhaka", "ঢাকা", "dacca"],
  ["Faridpur", "ফরিদপুর"],
  ["Gazipur", "গাজীপুর", "gajipur"],
  ["Gopalganj", "গোপালগঞ্জ"],
  ["Kishoreganj", "কিশোরগঞ্জ", "kishorganj"],
  ["Madaripur", "মাদারীপুর"],
  ["Manikganj", "মানিকগঞ্জ"],
  ["Munshiganj", "মুন্সিগঞ্জ", "munsiganj"],
  ["Narayanganj", "নারায়ণগঞ্জ", "narayangonj", "narayangang"],
  ["Narsingdi", "নরসিংদী", "narsingdi", "norsingdi"],
  ["Rajbari", "রাজবাড়ী"],
  ["Shariatpur", "শরীয়তপুর"],
  ["Tangail", "টাঙ্গাইল"],
  ["Bandarban", "বান্দরবান"],
  ["Brahmanbaria", "ব্রাহ্মণবাড়িয়া", "b.baria", "bbaria"],
  ["Chandpur", "চাঁদপুর"],
  ["Chattogram", "চট্টগ্রাম", "chittagong", "ctg", "chattagram"],
  ["Cox's Bazar", "কক্সবাজার", "coxs bazar", "coxsbazar", "cox bazar"],
  ["Cumilla", "কুমিল্লা", "comilla"],
  ["Feni", "ফেনী"],
  ["Khagrachhari", "খাগড়াছড়ি", "khagrachari"],
  ["Lakshmipur", "লক্ষ্মীপুর", "laxmipur"],
  ["Noakhali", "নোয়াখালী"],
  ["Rangamati", "রাঙ্গামাটি"],
  ["Bogura", "বগুড়া", "bogra"],
  ["Joypurhat", "জয়পুরহাট", "jaipurhat"],
  ["Naogaon", "নওগাঁ"],
  ["Natore", "নাটোর"],
  ["Chapainawabganj", "চাঁপাইনবাবগঞ্জ", "chapai nawabganj", "chapai"],
  ["Pabna", "পাবনা"],
  ["Rajshahi", "রাজশাহী"],
  ["Sirajganj", "সিরাজগঞ্জ"],
  ["Bagerhat", "বাগেরহাট"],
  ["Chuadanga", "চুয়াডাঙ্গা"],
  ["Jashore", "যশোর", "jessore"],
  ["Jhenaidah", "ঝিনাইদহ", "jhenaidaha"],
  ["Khulna", "খুলনা"],
  ["Kushtia", "কুষ্টিয়া"],
  ["Magura", "মাগুরা"],
  ["Meherpur", "মেহেরপুর"],
  ["Narail", "নড়াইল"],
  ["Satkhira", "সাতক্ষীরা"],
  ["Barguna", "বরগুনা"],
  ["Barishal", "বরিশাল", "barisal"],
  ["Bhola", "ভোলা"],
  ["Jhalokati", "ঝালকাঠি", "jhalakathi", "jhalokathi"],
  ["Patuakhali", "পটুয়াখালী"],
  ["Pirojpur", "পিরোজপুর"],
  ["Habiganj", "হবিগঞ্জ"],
  ["Moulvibazar", "মৌলভীবাজার", "maulvibazar", "moulvi bazar"],
  ["Sunamganj", "সুনামগঞ্জ"],
  ["Sylhet", "সিলেট"],
  ["Dinajpur", "দিনাজপুর"],
  ["Gaibandha", "গাইবান্ধা"],
  ["Kurigram", "কুড়িগ্রাম"],
  ["Lalmonirhat", "লালমনিরহাট"],
  ["Nilphamari", "নীলফামারী"],
  ["Panchagarh", "পঞ্চগড়"],
  ["Rangpur", "রংপুর"],
  ["Thakurgaon", "ঠাকুরগাঁও"],
  ["Jamalpur", "জামালপুর"],
  ["Mymensingh", "ময়মনসিংহ", "mymensing"],
  ["Netrokona", "নেত্রকোনা", "netrakona"],
  ["Sherpur", "শেরপুর"],
];
const DISTRICT_NAMES = DISTRICTS.map((d) => d[0]);
const DHAKA_CITY_AREAS = [
  "dhanmondi",
  "gulshan",
  "banani",
  "mirpur",
  "uttara",
  "mohammadpur",
  "badda",
  "rampura",
  "motijheel",
  "khilgaon",
  "bashundhara",
  "baridhara",
  "tejgaon",
  "farmgate",
  "mohakhali",
  "malibagh",
  "moghbazar",
  "magbazar",
  "shantinagar",
  "lalbagh",
  "old dhaka",
  "puran dhaka",
  "jatrabari",
  "demra",
  "shyamoli",
  "kallyanpur",
  "adabor",
  "cantonment",
  "khilkhet",
  "nikunja",
  "kuril",
  "wari",
  "sutrapur",
  "kotwali",
  "chawkbazar",
  "hazaribagh",
  "kamrangirchar",
  "shahbag",
  "ramna",
  "paltan",
  "segunbagicha",
  "azimpur",
  "new market",
  "kalabagan",
  "panthapath",
  "kawran bazar",
  "karwan bazar",
  "banasree",
  "aftabnagar",
  "mugda",
  "basabo",
  "sabujbagh",
  "shyampur",
  "kadamtali",
  "turag",
  "dakshinkhan",
  "uttarkhan",
  "pallabi",
  "kafrul",
  "agargaon",
  "sher-e-bangla nagar",
  "bangshal",
  "gendaria",
  "lalmatia",
  "jigatola",
  "elephant road",
  "bailey road",
  "kakrail",
  "dhaka cantonment",
  "ধানমন্ডি",
  "গুলশান",
  "বনানী",
  "মিরপুর",
  "উত্তরা",
  "মোহাম্মদপুর",
  "বাড্ডা",
  "রামপুরা",
  "মতিঝিল",
  "খিলগাঁও",
  "বসুন্ধরা",
  "যাত্রাবাড়ী",
  "মালিবাগ",
  "মগবাজার",
  "তেজগাঁও",
  "মহাখালী",
  "ফার্মগেট",
  "শ্যামলী",
  "লালবাগ",
  "আজিমপুর",
  "বাসাবো",
  "পল্লবী",
  "খিলক্ষেত",
];
const DHAKA_SUBURB_AREAS = [
  "savar",
  "ashulia",
  "keraniganj",
  "tongi",
  "dhamrai",
  "nawabganj dhaka",
  "dohar",
  "সাভার",
  "আশুলিয়া",
  "কেরানীগঞ্জ",
  "টঙ্গী",
  "ধামরাই",
];
const DEFAULT_ZONES = [
  {
    name: "Inside Dhaka",
    fee: 80,
    districts: ["Dhaka"],
    areas: DHAKA_CITY_AREAS,
    isDefault: false,
    freeOver: 0,
  },
  {
    name: "Dhaka suburbs",
    fee: 100,
    districts: ["Gazipur", "Narayanganj"],
    areas: DHAKA_SUBURB_AREAS,
    isDefault: false,
    freeOver: 0,
  },
  {
    name: "Outside Dhaka",
    fee: 130,
    districts: [],
    areas: [],
    isDefault: true,
    freeOver: 0,
  },
];
const normText = (s) =>
  ` ${String(s || "")
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()} `;
const hasTerm = (text, term) => text.includes(normText(term));
// Normalised address used to match repeat customers / fraud rings
const addressKey = (a) =>
  normText(a)
    .replace(
      /\b(house|home|road|rd|flat|floor|lane|block|sector|holding|no|বাসা|রোড|ফ্ল্যাট)\b/g,
      " ",
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140) || null;
const AREA_DISTRICT = { tongi: "Gazipur", টঙ্গী: "Gazipur" };
function districtOf(text) {
  const t = normText(text);
  const area = [...DHAKA_CITY_AREAS, ...DHAKA_SUBURB_AREAS]
    .sort((a, b) => b.length - a.length)
    .find((a) => hasTerm(t, a));
  // Longer names first so "chapai nawabganj" wins over "nawabganj"
  const all = DISTRICTS.flatMap((d) => d.map((alias) => [d[0], alias])).sort(
    (a, b) => b[1].length - a[1].length,
  );
  const hit = all.find(([, alias]) => hasTerm(t, alias));
  if (hit) return hit[0];
  return area ? AREA_DISTRICT[area] || "Dhaka" : null; // known Dhaka-area names imply the district
}
const canonicalDistrict = (d) =>
  d
    ? DISTRICTS.find((x) =>
        x.some((a) => a.toLowerCase() === String(d).trim().toLowerCase()),
      )?.[0] || null
    : null;
async function orgZones(org) {
  const o = await Organization.findById(org).select("zones").lean();
  return o?.zones?.length ? o.zones : DEFAULT_ZONES;
}
// Address/district -> delivery zone (rule-based, explainable)
function zoneFor(zones, { address, district }) {
  const t = normText(`${address || ""} ${district || ""}`);
  const explicit = canonicalDistrict(district);
  const detected = explicit || districtOf(address);
  const byArea = zones.find((z) => (z.areas || []).some((a) => hasTerm(t, a)));
  const byDistrict = detected
    ? zones.find((z) =>
        (z.districts || []).some(
          (d) => d.toLowerCase() === detected.toLowerCase(),
        ),
      )
    : null;
  const fallback = zones.find((z) => z.isDefault) || zones[zones.length - 1];
  let zone, matchedBy;
  if (explicit && explicit !== "Dhaka" && byDistrict) {
    zone = byDistrict;
    matchedBy = "district";
  } // "Mirpur, Kushtia" -> Kushtia
  else if (
    byArea &&
    (!detected ||
      detected === "Dhaka" ||
      (byArea.districts || []).includes(detected))
  ) {
    zone = byArea;
    matchedBy = "area";
  } else if (byDistrict) {
    zone = byDistrict;
    matchedBy = "district";
  } else if (detected) {
    zone = fallback;
    matchedBy = "district";
  } else {
    zone = fallback;
    matchedBy = "default";
  }
  return {
    zone: zone.name,
    fee: Number(zone.fee) || 0,
    freeOver: Number(zone.freeOver) || 0,
    district: detected || null,
    matchedBy,
    sure: matchedBy !== "default",
  };
}

/* ---------- variant stock (FR-INV, A.7.2/A.7.3) ---------- */
const variantLabel = (p, v) =>
  `${p.name}${v && v.name && v.name !== "Default" ? " · " + v.name : ""}`;
const priceOf = (p, v) =>
  v && v.price != null && v.price !== ""
    ? Number(v.price)
    : Number(p.price) || 0;
const sumVar = (p, f) =>
  (p.variants || []).reduce((s, v) => s + (Number(v[f]) || 0), 0);
async function movement(org, p, v, d) {
  return StockMovement.create({
    organizationId: org,
    productId: p._id || p.id,
    variantId: v?._id || null,
    label: variantLabel(p, v),
    ...d,
  }).catch((e) => console.warn("movement:", e.message));
}
// Atomic: only succeeds while available >= qty (two customers, last item -> one wins)
async function reserveStock(org, line, orderId, by) {
  const r = await Product.findOneAndUpdate(
    {
      _id: line.productId,
      organizationId: org,
      variants: {
        $elemMatch: { _id: line.variantId, available: { $gte: line.qty } },
      },
    },
    {
      $inc: {
        "variants.$.reserved": line.qty,
        "variants.$.available": -line.qty,
        stock: -line.qty,
      },
    },
    { new: true },
  ).lean();
  if (!r) return false;
  await movement(
    org,
    r,
    r.variants.find((v) => v._id === line.variantId),
    { reservedDelta: line.qty, reason: "order_reserve", orderId, by },
  );
  return true;
}
async function releaseStock(org, line, orderId, by) {
  if (!line.variantId)
    return restockStock(org, line, orderId, by, "order_release"); // legacy order: stock was taken directly
  const r = await Product.findOneAndUpdate(
    {
      _id: line.productId,
      organizationId: org,
      "variants._id": line.variantId,
    },
    {
      $inc: {
        "variants.$.reserved": -line.qty,
        "variants.$.available": line.qty,
        stock: line.qty,
      },
    },
    { new: true },
  ).lean();
  if (r)
    await movement(
      org,
      r,
      r.variants.find((v) => v._id === line.variantId),
      { reservedDelta: -line.qty, reason: "order_release", orderId, by },
    );
}
async function shipStock(org, line, orderId, by) {
  if (!line.variantId) return; // legacy order: already deducted
  const r = await Product.findOneAndUpdate(
    {
      _id: line.productId,
      organizationId: org,
      "variants._id": line.variantId,
    },
    {
      $inc: {
        "variants.$.reserved": -line.qty,
        "variants.$.onHand": -line.qty,
      },
    },
    { new: true },
  ).lean();
  if (r)
    await movement(
      org,
      r,
      r.variants.find((v) => v._id === line.variantId),
      {
        reservedDelta: -line.qty,
        onHandDelta: -line.qty,
        reason: "order_ship",
        orderId,
        by,
      },
    );
}
async function restockStock(org, line, orderId, by, reason = "return") {
  if (!line.productId || !line.qty) return;
  const p = await Product.findOne({
    _id: line.productId,
    organizationId: org,
  }).lean();
  if (!p) return;
  const v =
    (p.variants || []).find((x) => x._id === line.variantId) || p.variants?.[0];
  if (!v) return;
  const r = await Product.findOneAndUpdate(
    { _id: p._id, organizationId: org, "variants._id": v._id },
    {
      $inc: {
        "variants.$.onHand": line.qty,
        "variants.$.available": line.qty,
        stock: line.qty,
      },
    },
    { new: true },
  ).lean();
  if (r)
    await movement(org, r, v, { onHandDelta: line.qty, reason, orderId, by });
}
// Products saved before variants existed get one "Default" variant holding their stock
async function migrateProducts() {
  const old = await Product.find({
    $or: [{ variants: { $exists: false } }, { variants: { $size: 0 } }],
  }).lean();
  for (const p of old) {
    const n = Math.max(0, Number(p.stock) || 0);
    const v = {
      _id: crypto.randomBytes(8).toString("hex"),
      sku: p.sku,
      name: "Default",
      size: "",
      color: "",
      price: null,
      onHand: n,
      reserved: 0,
      available: n,
    };
    await Product.updateOne(
      {
        _id: p._id,
        $or: [{ variants: { $exists: false } }, { variants: { $size: 0 } }],
      },
      { $set: { variants: [v], stock: n, status: p.status || "active" } },
    );
    await movement(p.organizationId, p, v, {
      onHandDelta: n,
      reason: "initial",
      note: "Migrated to variants",
    });
  }
  if (old.length)
    console.log(`📦 Migrated ${old.length} product(s) to variant stock`);
}
// Map a requested line to a product + variant. Throws a readable error when it can't.
function resolveLine(products, it) {
  const p =
    products.find((x) => String(x._id) === String(it.productId)) ||
    (it.name &&
      products.find(
        (x) => x.name.toLowerCase() === String(it.name).toLowerCase(),
      ));
  if (!p) throw fail(400, `Product not found: ${it.name || it.productId}`);
  if (p.status === "archived") throw fail(400, `${p.name} is archived`);
  const vs = p.variants || [];
  let v = it.variantId ? vs.find((x) => x._id === String(it.variantId)) : null;
  if (!v && vs.length === 1) v = vs[0];
  if (!v && it.variant) {
    const want = normText(it.variant);
    v =
      vs.find((x) => normText(x.name) === want) ||
      vs.find(
        (x) =>
          want.trim() &&
          [x.size, x.color]
            .filter(Boolean)
            .every((a) => want.includes(normText(a).trim())),
      );
  }
  if (!v)
    throw fail(
      400,
      `Pick a variant for ${p.name}: ${vs.map((x) => x.name).join(", ")}`,
    );
  const qty = Math.max(1, Math.min(999, parseInt(it.qty, 10) || 1));
  return {
    productId: String(p._id),
    variantId: v._id,
    variantName: v.name === "Default" ? null : v.name,
    sku: v.sku || p.sku,
    name: p.name,
    qty,
    price: priceOf(p, v),
  };
}

/* ---------- order state machine (SRS 10.2 / A.7.1) ---------- */
const TRANSITIONS = {
  pending: ["confirmed", "on_hold", "cancelled"],
  on_hold: ["confirmed", "rejected"],
  confirmed: ["processing", "cancelled"],
  processing: ["packed", "cancelled"],
  packed: ["shipped"],
  shipped: ["out_for_delivery", "returned_to_sender"],
  out_for_delivery: ["delivered", "failed_delivery"],
  failed_delivery: ["out_for_delivery", "returned_to_sender"],
  delivered: ["return_requested"],
  return_requested: [
    "returned_restocked",
    "returned_damaged",
    "return_rejected",
  ],
  cancelled: [],
  rejected: [],
  returned_to_sender: [],
  returned_restocked: [],
  returned_damaged: [],
  return_rejected: [],
};
const STATUS_LABEL = {
  pending: "Pending",
  confirmed: "Confirmed",
  on_hold: "On hold",
  processing: "Processing",
  packed: "Packed",
  shipped: "Shipped",
  out_for_delivery: "Out for delivery",
  failed_delivery: "Failed delivery",
  delivered: "Delivered",
  return_requested: "Return requested",
  returned_to_sender: "Returned to sender",
  returned_restocked: "Returned (restocked)",
  returned_damaged: "Returned (damaged)",
  return_rejected: "Return rejected",
  cancelled: "Cancelled",
  rejected: "Rejected",
};
const RESERVED_STATES = [
  "pending",
  "on_hold",
  "confirmed",
  "processing",
  "packed",
];
const RETURNED_STATES = [
  "returned_to_sender",
  "returned_restocked",
  "returned_damaged",
  "failed_delivery",
];
const DEAD_STATES = ["cancelled", "rejected"];
const canMove = (from, to) => (TRANSITIONS[from] || []).includes(to);
// Shortest legal path, used by courier sync (shipped -> out_for_delivery -> delivered)
function pathTo(from, to) {
  const seen = new Set([from]);
  const q = [[from]];
  while (q.length) {
    const p = q.shift();
    const last = p[p.length - 1];
    if (last === to) return p.slice(1);
    for (const n of TRANSITIONS[last] || [])
      if (!seen.has(n) && !DEAD_STATES.includes(n)) {
        seen.add(n);
        q.push([...p, n]);
      }
  }
  return null;
}

const STATUS_MSG = {
  confirmed: (o) =>
    `✅ আপনার অর্ডার #${o.orderNo} কনফার্ম হয়েছে। মোট ${tk(o.total)}। ধন্যবাদ 🙏`,
  shipped: (o) =>
    `🚚 আপনার অর্ডার #${o.orderNo} কুরিয়ারে পাঠানো হয়েছে${o.courier?.trackingId ? ` (ট্র্যাকিং: ${o.courier.trackingId})` : ""}।`,
  delivered: (o) =>
    `📦 আপনার অর্ডার #${o.orderNo} ডেলিভারি হয়েছে। আমাদের সাথে কেনাকাটার জন্য ধন্যবাদ!`,
  cancelled: (o) =>
    `আপনার অর্ডার #${o.orderNo} বাতিল করা হয়েছে। কোনো প্রশ্ন থাকলে জানাবেন।`,
};
// Rule-based customer notification (FR-ORD-013): only inside the Messenger window
async function notifyCustomer(org, order, to) {
  if (!STATUS_MSG[to] || !order.conversationId) return;
  try {
    const c = await Conversation.findOne({
      _id: order.conversationId,
      organizationId: org,
    });
    if (!c || !windowOpen(c)) return;
    const text = STATUS_MSG[to](order);
    await sendToCustomer(org, c, text);
    pushMsg(c, "system", `Customer notified: ${STATUS_LABEL[to]}`);
    await c.save();
  } catch (e) {
    console.warn("notify customer:", e.message);
  }
}

async function transition(
  org,
  orderId,
  to,
  { by = "system", note = "", restockLines = null, ctx = null } = {},
) {
  if (!TRANSITIONS[to]) throw fail(400, `Unknown status: ${to}`);
  const cur = await Order.findOne({ _id: orderId, organizationId: org }).lean();
  if (!cur) throw fail(404, "Order not found");
  const from = cur.status in TRANSITIONS ? cur.status : "pending";
  if (!canMove(from, to))
    throw fail(
      409,
      `Cannot move order from ${STATUS_LABEL[from] || from} to ${STATUS_LABEL[to] || to}`,
    );
  const set = { status: to };
  if (to === "delivered" && cur.paymentMethod === "COD")
    set.paymentStatus = "paid";
  if (to === "shipped" && !cur.courier?.shippedAt)
    set["courier.shippedAt"] = new Date();
  // Status changes only if nobody changed it in the meantime
  const order = await Order.findOneAndUpdate(
    { _id: orderId, organizationId: org, status: cur.status },
    {
      $set: set,
      $push: {
        events: {
          from,
          to,
          by,
          note: String(note || "").slice(0, 300),
          at: new Date(),
        },
      },
    },
    { new: true },
  );
  if (!order)
    throw fail(
      409,
      "The order was changed by someone else. Refresh and try again.",
    );
  const lines = order.items || [];
  if (DEAD_STATES.includes(to) && RESERVED_STATES.includes(from))
    for (const l of lines) await releaseStock(org, l, order.id, by);
  if (to === "shipped")
    for (const l of lines) await shipStock(org, l, order.id, by);
  if (to === "returned_to_sender")
    for (const l of lines) await restockStock(org, l, order.id, by, "return");
  if (to === "returned_restocked" || to === "returned_damaged") {
    const plan =
      restockLines ||
      lines.map((l, i) => ({
        index: i,
        qty: to === "returned_restocked" ? l.qty : 0,
      }));
    for (const r of plan) {
      const l = lines[r.index];
      if (!l) continue;
      const good = Math.max(0, Math.min(l.qty, Number(r.qty) || 0));
      if (good)
        await restockStock(
          org,
          { ...(l.toObject?.() || l), qty: good },
          order.id,
          by,
          "return",
        );
      if (l.qty - good > 0) {
        const p = await Product.findById(l.productId).lean();
        if (p)
          await movement(
            org,
            p,
            p.variants?.find((v) => v._id === l.variantId),
            {
              reason: "damage",
              orderId: order.id,
              by,
              note: `${l.qty - good} returned damaged`,
            },
          );
      }
    }
  }
  audit(
    ctx ? { ctx } : { ctx: { org, user: { name: by } } },
    "order.transition",
    order.orderNo,
    { from, to, note },
  );
  notifyCustomer(org, order, to);
  return order;
}

/* ---------- fraud shield (SRS §11, A.8) ---------- */
const FAKE_NAME_RE =
  /^(test|fake|asdf|qwerty|xxx+|abc|na|n\/a|none|unknown|customer|\W*)$/i;
async function fraudSettings(org) {
  const o = await Organization.findById(org).select("fraud").lean();
  return {
    enabled: true,
    refuseBlocked: true,
    threshold: 60,
    lookbackDays: 30,
    ...(o?.fraud || {}),
  };
}
async function isBlocked(org, { phone, psid, address }) {
  const vals = [phone, psid, addressKey(address)].filter(Boolean);
  return vals.length
    ? Blacklist.findOne({ organizationId: org, phone: { $in: vals } }).lean()
    : null;
}
async function scoreOrder(org, f) {
  const s = await fraudSettings(org);
  const signals = [];
  const add = (code, points, reason) => signals.push({ code, points, reason });
  const blocked = await isBlocked(org, f);
  if (blocked)
    add(
      "blocked",
      100,
      `Blocked ${blocked.type || "phone"}: ${blocked.reason || ""}`.trim(),
    );
  if (s.enabled) {
    const akey = addressKey(f.address);
    const six = new Date(Date.now() - 183 * DAY);
    const who = {
      $or: [{ phone: f.phone }, ...(akey ? [{ addressKey: akey }] : [])],
    };
    const base = {
      organizationId: org,
      ...(f.excludeId ? { _id: { $ne: f.excludeId } } : {}),
    };
    const [returns, delivered, phonesAtAddr, last24, prior, stats] =
      await Promise.all([
        Order.countDocuments({
          ...base,
          ...who,
          status: { $in: RETURNED_STATES },
          createdAt: { $gte: six },
        }),
        Order.countDocuments({ ...base, phone: f.phone, status: "delivered" }),
        akey
          ? Order.distinct("phone", {
              ...base,
              addressKey: akey,
              createdAt: { $gte: new Date(Date.now() - s.lookbackDays * DAY) },
            })
          : [],
        Order.countDocuments({
          ...base,
          phone: f.phone,
          createdAt: { $gte: new Date(Date.now() - DAY) },
        }),
        Order.countDocuments({ ...base, phone: f.phone }),
        Order.aggregate([
          {
            $match: {
              organizationId: org,
              status: { $nin: DEAD_STATES },
              createdAt: { $gte: new Date(Date.now() - 90 * DAY) },
            },
          },
          { $project: { total: 1, q: { $sum: "$items.qty" } } },
          {
            $group: {
              _id: null,
              avg: { $avg: "$total" },
              qs: { $push: "$q" },
              n: { $sum: 1 },
            },
          },
        ]),
      ]);
    if (returns)
      add(
        "returns",
        Math.min(50, returns * 25),
        `${returns} returned/failed deliveries in 6 months`,
      );
    const done = delivered + returns;
    if (done >= 3 && delivered / done < 0.6)
      add(
        "courier_ratio",
        30,
        `Delivery success ${Math.round((delivered / done) * 100)}% (below 60%)`,
      );
    const others = new Set(phonesAtAddr.filter((p) => p !== f.phone));
    if (others.size + 1 >= 3)
      add(
        "phones_per_address",
        20,
        `${others.size + 1} different phones used at this address`,
      );
    if (last24 + 1 >= 3)
      add("velocity", 15, `${last24 + 1} orders from this phone in 24 hours`);
    const st = stats[0];
    if (st && st.n >= 5) {
      const qs = st.qs.sort((a, b) => a - b);
      const median = qs[Math.floor(qs.length / 2)] || 1;
      if (f.qty > 3 * median)
        add(
          "big_qty",
          15,
          `Quantity ${f.qty} is more than 3× the usual ${median}`,
        );
      if (!prior && f.total > 5 * st.avg)
        add(
          "big_first_order",
          15,
          `First order of ${tk(f.total)} is more than 5× the average ${tk(st.avg)}`,
        );
    }
    if (
      FAKE_NAME_RE.test(String(f.name || "").trim()) ||
      !/^01[3-9]\d{8}$/.test(f.phone || "") ||
      /^01(\d)\1{8}$/.test(f.phone || "")
    )
      add("fake_identity", 20, "Name or phone looks fake / invalid");
    if (f.district) {
      const d = districtOf(f.address);
      if (d && d !== canonicalDistrict(f.district))
        add(
          "address_mismatch",
          10,
          `Address says ${d} but district is ${f.district}`,
        );
    }
    if (delivered)
      add(
        "good_history",
        -Math.min(30, delivered * 15),
        `${delivered} delivered order(s) before`,
      );
  }
  const score = Math.max(
    0,
    Math.min(
      100,
      signals.reduce((t, x) => t + x.points, 0),
    ),
  );
  const band =
    blocked || score >= s.threshold ? "high" : score >= 40 ? "medium" : "low";
  return { score, band, signals, blocked: !!blocked, settings: s };
}

/* ---------- create order (FR-ORD-001..006) ---------- */
async function createOrder(org, b, meta = {}) {
  const by = meta.by || b.createdByName || "system";
  const createdBy =
    meta.createdBy || b.createdBy || (b.isAI ? "ai_agent" : "user");
  if (b.idemKey) {
    const dup = await Order.findOne({
      organizationId: org,
      idemKey: b.idemKey,
    });
    if (dup) return dup;
  }
  const phone = normPhone(b.phone);
  if (!String(b.customerName || "").trim())
    throw fail(400, "Customer name is required");
  if (!/^01[3-9]\d{8}$/.test(phone || ""))
    throw fail(400, "Enter a valid Bangladesh phone number (01XXXXXXXXX)");
  if (String(b.address || "").trim().length < 6)
    throw fail(400, "Full delivery address is required");
  const raw = Array.isArray(b.items) ? b.items : [];
  if (!raw.length) throw fail(400, "Add at least one product");
  const products = await Product.find({
    organizationId: org,
    _id: { $in: raw.map((i) => i.productId).filter(Boolean) },
  }).lean();
  const items = raw.map((i) => resolveLine(products, i));
  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
  const z = zoneFor(await orgZones(org), {
    address: b.address,
    district: b.district,
  });
  const manual = createdBy === "user";
  let deliveryFee = z.freeOver && subtotal >= z.freeOver ? 0 : z.fee;
  if (
    manual &&
    b.deliveryFee !== undefined &&
    b.deliveryFee !== null &&
    b.deliveryFee !== ""
  )
    deliveryFee = Math.max(0, Number(b.deliveryFee) || 0);
  const discount = manual
    ? Math.max(0, Math.min(subtotal, Number(b.discount) || 0))
    : 0; // AI may never give discounts (G-19)
  const total = subtotal + deliveryFee - discount;
  const paymentMethod = ["COD", "bKash", "Nagad", "Rocket", "Card"].includes(
    b.paymentMethod,
  )
    ? b.paymentMethod
    : "COD";
  const qty = items.reduce((s, i) => s + i.qty, 0);
  const risk = await scoreOrder(org, {
    phone,
    psid: b.psid,
    address: b.address,
    district: b.district || z.district,
    name: b.customerName,
    total,
    qty,
  });
  if (risk.blocked && risk.settings.refuseBlocked)
    throw fail(
      403,
      "This customer is on the block list. The order was not created.",
    );
  const hold = risk.band === "high";
  const wanted = b.status === "confirmed" ? "confirmed" : "pending";
  const order = new Order({
    organizationId: org,
    orderNo: await nextOrderNo(org),
    customerName: String(b.customerName).trim().slice(0, 120),
    phone,
    address: String(b.address).trim().slice(0, 400),
    district: z.district,
    zone: z.zone,
    addressKey: addressKey(b.address),
    items,
    subtotal,
    deliveryFee,
    discount,
    total,
    paymentMethod,
    paymentStatus: ["paid", "partial"].includes(b.paymentStatus)
      ? b.paymentStatus
      : paymentMethod === "COD"
        ? "unpaid"
        : b.paymentStatus || "unpaid",
    paymentRef: b.paymentRef || null,
    notes: String(b.notes || "").slice(0, 1000),
    channel:
      b.channel || (createdBy === "ai_agent" ? "Messenger AI" : "Manual"),
    isAI: createdBy === "ai_agent",
    status: "pending",
    riskScore: risk.score,
    riskBand: risk.band,
    riskSignals: risk.signals,
    riskReasons: risk.signals.filter((s) => s.points > 0).map((s) => s.reason),
    createdBy,
    createdByName: by,
    idemKey: b.idemKey || null,
    sourceCommentId: b.sourceCommentId || null,
    conversationId: b.conversationId || null,
    psid: b.psid || null,
    ...(b.attribution ? { attribution: b.attribution } : {}),
    events: [
      {
        from: null,
        to: "pending",
        by,
        note: `Created (${createdBy})`,
        at: new Date(),
      },
    ],
  });
  const taken = [];
  for (const l of items) {
    if (!(await reserveStock(org, l, order.id, by))) {
      for (const t of taken) await releaseStock(org, t, order.id, by);
      const p = products.find((x) => String(x._id) === l.productId);
      const v = p?.variants?.find((x) => x._id === l.variantId);
      throw fail(
        409,
        `Not enough stock for ${variantLabel(p || { name: l.name }, v)} (available ${v?.available ?? 0})`,
      );
    }
    taken.push(l);
  }
  if (hold) {
    order.status = "on_hold";
    order.events.push({
      from: "pending",
      to: "on_hold",
      by: "Fraud Shield",
      note: `Risk ${risk.score}`,
      at: new Date(),
    });
  } else if (wanted === "confirmed") {
    order.status = "confirmed";
    order.events.push({
      from: "pending",
      to: "confirmed",
      by,
      note: "",
      at: new Date(),
    });
  }
  try {
    await order.save();
  } catch (e) {
    for (const t of taken) await releaseStock(org, t, order.id, by);
    throw e;
  }
  audit(
    meta.ctx ? { ctx: meta.ctx } : { ctx: { org, user: { name: by } } },
    "order.create",
    order.orderNo,
    { total, createdBy, risk: risk.score },
  );
  if (hold)
    notify(
      org,
      "fraud",
      `Order #${order.orderNo} on hold`,
      `Risk ${risk.score}: ${order.riskReasons.join(", ")}`,
      "fraud",
    );
  else if (order.status === "confirmed")
    notifyCustomer(org, order, "confirmed");
  return order;
}

/* ---------- order views (PII masked for roles without customers.pii) ---------- */
const PAY_LABEL = {
  unpaid: "unpaid",
  paid: "paid",
  partial: "partial advance",
};
const payLabel2 = (o) =>
  o.paymentMethod === "COD"
    ? o.paymentStatus === "paid"
      ? "COD collected"
      : "COD unpaid"
    : `${o.paymentMethod} (${PAY_LABEL[o.paymentStatus] || o.paymentStatus})`;
function orderView(o, pii = true) {
  return {
    id: String(o._id),
    no: o.orderNo,
    customer: o.customerName,
    phone: pii ? o.phone : maskPhone(o.phone),
    address: pii ? o.address : maskAddress(o.address),
    district: o.district,
    zone: o.zone,
    items: (o.items || []).map((i) => ({
      productId: i.productId,
      variantId: i.variantId,
      name: i.name,
      variant: i.variantName,
      sku: i.sku,
      qty: i.qty,
      price: i.price,
    })),
    subtotal:
      o.subtotal || (o.items || []).reduce((s, i) => s + i.price * i.qty, 0),
    deliveryFee: o.deliveryFee || 0,
    discount: o.discount || 0,
    total: o.total,
    paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus,
    payment: payLabel2(o),
    paymentRef: o.paymentRef,
    channel: o.channel,
    isAI: o.isAI,
    createdBy: o.createdBy,
    status: o.status,
    statusLabel: STATUS_LABEL[o.status] || o.status,
    next: TRANSITIONS[o.status] || [],
    risk: o.riskScore,
    riskBand:
      o.riskBand ||
      (o.riskScore >= 60 ? "high" : o.riskScore >= 40 ? "medium" : "low"),
    reasons: o.riskReasons || [],
    signals: o.riskSignals || [],
    courier: o.courier?.provider || null,
    tracking: o.courier?.trackingId || null,
    consignmentId: o.courier?.consignmentId || null,
    courierStatus: o.courier?.status || null,
    notes: o.notes,
    events: o.events || [],
    returnInfo: o.returnInfo,
    conversationId: o.conversationId,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}
const orderRow = (o, pii = true) => {
  const v = orderView(o, pii);
  delete v.events;
  delete v.signals;
  return v;
};

function orderQuery(org, q) {
  const f = { organizationId: org };
  if (q.status)
    f.status = q.status.includes(",") ? { $in: q.status.split(",") } : q.status;
  if (q.payment === "unpaid") f.paymentStatus = { $ne: "paid" };
  else if (q.payment) f.paymentStatus = q.payment;
  if (q.method) f.paymentMethod = q.method;
  if (q.risk) f.riskBand = q.risk;
  if (q.courier)
    f["courier.provider"] = q.courier === "none" ? null : q.courier;
  if (q.channel) f.channel = q.channel;
  if (q.createdBy) f.createdBy = q.createdBy;
  if (q.ai === "1") f.createdBy = "ai_agent";
  if (q.from || q.to) {
    f.createdAt = {};
    if (q.from) f.createdAt.$gte = dhakaStart(q.from);
    if (q.to) f.createdAt.$lt = new Date(dhakaStart(q.to).getTime() + DAY);
  }
  if (q.q) {
    const re = new RegExp(escRe(String(q.q).trim()), "i");
    f.$or = [
      { orderNo: re },
      { customerName: re },
      { phone: re },
      { address: re },
      { "courier.trackingId": re },
    ];
  }
  return f;
}

app.get(
  "/api/orders",
  wrap(async (req, res) => {
    const org = tid(req);
    const f = orderQuery(org, req.query);
    const limit = [25, 50, 100].includes(Number(req.query.limit))
      ? Number(req.query.limit)
      : 25;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const [rows, total, counts] = await Promise.all([
      Order.find(f)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Order.countDocuments(f),
      Order.aggregate([
        { $match: { organizationId: org } },
        { $group: { _id: "$status", n: { $sum: 1 } } },
      ]),
    ]);
    res.json({
      rows: rows.map((o) => orderRow(o, canSeePii(req))),
      total,
      page,
      limit,
      counts: Object.fromEntries(counts.map((c) => [c._id, c.n])),
      statuses: STATUS_LABEL,
    });
  }),
);

app.get(
  "/api/orders/export.csv",
  wrap(async (req, res) => {
    const rows = await Order.find(orderQuery(tid(req), req.query))
      .sort({ createdAt: -1 })
      .limit(10000)
      .lean();
    const pii = canSeePii(req);
    audit(req, "order.export", null, { rows: rows.length });
    sendCsvObjects(
      res,
      "orders.csv",
      rows.map((o) => ({
        order: o.orderNo,
        date: new Date(o.createdAt).toISOString(),
        customer: o.customerName,
        phone: pii ? o.phone : maskPhone(o.phone),
        address: pii ? o.address : maskAddress(o.address),
        district: o.district || "",
        zone: o.zone || "",
        items: (o.items || [])
          .map(
            (i) =>
              `${i.name}${i.variantName ? " (" + i.variantName + ")" : ""} x${i.qty}`,
          )
          .join("; "),
        subtotal: o.subtotal,
        delivery: o.deliveryFee,
        discount: o.discount,
        total: o.total,
        payment: payLabel2(o),
        status: STATUS_LABEL[o.status] || o.status,
        channel: o.channel,
        risk: o.riskScore,
        courier: o.courier?.provider || "",
        tracking: o.courier?.trackingId || "",
      })),
    );
  }),
);

// Price preview for the order form (same maths as createOrder)
app.post(
  "/api/orders/quote",
  wrap(async (req, res) => {
    const org = tid(req);
    const b = req.body;
    const raw = (b.items || []).filter((i) => i.productId);
    const products = await Product.find({
      organizationId: org,
      _id: { $in: raw.map((i) => i.productId) },
    }).lean();
    const items = [];
    const errors = [];
    for (const i of raw) {
      try {
        items.push(resolveLine(products, i));
      } catch (e) {
        errors.push(e.message);
      }
    }
    const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
    const z = zoneFor(await orgZones(org), {
      address: b.address,
      district: b.district,
    });
    let fee = z.freeOver && subtotal >= z.freeOver ? 0 : z.fee;
    if (
      b.deliveryFee !== undefined &&
      b.deliveryFee !== null &&
      b.deliveryFee !== ""
    )
      fee = Math.max(0, Number(b.deliveryFee) || 0);
    const discount = Math.max(0, Math.min(subtotal, Number(b.discount) || 0));
    const phone = normPhone(b.phone);
    const risk = phone
      ? await scoreOrder(org, {
          phone,
          address: b.address,
          district: b.district || z.district,
          name: b.customerName,
          total: subtotal + fee - discount,
          qty: items.reduce((s, i) => s + i.qty, 0),
        })
      : null;
    res.json({
      items,
      errors,
      subtotal,
      zone: z,
      deliveryFee: fee,
      discount,
      total: subtotal + fee - discount,
      risk: risk && {
        score: risk.score,
        band: risk.band,
        signals: risk.signals,
        blocked: risk.blocked,
      },
    });
  }),
);

app.get("/api/places", (_req, res) =>
  res.json({
    districts: DISTRICT_NAMES,
    dhakaAreas: DHAKA_CITY_AREAS.filter((a) => /^[a-z]/.test(a)),
  }),
);

app.get(
  "/api/orders/:id",
  wrap(async (req, res) => {
    const o = await Order.findOne({
      _id: req.params.id,
      organizationId: tid(req),
    }).lean();
    if (!o) throw fail(404, "Order not found");
    res.json(orderView(o, canSeePii(req)));
  }),
);

app.post(
  "/api/orders",
  wrap(async (req, res) => {
    const order = await createOrder(
      tid(req),
      { ...req.body, createdBy: req.ctx?.service ? "n8n" : "user" },
      {
        by: actor(req),
        createdBy: req.ctx?.service
          ? req.body.isAI
            ? "ai_agent"
            : "n8n"
          : "user",
        ctx: req.ctx,
      },
    );
    res.json({ success: true, order: orderView(order, canSeePii(req)) });
  }),
);

// Edit before Packed (FR-ORD-011). After Packed only notes and courier fields.
app.put(
  "/api/orders/:id",
  wrap(async (req, res) => {
    const org = tid(req);
    const by = actor(req);
    const o = await Order.findOne({ _id: req.params.id, organizationId: org });
    if (!o) throw fail(404, "Order not found");
    const b = req.body;
    const editable = ["pending", "on_hold", "confirmed", "processing"].includes(
      o.status,
    );
    if ("notes" in b) o.notes = String(b.notes || "").slice(0, 1000);
    if (b.tracking !== undefined) {
      o.courier = {
        ...(o.courier?.toObject?.() || o.courier || {}),
        trackingId: b.tracking || null,
      };
    }
    const touched = [
      "customerName",
      "phone",
      "address",
      "district",
      "items",
      "discount",
      "deliveryFee",
    ].filter((k) => k in b);
    if (touched.length && !editable)
      throw fail(
        409,
        `Order is ${STATUS_LABEL[o.status]}: only notes and courier fields can change now`,
      );
    if (touched.length) {
      if (b.customerName) o.customerName = String(b.customerName).trim();
      if (b.phone) {
        const p = normPhone(b.phone);
        if (!/^01[3-9]\d{8}$/.test(p || "")) throw fail(400, "Invalid phone");
        o.phone = p;
      }
      if (b.address) {
        o.address = String(b.address).trim();
        o.addressKey = addressKey(o.address);
      }
      if (Array.isArray(b.items)) {
        const products = await Product.find({
          organizationId: org,
          _id: { $in: b.items.map((i) => i.productId) },
        }).lean();
        const next = b.items.map((i) => resolveLine(products, i));
        for (const l of o.items) await releaseStock(org, l, o.id, by);
        const taken = [];
        for (const l of next) {
          if (!(await reserveStock(org, l, o.id, by))) {
            for (const t of taken) await releaseStock(org, t, o.id, by);
            for (const l2 of o.items)
              await reserveStock(org, l2, o.id, by).catch(() => {});
            throw fail(
              409,
              `Not enough stock for ${l.name}${l.variantName ? " · " + l.variantName : ""}`,
            );
          }
          taken.push(l);
        }
        o.items = next;
      }
      const z = zoneFor(await orgZones(org), {
        address: o.address,
        district: b.district || o.district,
      });
      o.district = z.district;
      o.zone = z.zone;
      o.subtotal = o.items.reduce((s, i) => s + i.price * i.qty, 0);
      if ("deliveryFee" in b && b.deliveryFee !== "" && b.deliveryFee !== null)
        o.deliveryFee = Math.max(0, Number(b.deliveryFee) || 0);
      else if ("address" in b || "district" in b || "items" in b)
        o.deliveryFee = z.freeOver && o.subtotal >= z.freeOver ? 0 : z.fee;
      if ("discount" in b)
        o.discount = Math.max(0, Math.min(o.subtotal, Number(b.discount) || 0));
      o.total = o.subtotal + o.deliveryFee - (o.discount || 0);
    }
    o.events.push({
      from: o.status,
      to: o.status,
      by,
      note: `Edited: ${[...touched, ...("notes" in b ? ["notes"] : [])].join(", ") || "courier"}`,
      at: new Date(),
    });
    await o.save();
    audit(req, "order.edit", o.orderNo, { fields: touched });
    res.json({ success: true, order: orderView(o, canSeePii(req)) });
  }),
);

app.put(
  "/api/orders/:id/payment",
  wrap(async (req, res) => {
    const p = pick(req.body, ["paymentMethod", "paymentStatus", "paymentRef"]);
    if (
      p.paymentMethod &&
      !["COD", "bKash", "Nagad", "Rocket", "Card"].includes(p.paymentMethod)
    )
      throw fail(400, "Unknown payment method");
    if (
      p.paymentStatus &&
      !["unpaid", "paid", "partial"].includes(p.paymentStatus)
    )
      throw fail(400, "Unknown payment status");
    const o = await Order.findOneAndUpdate(
      { _id: req.params.id, organizationId: tid(req) },
      {
        $set: p,
        $push: {
          events: {
            from: null,
            to: null,
            by: actor(req),
            note: `Payment: ${Object.values(p).join(" · ")}`,
            at: new Date(),
          },
        },
      },
      { new: true },
    );
    if (!o) throw fail(404, "Order not found");
    audit(req, "order.payment", o.orderNo, p);
    res.json({ success: true, order: orderView(o, canSeePii(req)) });
  }),
);

app.post(
  "/api/orders/:id/transition",
  wrap(async (req, res) => {
    const o = await transition(tid(req), req.params.id, req.body.to, {
      by: actor(req),
      note: req.body.note,
      ctx: req.ctx,
    });
    res.json({ success: true, order: orderView(o, canSeePii(req)) });
  }),
);
// Old dashboard / n8n compatibility: PUT status through the state machine
app.put(
  "/api/orders/:id/status",
  wrap(async (req, res) => {
    const o = await transition(tid(req), req.params.id, req.body.status, {
      by: actor(req),
      note: req.body.note,
      ctx: req.ctx,
    });
    res.json({ success: true, order: orderView(o, canSeePii(req)) });
  }),
);

// Bulk actions (FR-ORD-009)
app.post(
  "/api/orders/bulk",
  wrap(async (req, res) => {
    const org = tid(req);
    const ids = (req.body.ids || []).slice(0, 200);
    const results = [];
    for (const id of ids) {
      try {
        await transition(org, id, req.body.to, {
          by: actor(req),
          note: "Bulk action",
          ctx: req.ctx,
        });
        results.push({ id, ok: true });
      } catch (e) {
        results.push({ id, ok: false, error: e.message });
      }
    }
    res.json({
      success: true,
      done: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok),
    });
  }),
);

// Returns (FR-ORD-012): shipped / out for delivery / failed -> returned to sender; delivered -> return requested
app.post(
  "/api/orders/:id/return",
  wrap(async (req, res) => {
    const org = tid(req);
    const o = await Order.findOne({ _id: req.params.id, organizationId: org });
    if (!o) throw fail(404, "Order not found");
    if (
      ![
        "shipped",
        "out_for_delivery",
        "failed_delivery",
        "delivered",
        "returned_to_sender",
      ].includes(o.status)
    )
      throw fail(
        409,
        "Returns are only possible for Shipped, Out for delivery, Delivered or Returned-to-sender orders",
      );
    const reason = String(req.body.reason || "").trim();
    if (!reason) throw fail(400, "Write the return reason");
    o.returnInfo = {
      reason,
      items:
        req.body.items || o.items.map((l, i) => ({ index: i, qty: l.qty })),
      requestedAt: new Date(),
      by: actor(req),
    };
    o.markModified("returnInfo");
    await o.save();
    const to =
      o.status === "delivered"
        ? "return_requested"
        : o.status === "returned_to_sender"
          ? null
          : "returned_to_sender";
    const out = to
      ? await transition(org, o.id, to, {
          by: actor(req),
          note: reason,
          ctx: req.ctx,
        })
      : o;
    res.json({ success: true, order: orderView(out, canSeePii(req)) });
  }),
);
app.post(
  "/api/orders/:id/return/resolve",
  wrap(async (req, res) => {
    const { resolution, items, note } = req.body; // resolution: restocked | damaged | rejected
    const to = {
      restocked: "returned_restocked",
      damaged: "returned_damaged",
      rejected: "return_rejected",
    }[resolution];
    if (!to) throw fail(400, "Pick restocked, damaged or rejected");
    const o = await transition(tid(req), req.params.id, to, {
      by: actor(req),
      note,
      restockLines: Array.isArray(items) ? items : null,
      ctx: req.ctx,
    });
    res.json({ success: true, order: orderView(o, canSeePii(req)) });
  }),
);

// Printable invoice (FR-ORD-010): opens in a new tab, use the browser's "Save as PDF"
app.get(
  "/api/orders/:id/invoice",
  wrap(async (req, res) => {
    const org = tid(req);
    const [o, ws] = await Promise.all([
      Order.findOne({ _id: req.params.id, organizationId: org }).lean(),
      Organization.findById(org).lean(),
    ]);
    if (!o) throw fail(404, "Order not found");
    const e = (s) =>
      String(s ?? "").replace(
        /[&<>"]/g,
        (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
      );
    const cod =
      o.paymentMethod === "COD" && o.paymentStatus !== "paid" ? o.total : 0;
    const label = req.query.size === "label";
    res.type("html")
      .send(`<!doctype html><html><head><meta charset="utf-8"><title>${e(o.orderNo)}</title><style>
body{font-family:system-ui,'Noto Sans Bengali',sans-serif;margin:0;padding:${label ? "8px" : "32px"};color:#111}${label ? "@page{size:3in 4in;margin:4mm}body{font-size:11px}" : "@page{size:A4;margin:14mm}"}
h1{font-size:${label ? "15px" : "22px"};margin:0}table{width:100%;border-collapse:collapse;margin-top:12px}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left}th:last-child,td:last-child{text-align:right}
.row{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}.muted{color:#666}.big{font-size:${label ? "16px" : "20px"};font-weight:700}.code{font-family:monospace;letter-spacing:2px;border:1px dashed #333;padding:4px 8px;display:inline-block;margin-top:6px}
@media print{button{display:none}}</style></head><body>
<button onclick="print()" style="float:right;padding:8px 14px">Print / Save PDF</button>
<div class="row"><div>${ws?.logoUrl ? `<img src="${e(ws.logoUrl)}" style="height:40px">` : ""}<h1>${e(ws?.name || "Invoice")}</h1><div class="muted">${e(ws?.businessPhone || "")}</div></div>
<div style="text-align:right"><div class="big">${e(o.orderNo)}</div><div class="code">*${e(o.orderNo)}*</div><div class="muted">${new Date(o.createdAt).toLocaleDateString("en-GB", { timeZone: "Asia/Dhaka" })}</div></div></div>
<p><b>${e(o.customerName)}</b> · ${e(o.phone)}<br>${e(o.address)}${o.district ? `, ${e(o.district)}` : ""}</p>
${
  label
    ? ""
    : `<table><tr><th>Item</th><th>Qty</th><th>Price</th><th>Amount</th></tr>${(o.items || []).map((i) => `<tr><td>${e(i.name)}${i.variantName ? ` (${e(i.variantName)})` : ""}</td><td>${i.qty}</td><td>৳${i.price}</td><td>৳${i.price * i.qty}</td></tr>`).join("")}
<tr><td colspan=3>Subtotal</td><td>৳${o.subtotal || 0}</td></tr><tr><td colspan=3>Delivery (${e(o.zone || "")})</td><td>৳${o.deliveryFee || 0}</td></tr>${o.discount ? `<tr><td colspan=3>Discount</td><td>-৳${o.discount}</td></tr>` : ""}<tr><td colspan=3><b>Total</b></td><td><b>৳${o.total}</b></td></tr></table>`
}
<p class="big">COD: ৳${cod}</p>${o.courier?.trackingId ? `<p>${e(o.courier.provider || "")} · ${e(o.courier.trackingId)}</p>` : ""}${!label && ws?.returnPolicy ? `<p class="muted">${e(ws.returnPolicy)}</p>` : ""}
</body></html>`);
  }),
);

/* ---------- products & inventory (FR-INV-001..011) ---------- */
function productView(p) {
  const onHand = sumVar(p, "onHand"),
    reserved = sumVar(p, "reserved"),
    available = sumVar(p, "available");
  return {
    ...p,
    id: String(p._id),
    onHand,
    reserved,
    available,
    stock: available,
    low: available <= (p.lowStockAt ?? 5),
    out: available <= 0,
  };
}
function cleanVariant(v, p) {
  return {
    name: String(
      v.name || [v.size, v.color].filter(Boolean).join(" / ") || "Default",
    )
      .trim()
      .slice(0, 60),
    size: String(v.size || "").trim(),
    color: String(v.color || "").trim(),
    sku: String(v.sku || "").trim() || null,
    price:
      v.price === "" || v.price === null || v.price === undefined
        ? null
        : Math.max(0, Number(v.price) || 0),
  };
}
const PRODUCT_FIELDS = [
  "name",
  "nameBn",
  "sku",
  "price",
  "category",
  "description",
  "imageUrl",
  "comparePrice",
  "costPrice",
  "weight",
  "lowStockAt",
  "status",
];

app.get(
  "/api/products",
  wrap(async (req, res) => {
    const q = { organizationId: tid(req) };
    q.status =
      req.query.status === "all"
        ? { $exists: true }
        : req.query.status || { $ne: "archived" };
    if (req.query.q) {
      const re = new RegExp(escRe(req.query.q), "i");
      q.$or = [
        { name: re },
        { nameBn: re },
        { sku: re },
        { category: re },
        { "variants.sku": re },
      ];
    }
    let rows = (
      await Product.find(q).sort({ createdAt: -1 }).limit(1000).lean()
    ).map(productView);
    if (req.query.stock === "low") rows = rows.filter((p) => p.low && !p.out);
    if (req.query.stock === "out") rows = rows.filter((p) => p.out);
    res.json(rows);
  }),
);

app.get(
  "/api/inventory/summary",
  wrap(async (req, res) => {
    const rows = (
      await Product.find({
        organizationId: tid(req),
        status: { $ne: "archived" },
      }).lean()
    ).map(productView);
    res.json({
      products: rows.length,
      variants: rows.reduce((s, p) => s + (p.variants || []).length, 0),
      onHand: rows.reduce((s, p) => s + p.onHand, 0),
      reserved: rows.reduce((s, p) => s + p.reserved, 0),
      available: rows.reduce((s, p) => s + p.available, 0),
      low: rows.filter((p) => p.low && !p.out).length,
      out: rows.filter((p) => p.out).length,
      stockValue: rows.reduce(
        (s, p) => s + p.onHand * (Number(p.costPrice) || 0),
        0,
      ),
      retailValue: rows.reduce(
        (s, p) =>
          s +
          (p.variants || []).reduce((t, v) => t + v.onHand * priceOf(p, v), 0),
        0,
      ),
    });
  }),
);

app.post(
  "/api/products",
  wrap(async (req, res) => {
    const org = tid(req);
    const b = pick(req.body, PRODUCT_FIELDS);
    if (!String(b.name || "").trim())
      throw fail(400, "Product name is required");
    if (!(Number(b.price) >= 0) || b.price === "" || b.price === undefined)
      throw fail(400, "Price is required");
    b.sku =
      String(b.sku || "").trim() ||
      `SKU-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    const rawVariants =
      Array.isArray(req.body.variants) && req.body.variants.length
        ? req.body.variants
        : [{ name: "Default", onHand: req.body.stock }];
    const variants = rawVariants.map((v, i) => {
      const c = cleanVariant(v);
      const n = Math.max(0, parseInt(v.onHand ?? v.stock, 10) || 0);
      return {
        _id: crypto.randomBytes(8).toString("hex"),
        ...c,
        sku: c.sku || (rawVariants.length > 1 ? `${b.sku}-${i + 1}` : b.sku),
        onHand: n,
        reserved: 0,
        available: n,
      };
    });
    const p = await Product.create({
      ...b,
      organizationId: org,
      price: Number(b.price),
      variants,
      stock: variants.reduce((s, v) => s + v.available, 0),
    });
    for (const v of variants)
      if (v.onHand)
        await movement(org, p.toObject(), v, {
          onHandDelta: v.onHand,
          reason: "initial",
          by: actor(req),
        });
    audit(req, "product.create", p.name);
    res.json({ success: true, product: productView(p.toObject()) });
  }),
);

app.put(
  "/api/products/:id",
  wrap(async (req, res) => {
    const org = tid(req);
    const p = await Product.findOne({
      _id: req.params.id,
      organizationId: org,
    });
    if (!p) throw fail(404, "Product not found");
    const patch = pick(req.body, PRODUCT_FIELDS);
    if ("price" in patch) patch.price = Math.max(0, Number(patch.price) || 0);
    Object.assign(p, patch);
    const added = [];
    if (Array.isArray(req.body.variants)) {
      const keep = [];
      for (const v of req.body.variants) {
        const c = cleanVariant(v);
        const ex = v._id && p.variants.find((x) => x._id === v._id);
        if (ex) {
          Object.assign(ex, c, { sku: c.sku || ex.sku });
          keep.push(ex._id);
        } else {
          const n = Math.max(0, parseInt(v.onHand, 10) || 0);
          const nv = {
            _id: crypto.randomBytes(8).toString("hex"),
            ...c,
            sku: c.sku || `${p.sku}-${p.variants.length + 1}`,
            onHand: n,
            reserved: 0,
            available: n,
          };
          p.variants.push(nv);
          keep.push(nv._id);
          added.push(nv);
        }
      }
      const removing = p.variants.filter((v) => !keep.includes(v._id));
      const busy = removing.find((v) => v.reserved > 0 || v.onHand > 0);
      if (busy)
        throw fail(
          409,
          `Can't remove "${busy.name}": it still has ${busy.onHand} on hand / ${busy.reserved} reserved. Adjust stock to 0 first.`,
        );
      p.variants = p.variants.filter((v) => keep.includes(v._id));
      if (!p.variants.length)
        throw fail(400, "A product needs at least one variant");
    }
    p.stock = p.variants.reduce((s, v) => s + v.available, 0);
    await p.save();
    for (const v of added)
      if (v.onHand)
        await movement(org, p.toObject(), v, {
          onHandDelta: v.onHand,
          reason: "initial",
          by: actor(req),
        });
    audit(req, "product.update", p.name, { fields: Object.keys(patch) });
    res.json({ success: true, product: productView(p.toObject()) });
  }),
);

// Manual stock change: reason required, writes a movement (FR-INV-006)
app.post(
  "/api/products/:id/adjust",
  wrap(async (req, res) => {
    const org = tid(req);
    const { variantId, reason, note } = req.body;
    const delta = parseInt(req.body.delta, 10);
    if (!delta)
      throw fail(400, "Enter a non-zero quantity (+ to add, − to remove)");
    if (
      !["restock", "damage", "count_correction", "return", "other"].includes(
        reason,
      )
    )
      throw fail(400, "Pick a reason");
    if (reason === "other" && !String(note || "").trim())
      throw fail(400, "Write a note for 'other'");
    const cond = {
      _id: req.params.id,
      organizationId: org,
      variants: {
        $elemMatch: {
          _id: variantId,
          ...(delta < 0 ? { available: { $gte: -delta } } : {}),
        },
      },
    };
    const r = await Product.findOneAndUpdate(
      cond,
      {
        $inc: {
          "variants.$.onHand": delta,
          "variants.$.available": delta,
          stock: delta,
        },
      },
      { new: true },
    ).lean();
    if (!r)
      throw fail(
        409,
        delta < 0
          ? "Not enough available stock to remove (reserved units can't be removed)"
          : "Variant not found",
      );
    await movement(
      org,
      r,
      r.variants.find((v) => v._id === variantId),
      {
        onHandDelta: delta,
        reason,
        by: actor(req),
        note: String(note || "").slice(0, 300),
      },
    );
    audit(
      req,
      "stock.adjust",
      variantLabel(
        r,
        r.variants.find((v) => v._id === variantId),
      ),
      { delta, reason },
    );
    res.json({ success: true, product: productView(r) });
  }),
);

app.get(
  "/api/products/:id/movements",
  wrap(async (req, res) => {
    res.json(
      await StockMovement.find({
        organizationId: tid(req),
        productId: req.params.id,
      })
        .sort({ createdAt: -1 })
        .limit(300)
        .lean(),
    );
  }),
);
app.get(
  "/api/inventory/movements",
  wrap(async (req, res) => {
    res.json(
      await StockMovement.find({ organizationId: tid(req) })
        .sort({ createdAt: -1 })
        .limit(Math.min(Number(req.query.limit) || 200, 1000))
        .lean(),
    );
  }),
);
app.get(
  "/api/products/export.csv",
  wrap(async (req, res) => {
    const rows = await Product.find({ organizationId: tid(req) }).lean();
    sendCsvObjects(
      res,
      "inventory.csv",
      rows.flatMap((p) =>
        (p.variants || []).map((v) => ({
          product: p.name,
          nameBn: p.nameBn || "",
          variant: v.name,
          sku: v.sku || p.sku,
          category: p.category,
          price: priceOf(p, v),
          cost: p.costPrice ?? "",
          onHand: v.onHand,
          reserved: v.reserved,
          available: v.available,
          status: p.status,
        })),
      ),
    );
  }),
);

app.delete(
  "/api/products/:id",
  wrap(async (req, res) => {
    const org = tid(req);
    const p = await Product.findOne({
      _id: req.params.id,
      organizationId: org,
    });
    if (!p) throw fail(404, "Product not found");
    const used = await Order.exists({
      organizationId: org,
      "items.productId": p.id,
    });
    if (used || sumVar(p, "reserved") > 0) {
      p.status = "archived";
      await p.save();
      audit(req, "product.archive", p.name);
      return res.json({ success: true, archived: true });
    }
    await Product.deleteOne({ _id: p.id });
    audit(req, "product.delete", p.name);
    res.json({ success: true });
  }),
);

/* ---------- fraud routes (FR-FRD) ---------- */
app.get(
  "/api/fraud/summary",
  wrap(async (req, res) => {
    const org = tid(req);
    const since = new Date(Date.now() - 30 * DAY);
    const [onHold, high, medium, blocked, rejected, shipped, returned, s] =
      await Promise.all([
        Order.countDocuments({ organizationId: org, status: "on_hold" }),
        Order.countDocuments({
          organizationId: org,
          riskBand: "high",
          createdAt: { $gte: since },
        }),
        Order.countDocuments({
          organizationId: org,
          riskBand: "medium",
          createdAt: { $gte: since },
        }),
        Blacklist.countDocuments({ organizationId: org }),
        Order.aggregate([
          {
            $match: {
              organizationId: org,
              status: "rejected",
              createdAt: { $gte: since },
            },
          },
          { $group: { _id: null, n: { $sum: 1 }, amount: { $sum: "$total" } } },
        ]),
        Order.countDocuments({
          organizationId: org,
          "courier.shippedAt": { $gte: since },
        }),
        Order.countDocuments({
          organizationId: org,
          "courier.shippedAt": { $gte: since },
          status: { $in: RETURNED_STATES },
        }),
        fraudSettings(org),
      ]);
    res.json({
      onHold,
      high30: high,
      medium30: medium,
      blocked,
      rejected30: rejected[0]?.n || 0,
      savedAmount30: rejected[0]?.amount || 0,
      returnRate30: shipped ? round((returned / shipped) * 100, 1) : null,
      settings: s,
    });
  }),
);
app.get(
  "/api/fraud/queue",
  wrap(async (req, res) => {
    const q = { organizationId: tid(req) };
    if (req.query.band) q.riskBand = req.query.band;
    else q.status = "on_hold";
    const rows = await Order.find(q).sort({ createdAt: -1 }).limit(200).lean();
    res.json(rows.map((o) => orderView(o, canSeePii(req))));
  }),
);
// Old route name kept for compatibility
app.get(
  "/api/fraud/orders",
  wrap(async (req, res) => {
    const rows = await Order.find({
      organizationId: tid(req),
      riskScore: { $gte: 40 },
    })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    res.json(rows.map((o) => orderRow(o, canSeePii(req))));
  }),
);
app.post(
  "/api/fraud/orders/:id/decide",
  wrap(async (req, res) => {
    const org = tid(req);
    const { decision, note, block } = req.body;
    if (!["approve", "reject"].includes(decision))
      throw fail(400, "decision must be approve or reject");
    if (decision === "reject" && !String(note || "").trim())
      throw fail(400, "Write why you reject this order");
    const o = await transition(
      org,
      req.params.id,
      decision === "approve" ? "confirmed" : "rejected",
      { by: actor(req), note: note || "Approved after review", ctx: req.ctx },
    );
    if (block)
      await Blacklist.updateOne(
        { organizationId: org, phone: o.phone },
        {
          $setOnInsert: {
            type: "phone",
            reason: note || `Rejected order #${o.orderNo}`,
            by: actor(req),
          },
        },
        { upsert: true },
      );
    audit(req, `fraud.${decision}`, o.orderNo, { note, block: !!block });
    res.json({ success: true, order: orderView(o, canSeePii(req)) });
  }),
);
app.post(
  "/api/fraud/check",
  wrap(async (req, res) => {
    const phone = normPhone(req.body.phone);
    if (!phone) throw fail(400, "Enter a phone number");
    const r = await scoreOrder(tid(req), {
      phone,
      address: req.body.address,
      district: req.body.district,
      name: req.body.name || "x",
      total: Number(req.body.total) || 0,
      qty: 1,
    });
    const history = await Order.aggregate([
      { $match: { organizationId: tid(req), phone } },
      { $group: { _id: "$status", n: { $sum: 1 } } },
    ]);
    res.json({
      score: r.score,
      band: r.band,
      signals: r.signals,
      blocked: r.blocked,
      history: Object.fromEntries(history.map((h) => [h._id, h.n])),
    });
  }),
);
app.get(
  "/api/fraud/returners",
  wrap(async (req, res) => {
    const rows = await Order.aggregate([
      {
        $match: {
          organizationId: tid(req),
          createdAt: { $gte: new Date(Date.now() - 183 * DAY) },
        },
      },
      {
        $group: {
          _id: "$phone",
          name: { $last: "$customerName" },
          orders: { $sum: 1 },
          returned: {
            $sum: { $cond: [{ $in: ["$status", RETURNED_STATES] }, 1, 0] },
          },
          delivered: {
            $sum: { $cond: [{ $eq: ["$status", "delivered"] }, 1, 0] },
          },
          lost: {
            $sum: {
              $cond: [{ $in: ["$status", RETURNED_STATES] }, "$deliveryFee", 0],
            },
          },
        },
      },
      { $match: { returned: { $gte: 1 } } },
      { $sort: { returned: -1 } },
      { $limit: 100 },
    ]);
    const blocked = new Set(
      (
        await Blacklist.find({
          organizationId: tid(req),
          phone: { $in: rows.map((r) => r._id) },
        }).lean()
      ).map((b) => b.phone),
    );
    res.json(
      rows.map((r) => ({
        phone: canSeePii(req) ? r._id : maskPhone(r._id),
        rawPhone: canSeePii(req) ? r._id : null,
        name: r.name,
        orders: r.orders,
        returned: r.returned,
        delivered: r.delivered,
        lostFees: r.lost,
        blocked: blocked.has(r._id),
      })),
    );
  }),
);
app.get(
  "/api/fraud/blacklist",
  wrap(async (req, res) => {
    const rows = await Blacklist.find({ organizationId: tid(req) })
      .sort({ createdAt: -1 })
      .lean();
    res.json(
      rows.map((b) => ({
        ...b,
        value:
          b.type === "phone" && !canSeePii(req) ? maskPhone(b.phone) : b.phone,
      })),
    );
  }),
);
app.post(
  "/api/fraud/blacklist",
  wrap(async (req, res) => {
    const org = tid(req);
    const type = ["phone", "psid", "address"].includes(req.body.type)
      ? req.body.type
      : "phone";
    let value = String(req.body.value || req.body.phone || "").trim();
    if (type === "phone") value = normPhone(value);
    if (type === "address") value = addressKey(value);
    if (!value) throw fail(400, "Enter a value to block");
    const reason = String(req.body.reason || "").trim();
    if (!reason) throw fail(400, "Write why you block this customer");
    await Blacklist.updateOne(
      { organizationId: org, phone: value },
      { $set: { type, reason, by: actor(req) } },
      { upsert: true },
    );
    if (type === "phone") {
      const pend = await Order.find({
        organizationId: org,
        phone: value,
        status: "pending",
      })
        .select("_id")
        .lean();
      for (const o of pend)
        await transition(org, o._id, "on_hold", {
          by: actor(req),
          note: "Customer blocked",
          ctx: req.ctx,
        }).catch(() => {});
    }
    audit(
      req,
      "fraud.block",
      `${type}:${type === "phone" ? maskPhone(value) : value}`,
      { reason },
    );
    res.json({ success: true });
  }),
);
app.delete(
  "/api/fraud/blacklist/:id",
  wrap(async (req, res) => {
    const b = await Blacklist.findOneAndDelete({
      _id: req.params.id,
      organizationId: tid(req),
    });
    if (b)
      audit(
        req,
        "fraud.unblock",
        `${b.type}:${b.type === "phone" ? maskPhone(b.phone) : b.phone}`,
      );
    res.json({ success: true });
  }),
);
app.put(
  "/api/fraud/settings",
  wrap(async (req, res) => {
    const b = req.body;
    const s = {
      enabled: b.enabled !== false,
      refuseBlocked: b.refuseBlocked !== false,
      threshold: Math.max(40, Math.min(100, Number(b.threshold) || 60)),
      lookbackDays: Math.max(7, Math.min(365, Number(b.lookbackDays) || 30)),
    };
    await Organization.updateOne({ _id: tid(req) }, { fraud: s });
    audit(req, "fraud.settings", null, s);
    res.json({ success: true, settings: s });
  }),
);

/* ---------- workspace profile + delivery zones (FR-AUTH-011, FR-ORD-006) ---------- */
app.get(
  "/api/workspace",
  wrap(async (req, res) => {
    const o = await Organization.findById(tid(req)).lean();
    res.json({
      id: o?._id,
      name: o?.name,
      logoUrl: o?.logoUrl,
      businessPhone: o?.businessPhone,
      returnPolicy: o?.returnPolicy,
      defaultLanguage: o?.defaultLanguage || "bn",
      orderPrefix: o?.orderPrefix || "ORD-",
      zones: o?.zones?.length ? o.zones : DEFAULT_ZONES,
      customZones: !!o?.zones?.length,
      fraud: await fraudSettings(tid(req)),
      districts: DISTRICT_NAMES,
    });
  }),
);
app.put(
  "/api/workspace",
  wrap(async (req, res) => {
    const p = pick(req.body, [
      "name",
      "logoUrl",
      "businessPhone",
      "returnPolicy",
      "defaultLanguage",
      "orderPrefix",
    ]);
    if ("name" in p && !String(p.name).trim())
      throw fail(400, "Workspace name can't be empty");
    if ("orderPrefix" in p)
      p.orderPrefix =
        String(p.orderPrefix || "ORD-")
          .replace(/[^A-Za-z0-9-]/g, "")
          .slice(0, 10) || "ORD-";
    if (Array.isArray(req.body.zones)) {
      const zones = req.body.zones
        .map((z) => ({
          name: String(z.name || "").trim(),
          fee: Math.max(0, Number(z.fee) || 0),
          districts: (Array.isArray(z.districts)
            ? z.districts
            : lines(z.districts)
          )
            .map(canonicalDistrict)
            .filter(Boolean),
          areas: Array.isArray(z.areas)
            ? z.areas
            : lines(z.areas).map((a) => a.toLowerCase()),
          isDefault: !!z.isDefault,
          freeOver: Math.max(0, Number(z.freeOver) || 0),
        }))
        .filter((z) => z.name);
      if (!zones.length) throw fail(400, "Add at least one delivery zone");
      if (zones.filter((z) => z.isDefault).length !== 1)
        throw fail(
          400,
          "Mark exactly one zone as the default (used when the address doesn't match)",
        );
      p.zones = zones;
    }
    if (req.body.resetZones) p.zones = [];
    await Organization.updateOne({ _id: tid(req) }, p);
    audit(req, "workspace.update", null, { fields: Object.keys(p) });
    res.json({ success: true });
  }),
);
app.post(
  "/api/zones/test",
  wrap(async (req, res) =>
    res.json(zoneFor(await orgZones(tid(req)), req.body)),
  ),
);

/* ---------- AI agent settings ---------- */
app.get(
  "/api/agent",
  wrap(async (req, res) => {
    res.json(
      await AgentConfig.findOneAndUpdate(
        { organizationId: tid(req) },
        { $setOnInsert: {} },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ),
    );
  }),
);
app.put(
  "/api/agent",
  wrap(async (req, res) => {
    const allowed = [
      "enabled",
      "autoConfirm",
      "tone",
      "escalateBelow",
      "greeting",
      "deliveryTime",
      "paymentNote",
      "knowledge",
      "handoffMessage",
      "commentAutoReply",
      "commentPrivateReply",
      "commentPublicReply",
    ];
    const c = await AgentConfig.findOneAndUpdate(
      { organizationId: tid(req) },
      pick(req.body, allowed),
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
        runValidators: true,
      },
    );
    audit(req, "agent.settings", null, {
      fields: Object.keys(pick(req.body, allowed)),
    });
    res.json({ success: true, config: c });
  }),
);

/* ---------- subscription (plan changes: super admin only until billing is connected) ---------- */
app.get(
  "/api/subscription",
  wrap(async (req, res) => {
    const org = tid(req);
    const o = (await Organization.findById(org)) || {
      plan: "free",
      planStatus: "active",
      planRenewsAt: null,
    };
    const monthStart = dhakaStart(todayIn("Asia/Dhaka").slice(0, 8) + "01");
    const [aiOrders, pages] = await Promise.all([
      Order.countDocuments({
        organizationId: org,
        createdBy: "ai_agent",
        createdAt: { $gte: monthStart },
      }),
      SocialAccount.countDocuments({
        organizationId: org,
        platform: { $in: ["Facebook", "Instagram"] },
      }),
    ]);
    res.json({
      plan: o.plan,
      status: o.planStatus,
      renewsAt: o.planRenewsAt,
      limits: PLANS[o.plan],
      usage: { aiOrders, pages },
      plans: PLANS,
      canChange: !!req.ctx?.superAdmin,
    });
  }),
);
app.put(
  "/api/subscription",
  wrap(async (req, res) => {
    if (!req.ctx?.superAdmin)
      throw fail(
        403,
        "Plan changes are made by the platform admin after payment",
      );
    const { plan } = req.body;
    if (!PLANS[plan]) throw fail(400, "Unknown plan");
    await Organization.updateOne(
      { _id: tid(req) },
      {
        plan,
        planStatus: "active",
        planRenewsAt: plan === "free" ? null : new Date(Date.now() + 30 * DAY),
      },
    );
    audit(req, "billing.plan", plan);
    res.json({ success: true });
  }),
);

/* =====================================================
   METRIC SERVICE (SRS §7): every dashboard number comes from here
   ===================================================== */
// Midnight in Asia/Dhaka (UTC+6, no DST) for a YYYY-MM-DD date
const dhakaStart = (ymdStr) =>
  new Date(`${String(ymdStr).slice(0, 10)}T00:00:00+06:00`);
function periodRange(q) {
  const today = todayIn("Asia/Dhaka");
  const t0 = dhakaStart(today).getTime();
  let from, to;
  switch (q.period || "today") {
    case "yesterday":
      from = t0 - DAY;
      to = t0;
      break;
    case "7d":
      from = t0 - 6 * DAY;
      to = t0 + DAY;
      break;
    case "30d":
      from = t0 - 29 * DAY;
      to = t0 + DAY;
      break;
    case "month":
      from = dhakaStart(today.slice(0, 8) + "01").getTime();
      to = t0 + DAY;
      break;
    case "custom": {
      if (!q.from || !q.to) throw fail(400, "Pick a start and end date");
      from = dhakaStart(q.from).getTime();
      to = dhakaStart(q.to).getTime() + DAY;
      if (to <= from) throw fail(400, "End date must be after the start date");
      break;
    }
    default:
      from = t0;
      to = t0 + DAY;
  }
  const len = to - from;
  return {
    from: new Date(from),
    to: new Date(to),
    prevFrom: new Date(from - len),
    prevTo: new Date(from),
    label: q.period || "today",
  };
}
const METRIC_CACHE = new Map();
async function computeMetrics(org, r, pageId) {
  const conv = { organizationId: org, ...(pageId ? { pageId } : {}) };
  const inR = (a, b) => ({ createdAt: { $gte: a, $lt: b } });
  const ordersIn = async (a, b) => {
    const [x] = await Order.aggregate([
      { $match: { organizationId: org, ...inR(a, b) } },
      {
        $group: {
          _id: null,
          all: { $sum: 1 },
          ai: { $sum: { $cond: [{ $eq: ["$createdBy", "ai_agent"] }, 1, 0] } },
          revenue: {
            $sum: { $cond: [{ $in: ["$status", DEAD_STATES] }, 0, "$total"] },
          },
          live: { $sum: { $cond: [{ $in: ["$status", DEAD_STATES] }, 0, 1] } },
        },
      },
    ]);
    return { orders: x?.live || 0, ai: x?.ai || 0, revenue: x?.revenue || 0 };
  };
  // Collected = paid, or COD delivered (status time = last event at delivered)
  const collectedIn = async (a, b) => {
    const [x] = await Order.aggregate([
      {
        $match: {
          organizationId: org,
          status: { $nin: DEAD_STATES },
          $or: [
            { paymentStatus: "paid" },
            { paymentMethod: "COD", status: "delivered" },
          ],
          updatedAt: { $gte: a, $lt: b },
        },
      },
      { $group: { _id: null, sum: { $sum: "$total" } } },
    ]);
    return x?.sum || 0;
  };
  const shippedReturned = async (a, b) => {
    const [shipped, returned] = await Promise.all([
      Order.countDocuments({
        organizationId: org,
        "courier.shippedAt": { $gte: a, $lt: b },
      }),
      Order.countDocuments({
        organizationId: org,
        "courier.shippedAt": { $gte: a, $lt: b },
        status: {
          $in: ["returned_to_sender", "returned_restocked", "returned_damaged"],
        },
      }),
    ]);
    return shipped ? round((returned / shipped) * 100, 1) : null;
  };
  const [
    cur,
    prev,
    collected,
    collectedPrev,
    openThreads,
    humanThreads,
    onHold,
    products,
    units,
    leads,
    leadsPrev,
    retCur,
    retPrev,
    recent,
    aiHandled,
    commentsIn,
    commentOrders,
  ] = await Promise.all([
    ordersIn(r.from, r.to),
    ordersIn(r.prevFrom, r.prevTo),
    collectedIn(r.from, r.to),
    collectedIn(r.prevFrom, r.prevTo),
    Conversation.countDocuments({
      ...conv,
      status: { $in: ["open", "needs_review"] },
    }),
    Conversation.countDocuments({ ...conv, status: "needs_review" }),
    Order.countDocuments({ organizationId: org, status: "on_hold" }),
    Product.countDocuments({
      organizationId: org,
      status: { $ne: "archived" },
    }),
    Product.aggregate([
      { $match: { organizationId: org, status: { $ne: "archived" } } },
      { $unwind: "$variants" },
      {
        $group: {
          _id: null,
          onHand: { $sum: "$variants.onHand" },
          available: { $sum: "$variants.available" },
        },
      },
    ]),
    Lead.countDocuments({ organizationId: org, ...inR(r.from, r.to) }),
    Lead.countDocuments({ organizationId: org, ...inR(r.prevFrom, r.prevTo) }),
    shippedReturned(r.from, r.to),
    shippedReturned(r.prevFrom, r.prevTo),
    Order.find({ organizationId: org })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean(),
    Conversation.aggregate([
      { $match: conv },
      { $group: { _id: null, n: { $sum: { $ifNull: ["$aiHandled", 0] } } } },
    ]),
    Comment.countDocuments({
      organizationId: org,
      intent: { $in: ["order_intent", "price", "availability", "size_colour"] },
      ...inR(r.from, r.to),
    }),
    Order.countDocuments({
      organizationId: org,
      sourceCommentId: { $ne: null },
      ...inR(r.from, r.to),
    }),
  ]);
  const card = (key, label, value, prevValue, link, extra = {}) => ({
    key,
    label,
    value,
    prev: prevValue,
    delta: prevValue == null || value == null ? null : pct(value, prevValue),
    link,
    ...extra,
  });
  return {
    period: r.label,
    from: r.from,
    to: r.to,
    updatedAt: new Date(),
    cards: [
      card(
        "revenue",
        "Revenue",
        cur.revenue,
        prev.revenue,
        { view: "orders", filter: { from: r.from, to: r.to } },
        {
          money: true,
          hint: "Orders created in the period, excluding cancelled/rejected",
        },
      ),
      card("orders", "Orders", cur.orders, prev.orders, {
        view: "orders",
        filter: {},
      }),
      card(
        "ai_orders",
        "AI orders",
        cur.ai,
        prev.ai,
        { view: "orders", filter: { createdBy: "ai_agent" } },
        { hint: "Orders created by the AI sales agent" },
      ),
      card(
        "collected",
        "Collected revenue",
        collected,
        collectedPrev,
        { view: "orders", filter: { payment: "paid" } },
        { money: true, hint: "Paid orders + COD delivered (by last update)" },
      ),
      card("open_threads", "Open threads", openThreads, null, {
        view: "inbox",
      }),
      card(
        "needs_human",
        "Needs human review",
        humanThreads + onHold,
        null,
        { view: "inbox", filter: { tab: "human" } },
        { hint: `${humanThreads} chats + ${onHold} orders on hold` },
      ),
      card(
        "products",
        "Active products",
        products,
        null,
        { view: "inventory" },
        { hint: "Number of products (not units)" },
      ),
      card(
        "stock_units",
        "Stock units",
        units[0]?.onHand || 0,
        null,
        { view: "inventory" },
        { hint: `${units[0]?.available || 0} available to sell` },
      ),
      card("leads", "B2B leads", leads, leadsPrev, { view: "leads" }),
      card(
        "return_rate",
        "Return rate",
        retCur,
        retPrev,
        {
          view: "orders",
          filter: {
            status: "returned_to_sender,returned_restocked,returned_damaged",
          },
        },
        {
          suffix: "%",
          incomplete: retCur == null,
          hint: "Returned ÷ shipped in the period",
        },
      ),
    ],
    aiReplies: aiHandled[0]?.n || 0,
    commentConversion: commentsIn
      ? round((commentOrders / commentsIn) * 100, 1)
      : null,
    recent: recent.map((o) => orderRow(o, true)),
  };
}
app.get(
  "/api/metrics/overview",
  wrap(async (req, res) => {
    const org = tid(req);
    const r = periodRange(req.query);
    const key = `${org}|${req.query.period}|${req.query.from}|${req.query.to}|${req.query.pageId || ""}`;
    const hit = METRIC_CACHE.get(key);
    let data;
    if (hit && Date.now() - hit.at < 60e3 && req.query.refresh !== "1")
      data = hit.data;
    else {
      data = await computeMetrics(org, r, req.query.pageId);
      METRIC_CACHE.set(key, { at: Date.now(), data });
      if (METRIC_CACHE.size > 500)
        METRIC_CACHE.delete(METRIC_CACHE.keys().next().value);
    }
    const pii = canSeePii(req);
    res.json({
      ...data,
      recent: data.recent.map((o) =>
        pii
          ? o
          : {
              ...o,
              phone: maskPhone(o.phone),
              address: maskAddress(o.address),
            },
      ),
    });
  }),
);
// Old dashboard endpoint, now backed by the metric service
app.get(
  "/api/overview",
  wrap(async (req, res) => {
    const m = await computeMetrics(tid(req), periodRange({ period: "today" }));
    const c = Object.fromEntries(m.cards.map((x) => [x.key, x]));
    res.json({
      revenueToday: c.revenue.value,
      revenueDelta: c.revenue.delta,
      ordersToday: c.orders.value,
      ordersDelta: c.orders.delta,
      aiOrders: c.ai_orders.value,
      aiDelta: c.ai_orders.delta,
      collected: c.collected.value,
      collectedDelta: c.collected.delta,
      openThreads: c.open_threads.value,
      needsReview: c.needs_human.value,
      products: c.products.value,
      stockUnits: c.stock_units.value,
      b2bLeads: c.leads.value,
      leadsDelta: c.leads.delta,
    });
  }),
);

app.get(
  "/api/analytics",
  wrap(async (req, res) => {
    const org = tid(req);
    const r = periodRange({
      period: req.query.period || "30d",
      from: req.query.from,
      to: req.query.to,
    });
    const base = {
      organizationId: org,
      createdAt: { $gte: r.from, $lt: r.to },
    };
    const live = { ...base, status: { $nin: DEAD_STATES } };
    const [daily, channels, statuses, byDistrict, byProduct, convs] =
      await Promise.all([
        Order.aggregate([
          { $match: live },
          {
            $group: {
              _id: {
                $dateToString: {
                  format: "%Y-%m-%d",
                  date: "$createdAt",
                  timezone: "+06:00",
                },
              },
              revenue: { $sum: "$total" },
              orders: { $sum: 1 },
              ai: {
                $sum: { $cond: [{ $eq: ["$createdBy", "ai_agent"] }, 1, 0] },
              },
            },
          },
          { $sort: { _id: 1 } },
        ]),
        Order.aggregate([
          { $match: live },
          {
            $group: {
              _id: "$channel",
              orders: { $sum: 1 },
              revenue: { $sum: "$total" },
            },
          },
          { $sort: { revenue: -1 } },
        ]),
        Order.aggregate([
          { $match: base },
          { $group: { _id: "$status", count: { $sum: 1 } } },
        ]),
        Order.aggregate([
          { $match: { ...base, "courier.shippedAt": { $ne: null } } },
          {
            $group: {
              _id: { $ifNull: ["$district", "Unknown"] },
              shipped: { $sum: 1 },
              returned: {
                $sum: {
                  $cond: [
                    {
                      $in: [
                        "$status",
                        [
                          "returned_to_sender",
                          "returned_restocked",
                          "returned_damaged",
                        ],
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
            },
          },
          { $sort: { shipped: -1 } },
          { $limit: 20 },
        ]),
        Order.aggregate([
          { $match: live },
          { $unwind: "$items" },
          {
            $group: {
              _id: "$items.name",
              units: { $sum: "$items.qty" },
              revenue: { $sum: { $multiply: ["$items.qty", "$items.price"] } },
              returned: {
                $sum: {
                  $cond: [
                    { $in: ["$status", RETURNED_STATES] },
                    "$items.qty",
                    0,
                  ],
                },
              },
            },
          },
          { $sort: { revenue: -1 } },
          { $limit: 20 },
        ]),
        Conversation.aggregate([
          {
            $match: {
              organizationId: org,
              createdAt: { $gte: r.from, $lt: r.to },
            },
          },
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              handoff: {
                $sum: { $cond: [{ $ifNull: ["$handoffReason", false] }, 1, 0] },
              },
              withOrder: {
                $sum: { $cond: [{ $ifNull: ["$orderId", false] }, 1, 0] },
              },
              closed: {
                $sum: { $cond: [{ $eq: ["$status", "closed"] }, 1, 0] },
              },
            },
          },
        ]),
      ]);
    const days = [];
    for (let t = r.from.getTime(); t < r.to.getTime(); t += DAY)
      days.push(new Date(t + 6 * 3600e3).toISOString().slice(0, 10));
    const byDay = Object.fromEntries(daily.map((d) => [d._id, d]));
    const cv = convs[0] || { total: 0, handoff: 0, withOrder: 0 };
    res.json({
      daily: days.map((d) => ({
        date: d,
        revenue: byDay[d]?.revenue || 0,
        orders: byDay[d]?.orders || 0,
        ai: byDay[d]?.ai || 0,
      })),
      channels: channels.map((c) => ({
        channel: c._id || "Manual",
        orders: c.orders,
        revenue: c.revenue,
      })),
      statuses: statuses.map((s) => ({
        status: s._id,
        label: STATUS_LABEL[s._id] || s._id,
        count: s.count,
      })),
      districts: byDistrict.map((d) => ({
        district: d._id,
        shipped: d.shipped,
        returned: d.returned,
        rate: d.shipped ? round((d.returned / d.shipped) * 100, 1) : 0,
      })),
      products: byProduct.map((p) => ({
        product: p._id,
        units: p.units,
        revenue: p.revenue,
        returned: p.returned,
      })),
      ai: {
        conversations: cv.total,
        handoverRate: cv.total ? round((cv.handoff / cv.total) * 100, 1) : null,
        ordersPer100: cv.total
          ? round((cv.withOrder / cv.total) * 100, 1)
          : null,
      },
    });
  }),
);

app.get(
  "/api/stats",
  wrap(async (req, res) => {
    const org = tid(req);
    const [totalLeads, hotLeads, totalContent, publishedContent] =
      await Promise.all([
        Lead.countDocuments({ organizationId: org }),
        Lead.countDocuments({ organizationId: org, aiStatus: "Hot" }),
        ContentItem.countDocuments({ organizationId: org }),
        ContentItem.countDocuments({
          organizationId: org,
          status: { $in: ["Approved", "Published"] },
        }),
      ]);
    res.json({ totalLeads, hotLeads, totalContent, publishedContent });
  }),
);

/* =====================================================
   COURIER HUB (SRS §10.4): Steadfast, Pathao, local delivery
   Credentials are stored encrypted. Booking moves Packed -> Shipped and stores the consignment.
   A sync job walks Shipped -> Out for delivery -> Delivered / Returned along the state machine.
   ===================================================== */
const STEADFAST_BASE = "https://portal.packzy.com/api/v1";
const PATHAO_BASE = (sandbox) =>
  sandbox
    ? "https://courier-api-sandbox.pathao.com"
    : "https://api-hermes.pathao.com";
const COURIERS = {
  steadfast: { label: "Steadfast", fields: ["apiKey", "secretKey"] },
  pathao: {
    label: "Pathao",
    fields: ["clientId", "clientSecret", "username", "password"],
  },
  local: { label: "Local / own rider", fields: [] },
};
const credsOf = (acc) => {
  try {
    return JSON.parse(decrypt(acc.credentialsEnc) || "{}");
  } catch {
    return {};
  }
};
const courierView = (a) => ({
  id: a._id || a.id,
  provider: a.provider,
  providerLabel: COURIERS[a.provider]?.label || a.provider,
  label: a.label,
  storeId: a.storeId,
  sandbox: !!a.sandbox,
  isDefault: !!a.isDefault,
  active: a.active !== false,
  lastError: a.lastError,
  createdAt: a.createdAt,
});

async function courierFetch(url, { method = "GET", headers = {}, body } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20e3);
  try {
    const r = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await r.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text.slice(0, 300) };
    }
    if (!r.ok)
      throw fail(
        502,
        `Courier API ${r.status}: ${data.message || data.error || (data.errors ? JSON.stringify(data.errors) : "") || data.raw || "error"}`.slice(
          0,
          300,
        ),
      );
    return data;
  } catch (e) {
    if (e.name === "AbortError") throw fail(504, "Courier API timed out");
    throw e;
  } finally {
    clearTimeout(t);
  }
}

/* --- Steadfast --- */
const sfHeaders = (c) => ({ "Api-Key": c.apiKey, "Secret-Key": c.secretKey });
const steadfast = {
  async test(acc) {
    const d = await courierFetch(`${STEADFAST_BASE}/get_balance`, {
      headers: sfHeaders(credsOf(acc)),
    });
    return `Connected. Balance ৳${d.current_balance ?? "?"}`;
  },
  async book(acc, o) {
    const d = await courierFetch(`${STEADFAST_BASE}/create_order`, {
      method: "POST",
      headers: sfHeaders(credsOf(acc)),
      body: {
        invoice: o.orderNo,
        recipient_name: o.customerName,
        recipient_phone: o.phone,
        recipient_address:
          `${o.address}${o.district ? ", " + o.district : ""}`.slice(0, 250),
        cod_amount: codAmount(o),
        note: (o.notes || "").slice(0, 200),
      },
    });
    const c = d.consignment || {};
    if (!c.consignment_id)
      throw fail(502, `Steadfast: ${d.message || "booking failed"}`);
    return {
      consignmentId: String(c.consignment_id),
      trackingId: c.tracking_code || String(c.consignment_id),
      status: c.status || "in_review",
    };
  },
  async status(acc, o) {
    const d = await courierFetch(
      `${STEADFAST_BASE}/status_by_cid/${encodeURIComponent(o.courier.consignmentId)}`,
      { headers: sfHeaders(credsOf(acc)) },
    );
    return String(d.delivery_status || "");
  },
  map(s) {
    s = s.toLowerCase();
    if (
      s === "delivered" ||
      s === "delivered_approval_pending" ||
      s.startsWith("partial_delivered")
    )
      return "delivered";
    if (s.startsWith("cancelled")) return "returned_to_sender";
    if (s === "hold") return "failed_delivery";
    return null; // pending / in_review / unknown: still on the way
  },
};

/* --- Pathao (token cached per account) --- */
const PATHAO_TOKENS = new Map();
async function pathaoToken(acc) {
  const hit = PATHAO_TOKENS.get(String(acc._id));
  if (hit && hit.exp > Date.now() + 60e3) return hit.token;
  const c = credsOf(acc);
  const d = await courierFetch(
    `${PATHAO_BASE(acc.sandbox)}/aladdin/api/v1/issue-token`,
    {
      method: "POST",
      body: {
        client_id: c.clientId,
        client_secret: c.clientSecret,
        username: c.username,
        password: c.password,
        grant_type: "password",
      },
    },
  );
  if (!d.access_token)
    throw fail(
      502,
      "Pathao login failed. Check the client ID/secret, email and password.",
    );
  PATHAO_TOKENS.set(String(acc._id), {
    token: d.access_token,
    exp: Date.now() + (Number(d.expires_in) || 3600) * 1000,
  });
  return d.access_token;
}
const pathaoGet = async (acc, p) =>
  courierFetch(`${PATHAO_BASE(acc.sandbox)}${p}`, {
    headers: { Authorization: `Bearer ${await pathaoToken(acc)}` },
  });
const pathao = {
  async test(acc) {
    await pathaoToken(acc);
    const d = await pathaoGet(acc, "/aladdin/api/v1/stores");
    const stores = d.data?.data || [];
    return `Connected. ${stores.length} store(s): ${stores.map((s) => `${s.store_name} (#${s.store_id})`).join(", ") || "none"}`;
  },
  async book(acc, o, extra = {}) {
    if (!acc.storeId)
      throw fail(400, "Set the Pathao store ID in Courier settings");
    const body = {
      store_id: Number(acc.storeId),
      merchant_order_id: o.orderNo,
      recipient_name: o.customerName,
      recipient_phone: o.phone,
      recipient_address:
        `${o.address}${o.district ? ", " + o.district : ""}`.slice(0, 220),
      delivery_type: 48,
      item_type: 2,
      item_quantity: (o.items || []).reduce((s, i) => s + i.qty, 0) || 1,
      item_weight: Math.max(0.5, Number(extra.weight) || 0.5),
      amount_to_collect: codAmount(o),
      item_description: (o.items || [])
        .map(
          (i) =>
            `${i.name}${i.variantName ? " " + i.variantName : ""} x${i.qty}`,
        )
        .join(", ")
        .slice(0, 200),
      special_instruction: (o.notes || "").slice(0, 200),
    };
    if (extra.cityId) body.recipient_city = Number(extra.cityId);
    if (extra.zoneId) body.recipient_zone = Number(extra.zoneId);
    if (extra.areaId) body.recipient_area = Number(extra.areaId);
    const d = await courierFetch(
      `${PATHAO_BASE(acc.sandbox)}/aladdin/api/v1/orders`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${await pathaoToken(acc)}` },
        body,
      },
    );
    const x = d.data || {};
    if (!x.consignment_id)
      throw fail(502, `Pathao: ${d.message || "booking failed"}`);
    return {
      consignmentId: String(x.consignment_id),
      trackingId: String(x.consignment_id),
      status: x.order_status || "Pending",
      charge: x.delivery_fee ?? null,
    };
  },
  async status(acc, o) {
    const d = await pathaoGet(
      acc,
      `/aladdin/api/v1/orders/${encodeURIComponent(o.courier.consignmentId)}/info`,
    );
    return String(d.data?.order_status || d.data?.order_status_slug || "");
  },
  map(s) {
    s = s.toLowerCase().replace(/[\s-]+/g, "_");
    if (s === "delivered" || s === "partial_delivery") return "delivered";
    if (s.startsWith("return")) return "returned_to_sender";
    if (s === "delivery_failed" || s === "on_hold") return "failed_delivery";
    if (s === "assigned_for_delivery" || s === "out_for_delivery")
      return "out_for_delivery";
    return null;
  },
};
const PROVIDERS = { steadfast, pathao };
const codAmount = (o) =>
  o.paymentMethod === "COD" && o.paymentStatus !== "paid"
    ? Math.round(o.total)
    : 0;

/* --- accounts --- */
app.get(
  "/api/courier/accounts",
  wrap(async (req, res) => {
    res.json({
      providers: Object.entries(COURIERS).map(([id, c]) => ({ id, ...c })),
      accounts: (
        await CourierAccount.find({ organizationId: tid(req) })
          .sort({ createdAt: 1 })
          .lean()
      ).map(courierView),
    });
  }),
);
app.post(
  "/api/courier/accounts",
  wrap(async (req, res) => {
    const org = tid(req);
    const provider = req.body.provider;
    if (!COURIERS[provider]) throw fail(400, "Pick Steadfast, Pathao or Local");
    const creds = pick(req.body.credentials || {}, COURIERS[provider].fields);
    const missing = COURIERS[provider].fields.filter(
      (f) => !String(creds[f] || "").trim(),
    );
    if (missing.length) throw fail(400, `Missing: ${missing.join(", ")}`);
    const first = !(await CourierAccount.exists({ organizationId: org }));
    const a = await CourierAccount.create({
      organizationId: org,
      provider,
      label: req.body.label || COURIERS[provider].label,
      credentialsEnc: Object.keys(creds).length
        ? encrypt(JSON.stringify(creds))
        : null,
      storeId: req.body.storeId || null,
      sandbox: !!req.body.sandbox,
      isDefault: first || !!req.body.isDefault,
    });
    if (a.isDefault && !first)
      await CourierAccount.updateMany(
        { organizationId: org, _id: { $ne: a.id } },
        { isDefault: false },
      );
    audit(req, "courier.connect", provider);
    res.json({ success: true, account: courierView(a) });
  }),
);
app.put(
  "/api/courier/accounts/:id",
  wrap(async (req, res) => {
    const org = tid(req);
    const a = await CourierAccount.findOne({
      _id: req.params.id,
      organizationId: org,
    }).select("+credentialsEnc");
    if (!a) throw fail(404, "Courier account not found");
    Object.assign(a, pick(req.body, ["label", "storeId", "sandbox", "active"]));
    const creds = pick(
      req.body.credentials || {},
      COURIERS[a.provider]?.fields || [],
    );
    if (Object.values(creds).some((v) => String(v || "").trim()))
      a.credentialsEnc = encrypt(
        JSON.stringify({
          ...credsOf(a),
          ...Object.fromEntries(
            Object.entries(creds).filter(([, v]) => String(v || "").trim()),
          ),
        }),
      );
    if (req.body.isDefault) {
      await CourierAccount.updateMany(
        { organizationId: org },
        { isDefault: false },
      );
      a.isDefault = true;
    }
    await a.save();
    PATHAO_TOKENS.delete(String(a._id));
    audit(req, "courier.update", a.provider);
    res.json({ success: true, account: courierView(a) });
  }),
);
app.delete(
  "/api/courier/accounts/:id",
  wrap(async (req, res) => {
    const a = await CourierAccount.findOneAndDelete({
      _id: req.params.id,
      organizationId: tid(req),
    });
    if (a) audit(req, "courier.disconnect", a.provider);
    res.json({ success: true });
  }),
);
app.post(
  "/api/courier/accounts/:id/test",
  wrap(async (req, res) => {
    const a = await CourierAccount.findOne({
      _id: req.params.id,
      organizationId: tid(req),
    }).select("+credentialsEnc");
    if (!a) throw fail(404, "Courier account not found");
    if (!PROVIDERS[a.provider])
      return res.json({
        success: true,
        message: "Local delivery needs no connection test",
      });
    try {
      const message = await PROVIDERS[a.provider].test(a);
      a.lastError = null;
      await a.save();
      res.json({ success: true, message });
    } catch (e) {
      a.lastError = e.message;
      await a.save();
      throw e;
    }
  }),
);
async function courierAccount(org, id) {
  const a = id
    ? await CourierAccount.findOne({ _id: id, organizationId: org }).select(
        "+credentialsEnc",
      )
    : (await CourierAccount.findOne({
        organizationId: org,
        isDefault: true,
        active: true,
      }).select("+credentialsEnc")) ||
      (await CourierAccount.findOne({
        organizationId: org,
        active: true,
      }).select("+credentialsEnc"));
  if (!a) throw fail(400, "Connect a courier first (Courier Hub → Accounts)");
  return a;
}
app.get(
  "/api/courier/pathao/cities",
  wrap(async (req, res) => {
    const a = await courierAccount(tid(req), req.query.accountId);
    if (a.provider !== "pathao") throw fail(400, "Not a Pathao account");
    const d = await pathaoGet(a, "/aladdin/api/v1/city-list");
    res.json(
      (d.data?.data || []).map((c) => ({ id: c.city_id, name: c.city_name })),
    );
  }),
);
app.get(
  "/api/courier/pathao/zones",
  wrap(async (req, res) => {
    const a = await courierAccount(tid(req), req.query.accountId);
    const d = await pathaoGet(
      a,
      `/aladdin/api/v1/cities/${Number(req.query.cityId)}/zone-list`,
    );
    res.json(
      (d.data?.data || []).map((z) => ({ id: z.zone_id, name: z.zone_name })),
    );
  }),
);

/* --- booking --- */
async function bookOrder(
  org,
  orderId,
  { accountId, extra = {}, tracking, by, ctx } = {},
) {
  let o = await Order.findOne({ _id: orderId, organizationId: org });
  if (!o) throw fail(404, "Order not found");
  if (
    o.courier?.consignmentId ||
    (o.courier?.trackingId && o.status === "shipped")
  )
    throw fail(409, `#${o.orderNo} is already booked`);
  if (!["confirmed", "processing", "packed"].includes(o.status))
    throw fail(
      409,
      `#${o.orderNo} is ${STATUS_LABEL[o.status]}: confirm it first`,
    );
  const acc = await courierAccount(org, accountId);
  if (!acc.active) throw fail(400, "This courier account is turned off");
  // Walk the legal path up to Packed (audited at every step)
  for (const s of pathTo(o.status, "packed") || [])
    o = await transition(org, o.id, s, { by, note: "Courier booking", ctx });
  let booked;
  if (acc.provider === "local")
    booked = {
      consignmentId: null,
      trackingId: tracking || `LOCAL-${o.orderNo}`,
      status: "assigned",
    };
  else booked = await PROVIDERS[acc.provider].book(acc, o, extra);
  await Order.updateOne(
    { _id: o.id },
    {
      $set: {
        courier: {
          provider: acc.provider,
          trackingId: booked.trackingId,
          consignmentId: booked.consignmentId,
          status: booked.status,
          charge: booked.charge ?? null,
          bookedAt: new Date(),
          lastSyncAt: new Date(),
          shippedAt: new Date(),
          accountId: String(acc._id),
        },
      },
    },
  );
  return transition(org, o.id, "shipped", {
    by,
    note: `Booked with ${COURIERS[acc.provider].label}: ${booked.trackingId}`,
    ctx,
  });
}
app.post(
  "/api/courier/book",
  wrap(async (req, res) => {
    const org = tid(req);
    const ids = (req.body.orderIds || [req.body.orderId])
      .filter(Boolean)
      .slice(0, 100);
    if (!ids.length) throw fail(400, "Pick at least one order");
    const results = [];
    for (const id of ids) {
      try {
        const o = await bookOrder(org, id, {
          accountId: req.body.accountId,
          extra: req.body.pathao || {},
          tracking: req.body.tracking,
          by: actor(req),
          ctx: req.ctx,
        });
        results.push({
          id,
          ok: true,
          orderNo: o.orderNo,
          tracking: o.courier?.trackingId,
        });
      } catch (e) {
        results.push({ id, ok: false, error: e.message });
      }
    }
    audit(req, "courier.book", null, {
      ok: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    });
    res.json({ success: results.some((r) => r.ok), results });
  }),
);
// Old dashboard button
app.post(
  "/api/orders/:id/ship",
  wrap(async (req, res) => {
    const o = await bookOrder(tid(req), req.params.id, {
      accountId: req.body.accountId,
      tracking: req.body.tracking,
      by: actor(req),
      ctx: req.ctx,
    });
    res.json({ success: true, order: orderView(o, canSeePii(req)) });
  }),
);

/* --- status sync --- */
async function syncShipment(org, o) {
  const p = PROVIDERS[o.courier?.provider];
  if (!p || !o.courier?.consignmentId) return null;
  const acc = o.courier.accountId
    ? await CourierAccount.findOne({
        _id: o.courier.accountId,
        organizationId: org,
      }).select("+credentialsEnc")
    : await CourierAccount.findOne({
        organizationId: org,
        provider: o.courier.provider,
      }).select("+credentialsEnc");
  if (!acc) return null;
  const raw = await p.status(acc, o);
  await Order.updateOne(
    { _id: o._id },
    { "courier.status": raw, "courier.lastSyncAt": new Date() },
  );
  const target = p.map(raw);
  if (!target || target === o.status) return { raw, moved: [] };
  const path = pathTo(o.status, target) || [];
  for (const s of path)
    await transition(org, o._id, s, {
      by: `${COURIERS[o.courier.provider].label} sync`,
      note: `Courier status: ${raw}`,
    });
  return { raw, moved: path };
}
async function syncCouriers() {
  const rows = await Order.find({
    status: { $in: ["shipped", "out_for_delivery", "failed_delivery"] },
    "courier.consignmentId": { $ne: null },
    $or: [
      { "courier.lastSyncAt": null },
      { "courier.lastSyncAt": { $lt: new Date(Date.now() - 25 * 60e3) } },
    ],
  })
    .limit(300)
    .lean();
  for (const o of rows) {
    await syncShipment(o.organizationId, o).catch((e) =>
      console.warn(`courier sync ${o.orderNo}:`, e.message),
    );
    await sleep(300);
  }
}
app.post(
  "/api/courier/sync/:id",
  wrap(async (req, res) => {
    const o = await Order.findOne({
      _id: req.params.id,
      organizationId: tid(req),
    }).lean();
    if (!o) throw fail(404, "Order not found");
    const r = await syncShipment(tid(req), o);
    if (!r) throw fail(400, "This order has no courier consignment to sync");
    res.json({ success: true, ...r });
  }),
);

app.get(
  "/api/courier/shipments",
  wrap(async (req, res) => {
    const q = { organizationId: tid(req), "courier.provider": { $ne: null } };
    if (req.query.status) q.status = req.query.status;
    if (req.query.provider) q["courier.provider"] = req.query.provider;
    const rows = await Order.find(q)
      .sort({ "courier.bookedAt": -1, createdAt: -1 })
      .limit(300)
      .lean();
    const ready = await Order.find({
      organizationId: tid(req),
      status: { $in: ["confirmed", "processing", "packed"] },
    })
      .sort({ createdAt: 1 })
      .limit(300)
      .lean();
    res.json({
      shipments: rows.map((o) => orderRow(o, canSeePii(req))),
      ready: ready.map((o) => orderRow(o, canSeePii(req))),
    });
  }),
);
// COD reconciliation summary
app.get(
  "/api/courier/cod",
  wrap(async (req, res) => {
    const rows = await Order.aggregate([
      {
        $match: {
          organizationId: tid(req),
          paymentMethod: "COD",
          "courier.provider": { $ne: null },
        },
      },
      {
        $group: {
          _id: "$courier.provider",
          inTransit: {
            $sum: {
              $cond: [
                {
                  $in: [
                    "$status",
                    ["shipped", "out_for_delivery", "failed_delivery"],
                  ],
                },
                "$total",
                0,
              ],
            },
          },
          collected: {
            $sum: { $cond: [{ $eq: ["$status", "delivered"] }, "$total", 0] },
          },
          delivered: {
            $sum: { $cond: [{ $eq: ["$status", "delivered"] }, 1, 0] },
          },
          returned: {
            $sum: {
              $cond: [
                {
                  $in: [
                    "$status",
                    [
                      "returned_to_sender",
                      "returned_restocked",
                      "returned_damaged",
                    ],
                  ],
                },
                1,
                0,
              ],
            },
          },
          shipments: { $sum: 1 },
          charges: { $sum: { $ifNull: ["$courier.charge", 0] } },
        },
      },
    ]);
    res.json(
      rows.map((r) => ({
        provider: r._id,
        label: COURIERS[r._id]?.label || r._id,
        inTransit: r.inTransit,
        collected: r.collected,
        delivered: r.delivered,
        returned: r.returned,
        shipments: r.shipments,
        charges: r.charges,
        successRate:
          r.delivered + r.returned
            ? round((r.delivered / (r.delivered + r.returned)) * 100, 1)
            : null,
      })),
    );
  }),
);

/* =====================================================
   COMMENT ENGINE (SRS §8.2): rules first, AI only for free-form questions
   webhook -> spam filter -> intent + sentiment -> product link -> private-reply DM
   -> public reply (template with catalogue facts, validated) after the Page's delay or approval
   ===================================================== */
const sandboxOk = (req) =>
  !AUTH_ON || !!req.ctx?.superAdmin || process.env.SANDBOX_TOOLS === "on";
const DEFAULT_PAGE_CFG = {
  autoReply: true,
  delaySec: 30,
  manualApproval: false,
  privateReply: true,
  language: "auto",
  blockedKeywords: [],
  personaName: "",
  hideSpam: false,
};
async function pageCfg(org, pageId) {
  const [page, agent] = await Promise.all([
    SocialAccount.findOne({
      organizationId: org,
      platform: "Facebook",
      accountId: pageId,
    }).lean(),
    agentConfig(org),
  ]);
  return {
    ...DEFAULT_PAGE_CFG,
    autoReply: agent.commentAutoReply !== false,
    ...(page?.pageConfig || {}),
  };
}
const BN_DIGITS = "০১২৩৪৫৬৭৮৯";
const asciiDigits = (s) =>
  String(s || "").replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)));
const LEX = {
  complaint:
    /(fake|ভুয়া|ভুয়া|বাটপার|batpar|প্রতারক|protarok|scam|cheat|চিটার|chiter|worst|bad quality|খারাপ|kharap|নষ্ট|nosto|damaged|broken|ভাঙা|refund|রিফান্ড|ফেরত|ferot|ঠক|thok|পাইনি|পাই নাই|pai nai|paini|not received|late delivery|এখনো পাই|ekhono pai|ধোকা|dhoka|বাজে|baje)/i,
  order_intent:
    /(\border\b|অর্ডার|ordar|nibo|নিব|নেব|নিতে চাই|chai\b|চাই|lagbe|লাগবে|\bwant\b|\bbuy\b|kinbo|কিনব|কিনতে|confirm|কনফার্ম|\binbox\b|ইনবক্স|\bib\b|\bdm\b|\bpm\b|পিএম)/i,
  price:
    /(price|prize|\bdam\b|daam|দাম|প্রাইস|কত টাকা|koto taka|\bkoto\b|কত|\brate\b|\bcost\b|how much|\bprc\b|\bpp\b)/i,
  availability:
    /(available|avlbl|\bache\b|\base\b|আছে|stock|স্টক|pawa jabe|পাওয়া যাবে|পাওয়া যাবে|\bhobe\b|হবে কি)/i,
  size_colour:
    /(\bsize\b|সাইজ|\bcolou?r\b|কালার|রং|\bxxl\b|\bxl\b|\bl\b|\bm\b|\bs\b|chest|length|লম্বা|মাপ)/i,
  delivery:
    /(delivery|ডেলিভারি|courier|কুরিয়ার|shipping|charge|চার্জ|কবে পাব|kobe pabo|outside dhaka|ঢাকার বাইরে|home delivery|cod\b)/i,
  recommendation:
    /(which one|kon ta|konta|কোনটা|কোনটি|suggest|recommend|best one|ভালো হবে)/i,
};
const POSITIVE =
  /(nice|good|great|awesome|wow|love|beautiful|sundor|সুন্দর|ভালো|valo|bhalo|অসাধারণ|osadharon|দারুণ|darun|❤|😍|👍|🥰|💯)/i;
const NEGATIVE = /(😡|👎|🤬|💩|বাজে|খারাপ|worst|bad|hate|ফালতু|faltu)/i;
const SPAM_LINK =
  /(https?:\/\/|www\.|\.com\b|t\.me\/|bit\.ly|wa\.me|\bwhatsapp\b.*\d{6,})/i;
function classifyComment(text, cfg) {
  const t = String(text || "").trim();
  const blocked = (cfg.blockedKeywords || []).find(
    (k) => k && t.toLowerCase().includes(String(k).toLowerCase()),
  );
  const lettersOnly = t.replace(/[\s\p{P}\p{S}\p{Emoji_Presentation}‍️]/gu, "");
  if (blocked)
    return {
      intent: "spam",
      sentiment: "neutral",
      confidence: 100,
      reason: `Blocked keyword "${blocked}"`,
    };
  if (SPAM_LINK.test(t))
    return {
      intent: "spam",
      sentiment: "neutral",
      confidence: 95,
      reason: "Contains a link",
    };
  if (/(.)\1{9,}/u.test(t) || /(\b\S+\b)(\s+\1){4,}/i.test(t))
    return {
      intent: "spam",
      sentiment: "neutral",
      confidence: 90,
      reason: "Repeated text",
    };
  const sentiment =
    NEGATIVE.test(t) || LEX.complaint.test(t)
      ? "negative"
      : POSITIVE.test(t)
        ? "positive"
        : "neutral";
  if (!lettersOnly)
    return {
      intent: "general",
      sentiment,
      confidence: 90,
      reason: "Emoji only",
    };
  for (const k of [
    "complaint",
    "order_intent",
    "delivery",
    "price",
    "availability",
    "size_colour",
    "recommendation",
  ])
    if (LEX[k].test(t))
      return { intent: k, sentiment, confidence: 85, reason: "Keyword rule" };
  return {
    intent: "general",
    sentiment,
    confidence: t.length > 12 ? 40 : 70,
    reason: "No rule matched",
  };
}
function linkProducts(text, products, mapped = []) {
  if (mapped.length)
    return products.filter((p) => mapped.includes(String(p._id)));
  const t = normText(text);
  const words = t.split(" ").filter((w) => w.length >= 3);
  return products
    .map((p) => {
      const hay = normText(
        `${p.name} ${p.nameBn || ""} ${p.sku} ${(p.variants || []).map((v) => v.sku).join(" ")}`,
      );
      return {
        p,
        s:
          words.filter((w) => hay.includes(` ${w}`)).length +
          (hasTerm(t, p.sku) ? 3 : 0),
      };
    })
    .filter((x) => x.s >= 1)
    .sort((a, b) => b.s - a.s)
    .slice(0, 3)
    .map((x) => x.p);
}
const replyLang = (text, pref) =>
  pref === "bn" || pref === "en"
    ? pref
    : /[ঀ-৿]/.test(text)
      ? "bn"
      : /\b(the|is|are|price|how|please|what|available|want)\b/i.test(text) &&
          !/\b(koto|ache|dam|nibo|lagbe|vai|bhai|apu)\b/i.test(text)
        ? "en"
        : "bn";
const availNames = (p) =>
  (p.variants || [])
    .filter((v) => v.available > 0 && v.name !== "Default")
    .map((v) => v.name);
const inStock = (p) => (p.variants || []).some((v) => v.available > 0);
// Templates filled with catalogue facts only (FR-CMT-006)
function templateReply(intent, sentiment, products, zones, lang) {
  const p = products[0];
  const bn = lang === "bn";
  const prices = p
    ? [...new Set((p.variants || []).map((v) => priceOf(p, v)))].sort(
        (a, b) => a - b,
      )
    : [];
  const priceTxt =
    prices.length > 1
      ? `${tk(prices[0])}–${tk(prices[prices.length - 1])}`
      : prices.length
        ? tk(prices[0])
        : "";
  const sizes = p ? availNames(p).join(", ") : "";
  const inside =
    zones.find((z) => (z.districts || []).includes("Dhaka")) || zones[0];
  const outside = zones.find((z) => z.isDefault) || zones[zones.length - 1];
  switch (intent) {
    case "price":
      return p
        ? bn
          ? `${p.name} এর দাম ${priceTxt}। বিস্তারিত ইনবক্সে পাঠিয়েছি ✅`
          : `${p.name} is ${priceTxt}. We've sent you the details in inbox ✅`
        : bn
          ? "দাম ও বিস্তারিত ইনবক্সে পাঠিয়েছি, চেক করুন ✅"
          : "We've sent the price and details to your inbox ✅";
    case "availability":
      if (!p)
        return bn
          ? "ইনবক্সে বিস্তারিত পাঠিয়েছি ✅"
          : "Details sent to your inbox ✅";
      return inStock(p)
        ? bn
          ? `জি, ${p.name} স্টকে আছে ✅${sizes ? ` (${sizes})` : ""} অর্ডার করতে ইনবক্স চেক করুন।`
          : `Yes, ${p.name} is in stock ✅${sizes ? ` (${sizes})` : ""}. Check your inbox to order.`
        : bn
          ? `দুঃখিত, ${p.name} এখন স্টকে নেই। ইনবক্সে বিকল্প জানাচ্ছি 🙏`
          : `Sorry, ${p.name} is out of stock right now. We'll suggest options in inbox 🙏`;
    case "size_colour":
      return p && sizes
        ? bn
          ? `${p.name} পাওয়া যাচ্ছে: ${sizes}। ইনবক্সে বিস্তারিত পাঠিয়েছি ✅`
          : `${p.name} is available in: ${sizes}. Details sent to your inbox ✅`
        : bn
          ? "সাইজ/কালারের বিস্তারিত ইনবক্সে পাঠিয়েছি ✅"
          : "Size/colour details sent to your inbox ✅";
    case "delivery":
      return bn
        ? `ডেলিভারি চার্জ: ${inside.name} ${tk(inside.fee)}, ${outside.name} ${tk(outside.fee)}। ক্যাশ অন ডেলিভারি ✅`
        : `Delivery: ${inside.name} ${tk(inside.fee)}, ${outside.name} ${tk(outside.fee)}. Cash on delivery ✅`;
    case "order_intent":
      return bn
        ? "ধন্যবাদ! ইনবক্সে মেসেজ পাঠিয়েছি, সেখানে অর্ডারটি কনফার্ম করুন ✅"
        : "Thank you! We've messaged you, please confirm the order in inbox ✅";
    case "general":
      return sentiment === "positive"
        ? bn
          ? "ধন্যবাদ ❤️"
          : "Thank you ❤️"
        : null;
    default:
      return null;
  }
}
// G-19: a reply may only contain prices/fees that exist in the workspace data, and no discounts
function validateReply(text, products, zones) {
  const allowed = new Set(
    [
      ...products.flatMap((p) => [
        Number(p.price),
        Number(p.comparePrice),
        ...(p.variants || []).map((v) => priceOf(p, v)),
      ]),
      ...zones.flatMap((z) => [Number(z.fee), Number(z.freeOver)]),
    ].filter((n) => n > 0),
  );
  const t = asciiDigits(text);
  const money = [
    ...t.matchAll(
      /(?:৳|tk\.?|taka|টাকা|bdt)\s*([\d,]+)|([\d,]+)\s*(?:৳|tk\.?|taka|টাকা|bdt|\/-)/gi,
    ),
  ].map((m) => Number(String(m[1] || m[2]).replace(/,/g, "")));
  const bad = money.filter((n) => n > 0 && !allowed.has(n));
  if (bad.length)
    return `Mentions a price not in the catalogue (${bad.join(", ")})`;
  if (/(discount|ডিসকাউন্ট|ছাড়|ছাড়|% ?off|\d+ ?%|free gift|ফ্রি)/i.test(t))
    return "Mentions a discount or offer";
  return null;
}
async function aiCommentReply(org, cm, products, lang) {
  if (!aiConfigured()) return null;
  const k = await agentKnowledge(org, cm.message, null);
  const out = await aiJSON(
    org,
    "comment_reply",
    `You write ONE short public reply (max 2 lines) to a Facebook comment for a Bangladeshi shop, in ${lang === "bn" ? "Bangla" : "English"}. Use ONLY the facts given. Never invent prices, discounts or policies; if unsure say details were sent to inbox. No sales pitch for complaints. Return JSON {"reply":"","confident":true}`,
    `${k.text}\n\nLINKED PRODUCTS: ${products.map((p) => p.name).join(", ") || "-"}\nCOMMENT by ${cm.fromName}: ${cm.message}`,
    { temperature: 0.4, maxTokens: 300 },
  );
  return out?.confident === false
    ? null
    : String(out?.reply || "").trim() || null;
}

const isSimComment = (cm) => String(cm.commentId).startsWith("sim_");
async function pageTokenFor(org, pageId) {
  const page = await SocialAccount.findOne({
    organizationId: org,
    platform: "Facebook",
    accountId: pageId,
  }).select("+accessToken");
  if (!page) throw fail(400, "Facebook Page is not connected");
  return page;
}
async function postPublicReply(org, cm, text, by) {
  let replyId = `sim_reply_${Date.now()}`;
  if (!isSimComment(cm)) {
    const page = await pageTokenFor(org, cm.pageId);
    const r = await graph(`/${cm.commentId}/comments`, {
      token: tok(page),
      method: "POST",
      body: { message: text },
    });
    replyId = r.id;
  }
  cm.publicReply = {
    ...(cm.publicReply || {}),
    text,
    status: "sent",
    sentAt: new Date(),
    replyId,
    by,
  };
  cm.status = "replied";
  cm.markModified("publicReply");
}

// One private reply per comment (Meta rule). Opens / updates the Messenger conversation (FR-CMT-007)
async function sendPrivateReply(org, cm, products) {
  if (cm.privateReply?.status === "sent") return;
  const cfg = await agentConfig(org);
  const first = String(cm.fromName || "").split(" ")[0] || "there";
  let text = cfg.commentPrivateReply.replace(/\{name\}/g, first),
    draftOut = null;
  if (aiConfigured() && cfg.enabled) {
    try {
      const { out } = await runAgent(
        org,
        { messages: [], orderDraft: { items: [], status: "collecting" } },
        `(Public comment on our post${products.length ? ` about ${products.map((p) => p.name).join(", ")}` : ""}) ${cm.message}`,
      );
      if (
        !out.needsHuman &&
        (Number(out.confidence) || 0) >= cfg.escalateBelow &&
        out.reply
      ) {
        text = `Hi ${first}! 👋 ${out.reply}`;
        draftOut = out;
      }
    } catch (e) {
      console.warn("comment DM AI:", e.message);
    }
  }
  let psid = `sim_c_${cm.commentId}`,
    mid = null;
  if (!isSimComment(cm)) {
    const page = await pageTokenFor(org, cm.pageId);
    const sent = await graph(`/${page.accountId}/messages`, {
      token: tok(page),
      method: "POST",
      body: {
        recipient: { comment_id: cm.commentId },
        message: { text: text.slice(0, 2000) },
      },
    });
    psid = String(sent.recipient_id || `comment_${cm.commentId}`);
    mid = sent.message_id;
  }
  let convId;
  await withLock(`${org}:${psid}`, async () => {
    let c = await Conversation.findOne({ organizationId: org, psid });
    if (!c)
      c = new Conversation({
        organizationId: org,
        psid,
        channel: isSimComment(cm) ? "Simulator" : "Messenger",
        pageId: cm.pageId,
        customerName: cm.fromName || "Customer",
      });
    c.source = {
      type: "comment",
      commentId: cm.commentId,
      postId: cm.postId,
      text: cm.message,
    };
    c.markModified("source");
    pushMsg(c, "customer", cm.message, { fromComment: true });
    pushMsg(c, "ai", text, { privateReply: true, mid });
    c.aiHandled = (c.aiHandled || 0) + 1;
    if (draftOut) {
      mergeDraft(
        c,
        draftOut,
        await Product.find({
          organizationId: org,
          status: { $ne: "archived" },
        }).lean(),
      );
      await refreshDraftZone(org, c);
    }
    c.unread = (c.unread || 0) + 1;
    await ensureLead(org, c, cm.message);
    await c.save();
    convId = c.id;
  });
  cm.privateReply = {
    status: "sent",
    sentAt: new Date(),
    conversationId: convId,
  };
  cm.markModified("privateReply");
}

const BUY_INTENTS = [
  "price",
  "availability",
  "size_colour",
  "order_intent",
  "delivery",
  "recommendation",
];
async function ingestComment(org, d) {
  const cfg = await pageCfg(org, d.pageId);
  let cm;
  try {
    cm = await Comment.create({
      organizationId: org,
      pageId: d.pageId,
      commentId: d.commentId,
      postId: d.postId || null,
      parentId: d.parentId || null,
      fromId: d.fromId || null,
      fromName: d.fromName || "Someone",
      message: String(d.message || "").slice(0, 2000),
    });
  } catch (e) {
    if (e.code === 11000) return null;
    throw e;
  } // dedupe by comment_id
  const cls = classifyComment(cm.message, cfg);
  cm.intent = cls.intent;
  cm.sentiment = cls.sentiment;
  cm.reason = cls.reason;
  const [products, map, zones] = await Promise.all([
    Product.find({ organizationId: org, status: { $ne: "archived" } }).lean(),
    cm.postId
      ? PostProduct.findOne({ organizationId: org, postId: cm.postId }).lean()
      : null,
    orgZones(org),
  ]);
  const linked = linkProducts(cm.message, products, map?.productIds || []);
  cm.productIds = linked.map((p) => String(p._id));
  if (cls.intent === "spam") {
    cm.status = "spam";
    if (cfg.hideSpam && !isSimComment(cm)) {
      try {
        const page = await pageTokenFor(org, cm.pageId);
        await graph(`/${cm.commentId}`, {
          token: tok(page),
          method: "POST",
          body: { is_hidden: true },
        });
        cm.status = "hidden";
      } catch (e) {
        console.warn("hide spam:", e.message);
      }
    }
    await cm.save();
    return cm;
  }
  // Complaints / negative comments are never answered with sales copy (FR-CMT-012)
  if (cls.intent === "complaint" || cls.sentiment === "negative") {
    cm.status = "needs_human";
    await cm.save();
    await notify(
      org,
      "comment",
      `${cm.fromName} left a ${cls.intent === "complaint" ? "complaint" : "negative comment"}`,
      cm.message.slice(0, 140),
      "comments",
    );
    return cm;
  }
  if (cfg.privateReply && BUY_INTENTS.includes(cls.intent)) {
    try {
      await sendPrivateReply(org, cm, linked);
    } catch (e) {
      cm.privateReply = { status: "failed", error: e.message };
      cm.markModified("privateReply");
    }
  }
  if (!cfg.autoReply) {
    cm.status = cm.privateReply?.status === "sent" ? "replied" : "new";
    await cm.save();
    return cm;
  }
  const lang = replyLang(cm.message, cfg.language);
  let text = templateReply(cls.intent, cls.sentiment, linked, zones, lang),
    source = "template";
  if (!text && cls.confidence < 60 && cls.intent !== "spam") {
    try {
      text = await aiCommentReply(org, cm, linked, lang);
      source = "ai";
    } catch (e) {
      console.warn("comment AI:", e.message);
    }
  }
  if (!text) {
    cm.status = cm.privateReply?.status === "sent" ? "replied" : "ignored";
    cm.reason = cm.reason + " · no reply needed";
    await cm.save();
    return cm;
  }
  const invalid = validateReply(text, products, zones);
  if (invalid) {
    cm.status = "needs_human";
    cm.reason = `Reply blocked: ${invalid}`;
    cm.publicReply = { text, source, status: "blocked" };
    await cm.save();
    return cm;
  }
  cm.publicReply = {
    text,
    source,
    status: cfg.manualApproval ? "pending" : "scheduled",
  };
  cm.status = cfg.manualApproval ? "pending_approval" : "scheduled";
  cm.dueAt = cfg.manualApproval
    ? null
    : new Date(
        Date.now() +
          Math.max(0, Math.min(600, Number(cfg.delaySec) || 0)) * 1000,
      );
  await cm.save();
  return cm;
}
async function sendDueComments() {
  const due = await Comment.find({
    status: "scheduled",
    dueAt: { $lte: new Date() },
  })
    .sort({ dueAt: 1 })
    .limit(50);
  for (const cm of due) {
    const cfg = await pageCfg(cm.organizationId, cm.pageId);
    if (!cfg.autoReply) {
      cm.status = "pending_approval";
      await cm.save();
      continue;
    }
    try {
      await postPublicReply(cm.organizationId, cm, cm.publicReply.text, "AI");
    } catch (e) {
      cm.status = "failed";
      cm.publicReply = {
        ...cm.publicReply,
        status: "failed",
        error: e.message,
      };
      cm.markModified("publicReply");
    }
    await cm.save();
  }
}

// Called by the Meta webhook (feed field)
async function handleComment(page, v) {
  if (v.item !== "comment" || v.verb !== "add" || !v.message) return;
  if (String(v.from?.id) === String(page.accountId)) return; // our own comment
  if (v.parent_id && v.post_id && v.parent_id !== v.post_id) return; // only top-level comments
  await ingestComment(page.organizationId, {
    pageId: page.accountId,
    commentId: v.comment_id,
    postId: v.post_id,
    parentId: v.parent_id,
    fromId: v.from?.id,
    fromName: v.from?.name,
    message: v.message,
  });
}

/* ---------- comment routes ---------- */
const commentRow = (c) => ({
  id: c._id,
  pageId: c.pageId,
  commentId: c.commentId,
  postId: c.postId,
  from: c.fromName,
  message: c.message,
  intent: c.intent,
  sentiment: c.sentiment,
  status: c.status,
  reason: c.reason,
  productIds: c.productIds,
  publicReply: c.publicReply,
  privateReply: c.privateReply,
  dueAt: c.dueAt,
  createdAt: c.createdAt,
  simulated: isSimComment(c),
  postUrl:
    c.postId && !isSimComment(c)
      ? `https://www.facebook.com/${c.postId}`
      : null,
});
app.get(
  "/api/comments",
  wrap(async (req, res) => {
    const org = tid(req);
    const q = { organizationId: org };
    for (const f of ["status", "intent", "sentiment", "pageId", "postId"])
      if (req.query[f])
        q[f] = req.query[f].includes(",")
          ? { $in: req.query[f].split(",") }
          : req.query[f];
    if (req.query.q) {
      const re = new RegExp(escRe(req.query.q), "i");
      q.$or = [{ message: re }, { fromName: re }];
    }
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const [rows, total, counts] = await Promise.all([
      Comment.find(q)
        .sort({ createdAt: -1 })
        .skip((page - 1) * 50)
        .limit(50)
        .lean(),
      Comment.countDocuments(q),
      Comment.aggregate([
        { $match: { organizationId: org } },
        { $group: { _id: "$status", n: { $sum: 1 } } },
      ]),
    ]);
    const products = Object.fromEntries(
      (
        await Product.find({
          organizationId: org,
          _id: { $in: [...new Set(rows.flatMap((r) => r.productIds || []))] },
        })
          .select("name")
          .lean()
      ).map((p) => [p._id, p.name]),
    );
    res.json({
      rows: rows.map((c) => ({
        ...commentRow(c),
        products: (c.productIds || [])
          .map((id) => products[id])
          .filter(Boolean),
      })),
      total,
      page,
      counts: Object.fromEntries(counts.map((c) => [c._id, c.n])),
    });
  }),
);
app.get(
  "/api/comments/kpis",
  wrap(async (req, res) => {
    const org = tid(req);
    const r = periodRange({
      period: req.query.period || "7d",
      from: req.query.from,
      to: req.query.to,
    });
    const m = { organizationId: org, createdAt: { $gte: r.from, $lt: r.to } };
    const [total, autoReplied, dms, spam, human, pending] = await Promise.all([
      Comment.countDocuments(m),
      Comment.countDocuments({
        ...m,
        "publicReply.status": "sent",
        "publicReply.by": "AI",
      }),
      Comment.countDocuments({ ...m, "privateReply.status": "sent" }),
      Comment.countDocuments({
        ...m,
        status: { $in: ["spam", "hidden"] },
        intent: "spam",
      }),
      Comment.countDocuments({ organizationId: org, status: "needs_human" }),
      Comment.countDocuments({
        organizationId: org,
        status: "pending_approval",
      }),
    ]);
    res.json({ total, autoReplied, dms, spam, needsHuman: human, pending });
  }),
);
async function loadComment(req) {
  const cm = await Comment.findOne({
    _id: req.params.id,
    organizationId: tid(req),
  });
  if (!cm) throw fail(404, "Comment not found");
  return cm;
}
app.post(
  "/api/comments/:id/approve",
  wrap(async (req, res) => {
    const cm = await loadComment(req);
    const text = String(req.body.text || cm.publicReply?.text || "").trim();
    if (!text) throw fail(400, "Reply text is empty");
    const [products, zones] = await Promise.all([
      Product.find({ organizationId: tid(req) }).lean(),
      orgZones(tid(req)),
    ]);
    const bad = validateReply(text, products, zones);
    if (bad && !req.body.force)
      throw fail(400, `${bad}. Fix the text or send it as a manual reply.`);
    await postPublicReply(tid(req), cm, text, actor(req));
    await cm.save();
    audit(req, "comment.approve", cm.commentId);
    res.json({ success: true, comment: commentRow(cm) });
  }),
);
app.post(
  "/api/comments/:id/reply",
  wrap(async (req, res) => {
    const cm = await loadComment(req);
    const text = String(req.body.text || "").trim();
    if (!text) throw fail(400, "Write a reply");
    await postPublicReply(tid(req), cm, text, actor(req));
    cm.publicReply.source = "agent";
    await cm.save();
    audit(req, "comment.reply", cm.commentId);
    res.json({ success: true, comment: commentRow(cm) });
  }),
);
app.post(
  "/api/comments/:id/reject",
  wrap(async (req, res) => {
    const cm = await loadComment(req);
    cm.status = "ignored";
    cm.dueAt = null;
    cm.publicReply = {
      ...(cm.publicReply || {}),
      status: "rejected",
      by: actor(req),
    };
    cm.markModified("publicReply");
    await cm.save();
    res.json({ success: true });
  }),
);
app.post(
  "/api/comments/:id/dm",
  wrap(async (req, res) => {
    const cm = await loadComment(req);
    if (cm.privateReply?.status === "sent")
      throw fail(
        409,
        "A private reply was already sent (Meta allows one per comment)",
      );
    const products = await Product.find({
      organizationId: tid(req),
      _id: { $in: cm.productIds },
    }).lean();
    await sendPrivateReply(tid(req), cm, products);
    if (cm.status === "new" || cm.status === "needs_human")
      cm.status = "replied";
    await cm.save();
    audit(req, "comment.dm", cm.commentId);
    res.json({ success: true, conversationId: cm.privateReply.conversationId });
  }),
);
app.post(
  "/api/comments/:id/hide",
  wrap(async (req, res) => {
    const cm = await loadComment(req);
    const hide = req.body.hidden !== false;
    if (!isSimComment(cm)) {
      const page = await pageTokenFor(tid(req), cm.pageId);
      await graph(`/${cm.commentId}`, {
        token: tok(page),
        method: "POST",
        body: { is_hidden: hide },
      });
    }
    cm.status = hide ? "hidden" : "new";
    await cm.save();
    audit(req, hide ? "comment.hide" : "comment.unhide", cm.commentId);
    res.json({ success: true });
  }),
);
app.delete(
  "/api/comments/:id",
  wrap(async (req, res) => {
    const cm = await loadComment(req);
    if (!isSimComment(cm)) {
      const page = await pageTokenFor(tid(req), cm.pageId);
      await graph(`/${cm.commentId}`, { token: tok(page), method: "DELETE" });
    }
    cm.status = "deleted";
    await cm.save();
    audit(req, "comment.delete", cm.commentId, {
      from: cm.fromName,
      text: cm.message.slice(0, 80),
    });
    res.json({ success: true });
  }),
);
app.post(
  "/api/comments/bulk",
  wrap(async (req, res) => {
    const ids = (req.body.ids || []).slice(0, 100);
    let done = 0;
    const errors = [];
    for (const id of ids) {
      try {
        const cm = await Comment.findOne({ _id: id, organizationId: tid(req) });
        if (!cm) continue;
        if (req.body.action === "approve" && cm.status === "pending_approval") {
          await postPublicReply(tid(req), cm, cm.publicReply.text, actor(req));
          await cm.save();
        } else if (req.body.action === "reject") {
          cm.status = "ignored";
          cm.dueAt = null;
          await cm.save();
        } else continue;
        done++;
      } catch (e) {
        errors.push(e.message);
      }
    }
    res.json({ success: true, done, errors });
  }),
);

// Per-Page settings (FR-PAGE-003, FR-PAGE-005)
app.get(
  "/api/comments/pages",
  wrap(async (req, res) => {
    const org = tid(req);
    const pages = await SocialAccount.find({
      organizationId: org,
      platform: "Facebook",
    }).lean();
    const agent = await agentConfig(org);
    res.json(
      pages.map((p) => ({
        pageId: p.accountId,
        name: p.accountName,
        picture: p.picture || p.avatar || null,
        status: p.status,
        lastWebhookAt: p.lastWebhookAt || null,
        config: {
          ...DEFAULT_PAGE_CFG,
          autoReply: agent.commentAutoReply !== false,
          ...(p.pageConfig || {}),
        },
      })),
    );
  }),
);
app.put(
  "/api/comments/pages/:pageId",
  wrap(async (req, res) => {
    const b = req.body;
    const cfg = {
      autoReply: !!b.autoReply,
      delaySec: Math.max(0, Math.min(600, Number(b.delaySec) || 0)),
      manualApproval: !!b.manualApproval,
      privateReply: !!b.privateReply,
      language: ["auto", "bn", "en"].includes(b.language) ? b.language : "auto",
      blockedKeywords: lines(b.blockedKeywords),
      personaName: String(b.personaName || "").slice(0, 40),
      hideSpam: !!b.hideSpam,
    };
    const r = await SocialAccount.updateOne(
      {
        organizationId: tid(req),
        platform: "Facebook",
        accountId: req.params.pageId,
      },
      { pageConfig: cfg },
    );
    if (!r.matchedCount) throw fail(404, "Page not found");
    audit(req, "page.config", req.params.pageId, cfg);
    res.json({ success: true, config: cfg });
  }),
);

// Post -> product mapping (FR-INV-011)
app.get(
  "/api/comments/posts",
  wrap(async (req, res) => {
    const org = tid(req);
    const [posts, maps] = await Promise.all([
      Comment.aggregate([
        { $match: { organizationId: org, postId: { $ne: null } } },
        {
          $group: {
            _id: "$postId",
            pageId: { $first: "$pageId" },
            comments: { $sum: 1 },
            last: { $max: "$createdAt" },
          },
        },
        { $sort: { last: -1 } },
        { $limit: 100 },
      ]),
      PostProduct.find({ organizationId: org }).lean(),
    ]);
    const byPost = Object.fromEntries(maps.map((m) => [m.postId, m]));
    const ids = new Set([
      ...posts.map((p) => p._id),
      ...maps.map((m) => m.postId),
    ]);
    res.json(
      [...ids].map((id) => {
        const p = posts.find((x) => x._id === id);
        return {
          postId: id,
          pageId: p?.pageId || byPost[id]?.pageId || null,
          comments: p?.comments || 0,
          last: p?.last || null,
          productIds: byPost[id]?.productIds || [],
          caption: byPost[id]?.caption || "",
        };
      }),
    );
  }),
);
app.put(
  "/api/comments/posts/:postId",
  wrap(async (req, res) => {
    const ids = (req.body.productIds || []).map(String);
    if (!ids.length) {
      await PostProduct.deleteOne({
        organizationId: tid(req),
        postId: req.params.postId,
      });
      return res.json({ success: true });
    }
    await PostProduct.updateOne(
      { organizationId: tid(req), postId: req.params.postId },
      {
        $set: {
          productIds: ids,
          caption: String(req.body.caption || "").slice(0, 200),
          pageId: req.body.pageId || null,
        },
      },
      { upsert: true },
    );
    res.json({ success: true });
  }),
);

// Sandbox only (G-26): test the engine without Facebook
app.post(
  "/api/comments/simulate",
  wrap(async (req, res) => {
    if (!sandboxOk(req))
      throw fail(
        403,
        "The comment simulator is a sandbox tool for the platform admin",
      );
    const org = tid(req);
    const message = String(req.body.message || "").trim();
    if (!message) throw fail(400, "Write a test comment");
    const page = await SocialAccount.findOne({
      organizationId: org,
      platform: "Facebook",
    }).lean();
    const cm = await ingestComment(org, {
      pageId: req.body.pageId || page?.accountId || "sim_page",
      commentId: `sim_${crypto.randomBytes(6).toString("hex")}`,
      postId: req.body.postId || "sim_post",
      fromId: "sim_user",
      fromName: req.body.name || "Test customer",
      message,
    });
    res.json({ success: true, comment: commentRow(cm) });
  }),
);

/* ---------- video upload to n8n (existing) ---------- */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
});

app.post("/upload", upload.single("data"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No video." });
    if (!req.body.caption)
      return res.status(400).json({ error: "No caption." });

    const form = new FormData();
    form.append(
      "data",
      new Blob([req.file.buffer], { type: req.file.mimetype }),
      req.file.originalname,
    );
    form.append("caption", req.body.caption);

    const r = await fetch(
      process.env.N8N_UPLOAD_URL || `${N8N_BASE}/webhook-test/upload-video`,
      {
        method: "POST",
        body: form,
      },
    );

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
  try {
    await fn();
  } catch (e) {
    console.error(`job ${name}:`, e.message);
  } finally {
    RUNNING.delete(name);
  }
}
async function syncAll() {
  const orgs = await SocialAccount.distinct("organizationId");
  for (const org of orgs) {
    await checkTokens(org).catch((e) => console.warn("tokens:", e.message));
    const ads = await SocialAccount.find({
      organizationId: org,
      platform: "Meta Ads",
      status: { $nin: ["expired", "revoked"] },
    }).select("+accessToken");
    for (const a of ads)
      await syncAdAccount(org, a, 30).catch((e) =>
        console.warn(`ads ${a.accountId}:`, e.message),
      );
    if (ads.length) {
      await runAdRules(org).catch((e) => console.warn("rules:", e.message));
      await checkBudgets(org).catch((e) => console.warn("budget:", e.message));
    }
    await syncOrganic(org).catch((e) => console.warn("organic:", e.message));
    const comps = await Competitor.find({
      organizationId: org,
      igUsername: { $ne: null },
      $or: [
        { lastSnapshotAt: null },
        { lastSnapshotAt: { $lt: new Date(Date.now() - 20 * 3600e3) } },
      ],
    });
    for (const c of comps) {
      await snapshotCompetitor(org, c).catch((e) =>
        console.warn(`competitor ${c.name}:`, e.message),
      );
      await sleep(1500);
    }
  }
}
// Conversations with no customer message for 72h are closed (bot or human can still reopen)
async function autoCloseConversations() {
  await Conversation.updateMany(
    {
      status: "open",
      aiPaused: { $ne: true },
      updatedAt: { $lt: new Date(Date.now() - 72 * 3600e3) },
    },
    { status: "closed" },
  );
}
function startJobs() {
  if (process.env.JOBS === "off")
    return console.log("⏸️  Background jobs disabled (JOBS=off)");
  setInterval(() => runJob("publish", publishDue), 30e3);
  setInterval(() => runJob("followups", followUpReminders), 5 * 60e3);
  setInterval(() => runJob("sync", syncAll), 6 * 3600e3);
  setTimeout(() => runJob("sync", syncAll), 90e3);
  setInterval(() => runJob("comments", sendDueComments), 10e3);
  setInterval(() => runJob("courier", syncCouriers), 30 * 60e3);
  setTimeout(() => runJob("courier", syncCouriers), 120e3);
  setInterval(() => runJob("autoclose", autoCloseConversations), 3600e3);
  console.log(
    "⏱️  Background jobs: publishing 30s, comment replies 10s, courier sync 30m, Meta sync 6h",
  );
}
app.post(
  "/api/jobs/sync-all",
  wrap(async (_req, res) => {
    runJob("sync", syncAll);
    res.json({ success: true, started: true });
  }),
);

/* ---------- start ---------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🚀 Backend running on http://localhost:${PORT}`),
);
