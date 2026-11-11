// Small helpers used across the app.
const DAY = 24 * 60 * 60 * 1000;

// Keep only the listed keys of an object (used to accept safe fields from the browser)
const pick = (obj, keys) => Object.fromEntries(Object.entries(obj || {}).filter(([k]) => keys.includes(k)));

// "a, b\nc" or ["a","b"] -> ["a","b","c"]
const toList = (v) => (Array.isArray(v) ? v : String(v || "").split(/\r?\n|,/)).map((s) => String(s).trim()).filter(Boolean);

// Escape text before putting it in a RegExp
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 1250 -> "৳1,250"
const taka = (n) => "৳" + Number(n || 0).toLocaleString("en-IN");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Bangladesh time (UTC+6, no daylight saving)
const dhakaToday = () => new Date(Date.now() + 6 * 3600e3).toISOString().slice(0, 10);
const dhakaMidnight = (ymd) => new Date(`${ymd}T00:00:00+06:00`);

// "+880 1712-345678" -> "01712345678"
function normalizePhone(p) {
  let d = String(p || "").replace(/[০-৯]/g, (c) => "০১২৩৪৫৬৭৮৯".indexOf(c)).replace(/\D/g, "");
  if (d.startsWith("880")) d = d.slice(2);
  if (d.length === 10 && d.startsWith("1")) d = "0" + d;
  return d;
}
const isValidPhone = (p) => /^01[3-9]\d{8}$/.test(p || "");

module.exports = { DAY, pick, toList, escapeRegex, taka, sleep, dhakaToday, dhakaMidnight, normalizePhone, isValidPhone };
