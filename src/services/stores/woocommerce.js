// WooCommerce (WordPress) website: products in, orders out, through the WooCommerce REST API.
// The shop makes a key in WordPress → WooCommerce → Settings → Advanced → REST API (Read/Write).
// link = { url, key, secret } (already decrypted)

// HTML -> plain text (keeps line breaks between paragraphs / list items, decodes &amp; &#2476; …)
const ENTITY = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
const strip = (html) => String(html || "")
  .replace(/<\s*(br|\/p|\/li|\/h\d|\/div)\s*\/?>/gi, "\n").replace(/<li[^>]*>/gi, "• ").replace(/<[^>]+>/g, " ")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&([a-z]+);/gi, (m, n) => ENTITY[n.toLowerCase()] ?? " ")
  .split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
const num = (x) => (x === "" || x == null || !Number.isFinite(Number(x)) ? null : Math.round(Number(x)));

function siteOf(link) {
  let u = String(link.url || "").trim().replace(/\/+$/, "").replace(/\/wp-admin.*$/, "");
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u;
}

async function call(link, path, { method = "GET", body, query = {} } = {}) {
  const url = new URL(`${siteOf(link)}/wp-json/wc/v3${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const send = (headers) => fetch(url, { method, headers: { "Content-Type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  let res = await send({ Authorization: `Basic ${Buffer.from(`${link.key}:${link.secret}`).toString("base64")}` }).catch((e) => { throw new Error(`Could not reach the website (${e.message})`); });
  if (res.status === 401) { // some hosting drops the Authorization header: the keys go in the address instead
    url.searchParams.set("consumer_key", link.key);
    url.searchParams.set("consumer_secret", link.secret);
    res = await send({});
  }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) {
    if (res.status === 401) throw new Error("WooCommerce said the key is wrong (check the Consumer key / secret, and that it has Read/Write)");
    if (res.status === 404) throw new Error("WooCommerce was not found on this website (check the address, and that WooCommerce is installed)");
    throw new Error(`WooCommerce: ${strip(data?.message) || `error ${res.status}`}`);
  }
  if (data === null) throw new Error("This doesn't look like a WooCommerce website (check the address)");
  return { data, pages: Number(res.headers.get("x-wp-totalpages")) || 1 };
}

// stock: a number, or null when the website doesn't count it (always available)
const stockOf = (x) => (x.manage_stock ? Math.max(0, Number(x.stock_quantity) || 0) : x.stock_status === "outofstock" ? 0 : null);

async function toProduct(link, p) {
  let variants;
  if (p.type === "variable") {
    const { data } = await call(link, `/products/${p.id}/variations`, { query: { per_page: 100 } });
    variants = data.map((v) => ({
      id: String(v.id), name: (v.attributes || []).map((a) => a.option).filter(Boolean).join(" / ") || `#${v.id}`,
      price: num(v.price), stock: stockOf(v),
    }));
  } else variants = [{ id: String(p.id), name: "", price: num(p.price), stock: stockOf(p) }];
  const prices = variants.map((v) => v.price).filter((x) => x != null);
  // On sale (simple product): the normal price, with the sale as an offer, so the AI says "৳1,100 → ৳950"
  const regular = num(p.regular_price), sale = num(p.sale_price);
  const onSale = p.type !== "variable" && regular && sale && sale < regular;
  // attributes that are not options (Fabric: Dubai Cherry…) become details the AI reads
  const facts = (p.attributes || []).filter((a) => !a.variation && a.options?.length).map((a) => `${strip(a.name)}: ${a.options.map(strip).join(", ")}`);
  return {
    id: String(p.id), name: strip(p.name) || `Product ${p.id}`,
    price: onSale ? regular : num(p.price) ?? (prices.length ? Math.min(...prices) : 0),
    offer: onSale ? { kind: "amount", value: regular - sale, until: p.date_on_sale_to_gmt ? new Date(`${p.date_on_sale_to_gmt}Z`) : null } : null,
    text: [...facts, strip(p.short_description), strip(p.description)].filter(Boolean).join("\n").slice(0, 4000),
    imageUrl: p.images?.[0]?.src || "", category: strip(p.categories?.[0]?.name || ""), variants,
  };
}

async function test(link) {
  await call(link, "/products", { query: { per_page: 1 } });
}

async function fetchProducts(link) {
  const out = [];
  for (let page = 1; page <= 30; page++) { // up to 3000 products
    const { data, pages } = await call(link, "/products", { query: { per_page: 100, page, status: "publish" } });
    for (const p of data) out.push(await toProduct(link, p));
    if (page >= pages || data.length < 100) break;
  }
  return out;
}

// lines = [{ productId, variantId, qty, price }] with the website's ids (variantId === productId for a simple product)
async function createOrder(link, order, lines) {
  const cod = !order.paymentMethod || order.paymentMethod === "COD";
  const person = { first_name: order.customerName, address_1: order.address, city: order.district || "", country: "BD" };
  const { data } = await call(link, "/orders", {
    method: "POST",
    body: {
      status: "processing", set_paid: !!order.paid,
      payment_method: cod ? "cod" : String(order.paymentMethod).toLowerCase(), payment_method_title: cod ? "Cash on delivery" : order.paymentMethod,
      billing: { ...person, phone: order.phone }, shipping: person,
      line_items: lines.map((l) => ({
        product_id: Number(l.productId), ...(l.variantId !== l.productId ? { variation_id: Number(l.variantId) } : {}),
        quantity: l.qty, subtotal: String(l.price * l.qty), total: String(l.price * l.qty), // the price agreed in the chat
      })),
      shipping_lines: order.deliveryFee ? [{ method_id: "flat_rate", method_title: "Delivery", total: String(order.deliveryFee) }] : [],
      customer_note: `From Messenger (MarketingFlow order ${order.orderNo})${order.notes ? ` · ${order.notes}` : ""}`,
      meta_data: [{ key: "marketingflow_order", value: order.orderNo }],
    },
  });
  return String(data.number || data.id);
}

module.exports = { test, fetchProducts, createOrder, siteOf, strip };
