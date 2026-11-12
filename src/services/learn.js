// "AI Training": reads the shop's Facebook Page and website, and lets the AI write
//   1) the shop knowledge (delivery, returns, payment, stores, FAQ...) and
//   2) a list of products with prices.
// Nothing is saved to the shop here. The result goes into a ShopScan, the seller checks it on the
// AI Training page and presses Save (routes/learn.js).
//
//   startScan(org, website)  -> starts the work in the background
//   Steps: readPage -> readWebsite -> writeKnowledge -> findProducts
const { SocialAccount, ShopScan, Organization } = require("../models");
const { graph } = require("../lib/graph");
const { decrypt } = require("../lib/crypto");
const { askAI, aiReady } = require("../lib/ai");
const { fail } = require("../lib/errors");
const { fetchPage, textOf, linksOf, metaOf } = require("../lib/web");
const { normalizeText } = require("../lib/places");

const LIMITS = { infoPages: 8, listPages: 6, productPages: 40, posts: 48, knowledgeChars: 12000 };

// Which links are worth reading
const SKIP = /(login|signin|sign-in|register|signup|cart|checkout|wishlist|account|password|privacy|cookie|compare|track|\/tag\/|\/blog|\/feed|javascript:|mailto:|tel:)/i;
const INFO = /(about|delivery|shipping|return|refund|exchange|faq|contact|polic|terms|store|outlet|branch|payment|how-to|size|guide|help|support|warranty)/i;
const PRODUCT = /(product-details|\/products?\/[^/]+|\/item\/|\/p\/[^/]+|\/shop\/[^/]+\/[^/]+)/i;
const LISTING = /(\/shop\/?$|^shop$|categor|collection|\/products\/?$|^products$|new-arrival|new arrival|catalog)/i;

const running = new Set(); // workspaces with a scan in progress

/* ---------- 1. Facebook Page ---------- */
async function readPage(org) {
  const page = await SocialAccount.findOne({ organizationId: org, platform: "Facebook" }).select("+accessToken");
  if (!page) return null;
  const token = decrypt(page.accessToken);
  // some Pages don't have every field, so fall back to the basic ones
  const info = await graph(`/${page.accountId}`, { token, params: { fields: "name,about,description,phone,emails,website,single_line_address,category" } })
    .catch(() => graph(`/${page.accountId}`, { token, params: { fields: "name,about" } }))
    .catch(() => ({ name: page.accountName }));
  const posts = await graph(`/${page.accountId}/posts`, { token, params: { fields: "message,created_time,full_picture,permalink_url", limit: 50 } })
    .then((r) => (r.data || []).filter((p) => p.message && p.message.length > 20).slice(0, LIMITS.posts))
    .catch(() => []);
  return { info, posts };
}

/* ---------- 2. Website ---------- */
// Runs fn over the list, a few at a time. Failed items are skipped.
async function eachLimited(list, limit, fn) {
  const out = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (next < list.length) { const i = next++; out[i] = await fn(list[i]).catch(() => null); }
  }));
  return out.filter(Boolean);
}

async function readWebsite(website, say) {
  // some small shops still have no https: try plain http once before giving up
  const home = await fetchPage(website).catch((e) => (website.startsWith("https://") ? fetchPage(website.replace("https://", "http://")).catch(() => { throw e; }) : Promise.reject(e)));
  // a link is picked by its address ("/menu/shipping-delivery") or by its text ("Delivery info")
  const pick = (links, test, max) => links.filter((l) => !SKIP.test(l.url) && (test.test(new URL(l.url).pathname) || test.test(l.label))).slice(0, max);
  const homeLinks = linksOf(home.html, home.url);

  await say("Reading your website: delivery, returns, about…");
  const info = await eachLimited(pick(homeLinks, INFO, LIMITS.infoPages), 3, (l) => fetchPage(l.url).then((p) => ({ ...p, label: l.label })));

  await say("Reading your website: product lists…");
  const lists = await eachLimited(pick(homeLinks, LISTING, LIMITS.listPages), 3, (l) => fetchPage(l.url));
  const productLinks = new Map();
  for (const page of [home, ...lists]) for (const l of linksOf(page.html, page.url)) if (PRODUCT.test(new URL(l.url).pathname) && !SKIP.test(l.url)) productLinks.set(l.url, l);

  await say(`Reading your website: ${Math.min(productLinks.size, LIMITS.productPages)} product pages…`);
  const products = await eachLimited([...productLinks.values()].slice(0, LIMITS.productPages), 4, (l) => fetchPage(l.url));

  // Lines that are on almost every page (menu, footer) are noise: remove them
  const all = [home, ...info, ...lists, ...products].map((p) => ({ ...p, lines: textOf(p.html).split("\n") }));
  const seenOn = new Map();
  for (const p of all) for (const line of new Set(p.lines)) seenOn.set(line, (seenOn.get(line) || 0) + 1);
  const noise = (line) => all.length >= 4 && seenOn.get(line) >= all.length * 0.6;
  const clean = (p) => { const page = all.find((x) => x.url === p.url); return page.lines.filter((l) => l.length > 1 && !noise(l)).join("\n"); };

  return {
    home: { url: home.url, title: metaOf(home.html).title, text: textOf(home.html).slice(0, 6000) }, // the home page keeps its footer: phone and address are often there
    info: info.map((p) => ({ url: p.url, title: p.label || metaOf(p.html).title, text: clean(p).slice(0, 6000) })),
    lists: lists.map((p) => ({ url: p.url, text: clean(p).slice(0, 5000) })),
    products: products.map((p) => ({ url: p.url, meta: metaOf(p.html), text: clean(p).slice(0, 900) })),
  };
}

/* ---------- 3. Shop knowledge ---------- */
async function writeKnowledge(sources, say) {
  const sections = [];
  let deliveryTime = "", returnPolicy = "";
  for (const [i, s] of sources.entries()) {
    await say(`AI is learning your shop (${i + 1} of ${sources.length}): ${s.title}`);
    const r = await askAI({
      system: `You prepare notes for the sales assistant of a Bangladeshi online shop. From the TEXT, write the facts a customer could ask about:
delivery areas, delivery charge and time, payment methods, return/exchange/refund rules, shop addresses and opening hours, phone/email, what the shop sells and its story, sizes, care, offers.
RULES: Use ONLY facts that are in the TEXT. Never guess or add anything. Skip menus, buttons, cart/login text and legal boilerplate. Keep numbers, prices and names exactly.
Each fact is one short sentence. Write in English, but keep Bangla names as they are. If the TEXT has no useful facts, return an empty list.
Return JSON only: {"title":"short section title","facts":["..."],"deliveryTime":"e.g. 2-3 days inside Dhaka, or empty","returnPolicy":"one or two sentences, or empty"}`,
      user: `SOURCE: ${s.title} (${s.url || "Facebook Page"})\nTEXT:\n${s.text}`,
      temperature: 0.1, maxTokens: 900,
    }).catch(() => null); // one bad page must not stop the whole scan
    const facts = (r?.facts || []).map((f) => String(f).trim()).filter((f) => f.length > 3).slice(0, 25);
    if (facts.length) sections.push(`## ${String(r.title || s.title).slice(0, 60)}\n${facts.map((f) => `- ${f}`).join("\n")}`);
    deliveryTime ||= String(r?.deliveryTime || "").slice(0, 200);
    returnPolicy ||= String(r?.returnPolicy || "").slice(0, 400);
  }
  return { knowledge: sections.join("\n\n").slice(0, LIMITS.knowledgeChars), deliveryTime, returnPolicy };
}

/* ---------- 4. Products ---------- */
const PRODUCT_SHAPE = `{"products":[{"ref":1,"name":"","nameBn":"","price":0,"category":"","description":"","variants":["S","M"]}]}`;
const PRODUCT_RULES = `RULES: Only products with a clear selling price in taka (BDT, ৳, Tk). When there is an old price and a new price, use the new (lower, current) one. price is a plain number.
"ref" is the number of the block the product came from. "variants" are the sizes or colours the text lists for that product (empty list if none). "nameBn" only if the name is also written in Bangla.
"description": one or two sentences (fabric, material, size, what it is) taken from the text. Never invent anything. Skip delivery charges, offers and things that are not products.
Return JSON only: ${PRODUCT_SHAPE}`;

function cleanProduct(p, extra) {
  const price = Number(String(p.price ?? "").replace(/[^\d.]/g, ""));
  const name = String(p.name || "").trim().slice(0, 120);
  if (!name || !(price > 0)) return null;
  return {
    name, nameBn: String(p.nameBn || "").trim().slice(0, 120), price, category: String(p.category || "").trim().slice(0, 60) || "General",
    description: String(p.description || "").trim().slice(0, 600),
    variants: [...new Set((Array.isArray(p.variants) ? p.variants : []).map((v) => String(v).trim().slice(0, 40)).filter(Boolean))].slice(0, 20),
    ...extra,
  };
}

// blocks = [{ text, imageUrl, sourceUrl }]; the AI gets them in groups and says which block each product came from
async function productsFromText(blocks, from, groupSize, say) {
  const found = [];
  for (let i = 0; i < blocks.length; i += groupSize) {
    const group = blocks.slice(i, i + groupSize);
    await say(`AI is finding products ${from === "page" ? "in your Page posts" : "on your website"} (${Math.min(i + groupSize, blocks.length)} of ${blocks.length})`);
    const r = await askAI({
      system: `You read ${from === "page" ? "Facebook posts" : "web pages"} of a Bangladeshi online shop and list the products that are for sale.\n${PRODUCT_RULES}`,
      user: group.map((b, n) => `--- BLOCK ${n + 1} ---\n${b.text}`).join("\n\n"),
      temperature: 0.1, maxTokens: 1800,
    }).catch(() => null);
    for (const p of r?.products || []) {
      const block = group[Number(p.ref) - 1] || group[0];
      const product = cleanProduct(p, { imageUrl: block.imageUrl || "", sourceUrl: block.sourceUrl || "", from });
      if (product) found.push(product);
    }
  }
  return found;
}

async function findProducts(page, site, say) {
  const found = [];
  if (site) {
    const needAI = [];
    for (const p of site.products) {
      const ld = p.meta.product; // shop platforms often put the product in the page as data: no AI needed
      const direct = ld?.name && ld.price ? cleanProduct(ld, { imageUrl: ld.image || p.meta.image, sourceUrl: p.url, from: "web" }) : null;
      if (direct) found.push(direct);
      else needAI.push({ text: `${p.meta.title}\n${p.text}`, imageUrl: p.meta.image, sourceUrl: p.url });
    }
    found.push(...(await productsFromText(needAI, "web", 6, say)));
    // No product pages found: try the list pages ("Shop", categories) themselves
    if (!site.products.length) found.push(...(await productsFromText(site.lists.slice(0, 4).map((l) => ({ text: l.text, sourceUrl: l.url })), "web", 1, say)));
  }
  if (page?.posts.length) {
    const blocks = page.posts.map((p) => ({ text: p.message.slice(0, 700), imageUrl: p.full_picture || "", sourceUrl: p.permalink_url || "" }));
    found.push(...(await productsFromText(blocks, "page", 8, say)));
  }
  // The same product is often on the website and in several posts: keep the first (website wins)
  const seen = new Set();
  return found.filter((p) => { const key = normalizeText(p.name); if (!key || seen.has(key)) return false; seen.add(key); return true; }).slice(0, 150);
}

/* ---------- the whole scan ---------- */
function cleanWebsite(input) {
  const text = String(input || "").trim();
  if (!text) return "";
  try { const u = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`); if (!u.hostname.includes(".")) throw 0; return u.href; }
  catch { throw fail(400, "Write the website like https://yourshop.com"); }
}

async function startScan(org, websiteInput) {
  if (!aiReady()) throw fail(400, "The AI is not set up on this server (AI_API_KEY is missing)");
  if (running.has(org)) throw fail(409, "Already working on it. Please wait.");
  const website = cleanWebsite(websiteInput);
  const hasPage = await SocialAccount.exists({ organizationId: org, platform: "Facebook" });
  if (!website && !hasPage) throw fail(400, "Connect your Facebook Page or write your website address first");

  await ShopScan.findOneAndUpdate({ _id: org }, { status: "running", step: "Starting…", error: null, website, sources: [], knowledge: "", deliveryTime: "", returnPolicy: "", products: [] }, { upsert: true, new: true, setDefaultsOnInsert: true });
  if (website) await Organization.updateOne({ _id: org }, { website });
  running.add(org);
  runScan(org, website)
    .catch((e) => ShopScan.updateOne({ _id: org }, { status: "failed", error: e.message || "Something went wrong", step: "" }))
    .finally(() => running.delete(org));
}

async function runScan(org, website) {
  const say = (step) => ShopScan.updateOne({ _id: org }, { step });

  await say("Reading your Facebook Page…");
  const page = await readPage(org);
  let site = null, siteError = null;
  if (website) {
    await say("Opening your website…");
    site = await readWebsite(website, say).catch((e) => { siteError = e.message; return null; });
  }
  if (!page && !site) throw fail(400, siteError || "Nothing could be read");

  // What the AI reads for the shop knowledge: the Page's "About", then the website pages
  const sources = [];
  if (page) {
    const i = page.info;
    const text = [`Name: ${i.name || ""}`, i.category && `Category: ${i.category}`, i.about && `About: ${i.about}`, i.description && `Description: ${i.description}`, i.phone && `Phone: ${i.phone}`,
      i.emails?.length && `Email: ${i.emails.join(", ")}`, i.website && `Website: ${i.website}`, i.single_line_address && `Address: ${i.single_line_address}`].filter(Boolean).join("\n");
    if (text.length > 40) sources.push({ kind: "page", title: `Facebook Page: ${i.name || ""}`, url: "", text });
  }
  if (site) sources.push({ kind: "web", title: "Home page", url: site.home.url, text: site.home.text }, ...site.info.map((p) => ({ kind: "web", ...p })));

  const written = await writeKnowledge(sources.filter((s) => s.text.length > 20), say);
  const products = await findProducts(page, site, say);

  await ShopScan.updateOne({ _id: org }, {
    status: "ready", step: "", error: siteError ? `The website could not be read (${siteError}). Only the Facebook Page was used.` : null,
    sources: [...sources.map(({ kind, title, url }) => ({ kind, title, url })), ...(page?.posts.length ? [{ kind: "page", title: `${page.posts.length} Page posts`, url: "" }] : []), ...(site?.products.length ? [{ kind: "web", title: `${site.products.length} product pages`, url: "" }] : [])],
    ...written, products,
  });
}

const isRunning = (org) => running.has(org);

module.exports = { startScan, isRunning, cleanWebsite };
