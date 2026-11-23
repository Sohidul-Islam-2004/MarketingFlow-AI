// Shopify store: products in, orders out, through the GraphQL Admin API.
// Two ways to connect (Shopify stopped "Develop apps" in the admin on Jan 1, 2026):
//   new: an app made in the Shopify Dev Dashboard → Client ID + Client secret. We swap them for an access token
//        (client credentials grant). The token lasts about a day and is renewed by itself.
//   old: an access token (shpat_…) from a custom app made before 2026 → key = token, secret = "".
// Scopes the app needs: read_products, read_inventory, write_orders.
// link = { url, key, secret, token, tokenUntil } (already decrypted). A new token is put on link (link.tokenChanged).

const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-10";
const num = (x) => (x === "" || x == null || !Number.isFinite(Number(x)) ? null : Math.round(Number(x)));

// "https://myshop.myshopify.com/admin" / "myshop" -> "myshop.myshopify.com"
function shopOf(link) {
  let s = String(link.url || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (s && !s.includes(".")) s = `${s}.myshopify.com`;
  return s;
}

const baseOf = (link) => process.env.SHOPIFY_BASE_URL || `https://${shopOf(link)}`; // SHOPIFY_BASE_URL: tests only

async function token(link) {
  if (!link.secret) return link.key; // a ready token from an old custom app
  if (link.token && link.tokenUntil && new Date(link.tokenUntil).getTime() > Date.now() + 10 * 60e3) return link.token;
  const res = await fetch(`${baseOf(link)}/admin/oauth/access_token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: link.key, client_secret: link.secret }),
    signal: AbortSignal.timeout(20000),
  }).catch((e) => { throw new Error(`Could not reach Shopify (${e.message})`); });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) {
    const why = j.error_description || j.error || (typeof j.errors === "string" ? j.errors : "") || `error ${res.status}`;
    throw new Error(`Shopify did not accept the Client ID / secret: ${why}. Check them, and that the app is installed on this store.`);
  }
  link.token = j.access_token;
  link.tokenUntil = new Date(Date.now() + (Number(j.expires_in) || 86399) * 1000);
  link.tokenChanged = true;
  return link.token;
}

async function gql(link, query, variables = {}) {
  const t = await token(link);
  const res = await fetch(`${baseOf(link)}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": t },
    body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(30000),
  }).catch((e) => { throw new Error(`Could not reach Shopify (${e.message})`); });
  const j = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error("Shopify said the access token is wrong or expired");
  if (res.status === 404) throw new Error("This Shopify store was not found (check the store address, e.g. myshop.myshopify.com)");
  if (!res.ok) throw new Error(`Shopify: error ${res.status}`);
  if (j.errors?.length) {
    const m = j.errors[0].message || "";
    throw new Error(/access denied|scope/i.test(m) ? `Shopify: the app needs these permissions: read_products, read_inventory, write_orders (${m})` : `Shopify: ${m}`);
  }
  return j.data;
}

const PRODUCTS = `query Products($cursor: String) {
  products(first: 50, after: $cursor, query: "status:active") {
    pageInfo { hasNextPage endCursor }
    nodes {
      id title description productType tracksInventory
      featuredMedia { preview { image { url } } }
      variants(first: 100) { nodes { id title price compareAtPrice inventoryQuantity inventoryPolicy } }
    }
  }
}`;

function toProduct(p) {
  const variants = (p.variants?.nodes || []).map((v) => ({
    id: v.id, name: v.title === "Default Title" ? "" : v.title, price: num(v.price),
    // not counted (sold even when out of stock) -> null
    stock: !p.tracksInventory || v.inventoryPolicy === "CONTINUE" ? null : Math.max(0, Number(v.inventoryQuantity) || 0),
  }));
  const prices = variants.map((v) => v.price).filter((x) => x != null);
  // One kind, on sale ("compare at" price higher): the normal price with the sale as an offer
  const only = p.variants?.nodes?.length === 1 ? p.variants.nodes[0] : null;
  const was = num(only?.compareAtPrice), now = num(only?.price);
  const onSale = !!(was && now && was > now);
  return {
    id: p.id, name: p.title, price: onSale ? was : prices.length ? Math.min(...prices) : 0,
    offer: onSale ? { kind: "amount", value: was - now, until: null } : null,
    text: String(p.description || "").replace(/\s+/g, " ").trim().slice(0, 4000),
    imageUrl: p.featuredMedia?.preview?.image?.url || "", category: p.productType || "", variants,
  };
}

async function test(link) {
  await gql(link, "{ shop { name } }");
}

async function fetchProducts(link) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < 60; page++) { // up to 3000 products
    const data = await gql(link, PRODUCTS, { cursor });
    out.push(...data.products.nodes.map(toProduct));
    if (!data.products.pageInfo.hasNextPage) break;
    cursor = data.products.pageInfo.endCursor;
  }
  return out;
}

// 01712345678 -> +8801712345678 (Shopify wants the international form)
const intlPhone = (p) => { const d = String(p || "").replace(/\D/g, ""); return /^01\d{9}$/.test(d) ? `+88${d}` : /^8801\d{9}$/.test(d) ? `+${d}` : null; };

const ORDER = `mutation Create($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
  orderCreate(order: $order, options: $options) { order { id name } userErrors { field message } }
}`;
const DRAFT = `mutation Draft($input: DraftOrderInput!) {
  draftOrderCreate(input: $input) { draftOrder { id name } userErrors { field message } }
}`;

// lines = [{ productId, variantId, qty, price }] with Shopify ids
async function createOrder(link, order, lines) {
  const { shop } = await gql(link, "{ shop { currencyCode } }");
  const money = (amount) => ({ shopMoney: { amount: String(amount), currencyCode: shop.currencyCode } });
  const phone = intlPhone(order.phone);
  const address = { firstName: order.customerName, address1: order.address, city: order.district || "Dhaka", countryCode: "BD", ...(phone ? { phone } : {}) };
  const note = `From Messenger (MarketingFlow order ${order.orderNo})${order.notes ? ` · ${order.notes}` : ""}${phone ? "" : ` · Phone: ${order.phone}`}`;
  try {
    const data = await gql(link, ORDER, {
      order: {
        lineItems: lines.map((l) => ({ variantId: l.variantId, quantity: l.qty, priceSet: money(l.price) })), // the price agreed in the chat
        shippingAddress: address, financialStatus: order.paid ? "PAID" : "PENDING",
        shippingLines: order.deliveryFee ? [{ title: "Delivery", priceSet: money(order.deliveryFee) }] : [],
        note, tags: ["MarketingFlow", "Messenger"],
      },
      options: { inventoryBehaviour: "DECREMENT_OBEYING_POLICY", sendReceipt: false },
    });
    const r = data.orderCreate;
    if (r.userErrors?.length) throw new Error(r.userErrors.map((e) => e.message).join("; "));
    return r.order.name || r.order.id;
  } catch (e) {
    // Some apps can't create orders directly: then a draft order the shop completes with one click in Shopify
    const data = await gql(link, DRAFT, {
      input: { lineItems: lines.map((l) => ({ variantId: l.variantId, quantity: l.qty })), shippingAddress: address, note: `${note} · Delivery ৳${order.deliveryFee || 0}`, tags: ["MarketingFlow", "Messenger"] },
    }).catch(() => { throw e; });
    const r = data.draftOrderCreate;
    if (r.userErrors?.length) throw new Error(`${e.message}; draft: ${r.userErrors.map((x) => x.message).join("; ")}`);
    return `${r.draftOrder.name || r.draftOrder.id} (draft)`;
  }
}

module.exports = { test, fetchProducts, createOrder, shopOf };
