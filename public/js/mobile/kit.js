// Building blocks for the phone screens (js/mobile/*): list rows, a segmented switch,
// the round "+" button and an action sheet. Plain HTML strings, like the rest of the app.
import { esc, icon, openModal, closeModal, onAction, taka, ORDER_STATUS } from "../ui.js";

// A soft colour from a name, so every customer/product letter looks a little different
const hue = (text) => [...String(text || "?")].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
export const letter = (name) => `<span class="m-lead" style="--h:${hue(name)}">${esc(String(name || "?").trim()[0] || "?").toUpperCase()}</span>`;
// The product's photo (or its first letter when it has none)
export const thumb = (url, name) => (url ? `<span class="m-lead pic"><img src="${esc(url)}" alt="" loading="lazy"></span>` : letter(name));
export const leadIcon = (name, tone = "accent") => `<span class="m-lead icon tone-${tone}">${icon(name)}</span>`;

// One tappable row: [lead] title / sub ........ side  ›
// open = { href } for a link, or { action, id } for a click handled with onAction
export function row({ href, action, id, lead = "", title, sub = "", side = "", chevron = true, extra = "", cls = "" }) {
  const inner = `${lead}<span class="m-main"><b>${title}</b>${sub ? `<small>${sub}</small>` : ""}</span>${side ? `<span class="m-side">${side}</span>` : ""}${extra}${chevron ? `<span class="m-chev">${icon("chevron")}</span>` : ""}`;
  return href ? `<a class="m-row ${cls}" href="${href}">${inner}</a>` : `<div class="m-row ${cls}" role="button" tabindex="0" data-action="${action}" ${id ? `data-id="${esc(id)}"` : ""}>${inner}</div>`;
}

// Segmented switch: seg([["call", "To call", 3], …], current, "seg")
export const seg = (list, current, action) => `<div class="m-seg">${list.map(([value, label, n]) =>
  `<button type="button" class="${value === current ? "on" : ""}" data-action="${action}" data-value="${value}">${esc(label)}${n ? `<span>${n}</span>` : ""}</button>`).join("")}</div>`;

// The round button at the bottom right
export const fab = (action, label) => `<button type="button" class="m-fab" data-action="${action}">${icon("plus")}<span>${esc(label)}</span></button>`;

export const searchBox = (value, placeholder) => `<label class="m-search">${icon("search")}<input data-filter="q" type="search" placeholder="${esc(placeholder)}" value="${esc(value)}"></label>`;

export const title = (text, linkHtml = "") => `<h2 class="m-h2"><span>${esc(text)}</span>${linkHtml}</h2>`;

// Order status as a small coloured word
export const status = (s) => `<small class="st st-${s}">${esc(ORDER_STATUS[s]?.[0] || s)}</small>`;

// One order in a list (Home and Orders)
export function orderRow(o, { action = "open", call = false } = {}) {
  const items = (o.items || []).map((i) => `${i.name}${i.variantName ? ` (${i.variantName})` : ""} ×${i.qty}`).join(", ");
  const tel = String(o.phone || "").replace(/[^0-9+]/g, "");
  const callBtn = call && o.status === "pending" && tel ? `<span class="m-call" role="button" data-action="call" data-tel="${esc(tel)}" aria-label="Call">${icon("phone")}</span>` : "";
  const twice = o.duplicateOf && ["pending", "confirmed"].includes(o.status) ? `<span class="warn-text">⚠️ Ordered twice?</span> · ` : "";
  return row({ action, id: o._id, lead: letter(o.customerName), title: esc(o.customerName), sub: twice + esc(items || o.orderNo), side: `<b>${taka(o.total)}</b>${status(o.status)}`, extra: callBtn, chevron: !callBtn });
}

// Bottom sheet with big choices: actionSheet("Cotton Panjabi", [["Edit", fn], ["Archive", fn, "danger"]])
export function actionSheet(heading, choices) {
  const body = openModal({
    title: heading, buttons: [],
    body: `<div class="m-sheet">${choices.map(([label, , tone], i) => `<button type="button" class="m-sheet-btn ${tone || ""}" data-action="pick" data-i="${i}">${label}</button>`).join("")}</div>`,
  });
  onAction(body, { pick: async (el) => { closeModal(); await choices[Number(el.dataset.i)][1](); } });
}
