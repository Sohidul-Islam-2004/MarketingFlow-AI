// App start: login screen, side menu, and switching pages.
// Each page lives in js/pages/<name>.js and exports render(root, params).
import { get, post } from "./api.js";
import { $, esc, icon, toast, openModal, dateTime, loading } from "./ui.js";

const MENU = [
  ["SHOP", [["overview", "Overview"], ["inbox", "Customer Inbox"], ["comments", "FB Comments"], ["orders", "Orders"], ["inventory", "Inventory"]]],
  ["MARKETING", [["content", "Content Studio"], ["calendar", "Calendar"]]],
  ["SETTINGS", [["train", "AI Training"], ["accounts", "Facebook Page"], ["settings", "Settings"]]],
];
const PAGES = MENU.flatMap(([, items]) => items.map(([id]) => id));
const LABELS = Object.fromEntries(MENU.flatMap(([, items]) => items));

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
      <div><label>Password ${signup ? "(at least 8 characters)" : ""}</label>
        <div class="with-btn"><input name="password" type="password" required ${signup ? 'minlength="8" autocomplete="new-password"' : 'autocomplete="current-password"'}><button type="button" id="showPass">Show</button></div></div>
      ${signup ? `<div><label>Business name</label><input name="business" placeholder="e.g. Rahim Fashion"></div>` : ""}
      <p class="note small hidden" id="authError"></p>
      <button class="btn full">${signup ? "Create account" : "Log in"}</button>
      <p class="small muted center">${signup ? "Already have an account?" : "New here?"} <a href="#" data-mode="${signup ? "login" : "signup"}">${signup ? "Log in" : "Create an account"}</a></p>
    </form></div>`;
  $("#showPass").onclick = (e) => { const input = box.querySelector("[name=password]"); input.type = input.type === "password" ? "text" : "password"; e.target.textContent = input.type === "password" ? "Show" : "Hide"; };
  box.querySelectorAll("[data-mode]").forEach((b) => (b.onclick = (e) => { e.preventDefault(); showLogin(b.dataset.mode); }));
  $("#authForm").onsubmit = async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    const button = e.target.querySelector("button.full");
    button.classList.add("busy");
    try {
      await post(`/api/auth/${signup ? "signup" : "login"}`, data);
      location.reload();
    } catch (err) {
      $("#authError").textContent = err.message;
      $("#authError").classList.remove("hidden");
      button.classList.remove("busy");
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
    menuCounts = { inbox: o.todo.needsHuman, comments: o.todo.newComments };
    drawMenu(currentPage(), menuCounts);
    // the same total on the phone top bar and in the browser tab
    const waiting = o.todo.needsHuman + o.todo.newComments;
    $("#topCount").textContent = waiting;
    $("#topCount").classList.toggle("hidden", !waiting);
    document.title = `${waiting ? `(${waiting}) ` : ""}MarketingFlow AI`;
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
  closeMenu();
  $("#topTitle").textContent = LABELS[page];
  const root = document.createElement("div"); // a fresh element each time, so old click handlers disappear
  root.innerHTML = loading();
  $("#page").replaceChildren(root);
  window.scrollTo(0, 0);
  try {
    const module = await import(`./pages/${page}.js`);
    if (id === renderId) await module.render(root, currentParams());
  } catch (e) {
    if (id !== renderId) return;
    root.innerHTML = `<div class="card"><b>Couldn't load this page</b><p class="muted">${esc(e.message)}</p><button class="btn light mt" id="retry">Try again</button></div>`;
    $("#retry").onclick = showPage;
  }
}

/* ---------- phone: slide-in menu ---------- */
const closeMenu = () => document.body.classList.remove("menu-open");
$("#menuBtn").onclick = () => document.body.classList.toggle("menu-open");
$("#shade").onclick = closeMenu;
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
  setInterval(() => document.hidden || refreshCounts(), 60000); // not while the tab is in the background
})();

// Pages call this after changes that affect the red counters
export const updateCounts = refreshCounts;
