// Token encryption (AES-256-GCM) and password hashing (scrypt).
const crypto = require("crypto");
const { TOKEN_ENC_KEY } = require("../config");
const { fail } = require("./errors");

const KEY = (() => {
  if (/^[0-9a-f]{64}$/i.test(TOKEN_ENC_KEY)) return Buffer.from(TOKEN_ENC_KEY, "hex");
  console.warn("⚠️  TOKEN_ENC_KEY is missing or not 64 hex characters. Using a development key.");
  return crypto.createHash("sha256").update("marketingflow-dev-key").digest();
})();

function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const data = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
  return ["enc:v1", iv.toString("hex"), cipher.getAuthTag().toString("hex"), data.toString("hex")].join(":");
}

function decrypt(stored) {
  if (!stored || !String(stored).startsWith("enc:v1:")) return stored; // old plain-text value
  const [, , iv, tag, data] = String(stored).split(":");
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, Buffer.from(iv, "hex"));
    decipher.setAuthTag(Buffer.from(tag, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(data, "hex")), decipher.final()]).toString("utf8");
  } catch {
    throw fail(401, "Saved Facebook token can't be read (TOKEN_ENC_KEY changed). Reconnect your Facebook Page.");
  }
}

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("hex");

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(String(password), salt, 64, (err, key) => (err ? reject(err) : resolve(`scrypt$${salt.toString("hex")}$${key.toString("hex")}`)));
  });
}

function checkPassword(password, stored) {
  return new Promise((resolve) => {
    const [, salt, hash] = String(stored || "").split("$");
    if (!salt || !hash) return resolve(false);
    crypto.scrypt(String(password), Buffer.from(salt, "hex"), 64, (err, key) => {
      const expected = Buffer.from(hash, "hex");
      resolve(!err && key.length === expected.length && crypto.timingSafeEqual(key, expected));
    });
  });
}

module.exports = { encrypt, decrypt, sha256, randomToken, hashPassword, checkPassword };
