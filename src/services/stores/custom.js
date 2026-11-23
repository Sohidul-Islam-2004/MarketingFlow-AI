// A website a developer made (Express, Laravel, PHP…): it gives its products as JSON at a link (a "product feed").
// The developer can follow FEED_EXAMPLE exactly; common other names (title, image_url, sale_price, variants,
// countInStock, data.items…) are understood too. Optional:
//   key      -> sent as "Authorization: Bearer <key>" and "X-API-Key: <key>"
//   ordersUrl -> confirmed orders are POSTed there as JSON (ORDER_EXAMPLE)
// link = { url, key, ordersUrl } (already decrypted)

const FEED_EXAMPLE = {
  products: [
    {
      id: "101", name: "IQRA Borka", price: 1100, sale_price: 950, image: "https://myshop.com/img/iqra.jpg",
      category: "Borka", description: "Dubai Cherry fabric, full open chain, 1 pocket", details: { "ঘের": "110+", "লং": "50–56" },
      stock: 10,
      options: [{ id: "101-1", name: "শুধু বোরকা", price: 950, stock: 5 }, { id: "101-2", name: "বোরকা + হিজাব", price: 1250, stock: 5 }],
    },
  ],
  next: null,
};
const ORDER_EXAMPLE = {
  orderNo: "MF-1024", customer: { name: "Tabassum", phone: "01903003727", address: "House 275/k, Road 27, Dhanmondi", district: "Dhaka" },
  items: [{ productId: "101", optionId: "101-2", name: "IQRA Borka", option: "বোরকা + হিজাব", qty: 1, price: 1250 }],
  deliveryFee: 80, total: 1330, paymentMethod: "COD", note: "From Messenger",
};

const BN = "০১২৩৪৫৬৭৮৯";
const pick = (o, keys) => {
  for (const k of keys) {
    const v = k.split(".").reduce((x, part) => (x == null ? undefined : x[part]), o);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
};
const toNum = (x) => {
  if (x == null || x === "") return null;
  if (typeof x === "number") return Number.isFinite(x) ? Math.round(x) : null;
  const s = String(x).replace(/[০-৯]/g, (d) => BN.indexOf(d)).replace(/,/g, "").match(/\d+(\.\d+)?/);
  return s ? Math.round(Number(s[0])) : null;
};
const text = (x) => String(x ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/[ \t]+/g, " ").trim();

function stockOf(o) {
  const s = pick(o, ["stock", "quantity", "qty", "stock_quantity", "stockQuantity", "countInStock", "inventory", "inventory_quantity"]);
  if (s !== undefined && toNum(s) !== null) return Math.max(0, toNum(s));
  const a = pick(o, ["inStock", "in_stock", "available", "isAvailable", "is_in_stock"]);
  if (a === false || a === "false" || a === 0 || a === "0" || a === "outofstock") return 0;
  return null; // not counted: always available
}

function imageOf(o, base) {
  let img = pick(o, ["image", "imageUrl", "image_url", "img", "photo", "thumbnail", "picture", "images.0", "photos.0"]);
  if (img && typeof img === "object") img = pick(img, ["src", "url", "secure_url", "link"]);
  if (!img) return "";
  try { return new URL(String(img), base).href; } catch { return ""; }
}

// price, sale price, "was" price -> { price (normal), offer, now (what the customer pays) }
//   { price: 1100, sale_price: 950 }  { regularPrice: 1100, price: 950 }  { mrp: 1100, price: 950 }  -> 1100, offer 150, now 950
function priceOf(o) {
  const cur = toNum(pick(o, ["price", "amount", "current_price", "currentPrice", "selling_price", "sellingPrice"]));
  const was = toNum(pick(o, ["regular_price", "regularPrice", "mrp", "original_price", "originalPrice", "compare_at_price", "compareAtPrice", "old_price", "oldPrice", "list_price"]));
  const sale = toNum(pick(o, ["sale_price", "salePrice", "discount_price", "discountPrice", "offer_price", "offerPrice", "special_price"]));
  const now = sale > 0 ? sale : cur ?? was;
  if (now == null) return { price: null, offer: null, now: null };
  const base = Math.max(now, ...[was, sale > 0 ? cur : null].filter((x) => x > 0));
  return { price: base, offer: base > now ? { kind: "amount", value: base - now, until: null } : null, now };
}

// Details the AI reads: a details/specs block, and common single fields (fabric, brand, warranty…)
const FACT_FIELDS = [["fabric", "Fabric"], ["material", "Material"], ["brand", "Brand"], ["model", "Model"], ["origin", "Origin"], ["made_in", "Made in"], ["madeIn", "Made in"],
  ["warranty", "Warranty"], ["weight", "Weight"], ["size_chart", "Size chart"], ["sizeChart", "Size chart"], ["care", "Care"], ["fit", "Fit"]];
function factsOf(o) {
  const out = [];
  const d = pick(o, ["details", "specs", "specifications", "attributes", "info", "features"]);
  if (Array.isArray(d)) out.push(...d.map((x) => (typeof x === "string" ? text(x) : `${text(pick(x, ["label", "name", "key", "title"]) || "")}: ${text([].concat(pick(x, ["value", "values", "options", "text"]) ?? "").join(", "))}`)).filter((l) => l && !/^:\s*|:\s*$/.test(l)));
  else if (d && typeof d === "object") out.push(...Object.entries(d).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : text(v)}`));
  else if (d) out.push(text(d));
  for (const [k, label] of FACT_FIELDS) if (typeof o[k] === "string" || typeof o[k] === "number") { const v = text(o[k]); if (v && !out.some((l) => l.toLowerCase().startsWith(`${label.toLowerCase()}:`))) out.push(`${label}: ${v}`); }
  return out;
}

// One group of choices: ["52","54"]  or  [{ name: "Black", price?, stock? }, …]
const choicesOf = (list) => (Array.isArray(list) ? list : []).map((v, i) => (typeof v === "object" && v
  ? { id: pick(v, ["id", "_id", "sku"]), name: text(pick(v, ["name", "title", "label", "option", "size", "color", "value"]) || `#${i + 1}`), price: priceOf(v).now, stock: pick(v, ["stock", "quantity", "qty", "countInStock", "inStock", "in_stock", "available"]) !== undefined ? stockOf(v) : undefined }
  : { name: text(v), price: null, stock: undefined })).filter((c) => c.name);

const MAX_OPTIONS = 60;
// Options a customer picks: given options/variants, or colours × sizes (× add-ons like "+ হিজাব ৳250")
function optionsOf(o, productId, now, stock) {
  const given = pick(o, ["options", "variants", "variations"]);
  if (Array.isArray(given) && given.length && given.some((v) => typeof v === "object" && !Array.isArray(v.values))) {
    return choicesOf(given).map((c) => ({ id: String(c.id ?? `${productId}|${c.name}`), name: c.name, price: c.price ?? now, stock: c.stock === undefined ? stock : c.stock }));
  }
  // groups: colours, sizes (and Shopify-style [{ name: "Size", values: [...] }])
  const groups = [];
  if (Array.isArray(given)) for (const g of given) if (g && Array.isArray(g.values)) groups.push(choicesOf(g.values));
  for (const k of ["colors", "colours", "color", "sizes", "size", "lengths"]) if (Array.isArray(o[k]) && o[k].length) groups.push(choicesOf(o[k]));
  let combos = [{ parts: [], price: now, stock }];
  for (const g of groups.filter((x) => x.length)) {
    const next = [];
    for (const c of combos) for (const ch of g) next.push({ parts: [...c.parts, ch.name], price: ch.price ?? c.price, stock: ch.stock === undefined ? c.stock : ch.stock });
    if (next.length > MAX_OPTIONS) break;
    combos = next;
  }
  const addons = choicesOf(pick(o, ["addons", "add_ons", "addOns", "extras", "upsells"]) || []).filter((a) => a.price != null);
  if (addons.length && combos.length * (addons.length + 1) <= MAX_OPTIONS) {
    combos = combos.flatMap((c) => [c, ...addons.map((a) => ({ parts: [...c.parts, `+ ${a.name}`], price: (c.price || 0) + a.price, stock: c.stock }))]);
    if (!combos[0].parts.length) combos[0].parts = ["শুধু পণ্যটি"]; // "only the product" next to "+ হিজাব"
  }
  return combos.map((c) => ({ id: [productId, ...c.parts].join("|"), name: c.parts.join(" / ").replace(/ \/ \+ /g, " + "), price: c.price, stock: c.stock }));
}

const HIDDEN = (o) => o.active === false || o.published === false || o.visible === false || o.isActive === false || ["draft", "hidden", "inactive", "archived", "private"].includes(String(o.status || "").toLowerCase());

function toProduct(o, base) {
  const name = text(pick(o, ["name", "title", "productName", "product_name", "name_en", "name_bn"]));
  if (!name || HIDDEN(o)) return null;
  const id = String(pick(o, ["id", "_id", "sku", "slug"]) ?? name);
  const { price, offer, now } = priceOf(o);
  const stock = stockOf(o);
  let variants = optionsOf(o, id, now, stock);
  const ownPrices = variants.length > 1 && variants.some((v) => v.price !== now);
  if (variants.length === 1 && !variants[0].name) variants = [{ id, name: "", price: now, stock }];
  const addons = choicesOf(pick(o, ["addons", "add_ons", "addOns", "extras", "upsells"]) || []);
  const addonNote = addons.length && !variants.some((v) => v.name.includes("+ ")) ? [`সাথে নিতে পারেন: ${addons.map((a) => `${a.name}${a.price != null ? ` +৳${a.price}` : ""}`).join(", ")}`] : [];
  const category = pick(o, ["category.name", "category", "categories.0.name", "categories.0", "type", "productType"]);
  let image = imageOf(o, base);
  if (!image) for (const c of [].concat(o.colors || [])) if (c && typeof c === "object" && c.image) { image = imageOf(c, base); break; }
  return {
    id, name,
    // options with their own price (add-ons, sizes): each pays its own price, so no product-wide offer on top
    // (then the product's price is the lowest price paid now, never the old "was" price)
    price: ownPrices ? Math.min(...variants.map((v) => v.price).filter((x) => x != null)) : price ?? 0, offer: ownPrices ? null : offer,
    variants: variants.map((v) => ({ ...v, price: ownPrices ? v.price : v.price === now ? null : v.price })),
    text: [...factsOf(o), ...addonNote, text(pick(o, ["description", "details_text", "short_description", "summary", "desc", "body", "body_html"]))].filter(Boolean).join("\n").slice(0, 4000),
    imageUrl: image, category: typeof category === "string" ? text(category) : "",
  };
}

async function getJson(link, url) {
  const headers = { Accept: "application/json" };
  if (link.key) { headers.Authorization = `Bearer ${link.key}`; headers["X-API-Key"] = link.key; }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) }).catch((e) => { throw new Error(`Could not reach the link (${e.message})`); });
  if (res.status === 401 || res.status === 403) throw new Error("The website said no (it needs the right key)");
  if (!res.ok) throw new Error(`The link answered ${res.status} (check it in a browser)`);
  const body = await res.text();
  try { return JSON.parse(body); } catch { throw new Error("This link does not give product data (JSON). Ask your web developer for the product feed link."); }
}

function listOf(data) {
  if (Array.isArray(data)) return data;
  for (const k of ["products", "data", "items", "results", "docs", "rows", "data.products", "data.items"]) {
    const v = pick(data, [k]);
    if (Array.isArray(v)) return v;
  }
  throw new Error('The link gives JSON, but no product list in it (expected a list, or { "products": [...] })');
}

async function fetchProducts(link) {
  const out = [];
  let url = link.url, seen = new Set();
  for (let page = 0; url && page < 50 && !seen.has(url); page++) { // follows "next" links
    seen.add(url);
    const data = await getJson(link, url);
    for (const o of listOf(data)) { const p = toProduct(o, url); if (p) out.push(p); }
    const next = Array.isArray(data) ? null : pick(data, ["next", "next_page_url", "links.next", "pagination.next", "meta.next"]);
    url = next ? new URL(String(next), url).href : null;
  }
  if (!out.length) throw new Error("No products found at this link");
  return out;
}

const test = async (link) => { listOf(await getJson(link, link.url)); };

async function createOrder(link, order, lines) {
  if (!link.ordersUrl) throw new Error("No order link set");
  const body = {
    orderNo: order.orderNo,
    customer: { name: order.customerName, phone: order.phone, address: order.address, district: order.district || "" },
    items: order.items.map((it) => { const l = lines.find((x) => x.item === it); return { productId: l?.productId || null, optionId: l && l.variantId !== l.productId ? l.variantId : null, name: it.name, option: it.variantName || "", qty: it.qty, price: it.price }; }),
    deliveryFee: order.deliveryFee || 0, total: order.total, paymentMethod: order.paymentMethod || "COD", note: `From Messenger${order.notes ? ` · ${order.notes}` : ""}`,
  };
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  if (link.key) { headers.Authorization = `Bearer ${link.key}`; headers["X-API-Key"] = link.key; }
  const res = await fetch(link.ordersUrl, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) }).catch((e) => { throw new Error(`Could not reach the order link (${e.message})`); });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`The order link answered ${res.status}${j.message || j.error ? `: ${j.message || j.error}` : ""}`);
  return String(pick(j, ["orderNo", "order_number", "number", "id", "_id", "orderId", "data.id"]) ?? order.orderNo);
}

module.exports = { test, fetchProducts, createOrder, FEED_EXAMPLE, ORDER_EXAMPLE };
