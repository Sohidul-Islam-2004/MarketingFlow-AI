// App start: login screen, side menu, and switching pages.
// Each page lives in js/pages/<name>.js and exports render(root, params).
import { get, post } from "./api.js";
import { $, esc, icon, toast, openModal, dateTime, loading } from "./ui.js";
import { applyTheme } from "./theme.js";

applyTheme(); // the shop's colours (Setup → Look), before anything is drawn

// The menu has 6 places. Some hold more than one page, shown as tabs at the top of the page.
//   [menu id, menu label, [[page id, tab label], …]]   the first page opens when the menu item is clicked
const MENU = [
  ["overview", "Home", [["overview", "Home"]]],
  ["inbox", "Inbox", [["inbox", "Chats"], ["comments", "Comments"]]],
  ["orders", "Orders", [["orders", "Orders"]]],
  ["inventory", "Products", [["inventory", "Products"]]],
  ["content", "Posts", [["content", "Posts"], ["calendar", "Calendar"]]],
  ["setup", "Setup", [["accounts", "Facebook & Instagram"], ["train", "AI Training"], ["settings", "Settings"], ["look", "Look"]]],
];
const ADMIN_MENU = [["admin-customers", "Customers", [["admin-customers", "Customers"]]], ["admin-pages", "All Pages", [["admin-pages", "All Pages"]]]]; // SUPER_ADMIN_EMAILS only
let SHOW_ADMIN = false;
const allMenu = () => (SHOW_ADMIN ? [...MENU, ...ADMIN_MENU] : MENU);
const sectionOf = (page) => allMenu().find(([, , pages]) => pages.some(([id]) => id === page)) || MENU[0];
const pageIds = () => allMenu().flatMap(([, , pages]) => pages.map(([id]) => id));
const labelOf = (page) => { const s = sectionOf(page); return s[2].length > 1 ? s[1] : s[2].find(([id]) => id === page)?.[1] || s[1]; };
const MENU_ICON = { setup: "settings" };

/* ---------- login / sign up ---------- */
let loginOptions = null; // { signup: can people create accounts?, support: who to contact }
async function showLogin(mode = "login") {
  $("#app").classList.add("hidden");
  const box = $("#auth");
  box.classList.remove("hidden");
  loginOptions ||= await get("/api/auth/options").catch(() => ({ signup: false, support: "" }));
  const signup = mode === "signup" && loginOptions.signup;
  box.innerHTML = `<div class="auth-card">
    <div class="brand"><div class="logo">${icon("send")}</div><span>MarketingFlow AI</span></div>
    ${loginOptions.signup ? `<div class="tabs"><button class="tab ${signup ? "" : "on"}" data-mode="login">Log in</button><button class="tab ${signup ? "on" : ""}" data-mode="signup">Create account</button></div>` : `<h2 style="margin:0 0 4px">Welcome back</h2><p class="small muted" style="margin:0 0 14px">Log in to your shop dashboard.</p>`}
    <form id="authForm" class="stack">
      ${signup ? `<div><label>Your name</label><input name="name" required></div>` : ""}
      <div><label>Email</label><input name="email" type="email" required autocomplete="email"></div>
      <div><label>Password ${signup ? "(at least 8 characters)" : ""}</label>
        <div class="with-btn"><input name="password" type="password" required ${signup ? 'minlength="8" autocomplete="new-password"' : 'autocomplete="current-password"'}><button type="button" id="showPass">Show</button></div></div>
      ${signup ? `<div><label>Business name</label><input name="business" placeholder="e.g. Rahim Fashion"></div>` : ""}
      <p class="note small hidden" id="authError"></p>
      <button class="btn full">${signup ? "Create account" : "Log in"}</button>
      ${signup ? "" : `<p class="small center"><a href="#" id="forgot">Forgot password?</a></p><p class="small muted center hidden" id="forgotText">Contact MarketingFlow${loginOptions.support ? `: <b>${esc(loginOptions.support)}</b>` : ""}. We will send you a link to set a new password.</p>`}
      ${loginOptions.signup ? `<p class="small muted center">${signup ? "Already have an account?" : "New here?"} <a href="#" data-mode="${signup ? "login" : "signup"}">${signup ? "Log in" : "Create an account"}</a></p>` : ""}
    </form></div>`;
  $("#showPass").onclick = (e) => { const input = box.querySelector("[name=password]"); input.type = input.type === "password" ? "text" : "password"; e.target.textContent = input.type === "password" ? "Show" : "Hide"; };
  if ($("#forgot")) $("#forgot").onclick = (e) => { e.preventDefault(); $("#forgotText").classList.remove("hidden"); };
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

/* ---------- "set your password" link (invite or reset): /#set-password?token=... ---------- */
async function showSetPassword(token) {
  $("#app").classList.add("hidden");
  const box = $("#auth");
  box.classList.remove("hidden");
  let who;
  try { who = await get(`/api/auth/set-password?token=${encodeURIComponent(token)}`); }
  catch (e) {
    box.innerHTML = `<div class="auth-card"><div class="brand"><div class="logo">${icon("send")}</div><span>MarketingFlow AI</span></div>
      <p class="note">${esc(e.message)}</p><a class="btn full mt" href="/">Go to log in</a></div>`;
    return;
  }
  box.innerHTML = `<div class="auth-card">
    <div class="brand"><div class="logo">${icon("send")}</div><span>MarketingFlow AI</span></div>
    <h2 style="margin:0 0 4px">Hi ${esc(who.name)}, set your password</h2>
    <p class="small muted" style="margin:0 0 14px">You will log in with <b>${esc(who.email)}</b> and this password.</p>
    <form id="setForm" class="stack">
      <div><label>New password (at least 8 characters)</label><input name="password" type="password" minlength="8" required autocomplete="new-password"></div>
      <div><label>Type it again</label><input name="again" type="password" minlength="8" required autocomplete="new-password"></div>
      <p class="note small hidden" id="setError"></p>
      <button class="btn full">Save and open my dashboard</button>
    </form></div>`;
  $("#setForm").onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const showError = (text) => { $("#setError").textContent = text; $("#setError").classList.remove("hidden"); };
    if (f.password !== f.again) return showError("The two passwords are not the same");
    try {
      await post("/api/auth/set-password", { token, password: f.password });
      location.replace("/#overview");
      location.reload();
    } catch (err) { showError(err.message); }
  };
}

/* ---------- suspended / plan ended ---------- */
function showBlocked(me) {
  $("#app").classList.add("hidden");
  const box = $("#auth");
  box.classList.remove("hidden");
  const ended = me.blocked === "expired";
  box.innerHTML = `<div class="auth-card">
    <div class="brand"><div class="logo">${icon("send")}</div><span>MarketingFlow AI</span></div>
    <h2 style="margin:0 0 6px">${ended ? "Your plan has ended" : "Your account is paused"}</h2>
    <p class="muted">${ended ? `It ended on ${esc(new Date(me.expiresAt).toLocaleDateString("en-GB"))}.` : "Your account was suspended."} The AI is not answering your customers right now. Your data is safe.</p>
    <p>Contact MarketingFlow${me.support ? `: <b>${esc(me.support)}</b>` : ""} to continue.</p>
    <button class="btn light full mt" id="blockedLogout">Log out</button></div>`;
  $("#blockedLogout").onclick = async () => { await post("/api/auth/logout"); location.reload(); };
}

/* ---------- side menu ---------- */
// Phone bottom bar: the 4 pages used all day + "More" (opens the full menu as a sheet)
const TABS = [["overview", "Home"], ["inbox", "Inbox"], ["orders", "Orders"], ["inventory", "Products"]];

// counts are per page (inbox, comments…); a menu item shows the total of its pages
const sectionCount = (pages, counts) => pages.reduce((n, [id]) => n + (counts[id] || 0), 0);

function drawMenu(page, counts = {}) {
  const active = sectionOf(page)[0];
  const item = ([id, label, pages]) => {
    const n = sectionCount(pages, counts);
    return `<a class="nav ${id === active ? "active" : ""}" href="#${pages[0][0]}">${icon(MENU_ICON[id] || id)}<span>${label}</span>${n ? `<span class="count">${n}</span>` : ""}</a>`;
  };
  $("#nav").innerHTML = MENU.map(item).join("") + (SHOW_ADMIN ? `<div class="nav-group">SUPER ADMIN</div>${ADMIN_MENU.map(item).join("")}` : "");
  const inTabs = TABS.some(([id]) => id === active);
  if ($("#tabbar")) $("#tabbar").innerHTML = TABS.map(([id, label]) => {
    const n = sectionCount(sectionOf(id)[2], counts);
    return `<a href="#${id}" class="${id === active ? "on" : ""}"><i>${icon(id)}${n ? `<b>${n}</b>` : ""}</i><span>${label}</span></a>`;
  }).join("") +
    `<button type="button" id="tabMore" class="${inTabs ? "" : "on"}"><i><svg class="i" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg></i><span>More</span></button>`;
  if ($("#tabMore")) $("#tabMore").onclick = () => document.body.classList.toggle("menu-open");
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
    document.title = `${waiting ? `(${waiting}) ` : ""}MarketingFlow AI`;
    const n = await get("/api/notifications");
    $("#bell").innerHTML = $("#topBell").innerHTML = icon("bell") + (n.unread ? `<span class="badge">${n.unread}</span>` : "");
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
  if (page === "setup") return "accounts";
  return pageIds().includes(page) ? page : "overview";
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
  if ($("#topTitle")) $("#topTitle").textContent = labelOf(page);
  const root = document.createElement("div"); // a fresh element each time, so old click handlers disappear
  root.innerHTML = loading();
  const tabs = subTabs(page);
  $("#page").replaceChildren(...(tabs ? [tabs, root] : [root]));
  tabs?.querySelector(".on")?.scrollIntoView({ inline: "center", block: "nearest" }); // phone: the open tab is visible
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

// Tabs at the top of pages that share one menu item, e.g. Inbox: Chats | Comments
function subTabs(page) {
  const pages = sectionOf(page)[2];
  if (pages.length < 2) return null;
  const nav = document.createElement("nav");
  nav.className = "subtabs";
  nav.innerHTML = pages.map(([id, label]) => `<a href="#${id}" class="${id === page ? "on" : ""}">${esc(label)}${menuCounts[id] ? `<span class="count">${menuCounts[id]}</span>` : ""}</a>`).join("");
  return nav;
}

/* ---------- phone: slide-in menu ---------- */
const closeMenu = () => document.body.classList.remove("menu-open");
if ($("#shade")) $("#shade").onclick = closeMenu;
window.addEventListener("hashchange", showPage);

/* ---------- start ---------- */
(async () => {
  if (location.hash.startsWith("#set-password")) return showSetPassword(new URLSearchParams(location.hash.split("?")[1] || "").get("token") || "");
  let me;
  try { me = await get("/api/auth/me"); } catch { return showLogin(); }
  if (me.blocked) return showBlocked(me);
  if (me.user.isAdmin) SHOW_ADMIN = true;
  $("#auth").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#logo").innerHTML = icon("send");
  $("#meAvatar").textContent = me.user.name[0].toUpperCase();
  $("#meName").textContent = me.user.name;
  $("#meBusiness").textContent = me.business;
  $("#logout").innerHTML = icon("logout");
  $("#logout").onclick = async () => { await post("/api/auth/logout"); location.reload(); };
  // The phone top bar (#topBell, #topLogo) is in the new index.html. If an old index.html is still on the
  // server or in the browser cache, skip it instead of stopping the whole app.
  for (const id of ["#bell", "#topBell"]) {
    const el = $(id);
    if (!el) continue;
    el.innerHTML = icon("bell");
    el.onclick = () => showNotifications().catch((e) => toast(e.message, true));
  }
  if ($("#topLogo")) $("#topLogo").innerHTML = icon("send");
  await showPage();
  refreshCounts();
  setInterval(() => document.hidden || refreshCounts(), 60000); // not while the tab is in the background
})();

// Pages call this after changes that affect the red counters
export const updateCounts = refreshCounts;
