// Super Admin → Customers: create shop accounts, give them a "set your password" link,
// set the plan and end date, suspend / activate, delete.
import { get, post, put, del } from "../api.js";
import { esc, num, taka, dateOnly, ymd, pill, table, onAction, toast, openModal, confirmBox, options, liveSearch } from "../ui.js";

const filters = { q: "", state: "" };
const STATE = { active: ["Active", "green"], suspended: ["Suspended", "red"], expired: ["Plan ended", "yellow"] };
let data = null;

export async function render(root) {
  onAction(root, {
    create: () => customerForm(null, () => draw(root)),
    edit: (el) => customerForm(find(el), () => draw(root)),
    link: async (el) => {
      const c = find(el);
      if (!(await confirmBox(`Make a new password link for ${c.owner.email}? The old link stops working.`, "Make link", false))) return;
      showLink(await post(`/api/admin/customers/${c._id}/link`), c.owner.email, "new password");
    },
    suspend: async (el) => {
      const c = find(el);
      if (!(await confirmBox(`Suspend ${c.name}? They can't log in and their AI stops answering customers.`, "Suspend"))) return;
      await put(`/api/admin/customers/${c._id}`, { suspended: true }); toast("Suspended"); draw(root);
    },
    activate: async (el) => { await put(`/api/admin/customers/${find(el)._id}`, { suspended: false }); toast("Active again"); draw(root); },
    remove: (el) => deleteForm(find(el), () => draw(root)),
    state: (el) => { filters.state = el.dataset.state; draw(root); },
  });
  liveSearch(root, filters, () => draw(root));
  await draw(root);
}

const find = (el) => data.rows.find((c) => c._id === el.dataset.id);

async function draw(root) {
  data = await get("/api/admin/customers");
  const q = filters.q.trim().toLowerCase();
  const rows = data.rows.filter((c) => (!filters.state || c.state === filters.state) && (!q || `${c.name} ${c.owner?.email || ""} ${c.owner?.name || ""} ${c.phone}`.toLowerCase().includes(q)));
  const t = data.totals;
  root.innerHTML = `
    <div class="page-head"><div><h1>Shops</h1><p>Every shop that uses MarketingFlow. Create accounts here and send the owner the password link.</p></div>
      <button class="btn" data-action="create">+ New customer</button></div>
    <div class="kpis">
      ${[["", "All shops", t.all], ["active", "Active", t.active], ["expired", "Plan ended", t.expired], ["suspended", "Suspended", t.suspended]]
        .map(([state, label, n]) => `<a href="#" class="kpi ${filters.state === state ? "on" : ""}" data-action="state" data-state="${state}"><div class="label">${label}</div><div class="value">${num(n)}</div></a>`).join("")}
    </div>
    <div class="card mt">
      <div class="filters"><input data-filter="q" placeholder="Search shop, owner, email, phone…" value="${esc(filters.q)}"></div>
      ${table([
        ["Shop", (c) => `<b>${esc(c.name)}</b>${c.isMe ? ` ${pill("You", "blue")}` : ""}<div class="small muted">${esc(c.phone || "")} · since ${dateOnly(c.createdAt)}</div>`],
        ["Owner", (c) => (c.owner ? `${esc(c.owner.name)}<div class="small muted">${esc(c.owner.email)}</div>${c.owner.invitePending ? pill("Hasn't set password", "yellow") : `<div class="small muted">Last login: ${c.owner.lastLoginAt ? dateOnly(c.owner.lastLoginAt) : "never"}</div>`}` : `<span class="muted">none</span>`)],
        ["Plan", (c) => `${esc(c.plan)}<div class="small muted">${c.expiresAt ? `until ${dateOnly(c.expiresAt)}` : "no end date"}</div>`],
        ["Status", (c) => pill(...STATE[c.state])],
        ["Pages", (c) => `${c.pages}${c.instagram ? ` <span class="small muted">+ ${c.instagram} Instagram</span>` : ""}${c.brokenPages ? ` ${pill(`${c.brokenPages} need reconnect`, "red")}` : ""}`],
        ["Last 30 days", (c) => `${num(c.chats30)} chats · ${num(c.orders30)} orders<div class="small muted">${taka(c.revenue30)}</div>`],
        ["", (c) => `<div class="row" style="flex-wrap:nowrap">
            <button class="btn sm light" data-action="edit" data-id="${c._id}">Edit</button>
            ${c.owner ? `<button class="btn sm light" data-action="link" data-id="${c._id}" title="Make a new password link">Password link</button>` : ""}
            ${c.isMe ? "" : c.state === "suspended" ? `<button class="btn sm light" data-action="activate" data-id="${c._id}">Activate</button>` : `<button class="btn sm danger" data-action="suspend" data-id="${c._id}">Suspend</button>`}
            ${c.isMe ? "" : `<button class="btn sm danger" data-action="remove" data-id="${c._id}" title="Delete">✕</button>`}</div>`],
      ], rows, { emptyText: filters.q || filters.state ? "No customers match" : "No customers yet. Press New customer." })}
    </div>`;
}

// New customer (c = null) or edit an existing one
function customerForm(c, onDone) {
  const nextMonth = ymd(Date.now() + 30 * 86400e3);
  openModal({
    title: c ? `Edit ${c.name}` : "New customer",
    body: `
      <div class="f2">
        <div><label>Business name</label><input name="business" required value="${esc(c?.name || "")}"></div>
        <div><label>Phone</label><input name="phone" value="${esc(c?.phone || "")}" placeholder="01XXXXXXXXX"></div>
      </div>
      ${c ? "" : `<div class="f2 mt">
        <div><label>Owner's name</label><input name="ownerName" required></div>
        <div><label>Owner's email (they log in with it)</label><input name="email" type="email" required></div>
      </div>`}
      <div class="f2 mt">
        <div><label>Plan</label><select name="plan">${options(data.plans.map((p) => [p, p[0].toUpperCase() + p.slice(1)]), c?.plan || "trial")}</select></div>
        <div><label>Paid until (empty = no end date)</label><input name="expiresAt" type="date" value="${c ? (c.expiresAt ? ymd(c.expiresAt) : "") : nextMonth}"></div>
      </div>
      ${c ? "" : `<p class="small muted mt">After saving you get a link. Send it to the owner (WhatsApp / Messenger). They open it, set their own password and log in. You never see their password.</p>`}`,
    buttons: [["save", c ? "Save" : "Create account"]],
    onSubmit: async (f) => {
      if (c) {
        await put(`/api/admin/customers/${c._id}`, { name: f.business, phone: f.phone, plan: f.plan, expiresAt: f.expiresAt });
        toast("Saved");
      } else {
        const r = await post("/api/admin/customers", f);
        setTimeout(() => showLink(r, f.email, "invite"), 0); // after this pop-up closes
      }
      onDone();
    },
  });
}

function showLink(r, email, kind) {
  openModal({
    title: kind === "invite" ? "Account created: send this link" : "New password link",
    body: `
      <p>Send this link to <b>${esc(email)}</b>. It works once and for ${r.days} days.</p>
      <div class="with-btn mt"><input id="theLink" readonly value="${esc(r.link)}"><button type="button" id="copyLink">Copy</button></div>
      <p class="small muted mt">Example message: "Your MarketingFlow account is ready. Open this link and set your password: ${esc(r.link)}"</p>`,
    buttons: [],
  });
  const copy = document.getElementById("copyLink");
  copy.onclick = async () => {
    const input = document.getElementById("theLink");
    try { await navigator.clipboard.writeText(input.value); } catch { input.select(); document.execCommand("copy"); }
    copy.textContent = "Copied";
  };
}

function deleteForm(c, onDone) {
  openModal({
    title: `Delete ${c.name}?`,
    body: `
      <p class="note">This deletes the shop and <b>all</b> its data for good: products, orders, chats, posts, Pages and the owner's login. It can't be undone.</p>
      <p class="small muted mt">If they only stopped paying, use <b>Suspend</b> instead. Their data stays.</p>
      <div class="mt"><label>Type <b>${esc(c.name)}</b> to confirm</label><input name="confirmName" autocomplete="off"></div>`,
    buttons: [["delete", "Delete for good", "danger solid"]],
    onSubmit: async (f) => {
      await del(`/api/admin/customers/${c._id}`, { confirmName: f.confirmName });
      toast(`${c.name} deleted`);
      onDone();
    },
  });
}
