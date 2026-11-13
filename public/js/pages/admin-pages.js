// Super Admin → All Pages: every Facebook Page connected by any shop.
// See which ones work, which need a reconnect, and how busy they are. Pages are only connected
// by their owners (Facebook login): the admin can check, switch the AI off, or disconnect.
import { get, post, del } from "../api.js";
import { esc, num, dateTime, dateOnly, pill, table, onAction, toast, confirmBox, liveSearch } from "../ui.js";

const filters = { q: "", show: "" };
let data = null;

export async function render(root) {
  onAction(root, {
    checkAll: async () => {
      toast("Checking every Page with Facebook… this can take a minute");
      const r = await post("/api/admin/pages/check");
      toast(`Checked ${r.checked} Pages: ${r.broken} need a reconnect`, r.broken > 0);
      draw(root);
    },
    ai: async (el) => {
      const p = find(el);
      const on = !p.aiOn;
      if (!on && !(await confirmBox(`Switch off the AI for ${p.business}? It stops answering Messenger chats (comments still get their template replies).`, "Switch off"))) return;
      await post(`/api/admin/pages/${p._id}/ai`, { on });
      toast(on ? "AI on" : "AI off");
      draw(root);
    },
    remove: async (el) => {
      const p = find(el);
      if (!(await confirmBox(`Disconnect ${p.accountName} from ${p.business}? Messages stop arriving until the owner connects it again.`, "Disconnect"))) return;
      await del(`/api/admin/pages/${p._id}`);
      toast("Disconnected");
      draw(root);
    },
    show: (el) => { filters.show = el.dataset.show; draw(root); },
  });
  liveSearch(root, filters, () => draw(root));
  await draw(root);
}

const find = (el) => data.rows.find((p) => p._id === el.dataset.id);

const SHOW = {
  "": () => true,
  working: (p) => p.status === "active" && p.webhooksOn,
  reconnect: (p) => p.status !== "active",
  webhooksOff: (p) => p.status === "active" && !p.webhooksOn,
  silent: (p) => p.silent,
};

function statusOf(p) {
  if (p.status !== "active") return pill("Reconnect needed", "red") + (p.statusNote ? `<div class="small muted" title="${esc(p.statusNote)}">${esc(p.statusNote.slice(0, 60))}</div>` : "");
  if (!p.webhooksOn) return pill("Messages off", "red");
  if (p.silent) return pill("Working, but quiet 7+ days", "yellow");
  return pill("Working", "green");
}

async function draw(root) {
  data = await get("/api/admin/pages");
  const q = filters.q.trim().toLowerCase();
  const rows = data.rows.filter((p) => SHOW[filters.show](p) && (!q || `${p.accountName} ${p.business} ${p.accountId}`.toLowerCase().includes(q)));
  const t = data.totals;
  root.innerHTML = `
    <div class="page-head"><div><h1>All Facebook Pages</h1><p>Every Page your customers connected. Tokens are checked by themselves every 6 hours.</p></div>
      <button class="btn light" data-action="checkAll">Check all Pages now</button></div>
    <div class="kpis">
      ${[["", "Connected", t.all], ["working", "Working", t.working], ["reconnect", "Reconnect needed", t.reconnect], ["webhooksOff", "Messages off", t.webhooksOff], ["silent", "Quiet 7+ days", t.silent]]
        .map(([key, label, n]) => `<a href="#" class="kpi ${filters.show === key ? "on" : ""}" data-action="show" data-show="${key}"><div class="label">${label}</div><div class="value">${num(n)}</div></a>`).join("")}
    </div>
    <div class="card mt">
      <div class="filters"><input data-filter="q" placeholder="Search Page or shop…" value="${esc(filters.q)}"></div>
      ${table([
        ["Page", (p) => `<div class="row" style="flex-wrap:nowrap">${p.pictureUrl ? `<img src="${esc(p.pictureUrl)}" style="width:28px;height:28px;border-radius:50%">` : ""}<div><b>${esc(p.accountName)}</b><div class="small muted"><a href="https://facebook.com/${esc(p.accountId)}" target="_blank" rel="noopener">${esc(p.accountId)}</a></div></div></div>`],
        ["Shop", (p) => `${esc(p.business)}${p.shopState !== "active" ? ` ${pill(p.shopState === "expired" ? "Plan ended" : "Suspended", "yellow")}` : ""}<div class="small muted">connected ${dateOnly(p.connectedAt)}</div>`],
        ["Status", statusOf],
        ["Last message from Facebook", (p) => (p.lastWebhookAt ? dateTime(p.lastWebhookAt) : `<span class="muted">none yet</span>`)],
        ["Chats (30 days)", (p) => num(p.chats30)],
        ["AI", (p) => (p.aiOn ? pill("On", "green") : pill("Off", "grey"))],
        ["", (p) => `<div class="row" style="flex-wrap:nowrap"><button class="btn sm light" data-action="ai" data-id="${p._id}">${p.aiOn ? "AI off" : "AI on"}</button><button class="btn sm danger" data-action="remove" data-id="${p._id}">Disconnect</button></div>`],
      ], rows, { emptyText: filters.q || filters.show ? "No Pages match" : "No shop has connected a Page yet" })}
    </div>`;
}
