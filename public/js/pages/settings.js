// Settings: business profile, AI agent, comment replies, delivery zones, Fraud Shield, password.
import { get, put, post } from "../api.js";
import { esc, onAction, toast, options, readForm, confirmBox } from "../ui.js";

let tab = "ai";
const TABS = [["ai", "AI agent"], ["comments", "Comments"], ["zones", "Delivery fees"], ["fraud", "Fraud Shield"], ["profile", "Business"], ["password", "Password"]];

export async function render(root) {
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
    testZone: async (el) => {
      const r = await post("/api/settings/zones/test", { address: el.closest("form").querySelector("#testAddress").value });
      el.closest("form").querySelector("#testResult").textContent = `→ ${r.zone} · ৳${r.fee} · district: ${r.district || "unknown"} (matched by ${r.matched})`;
    },
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

async function draw(root) {
  const s = await get("/api/settings");
  const check = (name, on, text) => `<label class="check"><input type="checkbox" name="${name}" ${on ? "checked" : ""}> ${text}</label>`;
  const forms = {
    ai: `${s.ai.ready ? "" : `<div class="note">AI is not set up: add AI_API_KEY to .env and restart the server.</div>`}
      ${check("enabled", s.ai.enabled, "AI answers customers in Messenger / Instagram")}
      ${check("autoConfirm", s.ai.autoConfirm, "Orders the AI takes are Confirmed straight away (off = Pending, you call first)")}
      <div class="f2"><div><label>Tone</label><select name="tone">${options([["friendly", "Friendly"], ["professional", "Professional"], ["formal", "Formal"]], s.ai.tone)}</select></div>
        <div><label>Hand the chat to you when the AI is less sure than (%)</label><input type="number" name="handoffBelow" min="0" max="100" value="${s.ai.handoffBelow}"></div></div>
      <div><label>Delivery time (the AI tells customers this)</label><input name="deliveryTime" value="${esc(s.ai.deliveryTime)}"></div>
      <div><label>Shop knowledge: return policy, size chart, opening hours, address, FAQ. The AI only uses what is written here + your products.</label><textarea name="knowledge" rows="10">${esc(s.ai.knowledge)}</textarea></div>
      <div><label>Message when the AI hands the chat to you</label><input name="handoffMessage" value="${esc(s.ai.handoffMessage)}"></div>`,
    comments: `${check("sendDm", s.comments.sendDm, "Send a private Messenger message to people who ask about price / stock / ordering")}
      ${check("autoReply", s.comments.autoReply, "Post a public reply under the comment (template with your real prices)")}
      ${check("needApproval", s.comments.needApproval, "Don't post public replies until I approve them")}
      ${check("hideSpam", s.comments.hideSpam, "Hide spam comments (links, blocked words) on Facebook")}
      <div class="f2"><div><label>Wait before replying (seconds, looks more natural)</label><input type="number" name="delaySec" min="0" max="600" value="${s.comments.delaySec}"></div>
        <div><label>Blocked words (comma separated, treated as spam)</label><input name="blockedWords" value="${esc((s.comments.blockedWords || []).join(", "))}"></div></div>
      <p class="small muted">Complaints ("fake", "refund", "পাইনি"...) are never answered automatically. They wait for you in FB Comments.</p>`,
    zones: `<p class="small muted">Every order's delivery fee comes from these zones. The address is matched by area first (e.g. "Savar" → suburbs), then by district. If nothing matches, the default zone is used.${s.usingDefaultZones ? " You are using the built-in zones." : ""}</p>
      <div id="zones">${s.zones.map(zoneRow).join("")}</div>
      <div class="row mt"><button type="button" class="btn sm light" data-action="addZone">+ Zone</button>${s.usingDefaultZones ? "" : `<button type="button" class="btn sm light" data-action="resetZones">Use built-in zones</button>`}</div>
      <div class="box mt"><h4>Test an address</h4><div class="row"><input id="testAddress" placeholder="House 5, Mirpur 10" style="flex:1"><button type="button" class="btn sm light" data-action="testZone">Test</button></div><p class="small mt" id="testResult"></p></div>`,
    fraud: `<div><label>Put an order on hold when its risk score is at least</label><input type="number" name="holdAtScore" min="20" max="100" value="${s.fraud.holdAtScore}"></div>
      ${check("refuseBlocked", s.fraud.refuseBlocked, "Refuse orders from blocked phone numbers (off = create them on hold)")}
      <p class="small muted">Score: +25 per returned order (max 50), +15 for 3+ orders in 24h, +20 if 3+ phones use one address, +20 for a fake-looking name/phone, −15 per delivered order (max −30), 100 if blocked.</p>`,
    profile: `<div class="f2"><div><label>Business name</label><input name="name" required value="${esc(s.profile.name)}"></div><div><label>Phone (on invoices)</label><input name="phone" value="${esc(s.profile.phone)}"></div></div>
      <div class="f2"><div><label>Order number prefix</label><input name="orderPrefix" value="${esc(s.profile.orderPrefix)}"></div><div><label>Logo URL (optional)</label><input name="logoUrl" value="${esc(s.profile.logoUrl)}"></div></div>
      <div><label>Return policy (printed on invoices)</label><textarea name="returnPolicy" rows="3">${esc(s.profile.returnPolicy)}</textarea></div>`,
    password: `<div><label>Current password</label><input type="password" name="current" required></div><div><label>New password (8+ characters)</label><input type="password" name="next" minlength="8" required></div>`,
  };
  root.innerHTML = `
    <div class="page-head"><div><h1>Settings</h1></div></div>
    <div class="tabs">${TABS.map(([k, l]) => `<button class="tab ${tab === k ? "on" : ""}" data-action="tab" data-tab="${k}">${l}</button>`).join("")}</div>
    <div class="card" style="max-width:860px"><form class="stack" onsubmit="return false">${forms[tab]}<div><button class="btn" data-action="save">Save</button></div></form></div>`;
}
