// App start: login screen, side menu, and switching pages.
// Each page lives in js/pages/<name>.js and exports render(root, params).
import { get, post } from "./api.js";
import { $, esc, icon, toast, openModal, dateTime } from "./ui.js";

const MENU = [
  ["SHOP", [["overview", "Overview"], ["inbox", "Customer Inbox"], ["comments", "FB Comments"], ["orders", "Orders"], ["inventory", "Inventory"], ["fraud", "Fraud Shield"]]],
  ["MARKETING", [["content", "Content Studio"], ["calendar", "Calendar"]]],
  ["SETTINGS", [["accounts", "Meta Accounts"], ["settings", "Settings"]]],
];
const PAGES = MENU.flatMap(([, items]) => items.map(([id]) => id));

/* ---------- login / sign up ---------- */
function showLogin(mode = "login") {
  $("#app").classList.add("hidden");
  const box = $("#auth");
  box.classList.remove("hidden");
  const signup = mode === "signup";
  box.innerHTML = `<div class="auth-card">
    <div class="brand"><div class="logo">${icon("send")}</div><span>MarketingFlow AI</span></div>
    <div class="tabs"><button class="tab ${signup ? "" : "on"}" data-mode="login">Log in</button><button class="tab ${signup ? "on" : ""}" data-mode="signup">Create account</button></div>
    <form id="authForm" class="stack">
      ${signup ? `<div><label>Your name</label><input name="name" required></div>` : ""}
      <div><label>Email</label><input name="email" type="email" required autocomplete="email"></div>
      <div><label>Password</label><input name="password" type="password" required ${signup ? 'minlength="8" autocomplete="new-password"' : 'autocomplete="current-password"'}></div>
      ${signup ? `<div><label>Business name</label><input name="business" placeholder="e.g. Rahim Fashion"></div>` : ""}
      <button class="btn full">${signup ? "Create account" : "Log in"}</button>
      <p class="small" id="authError" style="color:var(--red)"></p>
    </form></div>`;
  box.querySelectorAll("[data-mode]").forEach((b) => (b.onclick = () => showLogin(b.dataset.mode)));
  $("#authForm").onsubmit = async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    try {
      await post(`/api/auth/${signup ? "signup" : "login"}`, data);
      location.reload();
    } catch (err) {
      $("#authError").textContent = err.message;
    }
  };
}
window.addEventListener("logged-out", () => showLogin());

/* ---------- side menu ---------- */
function drawMenu(active, counts = {}) {
  $("#nav").innerHTML = MENU.map(([group, items]) =>
    `<div class="nav-group">${group}</div>` +
    items.map(([id, label]) => `<a class="nav ${id === active ? "active" : ""}" href="#${id}">${icon(id)}${label}${counts[id] ? `<span class="count">${counts[id]}</span>` : ""}</a>`).join("")
  ).join("");
}

// Red counters in the menu (chats that need a person, comments to answer, orders on hold)
let menuCounts = {};
async function refreshCounts() {
  try {
    const o = await get("/api/overview?period=today");
    menuCounts = { inbox: o.todo.needsHuman, comments: o.todo.newComments, fraud: o.todo.onHold };
    drawMenu(currentPage(), menuCounts);
    const n = await get("/api/notifications");
    $("#bell").innerHTML = icon("bell") + (n.unread ? `<span class="badge">${n.unread}</span>` : "");
  } catch {}
}

/* ---------- notifications ---------- */
async function showNotifications() {
  const n = await get("/api/notifications");
  const body = openModal({
    title: "Notifications",
    buttons: n.unread ? [["read", "Mark all as read"]] : [],
    body: n.rows.length ? n.rows.map((x) => `<div class="notif ${x.read ? "" : "unread"}" data-view="${esc(x.view || "")}"><b>${esc(x.title)}</b><div class="small muted">${esc(x.message)} · ${dateTime(x.createdAt)}</div></div>`).join("") : `<p class="muted">No notifications yet.</p>`,
    onSubmit: async () => { await post("/api/notifications/read"); refreshCounts(); },
  });
  body.querySelectorAll("[data-view]").forEach((el) => (el.onclick = () => { if (el.dataset.view) location.hash = el.dataset.view; $("#modal").close(); }));
}

/* ---------- pages ---------- */
// "#orders?status=pending" -> { page: "orders", params: { status: "pending" } }
function currentPage() {
  const page = location.hash.slice(1).split("?")[0];
  return PAGES.includes(page) ? page : "overview";
}
function currentParams() {
  return Object.fromEntries(new URLSearchParams(location.hash.split("?")[1] || ""));
}

let renderId = 0;
async function showPage() {
  const page = currentPage();
  const id = ++renderId;
  drawMenu(page, menuCounts);
  const root = document.createElement("div"); // a fresh element each time, so old click handlers disappear
  $("#page").replaceChildren(root);
  try {
    const module = await import(`./pages/${page}.js`);
    if (id === renderId) await module.render(root, currentParams());
  } catch (e) {
    root.innerHTML = `<div class="card"><b>Couldn't load this page</b><p class="muted">${esc(e.message)}</p></div>`;
  }
}
window.addEventListener("hashchange", showPage);

/* ---------- start ---------- */
(async () => {
  let me;
  try { me = await get("/api/auth/me"); } catch { return showLogin(); }
  $("#auth").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#logo").innerHTML = icon("send");
  $("#meAvatar").textContent = me.user.name[0].toUpperCase();
  $("#meName").textContent = me.user.name;
  $("#meBusiness").textContent = me.business;
  $("#logout").innerHTML = icon("logout");
  $("#logout").onclick = async () => { await post("/api/auth/logout"); location.reload(); };
  $("#bell").innerHTML = icon("bell");
  $("#bell").onclick = () => showNotifications().catch((e) => toast(e.message, true));
  await showPage();
  refreshCounts();
  setInterval(refreshCounts, 60000);
})();

// Pages call this after changes that affect the red counters
export const updateCounts = refreshCounts;
