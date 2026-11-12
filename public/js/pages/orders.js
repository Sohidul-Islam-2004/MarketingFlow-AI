// Orders: list with filters, order details pop-up, new order form.
import { get, post, put } from "../api.js";
import { esc, taka, table, orderPill, dateTime, onAction, openModal, closeModal, toast, options, ORDER_STATUS, readForm, $, liveSearch } from "../ui.js";
import { itemRow, readItems, districtList } from "../shared.js";
import { updateCounts } from "../app.js";

const TABS = [["", "All"], ["pending", "Pending"], ["confirmed", "Confirmed"], ["packed", "Packed"], ["shipped", "Shipped"], ["delivered", "Delivered"], ["returned", "Returned"], ["cancelled", "Cancelled"]];
let filters = { status: "", q: "", from: "", to: "", page: 1 };
let places = null;

export async function render(root, params) {
  if (params.status !== undefined) filters = { ...filters, status: params.status, page: 1 };
  onAction(root, {
    tab: (el) => { filters.status = el.dataset.status; filters.page = 1; draw(root); },
    page: (el) => { filters.page = Number(el.dataset.page); draw(root); },
    open: (el) => openOrder(el.dataset.id, () => draw(root)),
    newOrder: () => orderForm(() => draw(root)),
  });
  root.addEventListener("change", (e) => {
    if (!e.target.dataset.filter || e.target.dataset.filter === "q") return; // the search box is handled by liveSearch
    filters[e.target.dataset.filter] = e.target.value;
    filters.page = 1;
    draw(root);
  });
  liveSearch(root, filters, () => draw(root));
  await draw(root);
  if (params.open) openOrder(params.open, () => draw(root));
}

async function draw(root) {
  const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v !== "")).toString();
  const data = await get(`/api/orders?${qs}`);
  const total = Object.values(data.counts).reduce((a, b) => a + b, 0);
  root.innerHTML = `
    <div class="page-head"><div><h1>Orders</h1><p>Every order from chats, comments and the ones you add by hand.</p></div>
      <div class="row"><a class="btn light" href="/api/orders/export.csv?${qs}">Download CSV</a><button class="btn" data-action="newOrder">+ New order</button></div></div>
    <div class="tabs">${TABS.map(([k, l]) => `<button class="tab ${filters.status === k ? "on" : ""}" data-action="tab" data-status="${k}">${l}<span class="n">${k ? data.counts[k] || 0 : total}</span></button>`).join("")}</div>
    <div class="card">
      <div class="filters">
        <input data-filter="q" placeholder="Search order no, name, phone, tracking…" value="${esc(filters.q)}" style="min-width:280px">
        <label class="small">From <input type="date" data-filter="from" value="${filters.from}"></label>
        <label class="small">To <input type="date" data-filter="to" value="${filters.to}"></label>
      </div>
      ${table([
        ["Order", (o) => `<b>${esc(o.orderNo)}</b><div class="small muted">${{ manual: "Added by you", ai_chat: "AI chat", comment: "Comment" }[o.source] || o.source}</div>`],
        ["Customer", (o) => `${esc(o.customerName)}<div class="small muted">${esc(o.phone)} · ${esc(o.district || "")}</div>`],
        ["Items", (o) => o.items.map((i) => `${esc(i.name)}${i.variantName ? ` (${esc(i.variantName)})` : ""} ×${i.qty}`).join("<br>")],
        ["Total", (o) => `<b>${taka(o.total)}</b><div class="small muted">${o.paymentMethod}${o.paid ? " · paid" : ""}</div>`],
        ["Status", (o) => orderPill(o.status)],
        ["Date", (o) => dateTime(o.createdAt)],
      ], data.rows, { emptyText: "No orders here", rowAttrs: (o) => `class="click" data-action="open" data-id="${o._id}"` })}
      <div class="row between mt"><span class="small muted">${data.total} order(s)</span>
        <div class="row">${data.page > 1 ? `<button class="btn sm light" data-action="page" data-page="${data.page - 1}">‹ Previous</button>` : ""}
        <span class="small">Page ${data.page} of ${data.pages}</span>
        ${data.page < data.pages ? `<button class="btn sm light" data-action="page" data-page="${data.page + 1}">Next ›</button>` : ""}</div></div>
    </div>`;
}

/* ---------- order details ---------- */
async function openOrder(id, refresh) {
  const o = await get(`/api/orders/${id}`);
  const early = ["pending", "confirmed"].includes(o.status);
  const body = openModal({
    title: `Order ${o.orderNo}`, wide: true, buttons: [],
    body: `
      <div class="row">${orderPill(o.status)} <span class="small muted">${dateTime(o.createdAt)}</span></div>
      <div class="grid2 mt">
        <div class="box"><h4>Customer</h4><b>${esc(o.customerName)}</b><div>${esc(o.phone)}</div><div class="small">${esc(o.address)}</div><div class="small muted">${esc(o.district || "")} · ${esc(o.zone || "")}</div>
          ${o.conversationId ? `<button type="button" class="btn sm light mt" data-action="openChat">Open chat</button>` : ""}</div>
        <div class="box"><h4>Items</h4>${o.items.map((i) => `<div class="line"><span>${esc(i.name)}${i.variantName ? ` (${esc(i.variantName)})` : ""} × ${i.qty}</span><b>${taka(i.price * i.qty)}</b></div>`).join("")}
          <div class="line"><span>Delivery</span><b>${taka(o.deliveryFee)}</b></div>${o.discount ? `<div class="line"><span>Discount</span><b>−${taka(o.discount)}</b></div>` : ""}
          <div class="line"><span><b>Total</b></span><b>${taka(o.total)}</b></div><div class="small muted">${o.paymentMethod} · ${o.paid ? "paid" : "not paid yet"}</div></div>
      </div>
      ${o.trackingNo ? `<div class="box mt"><h4>Courier</h4>${esc(o.courierName)} · <b>${esc(o.trackingNo)}</b></div>` : ""}
      <div class="box mt"><h4>Change status</h4><div class="row">
        ${o.next.map((s) => `<button type="button" class="btn sm ${s === "cancelled" || s === "returned" ? "danger" : ""}" data-action="status" data-to="${s}">→ ${ORDER_STATUS[s][0]}</button>`).join("") || `<span class="muted small">This order is finished.</span>`}
        <a class="btn sm light" target="_blank" href="/api/orders/${o._id}/invoice">Print invoice</a>
        ${early ? `<button type="button" class="btn sm light" data-action="edit">Edit details</button>` : ""}
        <button type="button" class="btn sm light" data-action="togglePaid">${o.paid ? "Mark as not paid" : "Mark as paid"}</button></div></div>
      <div class="box mt"><h4>Notes</h4><textarea id="orderNotes" rows="2">${esc(o.notes || "")}</textarea><button type="button" class="btn sm light mt" data-action="saveNotes">Save notes</button></div>
      <div class="box mt"><h4>History</h4>${o.history.slice().reverse().map((h) => `<div class="line small"><span>${esc(o.labels[h.status] || h.status)}${h.note ? ` · ${esc(h.note)}` : ""}</span><span>${esc(h.by || "")} · ${dateTime(h.at)}</span></div>`).join("")}</div>`,
  });

  const done = async (msg) => { toast(msg); closeModal(); refresh(); updateCounts(); };
  onAction(body, {
    openChat: () => { closeModal(); location.hash = `inbox?open=${o.conversationId}`; },
    status: (el) => changeStatus(o, el.dataset.to, done),
    saveNotes: async () => { await put(`/api/orders/${o._id}`, { notes: $("#orderNotes").value }); toast("Notes saved"); },
    togglePaid: async () => { await put(`/api/orders/${o._id}`, { paid: !o.paid }); done("Payment updated"); },
    edit: () => editDetails(o, done),
  });
}

// Some statuses need extra information first
function changeStatus(o, to, done) {
  const send = async (extra = {}) => { await post(`/api/orders/${o._id}/status`, { status: to, ...extra }); done(`Order is now ${ORDER_STATUS[to][0]}`); };
  if (to === "shipped") {
    return openModal({ title: "Ship order", buttons: [["ok", "Mark as shipped"]],
      body: `<div class="f2"><div><label>Courier</label><input name="courierName" placeholder="Steadfast, Pathao, own rider…"></div><div><label>Tracking number</label><input name="trackingNo"></div></div>`,
      onSubmit: (d) => send(d) });
  }
  if (to === "cancelled") {
    return openModal({ title: "Cancel order", buttons: [["ok", "Cancel order", "danger"]],
      body: `<label>Why is it cancelled?</label><input name="note" required placeholder="Customer didn't pick up the phone">`,
      onSubmit: (d) => send(d) });
  }
  if (to === "returned") {
    return openModal({ title: "Parcel returned", buttons: [["ok", "Save return", "danger"]],
      body: `<label>Reason</label><input name="note" placeholder="Customer refused"><label class="check mt"><input type="checkbox" name="restock" checked> Put the items back in stock</label>`,
      onSubmit: (d) => send(d) });
  }
  return send();
}

function editDetails(o, done) {
  openModal({ title: "Edit customer details",
    body: `<div class="f2"><div><label>Name</label><input name="customerName" value="${esc(o.customerName)}"></div><div><label>Phone</label><input name="phone" value="${esc(o.phone)}"></div></div>
      <div class="mt"><label>Address</label><input name="address" value="${esc(o.address)}"></div>
      <div class="f2 mt"><div><label>District</label><input name="district" value="${esc(o.district || "")}"></div><div><label>Discount (৳)</label><input type="number" name="discount" value="${o.discount || 0}"></div></div>
      <p class="small muted mt">The delivery fee is recalculated from the address.</p>`,
    onSubmit: async (d) => { await put(`/api/orders/${o._id}`, d); done("Order updated"); } });
}

/* ---------- new order ---------- */
async function orderForm(refresh) {
  const [products, settings] = await Promise.all([get("/api/products"), places || get("/api/settings")]);
  places = settings;
  const body = openModal({
    title: "New order", wide: true, buttons: [["save", "Create order"]],
    body: `${districtList(settings.districts)}
      <div class="f3"><div><label>Customer name</label><input name="customerName" required></div><div><label>Phone</label><input name="phone" required placeholder="01XXXXXXXXX"></div><div><label>District</label><input name="district" list="districts" placeholder="Dhaka"></div></div>
      <div class="mt"><label>Full address</label><input name="address" required placeholder="House, road, area"></div>
      <h4 class="mt">Products</h4><div id="itemRows">${itemRow(products)}</div>
      <button type="button" class="btn sm light mt" data-action="addRow">+ Add product</button>
      <div class="f3 mt"><div><label>Payment</label><select name="paymentMethod">${options(["COD", "bKash", "Nagad"])}</select></div><div><label>Discount (৳)</label><input type="number" name="discount" min="0" value="0"></div>
        <div><label>Status</label><select name="confirmed">${options([["yes", "Confirmed (I called the customer)"], ["", "Pending"]], "yes")}</select></div></div>
      <div class="mt"><label>Notes</label><input name="notes"></div>
      <div class="box mt" id="price"><span class="muted small">Choose products to see the total.</span></div>`,
    onSubmit: async (d) => {
      const order = await post("/api/orders", { ...d, items: readItems(d), confirmed: !!d.confirmed });
      toast(`Order ${order.orderNo} created`);
      refresh();
      updateCounts();
    },
  });
  onAction(body, {
    addRow: () => body.querySelector("#itemRows").insertAdjacentHTML("beforeend", itemRow(products)),
    removeRow: (el) => { if (body.querySelectorAll(".item-row").length > 1) el.closest(".item-row").remove(); showPrice(); },
  });
  // Live total from the server (same maths as the real order)
  const showPrice = async () => {
    const d = readForm($("#modalForm"));
    const items = readItems(d);
    if (!items.length) return;
    try {
      const p = await post("/api/orders/quote", { items, address: d.address, district: d.district, discount: d.discount });
      body.querySelector("#price").innerHTML = `<div class="line"><span>Products</span><b>${taka(p.subtotal)}</b></div><div class="line"><span>Delivery (${esc(p.zone?.zone || "")})</span><b>${taka(p.deliveryFee)}</b></div>${p.discount ? `<div class="line"><span>Discount</span><b>−${taka(p.discount)}</b></div>` : ""}<div class="line"><span><b>Total</b></span><b>${taka(p.total)}</b></div>`;
    } catch (e) { body.querySelector("#price").innerHTML = `<span class="small" style="color:var(--red)">${esc(e.message)}</span>`; }
  };
  body.addEventListener("change", showPrice);
}
