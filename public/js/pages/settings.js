// Settings: business profile, AI agent, comment replies, delivery zones, website (WooCommerce / Shopify), password.
import { get, put, post, del } from "../api.js";
import { esc, onAction, toast, options, readForm, confirmBox, dateTime } from "../ui.js";

let tab = "ai";
let storePlatform = "woocommerce"; // the choice before connecting
const TABS = [["ai", "AI"], ["comments", "Comments"], ["zones", "Delivery"], ["store", "Website"], ["profile", "Shop"], ["password", "Password"]];

export async function render(root, params = {}) {
  if (TABS.some(([k]) => k === params.tab)) tab = params.tab; // #settings?tab=zones
  onAction(root, {
    tab: (el) => { tab = el.dataset.tab; draw(root); },
    save: async (el) => {
      const form = el.closest("form");
      const data = readForm(form);
      if (tab === "password") { await post("/api/auth/password", data); form.reset(); }
      else if (tab === "zones") await put("/api/settings/zones", { zones: readZones(form) });
      else await put(`/api/settings/${tab}`, data);
      toast("Saved");
      if (tab === "zones" || tab === "profile") draw(root);
    },
    addZone: (el) => el.closest("form").querySelector("#zones").insertAdjacentHTML("beforeend", zoneRow({ name: "", fee: 0 })),
    removeZone: (el) => el.closest(".zone").remove(),
    resetZones: async () => { if (!(await confirmBox("Go back to Inside Dhaka ৳80 / Suburbs ৳100 / Outside ৳130?", "Reset zones"))) return; await put("/api/settings/zones", { reset: true }); toast("Default zones restored"); draw(root); },
    // Website (WooCommerce / Shopify)
    storePlatform: (el) => { storePlatform = el.dataset.p; draw(root); },
    storeConnect: async (el) => {
      el.disabled = true; el.textContent = "Connecting and bringing your products…";
      try {
        const r = await post("/api/store/connect", { platform: storePlatform, ...readForm(el.closest("form")) });
        toast(`Connected to ${r.name}: ${r.productCount} products ${r.added ? `(${r.added} new)` : ""}`);
        draw(root);
      } finally { el.disabled = false; el.textContent = "Connect and bring my products"; }
    },
    storeSync: async (el) => {
      el.disabled = true; el.textContent = "Syncing…";
      try { const r = await post("/api/store/sync"); toast(`Synced: ${r.lastNote}`); draw(root); }
      finally { el.disabled = false; el.textContent = "↻ Sync now"; }
    },
    storeDisconnect: async () => {
      if (!(await confirmBox("Products already brought in stay here. Orders stop going to the website.", "Disconnect the website?"))) return;
      await del("/api/store"); toast("Website disconnected"); draw(root);
    },
    testZone: async (el) => {
      const r = await post("/api/settings/zones/test", { address: el.closest("form").querySelector("#testAddress").value });
      el.closest("form").querySelector("#testResult").textContent = `→ ${r.zone} · ৳${r.fee} · district: ${r.district || "unknown"} (matched by ${r.matched})`;
    },
  });
  // "AI answers your customers": works the moment you flip it, for every chat
  root.addEventListener("change", async (e) => {
    if (tab === "store" && e.target.name === "sendOrders") {
      await put("/api/store", { sendOrders: e.target.checked }).catch((err) => { e.target.checked = !e.target.checked; toast(err.message, true); });
      return toast(e.target.checked ? "Confirmed orders will go to the website" : "Orders stay here only");
    }
    if (tab !== "ai" || e.target.name !== "enabled") return;
    const on = e.target.checked;
    try {
      const r = await post("/api/settings/ai/switch", { on });
      toast(on ? `AI is on for all chats${r.chats ? ` (${r.chats} turned back on)` : ""}` : "AI is off for all chats");
    } catch (err) { e.target.checked = !on; toast(err.message, true); }
  });
  await draw(root);
}

const zoneRow = (z, i = 0) => `<div class="box zone mt">
  <div class="f3" style="grid-template-columns:1.4fr .7fr .9fr auto"><div><label>Zone name</label><input data-z="name" value="${esc(z.name)}"></div><div><label>Fee (৳)</label><input type="number" data-z="fee" value="${z.fee}"></div>
  <div><label>Free delivery from (৳, 0 = never)</label><input type="number" data-z="freeOver" value="${z.freeOver || 0}"></div>
  <label class="check" style="align-self:end"><input type="radio" name="defaultZone" data-z="isDefault" ${z.isDefault ? "checked" : ""}> Default</label></div>
  <div class="f2 mt"><div><label>Districts (comma separated)</label><input data-z="districts" value="${esc((z.districts || []).join(", "))}"></div>
  <div><label>Areas / thanas (comma separated)</label><input data-z="areas" value="${esc((z.areas || []).filter((a) => /^[a-z]/i.test(a)).join(", "))}"></div></div>
  ${i > 0 || !z.name ? `<button type="button" class="btn sm light mt" data-action="removeZone">Remove</button>` : ""}</div>`;

const readZones = (form) => [...form.querySelectorAll(".zone")].map((box) => {
  const val = (k) => box.querySelector(`[data-z="${k}"]`);
  return { name: val("name").value, fee: val("fee").value, freeOver: val("freeOver").value, districts: val("districts").value, areas: val("areas").value, isDefault: val("isDefault").checked };
});

// Settings → Website: connect once, then products come by themselves
function storeForm(st, toggle) {
  if (st.connected) return `<div class="store-box">
      <div class="row between"><div><b>✅ Connected to ${esc(st.name)}</b><div class="small muted">${esc(st.url)}</div></div><span class="pill">${st.productCount} products</span></div>
      <p class="small mt">Last sync: ${st.lastSyncAt ? dateTime(st.lastSyncAt) : "never"}${st.lastNote ? ` · ${esc(st.lastNote)}` : ""}</p>
      ${st.lastError ? `<div class="note mt">⚠️ ${esc(st.lastError)}</div>` : ""}
      <div class="row mt"><button type="button" class="btn sm" data-action="storeSync">↻ Sync now</button><button type="button" class="btn sm light" data-action="storeDisconnect">Disconnect</button></div></div>
    ${toggle("sendOrders", st.sendOrders, "Send confirmed orders to the website", "When you confirm an order (after the call), it is created on your website too")}
    <p class="small muted">Products, prices, photos, options and stock come from your website every 2 hours (or press Sync now). Details and offers you add here are kept. A product removed from the website is hidden here.</p>`;
  const woo = storePlatform === "woocommerce";
  return `<p class="small muted">Have a website? Connect it and all its products come here by themselves: no typing them again. The AI always knows the latest price and stock.</p>
    <div class="seg store-pick">${[["woocommerce", "WooCommerce (WordPress)"], ["shopify", "Shopify"]].map(([k, l]) => `<button type="button" class="${storePlatform === k ? "on" : ""}" data-action="storePlatform" data-p="${k}">${l}</button>`).join("")}</div>
    <ol class="store-steps small">${woo
      ? `<li>Open your WordPress admin → <b>WooCommerce → Settings → Advanced → REST API</b>.</li>
         <li>Press <b>Add key</b>, give it a name (e.g. MarketingFlow), set Permissions to <b>Read/Write</b>, press <b>Generate API key</b>.</li>
         <li>Copy the <b>Consumer key</b> and <b>Consumer secret</b> here.</li>`
      : `<li>Open the Shopify <b>Dev Dashboard</b> (dev.shopify.com) with the account that owns the store, and create an app.</li>
         <li>Give it these permissions: <b>read_products, read_inventory, write_orders</b>, release it and <b>install it on your store</b>.</li>
         <li>Copy the app's <b>Client ID</b> and <b>Client secret</b> here.</li>
         <li class="muted">Have an old custom app (made before 2026)? Paste its Admin API access token (shpat_…) in the first box and leave the secret empty.</li>`}</ol>
    <div><label>${woo ? "Website address" : "Store address"}</label><input name="url" placeholder="${woo ? "https://myshop.com" : "myshop.myshopify.com"}" autocomplete="off"></div>
    <div class="f2"><div><label>${woo ? "Consumer key" : "Client ID (or access token)"}</label><input name="key" placeholder="${woo ? "ck_…" : ""}" autocomplete="off"></div>
      <div><label>${woo ? "Consumer secret" : "Client secret"}</label><input name="secret" type="password" placeholder="${woo ? "cs_…" : "empty if you pasted a token"}" autocomplete="new-password"></div></div>
    <div><button type="button" class="btn" data-action="storeConnect">Connect and bring my products</button></div>`;
}

async function draw(root) {
  const [s, st] = await Promise.all([get("/api/settings"), tab === "store" ? get("/api/store") : null]);
  // An on/off switch with a short explanation under it
  const toggle = (name, on, title, hint) => `<label class="switch-row"><span><b>${title}</b><small>${hint}</small></span><input type="checkbox" class="switch" name="${name}" ${on ? "checked" : ""}></label>`;
  const advanced = (inner) => `<details class="advanced"><summary>More settings</summary><div class="stack">${inner}</div></details>`;
  const forms = {
    ai: `${s.ai.ready ? "" : `<div class="note">AI is not set up: add AI_API_KEY to .env and restart the server.</div>`}
      <div>${toggle("enabled", s.ai.enabled, "AI answers your customers", "On or off for every chat at once. Works right away.")}
      ${toggle("followUp", s.ai.followUp !== false, "Remind unfinished orders", "One friendly message 3 hours after a customer stopped in the middle of an order")}
      ${toggle("introOn", s.ai.introOn !== false, "AI says it is an AI", "Once, at the start of every new chat. Customers trust it more, and know how to reach you")}</div>
      <div><label>That first message <span class="small muted">({shop} = your shop's name, {product} = one of your products)</span></label>
        <textarea name="introText" rows="9">${esc(s.ai.introText || s.ai.defaultIntro)}</textarea></div>
      <div><label>Delivery time (the AI tells customers this)</label><input name="deliveryTime" value="${esc(s.ai.deliveryTime)}" placeholder="Dhaka 1-2 days, outside Dhaka 3-5 days"></div>
      <div><label>Shop knowledge</label><p class="small muted" style="margin:-2px 0 8px">Return policy, size chart, opening hours, address, common questions. The AI only uses what is written here and your products. Answers you teach from a chat (🧠 Teach AI) are added here.</p><textarea name="knowledge" rows="10">${esc(s.ai.knowledge)}</textarea></div>
      ${advanced(`<div class="f2"><div><label>How the AI talks</label><select name="tone">${options([["friendly", "Friendly"], ["professional", "Professional"], ["formal", "Formal"]], s.ai.tone)}</select></div>
        <div><label>Hand the chat to you when the AI is less sure than (%)</label><input type="number" name="handoffBelow" min="0" max="100" value="${s.ai.handoffBelow}"></div></div>
        <div><label>Message when the AI hands the chat to you</label><input name="handoffMessage" value="${esc(s.ai.handoffMessage)}"></div>`)}`,
    comments: `<div>${toggle("sendDm", s.comments.sendDm, "Message buyers privately", "People who ask about price, stock or ordering get a Messenger message")}
      ${toggle("autoReply", s.comments.autoReply, "Reply under the comment", "A short public reply with your real prices")}
      ${toggle("needApproval", s.comments.needApproval, "Let me approve public replies first", "Replies wait in Comments until you press Approve")}
      ${toggle("hideSpam", s.comments.hideSpam, "Hide spam", "Comments with links or blocked words are hidden on Facebook")}</div>
      <p class="small muted">Complaints ("fake", "refund", "পাইনি"…) are never answered by the AI. They wait for you in Comments.</p>
      ${advanced(`<div class="f2"><div><label>Wait before replying (seconds, looks more natural)</label><input type="number" name="delaySec" min="0" max="600" value="${s.comments.delaySec}"></div>
        <div><label>Blocked words (comma separated, treated as spam)</label><input name="blockedWords" value="${esc((s.comments.blockedWords || []).join(", "))}"></div></div>`)}`,
    zones: `<p class="small muted">Every order's delivery fee comes from these zones. The address is matched by area first (e.g. "Savar" → suburbs), then by district. If nothing matches, the default zone is used.${s.usingDefaultZones ? " You are using the built-in zones." : ""}</p>
      <div id="zones">${s.zones.map(zoneRow).join("")}</div>
      <div class="row mt"><button type="button" class="btn sm light" data-action="addZone">+ Zone</button>${s.usingDefaultZones ? "" : `<button type="button" class="btn sm light" data-action="resetZones">Use built-in zones</button>`}</div>
      <div class="box mt"><h4>Test an address</h4><div class="row"><input id="testAddress" placeholder="House 5, Mirpur 10" style="flex:1"><button type="button" class="btn sm light" data-action="testZone">Test</button></div><p class="small mt" id="testResult"></p></div>`,
    profile: `<div class="f2"><div><label>Business name</label><input name="name" required value="${esc(s.profile.name)}"></div><div><label>Phone (on invoices)</label><input name="phone" value="${esc(s.profile.phone)}"></div></div>
      <div class="f2"><div><label>Order number prefix</label><input name="orderPrefix" value="${esc(s.profile.orderPrefix)}"></div><div><label>Logo URL (optional)</label><input name="logoUrl" value="${esc(s.profile.logoUrl)}"></div></div>
      <div><label>Return policy (printed on invoices)</label><textarea name="returnPolicy" rows="3">${esc(s.profile.returnPolicy)}</textarea></div>`,
    store: tab === "store" ? storeForm(st, toggle) : "",
    password: `<div><label>Current password</label><input type="password" name="current" required></div><div><label>New password (8+ characters)</label><input type="password" name="next" minlength="8" required></div>`,
  };
  root.innerHTML = `
    <div class="page-head"><div><h1>Settings</h1></div></div>
    <div class="tabs">${TABS.map(([k, l]) => `<button class="tab ${tab === k ? "on" : ""}" data-action="tab" data-tab="${k}">${l}</button>`).join("")}</div>
    <div class="card settings-card"><form class="stack" onsubmit="return false">${forms[tab]}${tab === "store" ? "" : `<div><button class="btn" data-action="save">Save changes</button></div>`}</form></div>`;
}
