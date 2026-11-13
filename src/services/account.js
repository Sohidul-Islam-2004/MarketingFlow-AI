// Customer accounts: is the shop allowed to use the app, and one-time "set your password" links.
// Used by: middleware/auth.js (blocks the dashboard), agent.js + comments.js (AI stays quiet),
// routes/admin.js (Super Admin) and routes/auth.js (set-password page).
const { User } = require("../models");
const { sha256, randomToken } = require("../lib/crypto");
const { SUPER_ADMIN_EMAILS, PUBLIC_BASE_URL } = require("../config");

const LINK_DAYS = 7;

const isAdminEmail = (email) => SUPER_ADMIN_EMAILS.includes(String(email || "").toLowerCase());

// Why a shop can't use the app right now: "suspended", "expired" or null (all good)
function blockedReason(org) {
  if (!org) return null;
  if (org.suspended) return "suspended";
  if (org.expiresAt && new Date(org.expiresAt) < new Date()) return "expired";
  return null;
}

// Makes a new "set your password" link for this user (used for invites and password resets).
// Only the hash is stored, so a database leak can't be used to log in.
async function passwordLink(userId, req) {
  const token = randomToken();
  await User.updateOne({ _id: userId }, { resetTokenHash: sha256(token), resetExpiresAt: new Date(Date.now() + LINK_DAYS * 86400e3) });
  // PUBLIC_BASE_URL is best; without it the link uses the address the admin opened the site with
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0] || (req.secure ? "https" : "http");
  const base = PUBLIC_BASE_URL || `${proto}://${req.headers.host}`;
  return { link: `${base}/#set-password?token=${token}`, days: LINK_DAYS };
}

module.exports = { isAdminEmail, blockedReason, passwordLink };
