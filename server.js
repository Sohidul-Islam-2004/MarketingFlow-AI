// MarketingFlow AI: start here.
// Folder map:
//   src/config.js      settings from .env
//   src/models/        MongoDB collections (one file each)
//   src/lib/           small tools (errors, Facebook API, AI, Bangladesh places, encryption)
//   src/services/      business logic (orders, stock, AI agent, comments, publishing, page + website reader)
//   src/routes/        URLs the dashboard calls (/api/...)
//   public/            the dashboard (HTML, CSS, one JS file per page)
const path = require("path");
const express = require("express");
const config = require("./src/config");
const { connectDB } = require("./src/db");
const { requireLogin, requireAdmin } = require("./src/middleware/auth");
const { startJobs } = require("./src/jobs");
const { registerWebhooks } = require("./src/services/webhookSetup");
const meta = require("./src/routes/meta");

const app = express();
app.set("trust proxy", true); // behind Cloudflare tunnel / nginx: read the real https + IP
// rawBody is needed to check Meta's webhook signature
app.use(express.json({ limit: "2mb", verify: (req, _res, buf) => { req.rawBody = buf; } }));

// Public: dashboard files, uploaded media (Meta downloads it), legal pages, webhooks
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(path.join(__dirname, "uploads"), { maxAge: "7d" }));
app.use(require("./src/routes/legal"));
app.use("/webhooks/meta", require("./src/routes/webhooks"));
app.use("/api/auth", require("./src/routes/auth"));
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// Facebook Login (browser redirects, the session cookie identifies the workspace)
app.get("/api/meta/connect", meta.startConnect);
app.get("/auth/facebook/callback", meta.finishConnect);

// Everything below needs a logged-in user (req.user, req.org)
app.use("/api", requireLogin);
app.use("/api", require("./src/routes/overview"));
app.use("/api/products", require("./src/routes/products"));
app.use("/api/orders", require("./src/routes/orders"));
app.use("/api/inbox", require("./src/routes/inbox"));
app.use("/api/comments", require("./src/routes/comments"));
app.use("/api/content", require("./src/routes/content"));
app.use("/api/media", require("./src/routes/media"));
app.use("/api/accounts", meta.router);
app.use("/api/learn", require("./src/routes/learn"));
app.use("/api/admin", requireAdmin, require("./src/routes/admin")); // Super Admin only
app.use("/api/settings", require("./src/routes/settings"));
app.use("/api", (req, res) => res.status(404).json({ error: `Unknown API: ${req.method} ${req.originalUrl}` }));

connectDB()
  .then(() => {
    app.listen(config.PORT, () => {
      console.log(`🚀 Running on http://localhost:${config.PORT}`);
      registerWebhooks(); // tells Meta where to send messages/comments (no manual dashboard step)
    });
    if (config.JOBS_ON) startJobs();
  })
  .catch((e) => {
    console.error("❌ Could not connect to MongoDB:", e.message);
    process.exit(1);
  });
