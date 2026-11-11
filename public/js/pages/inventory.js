// Inventory: products, sizes/colours (variants) and stock.
import { get, post, put, del } from "../api.js";
import { esc, taka, num, table, onAction, openModal, toast, options, dateTime, pill } from "../ui.js";

let filters = { q: "", low: "", archived: "" };
let products = [];

export async function render(root, params) {
  if (params.low) filters.low = "1";
  onAction(root, {
    add: () => productForm(null, () => draw(root)),
    edit: (el) => productForm(find(el), () => draw(root)),
    adjust: (el) => adjustForm(find(el), () => draw(root)),
    history: (el) => showHistory(find(el)),
    archive: async (el) => { await post(`/api/products/${el.dataset.id}/archive`, { archived: filters.archived !== "1" }); toast(filters.archived === "1" ? "Product is back in the shop" : "Product archived"); draw(root); },
    remove: async (el) => { if (!confirm("Delete this product for good?")) return; await del(`/api/products/${el.dataset.id}`); toast("Deleted"); draw(root); },
  });
  root.addEventListener("change", (e) => {
    const key = e.target.dataset.filter;
    if (!key) return;
    filters[key] = e.target.type === "checkbox" ? (e.target.checked ? "1" : "") : e.target.value;
    draw(root);
  });
  await draw(root);
}

const find = (el) => products.find((p) => p._id === el.dataset.id);

async function draw(root) {
  products = await get(`/api/products?${new URLSearchParams(filters)}`);
  const units = products.reduce((s, p) => s + p.onHand, 0);
  root.innerHTML = `
    <div class="page-head"><div><h1>Inventory</h1><p>Stock is counted per size/colour. Units in open orders are "reserved" until the parcel ships.</p></div>
      <button class="btn" data-action="add">+ Add product</button></div>
    <div class="kpis">
      <div class="kpi"><div class="label">Products</div><div class="value">${num(products.length)}</div></div>
      <div class="kpi"><div class="label">Units in shop</div><div class="value">${num(units)}</div></div>
      <div class="kpi"><div class="label">Low on stock</div><div class="value">${num(products.filter((p) => p.lowStock).length)}</div></div>
    </div>
    <div class="card">
      <div class="filters">
        <input data-filter="q" placeholder="Search name, SKU, category…" value="${esc(filters.q)}" style="min-width:260px">
        <label class="check small"><input type="checkbox" data-filter="low" ${filters.low ? "checked" : ""}> Low stock only</label>
        <label class="check small"><input type="checkbox" data-filter="archived" ${filters.archived ? "checked" : ""}> Show archived</label>
      </div>
      ${table([
        ["Product", (p) => `<b>${esc(p.name)}</b>${p.nameBn ? `<div class="small">${esc(p.nameBn)}</div>` : ""}<div class="small muted">${esc(p.category)}${p.sku ? " · " + esc(p.sku) : ""}</div>`],
        ["Price", (p) => taka(p.price)],
        ["Sizes / colours (available / in shop)", (p) => p.variants.map((v) => pill(`${v.name}: ${v.available}/${v.onHand}`, v.available <= 0 ? "red" : v.available <= p.lowStockAt ? "yellow" : "grey")).join(" ")],
        ["Available", (p) => `<b>${p.available}</b>${p.reserved ? `<div class="small muted">${p.reserved} reserved</div>` : ""}`],
        ["", (p) => `<div class="row" style="flex-wrap:nowrap">
          <button class="btn sm light" data-action="adjust" data-id="${p._id}">Stock +/−</button>
          <button class="btn sm light" data-action="edit" data-id="${p._id}">Edit</button>
          <button class="btn sm light" data-action="history" data-id="${p._id}">History</button>
          <button class="btn sm light" data-action="archive" data-id="${p._id}">${filters.archived ? "Restore" : "Archive"}</button>
          ${filters.archived ? `<button class="btn sm danger" data-action="remove" data-id="${p._id}">Delete</button>` : ""}</div>`],
      ], products, { emptyText: filters.q || filters.low ? "No products match" : "No products yet. Add your first product." })}
    </div>`;
}

/* ---------- add / edit ---------- */
const variantRow = (v = {}) => `<div class="f3 variant-row" style="grid-template-columns:1.3fr 1fr 1fr 1fr 36px;margin-top:8px">
  <input type="hidden" name="vid[]" value="${esc(v._id || "")}">
  <input name="vname[]" placeholder="Size/colour, e.g. M or Red" value="${esc(v.name && v.name !== "Default" ? v.name : "")}">
  <input name="vsku[]" placeholder="SKU (optional)" value="${esc(v.sku || "")}">
  <input type="number" name="vprice[]" placeholder="Price (if different)" value="${v.price ?? ""}">
  ${v._id ? `<input disabled value="${v.onHand} in shop" title="Use Stock +/− to change">` : `<input type="number" name="vstock[]" placeholder="Stock" min="0">`}
  <button type="button" class="btn sm light" data-action="removeVariant">×</button></div>`;

function productForm(p, refresh) {
  const body = openModal({
    title: p ? `Edit ${p.name}` : "Add product", wide: true,
    body: `<div class="f3"><div><label>Name</label><input name="name" required value="${esc(p?.name || "")}"></div><div><label>Name in Bangla (optional)</label><input name="nameBn" value="${esc(p?.nameBn || "")}"></div><div><label>Category</label><input name="category" value="${esc(p?.category || "General")}"></div></div>
      <div class="f3 mt"><div><label>Price (৳)</label><input type="number" name="price" min="0" required value="${p?.price ?? ""}"></div><div><label>Cost price (৳, optional)</label><input type="number" name="costPrice" value="${p?.costPrice ?? ""}"></div><div><label>Warn when stock is at or below</label><input type="number" name="lowStockAt" value="${p?.lowStockAt ?? 5}"></div></div>
      <div class="mt"><label>Description (the AI uses this to answer questions)</label><textarea name="description" rows="2">${esc(p?.description || "")}</textarea></div>
      <h4 class="mt">Sizes / colours</h4><p class="small muted">No sizes? Keep one row with an empty name.</p>
      <div id="variants">${(p?.variants || [{}]).map(variantRow).join("")}</div>
      <button type="button" class="btn sm light mt" data-action="addVariant">+ Add size/colour</button>`,
    onSubmit: async (d) => {
      let stockIndex = 0; // only new rows have a stock box
      const variants = d.vid.map((id, i) => ({ id: id || undefined, name: d.vname[i], sku: d.vsku[i], price: d.vprice[i], stock: id ? undefined : (d.vstock || [])[stockIndex++] }));
      const product = { name: d.name, nameBn: d.nameBn, category: d.category, price: d.price, costPrice: d.costPrice, lowStockAt: d.lowStockAt, description: d.description, variants };
      if (p) await put(`/api/products/${p._id}`, product); else await post("/api/products", product);
      toast(p ? "Product saved" : "Product added");
      refresh();
    },
  });
  onAction(body, {
    addVariant: () => body.querySelector("#variants").insertAdjacentHTML("beforeend", variantRow()),
    removeVariant: (el) => { if (body.querySelectorAll(".variant-row").length > 1) el.closest(".variant-row").remove(); },
  });
}

/* ---------- stock change ---------- */
function adjustForm(p, refresh) {
  openModal({
    title: `Stock +/− · ${p.name}`,
    body: `<div class="f2"><div><label>Size/colour</label><select name="variantId">${options(p.variants.map((v) => [v._id, `${v.name} (in shop ${v.onHand}, available ${v.available})`]))}</select></div>
      <div><label>Change (10 = add, −2 = remove)</label><input type="number" name="change" required></div></div>
      <div class="f2 mt"><div><label>Reason</label><select name="reason">${options([["restock", "New stock arrived"], ["correction", "Counting correction"], ["damage", "Damaged / lost"], ["return", "Customer return"]])}</select></div>
      <div><label>Note (optional)</label><input name="note"></div></div>`,
    onSubmit: async (d) => { await post(`/api/products/${p._id}/adjust`, d); toast("Stock updated"); refresh(); },
  });
}

async function showHistory(p) {
  const rows = await get(`/api/products/${p._id}/history`);
  const reason = { order_reserve: "Order placed (reserved)", order_release: "Order cancelled", order_ship: "Shipped", return: "Returned", restock: "New stock", damage: "Damaged / lost", correction: "Correction", initial: "Starting stock" };
  const signed = (n) => (n ? (n > 0 ? "+" : "") + n : "");
  openModal({
    title: `Stock history · ${p.name}`, wide: true, buttons: [],
    body: table([
      ["When", (m) => dateTime(m.createdAt)], ["Size/colour", (m) => esc(m.label)], ["In shop", (m) => signed(m.onHandChange)],
      ["Reserved", (m) => signed(m.reservedChange)], ["Why", (m) => esc(reason[m.reason] || m.reason)], ["Order / note", (m) => esc([m.orderNo, m.note].filter(Boolean).join(" · "))],
    ], rows, { emptyText: "No changes yet" }),
  });
}
