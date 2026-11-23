// Connections → Your website: WooCommerce, Shopify, or a developer-made website's product feed.
// Steps: choose the kind → follow the steps → "Check and show my products" (preview, nothing saved yet)
//        → "Import N products". Then: Sync now, send confirmed orders to the website, disconnect.
import { get, post, put, del } from "./api.js";
import { esc, onAction, toast, confirmBox, dateTime, readForm } from "./ui.js";

let kind = "woocommerce"; // the choice before connecting
let typed = {}; // what was typed, kept while looking at the preview
let shown = null; // the preview

const KINDS = [["woocommerce", "WooCommerce"], ["shopify", "Shopify"], ["custom", "Other website"]];
const taka = (n) => `৳${Number(n || 0).toLocaleString("en-IN")}`;

export async function drawWebsite(box) {
  const st = await get("/api/store");
  box.innerHTML = st.connected ? connectedView(st) : shown ? previewView(shown) : connectForm();
  onAction(box, {
    kind: (el) => { kind = el.dataset.k; typed = {}; drawWebsite(box); },
    check: async (el) => {
      typed = { platform: kind, ...readForm(el.closest("form")) };
      el.textContent = "Reading your website…";
      try { shown = await post("/api/store/preview", typed); } finally { el.textContent = "Check and show my products"; }
      drawWebsite(box);
    },
    back: () => { shown = null; drawWebsite(box); },
    connect: async (el) => {
      el.textContent = "Importing…";
      const r = await post("/api/store/connect", typed).finally(() => { el.textContent = "Import"; });
      shown = null; typed = {};
      toast(`Connected: ${r.productCount} products${r.added ? ` (${r.added} new)` : ""}`);
      drawWebsite(box);
    },
    sync: async (el) => {
      el.textContent = "Syncing…";
      const r = await post("/api/store/sync").finally(() => { el.textContent = "↻ Sync now"; });
      toast(`Synced: ${r.lastNote}`);
      drawWebsite(box);
    },
    disconnect: async () => {
      if (!(await confirmBox("Products already imported stay here. Orders stop going to the website.", "Disconnect the website?"))) return;
      await del("/api/store");
      toast("Website disconnected");
      drawWebsite(box);
    },
    copyFormat: async () => {
      const ex = await get("/api/store/feed-example");
      const text = `MarketingFlow product feed\n\n1) Products: a link that returns JSON like this (all products, or pages with "next"):\n${JSON.stringify(ex.feed, null, 2)}\n\nprice = normal price, sale_price = price now (optional). stock: a number, or leave it out if not counted.\noptions: sizes / colours / packages, each with its own stock (and price if different).\nIf the link needs a key, we send it as "Authorization: Bearer <key>".\n\n2) Orders (optional): a link we POST confirmed orders to, as JSON like this:\n${JSON.stringify(ex.order, null, 2)}\nReply with JSON { "orderNo": "..." }.`;
      try { await navigator.clipboard.writeText(text); toast("Copied: send it to your web developer"); } catch { toast("Could not copy", true); }
    },
  });
  box.querySelector("[name=sendOrders]")?.addEventListener("change", async (e) => {
    await put("/api/store", { sendOrders: e.target.checked }).catch((err) => { e.target.checked = !e.target.checked; toast(err.message, true); });
    toast(e.target.checked ? "Confirmed orders will go to the website" : "Orders stay here only");
  });
}

function connectedView(st) {
  return `<div class="store-box">
      <div class="row between"><div><b>✅ Connected to ${esc(st.name)}</b><div class="small muted">${esc(st.url)}</div></div><span class="pill">${st.productCount} products</span></div>
      <p class="small mt">Last sync: ${st.lastSyncAt ? dateTime(st.lastSyncAt) : "never"}${st.lastNote ? ` · ${esc(st.lastNote)}` : ""}</p>
      ${st.lastError ? `<div class="note mt">⚠️ ${esc(st.lastError)}</div>` : ""}
      <div class="row mt"><button type="button" class="btn sm" data-action="sync">↻ Sync now</button><button type="button" class="btn sm light" data-action="disconnect">Disconnect</button></div></div>
    ${st.canSendOrders
      ? `<label class="switch-row mt"><span><b>Send confirmed orders to the website</b><small>When you confirm an order (after the call), it is created on your website too</small></span><input type="checkbox" class="switch" name="sendOrders" ${st.sendOrders ? "checked" : ""}></label>`
      : `<p class="small muted mt">Orders stay in MarketingFlow (no order link was given).</p>`}
    <p class="small muted mt">Products, prices, sale prices, photos, options and stock come from your website every 2 hours (or press Sync now). Details and offers you add here are kept. A product removed from the website is hidden here.</p>`;
}

function steps() {
  if (kind === "woocommerce") return `<li>Open your WordPress admin → <b>WooCommerce → Settings → Advanced → REST API</b>.</li>
      <li>Press <b>Add key</b>, name it MarketingFlow, set Permissions to <b>Read/Write</b>, press <b>Generate API key</b>.</li>
      <li>Copy the <b>Consumer key</b> and <b>Consumer secret</b> here.</li>`;
  if (kind === "shopify") return `<li>Open the Shopify <b>Dev Dashboard</b> (dev.shopify.com) with the account that owns the store, and create an app.</li>
      <li>Give it these permissions: <b>read_products, read_inventory, write_orders</b>, release it and <b>install it on your store</b>.</li>
      <li>Copy the app's <b>Client ID</b> and <b>Client secret</b> here.</li>
      <li class="muted">Old custom app (made before 2026)? Paste its Admin API access token (shpat_…) in the first box and leave the secret empty.</li>`;
  return `<li>Your website must give its products as data (JSON) at a link: the <b>product feed</b>. Most web developers can add it in an hour.</li>
      <li><button type="button" class="link" data-action="copyFormat">📋 Copy the format for your developer</button>, and send it to them.</li>
      <li>Paste the link they give you here (and a key, if the link needs one). An <b>order link</b> is optional: with it, confirmed orders go to your website too.</li>`;
}

function connectForm() {
  const t = typed;
  const field = (name, label, ph, type = "text") => `<div><label>${label}</label><input name="${name}" type="${type}" placeholder="${ph}" value="${esc(t[name] || "")}" autocomplete="${type === "password" ? "new-password" : "off"}"></div>`;
  const fields = kind === "woocommerce"
    ? `${field("url", "Website address", "https://myshop.com")}<div class="f2">${field("key", "Consumer key", "ck_…")}${field("secret", "Consumer secret", "cs_…", "password")}</div>`
    : kind === "shopify"
      ? `${field("url", "Store address", "myshop.myshopify.com")}<div class="f2">${field("key", "Client ID (or access token)", "")}${field("secret", "Client secret", "empty if you pasted a token", "password")}</div>`
      : `${field("url", "Product data link (feed)", "https://myshop.com/api/products")}<div class="f2">${field("key", "Key (only if the link needs one)", "optional", "password")}${field("ordersUrl", "Order link (optional)", "https://myshop.com/api/orders")}</div>`;
  return `<form class="stack" onsubmit="return false">
    <p class="small muted">Have a website? Connect it and its products come here by themselves, exactly as on the website. You see them all before anything is imported.</p>
    <div class="store-pick">${KINDS.map(([k, l]) => `<button type="button" class="${kind === k ? "on" : ""}" data-action="kind" data-k="${k}">${l}</button>`).join("")}</div>
    <ol class="store-steps small">${steps()}</ol>
    ${fields}
    <div><button type="button" class="btn" data-action="check">Check and show my products</button></div></form>`;
}

function previewView(p) {
  const card = (it) => `<div class="pv-item">
      ${it.imageUrl ? `<img src="${esc(it.imageUrl)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'pv-noimg',textContent:'no photo'}))">` : `<div class="pv-noimg">no photo</div>`}
      <div class="pv-body"><b>${esc(it.name)}</b>
        <div class="pv-price">${it.offer ? `<s>${taka(it.price)}</s> ${taka(it.price - it.offer.value)}` : it.price ? taka(it.price) : `<span class="bad">no price</span>`}${it.category ? ` <span class="muted">· ${esc(it.category)}</span>` : ""}</div>
        ${it.options.length ? `<div class="pv-opts">${it.options.map((o) => `<span>${esc(o.name)}${o.price && o.price !== it.price ? ` ${taka(o.price)}` : ""} · ${o.stock === null ? "available" : `${o.stock} pcs`}</span>`).join("")}</div>`
          : `<div class="small muted">${it.stock === null || it.stock === undefined ? "Always available" : `${it.stock} in stock`}</div>`}
        ${it.text ? `<div class="small muted pv-text">${esc(it.text)}</div>` : ""}</div></div>`;
  return `<div class="stack">
    <div class="paste-ok"><b>✅ Found ${p.count} products on ${esc(p.name)}</b>
      <ul>${p.matched ? `<li>${p.matched} match products you already have: they are updated, not doubled</li>` : ""}
        <li>${p.count - p.matched} will be added</li>${p.noPhoto ? `<li>${p.noPhoto} have no photo</li>` : ""}</ul></div>
    ${p.problems.length ? `<div class="paste-todo"><b>⚠️ Fix these on the website for the best answers:</b><ul>${p.problems.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
    <div class="pv-list">${p.sample.map(card).join("")}</div>
    ${p.count > p.sample.length ? `<p class="small muted">…and ${p.count - p.sample.length} more.</p>` : ""}
    <div class="row"><button type="button" class="btn" data-action="connect">Import ${p.count} products</button><button type="button" class="btn light" data-action="back">Back</button></div></div>`;
}
