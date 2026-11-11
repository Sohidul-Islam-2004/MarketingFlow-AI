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

// Shown to a new shop until the four first steps are done
function gettingStarted(setup) {
  const steps = [
    ["page", "Connect your Facebook Page", "So the AI can answer Messenger chats and comments", "#accounts", "Connect"],
    ["products", "Add your products", "Name, price, sizes/colours and how many you have", "#inventory?add=1", "Add product"],
    ["knowledge", "Tell the AI about your shop", "Delivery time, return policy, size chart, common questions", "#settings", "Write"],
    ["chat", "Test the AI", "Chat with it as a customer. Nothing is sent to Facebook", "#inbox?simulate=1", "Try it"],
  ];
  const done = steps.filter(([key]) => setup[key]).length;
  if (done === steps.length) return "";
  return `<div class="card"><h3>Get your shop ready · ${done} of ${steps.length} done</h3>
    <div class="progress"><i style="width:${(done / steps.length) * 100}%"></i></div>
    <div class="steps">${steps.map(([key, title, hint, link, go], i) => setup[key]
      ? `<div class="step done"><span class="dot">✓</span><div><b>${title}</b></div></div>`
      : `<a class="step" href="${link}"><span class="dot">${i + 1}</span><div><b>${title}</b><small>${hint}</small></div><span class="go">${go} →</span></a>`).join("")}</div></div>`;
}

async function draw(root) {
  const o = await get(`/api/overview?period=${period}`);
  const label = { today: "today", "7d": "in the last 7 days", "30d": "in the last 30 days" }[period];
  root.innerHTML = `
    <div class="hero">
      <div><h2>Your shop at a glance</h2><p>Numbers in Bangladesh time. Cancelled orders are not counted.</p></div>
      <div class="row">${[["today", "Today"], ["7d", "7 days"], ["30d", "30 days"]].map(([k, l]) => `<button class="tab ${k === period ? "on" : ""}" data-action="period" data-p="${k}">${l}</button>`).join("")}</div>
    </div>
    ${gettingStarted(o.setup)}
    <div class="kpis mt">
      <div class="kpi"><div class="label">Sales</div><div class="value">${taka(o.sales.revenue)}</div><p>${label} ${changeText(o.sales.revenueChange)}</p></div>
      <div class="kpi"><div class="label">Orders</div><div class="value">${num(o.sales.orders)}</div><p>${label} ${changeText(o.sales.ordersChange)}</p></div>
      <div class="kpi"><div class="label">From chats & comments</div><div class="value">${num(o.sales.aiOrders)}</div><p>orders created by the AI</p></div>
      <div class="kpi"><div class="label">Open chats</div><div class="value">${num(o.openChats)}</div><p>in the inbox</p></div>
    </div>
    <div class="card">
      <h3>Needs your attention</h3><p class="sub">${Object.values(o.todo).some(Boolean) ? "Click a box to open the list." : "Nothing is waiting for you. 🎉"}</p>
      <div class="todo">
        ${[["#inbox?tab=needs_human", o.todo.needsHuman, "chats need a person"], ["#comments", o.todo.newComments, "comments to answer"], ["#fraud", o.todo.onHold, "orders on hold"],
          ["#orders?status=pending,confirmed", o.todo.toPack, "orders to confirm / pack"], ["#inventory?low=1", o.todo.lowStock, "products low on stock"]]
          .map(([link, n, text]) => `<a href="${link}" class="${n ? "has" : ""}"><b>${n}</b>${text}</a>`).join("")}
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
      ], o.recentOrders, { emptyText: "No orders yet. They appear here when the AI or you create one.", rowAttrs: (r) => `class="click" data-action="open" data-id="${r._id}"` })}
    </div>`;
}
