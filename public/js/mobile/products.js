// Phone · Products: search, All · Low stock · On offer, tap a product for Edit / Stock / Archive.
// The forms are the same as on a computer (pages/inventory.js).
import { get, post } from "../api.js";
import { esc, taka, onAction, liveSearch, chips, toast, icon } from "../ui.js";
import { productForm, adjustForm, offerForAll } from "../pages/inventory.js";
import { row, letter, fab, searchBox, actionSheet } from "./kit.js";

const filters = { q: "", show: "" };
let products = [];

export async function render(root, params) {
  if (params.low) filters.show = "low";
  const refresh = () => draw(root);
  onAction(root, {
    filter: (el) => { filters.show = el.dataset.value; draw(root); },
    add: () => productForm(null, refresh),
    offerAll: () => offerForAll(refresh),
    open: (el) => {
      const p = products.find((x) => x._id === el.dataset.id);
      actionSheet(p.name, [
        ["✏️ Edit product", () => productForm(p, refresh)],
        ...(p.alwaysAvailable ? [] : [["📦 Add or remove stock", () => adjustForm(p, refresh)]]),
        ["🗄️ Archive (hide from the AI)", async () => { await post(`/api/products/${p._id}/archive`, { archived: true }); toast("Product archived"); refresh(); }, "danger"],
      ]);
    },
  });
  liveSearch(root, filters, () => draw(root));
  await draw(root);
  if (params.add) productForm(null, refresh);
}

// "M 8 · L 2 · XL 0", "8 in stock" or "Always available"
function stockText(p) {
  if (p.alwaysAvailable) return "Always available";
  const named = p.variants.filter((v) => v.name !== "Default");
  return named.length ? named.map((v) => `${esc(v.name)} ${v.available}`).join(" · ") : `${p.available} in stock`;
}

async function draw(root) {
  const all = await get(`/api/products${filters.q ? `?q=${encodeURIComponent(filters.q)}` : ""}`);
  const show = { "": () => true, low: (p) => p.lowStock, offer: (p) => p.offerOn };
  products = all.filter(show[filters.show] || show[""]);
  root.innerHTML = `<div class="m-screen">
    ${searchBox(filters.q, "Search products")}
    <div class="m-toolbar">
      ${chips([["", "All", all.length || null], ["low", "Low stock", all.filter(show.low).length || null], ["offer", "On offer", all.filter(show.offer).length || null]], filters.show, "filter")}
      <button type="button" class="m-icon-btn" data-action="offerAll" title="Offer for all products">${icon("tag")}</button>
    </div>
    <div class="m-list">${products.map((p) => row({
      action: "open", id: p._id, lead: letter(p.name), title: esc(p.name), sub: stockText(p),
      side: p.offerOn ? `<b>${taka(p.salePrice)}</b><small><s>${taka(p.price)}</s></small>` : `<b>${taka(p.price)}</b>${p.lowStock ? `<small class="st st-low">Low</small>` : ""}`,
    })).join("") || `<p class="m-empty">${all.length ? "Nothing here." : "No products yet. Add what you sell: the AI only talks about products that are here."}</p>`}</div>
    ${fab("add", "Add product")}
  </div>`;
}
