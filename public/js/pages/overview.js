// Overview: today's sales, what needs your attention, recent orders.
import { get } from "../api.js";
import { esc, taka, num, table, orderPill, dateTime, onAction } from "../ui.js";

let period = "today";

const changeText = (pct) => (pct == null ? "" : `<span class="${pct < 0 ? "down" : "up"}">${pct < 0 ? "↓" : "↑"} ${Math.abs(pct)}%</span>`);

// Pattern used by every page: actions are connected once, draw() can run many times.
export async function render(root) {
  onAction(root, {
    period: (el) => { period = el.dataset.p; draw(root); },
    open: (el) => { location.hash = `orders?open=${el.dataset.id}`; },
  });
  await draw(root);
}

async function draw(root) {
  const o = await get(`/api/overview?period=${period}`);
  const label = { today: "today", "7d": "in the last 7 days", "30d": "in the last 30 days" }[period];
  root.innerHTML = `
    <div class="hero">
      <div><h2>Your shop at a glance</h2><p>Numbers in Bangladesh time. Cancelled orders are not counted.</p></div>
      <div class="row">${[["today", "Today"], ["7d", "7 days"], ["30d", "30 days"]].map(([k, l]) => `<button class="tab ${k === period ? "on" : ""}" data-action="period" data-p="${k}">${l}</button>`).join("")}</div>
    </div>
    <div class="kpis">
      <div class="kpi"><div class="label">Sales</div><div class="value">${taka(o.sales.revenue)}</div><p>${label} ${changeText(o.sales.revenueChange)}</p></div>
      <div class="kpi"><div class="label">Orders</div><div class="value">${num(o.sales.orders)}</div><p>${label} ${changeText(o.sales.ordersChange)}</p></div>
      <div class="kpi"><div class="label">From chats & comments</div><div class="value">${num(o.sales.aiOrders)}</div><p>orders created by the AI</p></div>
      <div class="kpi"><div class="label">Open chats</div><div class="value">${num(o.openChats)}</div><p>in the inbox</p></div>
    </div>
    <div class="card">
      <h3>Needs your attention</h3><p class="sub">Click a box to open the list.</p>
      <div class="todo">
        <a href="#inbox?tab=needs_human"><b>${o.todo.needsHuman}</b>chats need a person</a>
        <a href="#comments"><b>${o.todo.newComments}</b>comments to answer</a>
        <a href="#fraud"><b>${o.todo.onHold}</b>orders on hold</a>
        <a href="#orders?status=pending,confirmed"><b>${o.todo.toPack}</b>orders to confirm / pack</a>
        <a href="#inventory?low=1"><b>${o.todo.lowStock}</b>products low on stock</a>
      </div>
    </div>
    <div class="card">
      <div class="row between"><h3>Latest orders</h3><a class="btn sm light" href="#orders">All orders</a></div>
      ${table([
        ["Order", (r) => `<b>${esc(r.orderNo)}</b>`],
        ["Customer", (r) => `${esc(r.customerName)}<div class="small muted">${esc(r.phone)}</div>`],
        ["Total", (r) => taka(r.total)],
        ["Status", (r) => orderPill(r.status)],
        ["Date", (r) => dateTime(r.createdAt)],
      ], o.recentOrders, { emptyText: "No orders yet", rowAttrs: (r) => `class="click" data-action="open" data-id="${r._id}"` })}
    </div>`;
}
