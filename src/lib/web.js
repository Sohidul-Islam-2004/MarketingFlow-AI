// Reading public web pages (used by services/learn.js to read a shop's website).
//   fetchPage(url)  -> { url, html }   safe: only public http(s) addresses, 1.5 MB max, 12 s max
//   textOf(html)    -> readable text without tags, scripts and styles
//   linksOf(html, pageUrl) -> absolute links on the same website
//   metaOf(html)    -> { title, description, image, price, product } from <title>, og: tags and JSON-LD
const dns = require("dns").promises;
const net = require("net");
const { fail } = require("./errors");

const MAX_BYTES = 1.5e6;

// Never let a user make our server read its own network (localhost, 10.x, 192.168.x, cloud metadata...)
function isPrivate(ip) {
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return isPrivate(v.slice(7));
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

async function checkAddress(url) {
  const u = new URL(url);
  if (!["http:", "https:"].includes(u.protocol)) throw fail(400, "Only http and https websites can be read");
  if (process.env.ALLOW_LOCAL_WEBSITES === "1") return; // automated tests only
  if (u.port && !["80", "443"].includes(u.port)) throw fail(400, "This website address is not allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const ips = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((x) => x.address);
  if (!ips.length) throw fail(400, `Website not found: ${u.hostname}`);
  if (ips.some(isPrivate)) throw fail(400, "This website address is not allowed");
}

async function fetchPage(url) {
  let current = url;
  for (let hop = 0; hop < 5; hop++) { // follow redirects by hand so every hop is checked
    await checkAddress(current);
    const res = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(12000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MarketingFlowBot/1.0)", Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5", "Accept-Language": "bn,en;q=0.8" },
    }).catch((e) => { throw fail(502, e.name === "TimeoutError" ? "The website took too long to answer" : "Could not open the website"); });

    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) { current = new URL(res.headers.get("location"), current).href; continue; }
    if (!res.ok) throw fail(502, `The website answered with error ${res.status}`);
    if (!/html|json|text/i.test(res.headers.get("content-type") || "text/html")) throw fail(415, "Not a web page");

    // read at most MAX_BYTES
    const chunks = []; let size = 0;
    for await (const chunk of res.body) { chunks.push(chunk); size += chunk.length; if (size > MAX_BYTES) break; }
    return { url: current, html: Buffer.concat(chunks).toString("utf8") };
  }
  throw fail(502, "Too many redirects");
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'", "#8217": "’", "#2547": "৳" };
const decode = (s) => String(s || "").replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, code) => {
  if (ENTITIES[code.toLowerCase()]) return ENTITIES[code.toLowerCase()];
  if (code[0] === "#") { const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10); return n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : " "; }
  return m;
});

function textOf(html) {
  return decode(
    String(html || "")
      .replace(/<(head|script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\/(p|div|li|ul|h[1-6]|tr|section|article|nav|header|footer)\s*>|<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  ).replace(/[ \t\r]+/g, " ").replace(/\n\s*\n+/g, "\n").replace(/^ +| +$/gm, "").trim();
}

const sameSite = (a, b) => a.hostname.replace(/^www\./, "") === b.hostname.replace(/^www\./, "");

function linksOf(html, pageUrl) {
  const base = new URL(pageUrl), found = new Map();
  for (const m of String(html || "").matchAll(/<a\b[^>]*?href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const u = new URL(decode(m[1]), base);
      if (!sameSite(u, base) || !/^https?:$/.test(u.protocol)) continue;
      if (/\.(jpe?g|png|gif|webp|svg|pdf|zip|css|js|mp4)$/i.test(u.pathname)) continue;
      u.hash = "";
      if (!found.has(u.href)) found.set(u.href, textOf(m[2]).slice(0, 80));
    } catch { /* not a link */ }
  }
  return [...found].map(([url, label]) => ({ url, label }));
}

const metaTag = (html, name) => {
  const m = html.match(new RegExp(`<meta[^>]+(?:property|name)\\s*=\\s*["']${name}["'][^>]*>`, "i"));
  return m ? decode((m[0].match(/content\s*=\s*["']([^"']*)["']/i) || [])[1] || "") : "";
};

// Finds a schema.org Product inside <script type="application/ld+json"> (many shop platforms add it)
function jsonLdProduct(html) {
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const list = [].concat(JSON.parse(m[1].trim())).flatMap((x) => (x && x["@graph"]) || x);
      const p = list.find((x) => x && [].concat(x["@type"]).includes("Product"));
      if (!p) continue;
      const offer = [].concat(p.offers || [])[0] || {};
      return { name: decode(p.name), description: textOf(p.description || "").slice(0, 600), image: [].concat(p.image || [])[0] || "", price: Number(offer.price ?? offer.lowPrice) || null, category: decode(p.category || "") };
    } catch { /* broken JSON: ignore */ }
  }
  return null;
}

function metaOf(html) {
  const h = String(html || "");
  return {
    title: metaTag(h, "og:title") || decode((h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "").trim(),
    description: metaTag(h, "og:description") || metaTag(h, "description"),
    image: metaTag(h, "og:image"),
    price: Number(metaTag(h, "product:price:amount") || metaTag(h, "og:price:amount")) || null,
    product: jsonLdProduct(h),
  };
}

module.exports = { fetchPage, textOf, linksOf, metaOf };
