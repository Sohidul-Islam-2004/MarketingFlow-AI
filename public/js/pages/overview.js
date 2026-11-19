// Home: what to do now, sales, what the AI did for you, the last 7 days, the latest orders.
import { get } from "../api.js";
import { esc, taka, num, onAction, greeting, icon } from "../ui.js";
import { session } from "../app.js";
import { row, leadIcon, orderRow } from "../mobile/kit.js";

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

// The things waiting for you; only the ones with a number are shown
function doNow(todo, pageConnected) {
  const items = [
    ["#orders?status=pending", "phone", "amber", "Call to confirm", todo.toCall, "AI orders wait for your call"],
    ["#inbox?tab=needs_human", "chats", "red", "Chats need you", todo.needsHuman, "the AI handed them to you"],
    ["#comments", "comments", "blue", "Comments to answer", todo.newComments, "complaints and questions"],
    ["#orders?status=confirmed", "box", "purple", "Orders to pack", Math.max(0, (todo.toPack || 0) - (todo.toCall || 0)), "confirmed, not packed yet"],
    ["#inventory?low=1", "inventory", "pink", "Running low", todo.lowStock, "products almost sold out"],
  ].filter((t) => t[4] > 0);
  return `<div class="card"><h3>Do now</h3><p class="small muted">${items.length ? "Open one to get it done." : "Nothing is waiting for you."}</p>
    ${items.length ? `<div class="m-list">${items.map(([href, ic, tone, label, n, hint]) => row({ href, lead: leadIcon(ic, tone), title: label, sub: hint, side: `<span class="m-count tone-${tone}">${n}</span>` })).join("")}</div>`
      : pageConnected ? `<div class="all-clear">${icon("check")} All caught up. The AI is answering your customers.</div>`
      : `<p class="muted mt">When your Facebook Page is connected, chats to answer and orders to call show up here.</p>`}</div>`;
}

async function draw(root) {
  const o = await get(`/api/overview?period=${period}`);
  const label = { today: "today", "7d": "in the last 7 days", "30d": "in the last 30 days" }[period];
  const first = String(session.me?.user?.name || "").split(" ")[0];
  const setup = gettingStarted(o.setup);
  root.innerHTML = `
    <div class="page-head home-head"><div><h1>${greeting()}${first ? `, ${esc(first)}` : ""} 👋</h1><p>Here is your shop ${label}. Cancelled orders are not counted.</p></div>
      <div class="tabs">${[["today", "Today"], ["7d", "7 days"], ["30d", "30 days"]].map(([k, l]) => `<button class="tab ${k === period ? "on" : ""}" data-action="period" data-p="${k}">${l}</button>`).join("")}</div></div>
    ${setup}
    <div class="kpis ${setup ? "mt" : ""}">
      <div class="kpi"><div class="label">Sales</div><div class="value">${taka(o.sales.revenue)}</div><p>${label} ${changeText(o.sales.revenueChange)}</p></div>
      <div class="kpi"><div class="label">Orders</div><div class="value">${num(o.sales.orders)}</div><p>${label} ${changeText(o.sales.ordersChange)}</p></div>
      <div class="kpi"><div class="label">Taken by the AI</div><div class="value">${num(o.sales.aiOrders)}</div><p>orders from chats & comments</p></div>
      <div class="kpi"><div class="label">Open chats</div><div class="value">${num(o.openChats)}</div><p>the AI is answering</p></div>
    </div>
    <div class="grid2 home-grid">${doNow(o.todo, o.setup.page)}${aiCard(o.ai, label[0].toUpperCase() + label.slice(1))}</div>
    <div class="grid2 home-grid">${weekCard(o.week)}
      <div class="card"><div class="row between"><h3>Latest orders</h3><a class="btn sm light" href="#orders">All orders</a></div>
        ${o.recentOrders.length ? `<div class="m-list">${o.recentOrders.slice(0, 5).map((r) => orderRow(r)).join("")}</div>` : `<div class="empty"><b>No orders yet</b>They appear here when the AI or you create one.</div>`}</div>
    </div>`;
}
