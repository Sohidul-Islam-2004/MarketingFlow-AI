// Home: sales, what the AI did for you, the last 7 days, what needs your attention, recent orders.
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
    ["knowledge", "Train the AI on your shop", "It reads your Facebook Page and website and learns your delivery and return rules", "#train", "Train"],
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

// "2 h 15 min" from minutes
const timeText = (min) => (min >= 60 ? `${Math.floor(min / 60)} h ${min % 60 ? `${min % 60} min` : ""}` : `${min} min`);

// What the AI did: the reason a shop pays for MarketingFlow
function aiCard(ai, label) {
  return `<div class="card ai-card">
    <div class="ai-card-head"><span class="ai-badge">🤖</span><div><h3>Your AI worked for you</h3><p class="small muted">${label}</p></div></div>
    ${ai.minutesSaved ? `<div class="ai-saved"><b>≈ ${timeText(ai.minutesSaved)}</b><span>of typing saved</span></div>`
      : `<div class="ai-saved"><span>No customer chats yet in this period. The AI's work shows here as soon as customers message your Page.</span></div>`}
    <div class="ai-stats">
      <div><b>${num(ai.chats)}</b><span>chats answered</span></div>
      <div><b>${num(ai.replies)}</b><span>messages sent</span></div>
      <div><b>${num(ai.orders)}</b><span>orders taken</span></div>
      <div><b>${num(ai.comments)}</b><span>comments replied</span></div>
    </div></div>`;
}

// Bars for the last 7 days (sales in taka)
function weekCard(week) {
  const max = Math.max(1, ...week.map((d) => d.revenue));
  const total = week.reduce((s, d) => s + d.revenue, 0);
  const dayName = (ymd, i) => (i === 6 ? "Today" : new Date(`${ymd}T12:00:00+06:00`).toLocaleDateString("en-GB", { weekday: "short", timeZone: "Asia/Dhaka" }));
  return `<div class="card">
    <div class="row between"><div><h3>Last 7 days</h3><p class="small muted">${taka(total)} · ${num(week.reduce((s, d) => s + d.orders, 0))} orders</p></div></div>
    <div class="bars">${week.map((d, i) => `<div class="bar ${i === 6 ? "today" : ""}" title="${taka(d.revenue)} · ${d.orders} orders">
        <span class="bar-val">${d.revenue ? taka(d.revenue).replace(/,\d{3}$/, "k") : ""}</span>
        <i style="height:${Math.max(3, Math.round((d.revenue / max) * 100))}%"></i><span class="bar-day">${dayName(d.day, i)}</span></div>`).join("")}</div>
  </div>`;
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
    <div class="grid2 home-grid">${aiCard(o.ai, label[0].toUpperCase() + label.slice(1))}${weekCard(o.week)}</div>
    <div class="card">
      <h3>Needs your attention</h3><p class="sub">${Object.values(o.todo).some(Boolean) ? "Click a box to open the list." : "Nothing is waiting for you. 🎉"}</p>
      <div class="todo">
        ${[["#inbox?tab=needs_human", o.todo.needsHuman, "chats need a person"], ["#comments", o.todo.newComments, "comments to answer"],
          ["#orders?status=pending,confirmed", o.todo.toPack, "orders to call / pack"], ["#inventory?low=1", o.todo.lowStock, "products low on stock"]]
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
