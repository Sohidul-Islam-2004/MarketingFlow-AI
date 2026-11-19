// Customers: everyone who ordered from you (grouped by phone number), with all their orders.
// Handy before a confirmation call: a customer who often returns or cancels is marked in red.
import { get } from "../api.js";
import { esc, taka, shortTime, onAction, liveSearch, openModal, closeModal } from "../ui.js";
import { openOrder } from "./orders.js";
import { row, letter, leadIcon, status } from "../mobile/kit.js";

const TAG = { regular: ["Regular", "green"], risky: ["Returns often", "red"], new: ["New", "blue"] };
const TONE = { pending: "amber", confirmed: "blue", packed: "purple", shipped: "purple", delivered: "green", returned: "grey", cancelled: "grey" };
const filters = { q: "" };

export async function render(root, params) {
  onAction(root, { open: (el) => openCustomer(el.dataset.id, () => draw(root)) });
  liveSearch(root, filters, () => draw(root));
  await draw(root);
  if (params.open) openCustomer(params.open, () => draw(root));
}

const tagText = (c) => (TAG[c.tag] ? `<small class="st st-${TAG[c.tag][1]}">${TAG[c.tag][0]}</small>` : "");

async function draw(root) {
  const rows = await get(`/api/customers${filters.q ? `?q=${encodeURIComponent(filters.q)}` : ""}`);
  root.innerHTML = `
    <div class="page-head"><div><h1>Customers</h1><p>Everyone who ordered from you. Open one to see all their orders before you call.</p></div></div>
    <div class="card">
      <div class="filters"><input data-filter="q" placeholder="Search name, phone or address…" value="${esc(filters.q)}"></div>
      ${rows.length ? `<div class="m-list">${rows.map((c) => row({
        action: "open", id: c.phone, lead: letter(c.name), title: esc(c.name),
        sub: `${esc(c.phone)}${c.district ? ` · ${esc(c.district)}` : ""}`,
        side: `<b>${c.orderCount} order${c.orderCount > 1 ? "s" : ""}</b>${tagText(c) || `<small>${shortTime(c.lastOrderAt)}</small>`}`,
      })).join("")}</div>`
        : `<div class="empty"><b>${filters.q ? "No customer found" : "No customers yet"}</b>${filters.q ? "" : "Everyone who orders shows up here."}</div>`}
    </div>`;
}

// One customer: call, chat, their numbers and every order
async function openCustomer(phone, refresh) {
  const c = await get(`/api/customers/${encodeURIComponent(phone)}`);
  const tel = String(c.phone).replace(/[^0-9+]/g, "");
  const body = openModal({
    title: c.name, buttons: [],
    body: `<div class="row"><a class="btn light" href="tel:${esc(tel)}">📞 ${esc(c.phone)}</a>
        ${c.conversationId ? `<button type="button" class="btn light" data-action="chat">💬 Open chat</button>` : ""} ${tagText(c)}</div>
      <p class="small muted mt">${esc(c.address)}${c.district && !String(c.address).toLowerCase().includes(String(c.district).toLowerCase()) ? `, ${esc(c.district)}` : ""}</p>
      <div class="cust-stats mt">
        <div><b>${c.orderCount}</b><span>orders</span></div>
        <div><b>${c.delivered}</b><span>delivered</span></div>
        <div><b class="${c.returned + c.cancelled ? "warn-text" : ""}">${c.returned + c.cancelled}</b><span>returned or cancelled</span></div>
        <div><b>${taka(c.spent)}</b><span>bought (delivered)</span></div>
      </div>
      <h4 class="mt">Orders</h4>
      <div class="m-list">${c.orders.map((o) => row({
        action: "order", id: o._id, lead: leadIcon("orders", TONE[o.status] || "grey"), title: `#${esc(o.orderNo)}`,
        sub: `${shortTime(o.createdAt)} · ${esc(o.items.map((i) => `${i.name}${i.variantName ? ` (${i.variantName})` : ""} ×${i.qty}`).join(", "))}`,
        side: `<b>${taka(o.total)}</b>${status(o.status)}`,
      })).join("")}</div>`,
  });
  onAction(body, {
    order: (el) => openOrder(el.dataset.id, refresh), // the order opens in the same pop-up
    chat: () => { closeModal(); location.hash = `inbox?open=${c.conversationId}`; },
  });
}
