// Pieces used by more than one page.
import { esc, taka } from "./ui.js";

// <option>s for "product · size" with price and stock. value = "productId|variantId"
export function variantOptions(products, selected = "") {
  return `<option value="">Choose product…</option>` + products.map((p) =>
    `<optgroup label="${esc(p.name)}">${p.variants.map((v) => {
      const value = `${p._id}|${v._id}`;
      const name = v.name === "Default" ? p.name : `${p.name} · ${v.name}`;
      return `<option value="${value}" ${value === selected ? "selected" : ""} ${v.available <= 0 && value !== selected ? "disabled" : ""}>${esc(name)} — ${taka(v.price ?? p.price)} (${v.available} left)</option>`;
    }).join("")}</optgroup>`
  ).join("");
}

// One product row in an order form
export const itemRow = (products, item = {}) => `<div class="f2 item-row" style="grid-template-columns:1fr 90px 36px;margin-top:8px">
  <select name="item[]">${variantOptions(products, item.productId ? `${item.productId}|${item.variantId || ""}` : "")}</select>
  <input type="number" name="qty[]" min="1" value="${item.qty || 1}">
  <button type="button" class="btn sm light" data-action="removeRow">×</button></div>`;

// form data -> [{ productId, variantId, qty }]
export const readItems = (data) => (data.item || []).map((v, i) => ({ productId: v.split("|")[0], variantId: v.split("|")[1], qty: Number(data.qty[i]) || 1 })).filter((i) => i.productId);

export const districtList = (districts) => `<datalist id="districts">${districts.map((d) => `<option value="${esc(d)}">`).join("")}</datalist>`;
