// Phone · Orders: three simple groups (To call · Active · Done), search, tap an order to act on it.
// The order sheet and the new-order form are the same as on a computer (pages/orders.js).
import { get } from "../api.js";
import { onAction, liveSearch } from "../ui.js";
import { openOrder, orderForm } from "../pages/orders.js";
import { updateCounts } from "../app.js";
import { seg, fab, searchBox, orderRow } from "./kit.js";

const GROUPS = { call: "pending", active: "confirmed,packed,shipped", done: "delivered,returned,cancelled" };
const filters = { group: "", q: "", page: 1 };
let rows = [];

export async function render(root, params) {
  // links like #orders?status=pending (from Home) open the right group
  const group = Object.keys(GROUPS).find((g) => params.status && GROUPS[g].split(",").includes(params.status.split(",")[0]));
  if (group) { filters.group = group; filters.page = 1; }
  onAction(root, {
    seg: (el) => { filters.group = el.dataset.value; filters.page = 1; draw(root); },
    open: (el) => openOrder(el.dataset.id, () => draw(root)),
    call: (el) => { location.href = `tel:${el.dataset.tel}`; },
    more: () => { filters.page += 1; return draw(root, true); },
    newOrder: () => orderForm(() => draw(root)),
  });
  liveSearch(root, filters, () => draw(root));
  await draw(root);
  if (params.open) openOrder(params.open, () => { draw(root); updateCounts(); });
}

const load = () => get(`/api/orders?${new URLSearchParams({ status: GROUPS[filters.group], page: filters.page, ...(filters.q ? { q: filters.q } : {}) })}`);

async function draw(root, append = false) {
  let data;
  if (!filters.group) { // first visit: start where the work is
    filters.group = "call";
    data = await load();
    if (!data.counts.pending) { filters.group = "active"; data = await load(); }
  } else data = await load();
  const sum = (list) => list.split(",").reduce((n, s) => n + (data.counts[s] || 0), 0); // counts of every status (not only this group)
  rows = append ? [...rows, ...data.rows] : data.rows;
  const none = !Object.values(data.counts).some(Boolean);
  const empty = none ? "No orders yet. When the AI takes an order, it waits here under To call." : { call: "No orders to call. New AI orders show up here.", active: "No orders in progress.", done: "No finished orders yet." }[filters.group];

  root.innerHTML = `<div class="m-screen">
    ${searchBox(filters.q, "Search name, phone or order no")}
    ${seg([["call", "To call", sum(GROUPS.call)], ["active", "Active", sum(GROUPS.active)], ["done", "Done"]], filters.group, "seg")}
    <div class="m-list">${rows.map((o) => orderRow(o, { call: true })).join("") || `<p class="m-empty">${filters.q ? "No orders match your search." : empty}</p>`}</div>
    ${data.page < data.pages ? `<button type="button" class="btn light full mt" data-action="more">Show more</button>` : ""}
    ${fab("newOrder", "New order")}
  </div>`;
}
