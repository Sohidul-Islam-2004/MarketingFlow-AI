// Public legal pages (needed to publish the Meta app) + Meta's data-deletion and deauthorize callbacks.
// Fill BUSINESS_NAME, SUPPORT_EMAIL, BUSINESS_ADDRESS in .env
const router = require("express").Router();
const express = require("express");
const crypto = require("crypto");
const { ProcessedEvent } = require("../models");
const { LEGAL: L, META, PUBLIC_BASE_URL } = require("../config");

const UPDATED = "11 November 2026";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const page = (title, body) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · ${esc(L.BUSINESS_NAME)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:820px;margin:40px auto;padding:0 20px;color:#14211a;line-height:1.65}h1{font-size:30px;margin-bottom:4px}h2{font-size:19px;margin-top:30px}.muted{color:#5f6b63}a{color:#0b7a2b}code{background:#eef1ea;padding:2px 6px;border-radius:6px}footer{margin-top:50px;border-top:1px solid #e3e7df;padding-top:16px;font-size:13px}</style></head>
<body><h1>${title}</h1><p class="muted">${esc(L.BUSINESS_NAME)} · Last updated ${UPDATED}</p>${body}
<footer class="muted"><a href="/privacy">Privacy Policy</a> · <a href="/terms">Terms of Service</a> · <a href="/data-deletion">Data Deletion</a> · Contact: <a href="mailto:${esc(L.SUPPORT_EMAIL)}">${esc(L.SUPPORT_EMAIL)}</a></footer></body></html>`;

router.get("/privacy", (_req, res) => res.send(page("Privacy Policy", `
<p>${L.BUSINESS_NAME} ("we", "us") provides software that helps businesses manage their Facebook Pages, Instagram professional accounts, Messenger conversations, and orders. This policy explains what data we process and why.</p>
<h2>1. Who this applies to</h2>
<p><b>Business users</b> who sign in and connect their Meta accounts, and <b>their customers</b> who message or comment on those businesses' Facebook Pages or Instagram accounts.</p>
<h2>2. Data we collect</h2>
<ul>
<li><b>From Facebook Login (business users):</b> your name, the Pages and Instagram professional accounts you choose to connect, and access tokens that let us act for you. Tokens are encrypted at rest.</li>
<li><b>Page and Instagram content:</b> posts, media, publishing results and insights (reach, engagement, followers) of the accounts you connect.</li>
<li><b>Messages and comments:</b> when a customer messages or comments on a connected Page or Instagram account, we receive the message text, the page-scoped ID, name and profile picture provided by Meta, and the conversation history.</li>
<li><b>Order details</b> that customers give in a conversation: name, phone number, delivery address, products and quantities.</li>
<li><b>Technical data:</b> logs needed to run and secure the service.</li>
</ul>
<h2>3. How we use data</h2>
<ul>
<li>To publish and schedule content for the business that connected the account.</li>
<li>To reply to customer messages and comments (automatically with AI or by the business's staff) and prepare orders.</li>
<li>To detect fraud risk on cash-on-delivery orders (risk scores are shown to the business and reviewed by people; we never label a person a fraudster automatically).</li>
<li>To keep the service secure and fix problems.</li>
</ul>
<p>We do <b>not</b> sell personal data and do not use Meta Platform Data for advertising outside the business's own account.</p>
<h2>4. AI processing</h2>
<p>Message text and business information may be sent to our AI provider to generate replies, content and analysis. Providers process the data only to return the result to us. AI answers use only information the business has approved.</p>
<h2>5. Sharing</h2>
<p>Data is shared only with: the business that owns the connected account and its staff; service providers that host or process data for us (cloud hosting, database, AI provider); and authorities when the law requires it.</p>
<h2>6. Retention</h2>
<p>We keep data while the business account is active. When a business disconnects an account or deletes its workspace, related tokens and data are deleted within 30 days, except where the law requires us to keep records (for example invoices).</p>
<h2>7. Your rights and data deletion</h2>
<p>You can ask to access, correct or delete your data. See <a href="/data-deletion">Data Deletion Instructions</a> or email <a href="mailto:${L.SUPPORT_EMAIL}">${L.SUPPORT_EMAIL}</a>. Customers of a business can also contact that business directly.</p>
<h2>8. Security</h2>
<p>Access tokens are encrypted (AES-256-GCM), connections use HTTPS, and access to data is limited to the business that owns it.</p>
<h2>9. Children</h2>
<p>The service is for businesses and is not directed at children under 13.</p>
<h2>10. Changes and contact</h2>
<p>We may update this policy and will change the date above. Questions: <a href="mailto:${L.SUPPORT_EMAIL}">${L.SUPPORT_EMAIL}</a> · ${L.BUSINESS_ADDRESS}</p>`)));

router.get("/terms", (_req, res) => res.send(page("Terms of Service", `
<h2>1. The service</h2><p>${L.BUSINESS_NAME} provides tools to plan, create and publish social media content, handle customer messages and comments with AI assistance, and manage orders and stock.</p>
<h2>2. Your account</h2><p>You must have the right to connect each Page and Instagram account you connect, and you are responsible for activity in your workspace.</p>
<h2>3. Acceptable use</h2><p>You must follow Meta's Platform Terms, Community Standards and Messenger Platform policies, and applicable law. Do not use the service for spam, misleading claims, or to collect data you are not allowed to collect.</p>
<h2>4. AI features</h2><p>AI-generated content and replies can be wrong. You are responsible for reviewing approvals, prices, offers and orders.</p>
<h2>5. Payments</h2><p>Paid plans are billed as shown in the app.</p>
<h2>6. Liability</h2><p>The service is provided "as is". To the extent the law allows, we are not liable for indirect losses, lost profits or losses caused by third-party platforms.</p>
<h2>7. Termination</h2><p>You can stop using the service at any time. We may suspend accounts that break these terms.</p>
<h2>8. Contact</h2><p><a href="mailto:${L.SUPPORT_EMAIL}">${L.SUPPORT_EMAIL}</a> · ${L.BUSINESS_ADDRESS}</p>`)));

router.get("/data-deletion", async (req, res) => {
  let status = "";
  if (req.query.code) {
    const found = await ProcessedEvent.exists({ _id: `deletion:${String(req.query.code).slice(0, 40)}` }).catch(() => null);
    status = found
      ? `<p style="background:#e9f8df;padding:12px;border-radius:10px">Request <code>${esc(req.query.code)}</code> was received. Your data is deleted within 30 days.</p>`
      : `<p style="background:#fff4e5;padding:12px;border-radius:10px">No recent request with code <code>${esc(req.query.code)}</code>. Email us if you need help.</p>`;
  }
  res.send(page("Data Deletion Instructions", `${status}
<h2>Business users (Facebook Login)</h2><ol>
<li>In the app, open <b>Meta Accounts</b> and press <b>Disconnect</b> on each account. Its encrypted token is deleted immediately.</li>
<li>Remove the app from Facebook: <b>Settings &amp; privacy → Settings → Business integrations</b> → select ${esc(L.BUSINESS_NAME)} → <b>Remove</b>.</li>
<li>Or email <a href="mailto:${esc(L.SUPPORT_EMAIL)}">${esc(L.SUPPORT_EMAIL)}</a> with the subject "Delete my data".</li></ol>
<h2>Customers who messaged a business</h2>
<p>Email <a href="mailto:${esc(L.SUPPORT_EMAIL)}">${esc(L.SUPPORT_EMAIL)}</a> with the business name and the Facebook/Instagram name you used. We delete your conversation and personal order details (except records the business must keep by law) within 30 days.</p>`));
});

// Meta sends a "signed_request" signed with the app secret
function readSignedRequest(signed) {
  if (!signed || !META.APP_SECRET) return null;
  const [sig, payload] = String(signed).split(".");
  if (!sig || !payload) return null;
  const decode = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const expected = crypto.createHmac("sha256", META.APP_SECRET).update(payload).digest();
  const got = decode(sig);
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return null;
  return JSON.parse(decode(payload).toString("utf8"));
}

// App Dashboard → Settings → Basic → "Data deletion request URL" = https://YOUR-DOMAIN/api/meta/data-deletion
router.post("/api/meta/data-deletion", express.urlencoded({ extended: false }), async (req, res) => {
  const data = readSignedRequest(req.body?.signed_request);
  if (!data) return res.status(400).json({ error: "Invalid signed_request" });
  const code = crypto.randomBytes(8).toString("hex");
  await ProcessedEvent.create({ _id: `deletion:${code}` }).catch(() => {});
  console.log(`🗑️  Meta data deletion request for app user ${data.user_id}, code ${code}. Delete their data within 30 days.`);
  res.json({ url: `${PUBLIC_BASE_URL}/data-deletion?code=${code}`, confirmation_code: code });
});

// App Dashboard → Facebook Login → "Deauthorize callback URL" = https://YOUR-DOMAIN/api/meta/deauthorize
router.post("/api/meta/deauthorize", express.urlencoded({ extended: false }), (req, res) => {
  const data = readSignedRequest(req.body?.signed_request);
  if (!data) return res.sendStatus(400);
  console.log("Meta: a user removed the app:", data.user_id);
  res.sendStatus(200);
});

module.exports = router;
