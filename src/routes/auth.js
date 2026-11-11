// Sign up, log in, log out, "who am I", change password.
const router = require("express").Router();
const { User, Organization, Session } = require("../models");
const { handle, fail } = require("../lib/errors");
const { hashPassword, checkPassword } = require("../lib/crypto");
const { startSession, endSession, currentUser, requireLogin } = require("../middleware/auth");
const { DEFAULT_TENANT } = require("../config");

const validEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

router.post("/signup", handle(async (req, res) => {
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const business = String(req.body.business || "").trim() || `${name}'s shop`;
  if (name.length < 2) throw fail(400, "Write your name");
  if (!validEmail(email)) throw fail(400, "Write a valid email");
  if (password.length < 8) throw fail(400, "Password must be at least 8 characters");
  if (await User.exists({ email })) throw fail(409, "This email already has an account. Log in instead.");

  // The very first account takes over the existing workspace, so data from the old version stays
  let orgId;
  if (!(await User.exists({}))) {
    orgId = DEFAULT_TENANT;
    await Organization.updateOne({ _id: orgId }, { $set: { name: business } }, { upsert: true });
  } else {
    orgId = (await Organization.create({ name: business }))._id;
  }
  const user = await User.create({ organizationId: orgId, name, email, passwordHash: await hashPassword(password) });
  await startSession(req, res, user);
  res.json({ ok: true });
}));

const failedByIp = new Map(); // ip -> [timestamps]
router.post("/login", handle(async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const recent = (failedByIp.get(req.ip) || []).filter((t) => Date.now() - t < 15 * 60e3);
  if (recent.length >= 10) throw fail(429, "Too many wrong attempts. Wait 15 minutes.");

  const user = await User.findOne({ email }).select("+passwordHash");
  if (user?.lockedUntil > new Date()) throw fail(429, "This account is locked for 15 minutes after 5 wrong passwords.");
  if (!user || !(await checkPassword(req.body.password, user.passwordHash))) {
    failedByIp.set(req.ip, [...recent, Date.now()]);
    if (user) {
      user.failedLogins += 1;
      if (user.failedLogins >= 5) { user.lockedUntil = new Date(Date.now() + 15 * 60e3); user.failedLogins = 0; }
      await user.save();
    }
    throw fail(401, "Wrong email or password");
  }
  user.failedLogins = 0;
  user.lockedUntil = null;
  await user.save();
  await startSession(req, res, user);
  res.json({ ok: true });
}));

router.post("/logout", handle(async (req, res) => {
  await endSession(req, res);
  res.json({ ok: true });
}));

router.get("/me", handle(async (req, res) => {
  const who = await currentUser(req);
  if (!who) return res.status(401).json({ error: "Please log in", code: "LOGIN_REQUIRED" });
  const org = await Organization.findById(who.org).select("name").lean();
  res.json({ user: who.user, business: org?.name || "My business" });
}));

router.post("/password", requireLogin, handle(async (req, res) => {
  const user = await User.findById(req.user.id).select("+passwordHash");
  if (!(await checkPassword(req.body.current, user.passwordHash))) throw fail(400, "Current password is wrong");
  if (String(req.body.next || "").length < 8) throw fail(400, "New password must be at least 8 characters");
  user.passwordHash = await hashPassword(req.body.next);
  await user.save();
  await Session.deleteMany({ userId: user._id }); // log out everywhere...
  await startSession(req, res, user); // ...except here
  res.json({ ok: true });
}));

module.exports = router;
