// Login sessions with an HttpOnly cookie.
// After requireLogin runs, every route has req.user and req.org (the workspace id).
const { Session, User, Organization } = require("../models");
const { isAdminEmail, blockedReason } = require("../services/account");
const { sha256, randomToken } = require("../lib/crypto");
const { DAY } = require("../lib/utils");

const COOKIE = "mf_session";
const SESSION_DAYS = 30;

function readCookie(req, name) {
  const pair = String(req.headers.cookie || "").split(";").map((c) => c.trim()).find((c) => c.startsWith(name + "="));
  return pair ? decodeURIComponent(pair.slice(name.length + 1)) : null;
}

function writeCookie(req, res, value, maxAgeSeconds) {
  const https = req.secure || String(req.headers["x-forwarded-proto"] || "").includes("https");
  res.setHeader("Set-Cookie", `${COOKIE}=${value}; HttpOnly; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax${https ? "; Secure" : ""}`);
}

async function startSession(req, res, user) {
  const token = randomToken();
  await Session.create({ _id: sha256(token), userId: user._id || user.id, organizationId: user.organizationId, expiresAt: new Date(Date.now() + SESSION_DAYS * DAY) });
  writeCookie(req, res, token, SESSION_DAYS * 86400);
}

async function endSession(req, res) {
  const token = readCookie(req, COOKIE);
  remembered.clear();
  if (token) await Session.deleteOne({ _id: sha256(token) });
  writeCookie(req, res, "", 0);
}

// Returns { user, org } for the logged-in person, or null
const remembered = new Map(); // session id -> { who, until }
async function currentUser(req) {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  const id = sha256(token);
  const hit = remembered.get(id);
  if (hit && hit.until > Date.now()) return hit.who;
  const session = await Session.findById(id).lean();
  if (!session || session.expiresAt < new Date()) return null;
  const user = await User.findById(session.userId).lean();
  if (!user) return null;
  const org = await Organization.findById(user.organizationId).select("suspended expiresAt").lean();
  const isAdmin = isAdminEmail(user.email);
  const who = {
    user: { id: user._id, name: user.name, email: user.email, isAdmin },
    org: user.organizationId,
    blocked: isAdmin ? null : blockedReason(org), // "suspended" | "expired" | null
    expiresAt: org?.expiresAt || null,
  };
  if (remembered.size > 5000) remembered.clear();
  remembered.set(id, { who, until: Date.now() + 60000 });
  return who;
}
const forgetSessions = () => remembered.clear(); // call after a password change

async function requireLogin(req, res, next) {
  try {
    const who = await currentUser(req);
    if (!who) return res.status(401).json({ error: "Please log in", code: "LOGIN_REQUIRED" });
    if (who.blocked) return res.status(403).json({ error: who.blocked === "expired" ? "Your plan has ended" : "Your account is suspended", code: "ACCOUNT_BLOCKED" });
    req.user = who.user;
    req.org = who.org;
    next();
  } catch (e) {
    next(e);
  }
}

// Only for routes/admin.js (put it after requireLogin)
function requireAdmin(req, res, next) {
  if (!req.user?.isAdmin) return res.status(403).json({ error: "Super Admin only" });
  next();
}

module.exports = { requireAdmin, requireLogin, currentUser, startSession, endSession, forgetSessions };
