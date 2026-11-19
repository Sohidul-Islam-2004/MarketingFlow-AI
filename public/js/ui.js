// Small UI helpers shared by every page.

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

// Always use esc() when putting user text into HTML
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const num = (n) => Number(n || 0).toLocaleString("en-IN");
export const taka = (n) => "৳" + num(n);
export const dateTime = (d) => (d ? new Date(d).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
// Short time for lists: "21:55" today, "Yesterday", "17 Nov"
export function shortTime(d) {
  if (!d) return "";
  const x = new Date(d), now = new Date();
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  if (sameDay(x, now)) return x.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (sameDay(x, new Date(now.getTime() - 86400e3))) return "Yesterday";
  return x.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
// "Good morning" / "Good afternoon" / "Good evening" (Bangladesh time of day on the person's device)
export const greeting = () => { const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"; };
export const dateOnly = (d) => (d ? new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "");
export const ymd = (d) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
// <input type="datetime-local"> value <-> Date
export const toLocalInput = (d) => (d ? `${ymd(d)}T${String(new Date(d).getHours()).padStart(2, "0")}:${String(new Date(d).getMinutes()).padStart(2, "0")}` : "");

export const pill = (text, color = "grey") => `<span class="pill p-${color}">${esc(text)}</span>`;
// empty("No orders yet", "They appear here…", `<button …>`)  (the 3rd part is ready-made HTML, e.g. a button)
export const empty = (title, hint = "", actionHtml = "") => `<div class="empty"><b>${esc(title)}</b>${esc(hint)}${actionHtml ? `<div class="mt">${actionHtml}</div>` : ""}</div>`;

export const ORDER_STATUS = { pending: ["To call", "yellow"], confirmed: ["Confirmed", "blue"], packed: ["Packed", "purple"], shipped: ["Shipped", "purple"], delivered: ["Delivered", "green"], returned: ["Returned", "grey"], cancelled: ["Cancelled", "grey"] };
export const orderPill = (status) => pill(...(ORDER_STATUS[status] || [status, "grey"]));

// <select> options from ["a","b"] or [["value","Label"], ...]
export const options = (list, selected) =>
  list.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}" ${String(v) === String(selected ?? "") ? "selected" : ""}>${esc(l)}</option>`; }).join("");

// table([["Header", row => html], ...], rows, { rowAttrs: row => 'data-action="open" data-id=".."' })
export function table(columns, rows, { emptyText = "Nothing here yet", rowAttrs } = {}) {
  if (!rows.length) return empty(emptyText);
  const head = columns.map(([h]) => `<th>${h}</th>`).join("");
  const body = rows.map((r) => `<tr ${rowAttrs ? rowAttrs(r) : ""}>${columns.map(([h, cell]) => `<td data-label="${esc(h)}">${cell(r)}</td>`).join("")}</tr>`).join(""); // data-label: shown on phones
  return `<div class="table"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

export function toast(message, isError = false) {
  const t = document.createElement("div");
  t.className = "toast" + (isError ? " err" : "");
  t.textContent = message;
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), isError ? 7000 : Math.max(3500, String(message).length * 70)); // long messages stay longer
}

// Filter chips: chips([["", "All", 12], ["low", "Low stock", 2]], current, "filter") -> one row of round buttons
export const chips = (list, current, action) => `<div class="chips">${list.map(([value, label, n]) =>
  `<button type="button" class="chip ${String(value) === String(current) ? "on" : ""}" data-action="${action}" data-value="${esc(value)}">${esc(label)}${n != null ? `<span>${n}</span>` : ""}</button>`).join("")}</div>`;

// "⋯" button with a small menu for rarely used actions. items = HTML of buttons/links (class "menu-item").
export const moreMenu = (items, label = "More actions") =>
  `<details class="more-menu"><summary aria-label="${esc(label)}" title="${esc(label)}">⋯</summary><div class="menu">${items}</div></details>`;
// A click anywhere closes open "⋯" menus (a click inside a menu item runs its action first)
document.addEventListener("click", (e) => {
  document.querySelectorAll("details.more-menu[open]").forEach((d) => { if (!d.contains(e.target) || e.target.closest(".menu-item")) d.removeAttribute("open"); });
});
// The menu opens under its button, or above it when there is no room below (also inside tables that scroll)
document.addEventListener("toggle", (e) => {
  const d = e.target;
  if (!d.matches?.("details.more-menu") || !d.open) return;
  const menu = d.querySelector(".menu"), r = d.querySelector("summary").getBoundingClientRect();
  Object.assign(menu.style, { position: "fixed", left: "auto", right: `${Math.max(8, innerWidth - r.right)}px` });
  const roomBelow = r.bottom + 6 + menu.offsetHeight <= innerHeight;
  menu.style.top = `${roomBelow ? r.bottom + 6 : Math.max(8, r.top - 6 - menu.offsetHeight)}px`;
}, true);
window.addEventListener("scroll", () => document.querySelectorAll("details.more-menu[open]").forEach((d) => d.removeAttribute("open")), { passive: true, capture: true });

// Clicks on elements with data-action="name" call handlers.name(element, event).
// Errors thrown by a handler are shown as a red toast (unless you already left the page).
export function onAction(root, handlers) {
  root.addEventListener("click", async (event) => {
    const el = event.target.closest("[data-action]");
    if (!el || !root.contains(el) || !handlers[el.dataset.action]) return;
    event.preventDefault();
    if (el.classList.contains("busy")) return; // still working on the last click
    const isButton = el.tagName === "BUTTON";
    if (isButton) el.classList.add("busy");
    try { await handlers[el.dataset.action](el, event); } catch (e) { if (root.isConnected) toast(e.message, true); } finally { el.classList.remove("busy"); }
  });
}

// "Are you sure?" pop-up. Use: if (!(await confirmBox("Delete this product?", "Delete"))) return;
export function confirmBox(text, yesLabel = "Yes", danger = true) {
  return new Promise((done) => {
    const box = $("#confirm");
    $("#confirmText").textContent = text;
    $("#confirmYes").textContent = yesLabel;
    $("#confirmYes").className = "btn" + (danger ? " danger solid" : "");
    const finish = (answer) => { box.close(); box.oncancel = null; done(answer); };
    $("#confirmYes").onclick = () => finish(true);
    $("#confirmNo").onclick = () => finish(false);
    box.oncancel = () => done(false); // Esc key
    box.showModal();
  });
}

// Shown while a page or list is loading
export const loading = (text = "Loading…") => `<div class="loading"><span class="spin"></span>${esc(text)}</div>`;

// Search-as-you-type for pages that redraw themselves: boxes with data-filter="q" update filters.q,
// the page is redrawn a moment after the last key, and the cursor stays in the box.
export function liveSearch(root, filters, draw) {
  const redraw = debounce(async () => {
    await draw();
    const box = root.querySelector('[data-filter="q"]');
    if (box && document.activeElement !== box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
  });
  root.addEventListener("input", (e) => {
    if (e.target.dataset.filter !== "q") return;
    filters.q = e.target.value;
    if ("page" in filters) filters.page = 1;
    redraw();
  });
}

// Runs fn only after the person stops typing for a moment (for search boxes)
export function debounce(fn, ms = 350) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

// Reads form fields into an object: checkboxes -> true/false, number inputs -> numbers, name="x[]" -> arrays
// (for checkboxes named "x[]": an array of the ticked values)
export function readForm(form) {
  const data = {};
  for (const el of form.querySelectorAll("[name]")) {
    let key = el.name;
    const isList = key.endsWith("[]");
    if (isList) key = key.slice(0, -2);
    if (el.type === "checkbox" && isList) { if (el.checked) (data[key] = data[key] || []).push(el.value); continue; } // list of ticked values
    let value = el.type === "checkbox" ? el.checked : el.type === "number" ? (el.value === "" ? "" : Number(el.value)) : el.value;
    if (el.type === "radio" && !el.checked) continue;
    if (isList) (data[key] = data[key] || []).push(value);
    else data[key] = value;
  }
  return data;
}

/* ----- the shared pop-up ----- */
let submitHandler = null;
// openModal({ title, body (html), buttons: [["save","Save"], ["delete","Delete","danger"]], wide, onSubmit(data, buttonValue) })
// onSubmit may return true to keep the pop-up open. Return value of openModal: the body element (to add listeners).
export function openModal({ title, body, buttons = [["save", "Save"]], wide = false, onSubmit }) {
  $("#modalTitle").textContent = title;
  const bodyEl = document.createElement("div");
  bodyEl.innerHTML = body;
  $("#modalBody").replaceChildren(bodyEl);
  $("#modalFoot").innerHTML = `<button type="button" class="btn light" id="modalCancel">Close</button>` +
    buttons.map(([value, label, style]) => `<button class="btn ${style || ""}" value="${value}">${esc(label)}</button>`).join("");
  $("#modal").classList.toggle("wide", wide);
  $("#modalCancel").onclick = closeModal;
  submitHandler = onSubmit;
  if (!$("#modal").open) {
    $("#modal").showModal();
    // Phone: the Back button closes the pop-up (like an app) instead of leaving the page
    if (matchMedia("(max-width: 800px)").matches && !history.state?.sheet) history.pushState({ sheet: true }, "");
  }
  // On a computer: put the cursor in the first box. On a phone that would pop the keyboard open, so skip it.
  if (matchMedia("(pointer: fine)").matches) bodyEl.querySelector("input:not([type=hidden]):not([type=checkbox]):not([type=file]):not([type=date])")?.focus();
  return bodyEl;
}
export function closeModal() {
  if ($("#modal").open) $("#modal").close();
  submitHandler = null;
}
document.addEventListener("DOMContentLoaded", () => {
  $("#modalClose").onclick = closeModal;
  $("#modal").addEventListener("close", () => { if (history.state?.sheet) history.back(); }); // remove the "Back closes it" step
  window.addEventListener("popstate", () => { if ($("#modal").open) closeModal(); });
  $("#modalForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!submitHandler) return closeModal();
    const buttons = $$("#modalFoot button");
    buttons.forEach((b) => (b.disabled = true));
    event.submitter?.classList.add("busy");
    try {
      const keepOpen = await submitHandler(readForm($("#modalForm")), event.submitter?.value);
      if (keepOpen !== true) closeModal();
    } catch (e) {
      toast(e.message, true);
    } finally {
      buttons.forEach((b) => { b.disabled = false; b.classList.remove("busy"); });
    }
  });
});

/* ----- icons (simple line icons) ----- */
const ICONS = {
  overview: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z"/>',
  comments: '<path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12z"/>',
  orders: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  inventory: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  fraud: '<path d="M12 3 4 6v6c0 5 3.4 8 8 9 4.6-1 8-4 8-9V6z"/>',
  content: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  accounts: '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10 21a2 2 0 0 0 4 0"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  "admin-customers": '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6"/>',
  "admin-pages": '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 4v16"/>',
  train: '<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  chats: '<path d="M21 11.5a8.4 8.4 0 0 1-12.2 7.5L3 21l2-5.6A8.4 8.4 0 1 1 21 11.5z"/><path d="M8 11h.01M12 11h.01M16 11h.01"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  tag: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  sparkle: '<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  look: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18c1.7 0 2-1.3 1.3-2.3-.8-1-.1-2.7 1.4-2.7H17a4 4 0 0 0 4-4 9 9 0 0 0-9-9z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7.5" r="1"/>',
  alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
};
export const icon = (name) => `<svg class="i i-${name}" viewBox="0 0 24 24">${ICONS[name] || ""}</svg>`;
