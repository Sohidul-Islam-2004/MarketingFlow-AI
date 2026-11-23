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

// price + sale price -> { price, offer }
function priceOf(o) {
  const regular = toNum(pick(o, ["regular_price", "regularPrice", "mrp", "original_price", "originalPrice", "compare_at_price", "price"]));
  const sale = toNum(pick(o, ["sale_price", "salePrice", "discount_price", "discountPrice", "offer_price", "offerPrice", "special_price"]));
  if (regular && sale && sale < regular) return { price: regular, offer: { kind: "amount", value: regular - sale, until: null }, now: sale };
  const price = toNum(pick(o, ["price", "sale_price", "salePrice", "regular_price", "amount"]));
  return { price, offer: null, now: price };
}

function factsOf(o) {
  const d = pick(o, ["details", "specs", "specifications", "attributes", "info", "features"]);
  if (!d) return [];
  if (Array.isArray(d)) return d.map((x) => (typeof x === "string" ? text(x) : `${text(pick(x, ["label", "name", "key", "title"]) || "")}: ${text(pick(x, ["value", "values", "options", "text"]) ?? "")}`)).filter((l) => l && !/^:\s*$/.test(l));
  if (typeof d === "object") return Object.entries(d).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : text(v)}`);
  return [text(d)];
}

function toProduct(o, base) {
  const name = text(pick(o, ["name", "title", "productName", "product_name", "name_en", "name_bn"]));
  if (!name) return null;
  const { price, offer, now } = priceOf(o);
  const rawOptions = pick(o, ["options", "variants", "variations", "sizes", "colors"]);
  let variants = [];
  if (Array.isArray(rawOptions) && rawOptions.length) {
    variants = rawOptions.map((v, i) => {
      if (typeof v !== "object") return { id: `${name}#${text(v)}`, name: text(v), price: null, stock: null };
      const label = text(pick(v, ["name", "title", "label", "option", "size", "color", "value"]) || `#${i + 1}`);
      return { id: String(pick(v, ["id", "_id", "sku"]) ?? `${name}#${label}`), name: label, price: priceOf(v).now ?? null, stock: stockOf(v) };
    });
  } else variants = [{ id: String(pick(o, ["id", "_id", "sku", "slug"]) ?? name), name: "", price: now, stock: stockOf(o) }];
  if (variants.length > 1 && offer) variants = variants.map((v) => ({ ...v, price: v.price ?? now })); // options pay the sale price
  const prices = variants.map((v) => v.price).filter((x) => x != null);
  const category = pick(o, ["category.name", "category", "categories.0.name", "categories.0", "type", "productType"]);
  return {
    id: String(pick(o, ["id", "_id", "sku", "slug"]) ?? name), name,
    price: price ?? (prices.length ? Math.min(...prices) : 0), offer: variants.length > 1 ? null : offer,
    text: [...factsOf(o), text(pick(o, ["description", "details_text", "short_description", "summary", "desc", "body", "body_html"]))].filter(Boolean).join("\n").slice(0, 4000),
    imageUrl: imageOf(o, base), category: typeof category === "string" ? text(category) : "", variants,
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
