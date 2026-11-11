// Login sessions with an HttpOnly cookie.
// After requireLogin runs, every route has req.user and req.org (the workspace id).
const { Session, User } = require("../models");
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
  if (token) await Session.deleteOne({ _id: sha256(token) });
  writeCookie(req, res, "", 0);
}

// Returns { user, org } for the logged-in person, or null
async function currentUser(req) {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  const session = await Session.findById(sha256(token)).lean();
  if (!session || session.expiresAt < new Date()) return null;
  const user = await User.findById(session.userId).lean();
  if (!user) return null;
  return { user: { id: user._id, name: user.name, email: user.email }, org: user.organizationId };
}

async function requireLogin(req, res, next) {
  try {
    const who = await currentUser(req);
    if (!who) return res.status(401).json({ error: "Please log in", code: "LOGIN_REQUIRED" });
    req.user = who.user;
    req.org = who.org;
    next();
  } catch (e) {
    next(e);
  }
}

module.exports = { requireLogin, currentUser, startSession, endSession };
