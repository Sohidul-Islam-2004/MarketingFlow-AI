// Inventory: one simple form for every kind of shop. The shop writes things in its own words:
//   Details  = "label: value" lines (Warranty: 1 year, Fabric: cotton, RAM: 8GB…) that the AI reads
//   Options  = what the customer picks (M / L, 8/128GB Black, 500g…), each with its own stock
//   Offer    = "10% off" or "৳100 off" until a date: the AI quotes the sale price and orders use it

import { get, post, put, del } from "../api.js";
import { esc, taka, table, onAction, openModal, toast, options, dateTime, pill, confirmBox, liveSearch, empty, chips, moreMenu, icon } from "../ui.js";
import { pickPhoto, shrinkPhoto } from "../photo.js";
import { thumb } from "../mobile/kit.js";

// show: "" all · "low" low stock · "offer" on offer · "archived"
let filters = { q: "", show: "" };
let products = [];

export async function render(root, params) {
  if (params.low) filters.show = "low";
  onAction(root, {
    add: () => productForm(null, () => draw(root)),
    offerAll: () => offerForAll(() => draw(root)),
    edit: (el) => productForm(find(el), () => draw(root)),
    adjust: (el) => adjustForm(find(el), () => draw(root)),
    history: (el) => showHistory(find(el)),
    filter: (el) => { filters.show = el.dataset.value; return draw(root); },
    archive: async (el) => { const back = filters.show === "archived"; await post(`/api/products/${el.dataset.id}/archive`, { archived: !back }); toast(back ? "Product is back in the shop" : "Product archived"); draw(root); },
    remove: async (el) => { if (!(await confirmBox("Delete this product for good?", "Delete"))) return; await del(`/api/products/${el.dataset.id}`); toast("Deleted"); draw(root); },
  });
  liveSearch(root, filters, () => draw(root));
  await draw(root);
  if (params.add) productForm(null, () => draw(root));
}

const find = (el) => products.find((p) => p._id === el.dataset.id);

async function draw(root) {
  const archived = filters.show === "archived";
  const q = filters.q ? `q=${encodeURIComponent(filters.q)}` : "";
  const all = await get(`/api/products?${q}${archived ? "&archived=1" : ""}`);
  const show = { low: (p) => p.lowStock, offer: (p) => p.offerOn };
  products = show[filters.show] ? all.filter(show[filters.show]) : all;
  const count = (k) => (archived ? null : all.filter(show[k]).length || null);
  const nothingYet = !all.length && !filters.q && !archived;
  root.innerHTML = `
    <div class="page-head"><div><h1>Products</h1><p>Add what you sell, in your own words. The AI answers customers from here.</p></div>
      <div class="row"><button class="btn light" data-action="offerAll">🏷️ Offer for all</button><button class="btn" data-action="add">+ Add product</button></div></div>
    <div class="card">
      <div class="filters"><input data-filter="q" placeholder="Search products…" value="${esc(filters.q)}">
        ${chips([["", "All", archived ? null : all.length || null], ["low", "Low stock", count("low")], ["offer", "On offer", count("offer")], ["archived", "Archived"]], filters.show, "filter")}</div>
      ${nothingYet ? empty("No products yet", "Add what you sell. The AI can only talk about products that are here.", `<button class="btn" data-action="add">+ Add your first product</button>`) : table([
        ["Product", (p) => `<div class="prod-cell">${thumb(p.imageUrl, p.name)}<div><b>${esc(p.name)}</b>${detailsLine(p) ? `<div class="small muted">${esc(detailsLine(p))}</div>` : ""}</div></div>`],
        ["Price", (p) => (p.offerOn
          ? `<b>${taka(p.salePrice)}</b> <s class="small muted">${taka(p.price)}</s><div>${pill(offerText(p.offer), "pink")}</div>${p.offer.until ? `<div class="small muted">until ${untilText(p.offer.until)}</div>` : ""}`
          : taka(p.price) + (p.offerEnded ? `<div class="small muted">offer ended</div>` : ""))],
        ["Options", (p) => p.variants.map((v) => pill(optionText(p, v), p.alwaysAvailable ? "grey" : v.available <= 0 ? "red" : v.available <= p.lowStockAt ? "yellow" : "grey")).join(" ")],
        ["Stock", (p) => p.alwaysAvailable ? pill("Always available", "green") : `<b>${p.available}</b>${p.reserved ? `<div class="small muted">${p.reserved} in orders</div>` : ""}`],
        ["", (p) => `<div class="row" style="flex-wrap:nowrap;justify-content:flex-end">
          ${archived ? `<button class="btn sm light" data-action="archive" data-id="${p._id}">Restore</button><button class="btn sm danger" data-action="remove" data-id="${p._id}">Delete</button>`
            : `${p.alwaysAvailable ? "" : `<button class="btn sm light" data-action="adjust" data-id="${p._id}">Stock +/−</button>`}
          <button class="btn sm light" data-action="edit" data-id="${p._id}">Edit</button>
          ${moreMenu(`<button type="button" class="menu-item" data-action="history" data-id="${p._id}">Stock history</button><button type="button" class="menu-item" data-action="archive" data-id="${p._id}">Archive (hide from the AI)</button>`)}`}</div>`],
      ], products, { emptyText: archived ? "No archived products" : filters.q ? "No products match your search" : "Nothing here" })}
    </div>`;
}

// "Warranty: 1 year · RAM: 8GB" under the product name
const detailsLine = (p) => (p.info || []).filter((i) => i.value).slice(0, 3).map((i) => (i.label ? `${i.label}: ${i.value}` : i.value)).join(" · ");
const optionText = (p, v) => {
  const name = v.name === "Default" ? "" : v.name;
  if (p.alwaysAvailable) return name || "One option";
  return name ? `${name}: ${v.available}` : `${v.available} left`;
};

/* ---------- add / edit ---------- */
const EXAMPLES = [["Warranty", "1 year"], ["Fabric", "Cotton"], ["Brand", "Xiaomi"], ["Weight", "500g"]];
const infoRow = (i = {}, n = 0) => `<div class="pf-row info-row">
  <input name="ilabel[]" placeholder="${EXAMPLES[n % 4][0]}" list="infoLabels" value="${esc(i.label || "")}">
  <input name="ivalue[]" placeholder="${EXAMPLES[n % 4][1]}" value="${esc(i.value || "")}">
  <button type="button" class="btn sm light" data-action="removeRow" title="Remove">×</button></div>`;

const variantRow = (v = {}) => `<div class="pf-row variant-row">
  <input type="hidden" name="vid[]" value="${esc(v._id || "")}">
  <input name="vname[]" placeholder="52, Black, 8/128GB…" value="${esc(v.name && v.name !== "Default" ? v.name : "")}">
  <input type="number" name="vprice[]" placeholder="Own ৳" title="Leave empty to use the product price" value="${v.price ?? ""}">
  ${v._id ? `<input class="stock-box" disabled value="${v.onHand} pcs" title="Use Stock +/− to change">` : `<input class="stock-box" type="number" name="vstock[]" placeholder="Stock" min="0">`}
  <button type="button" class="btn sm light" data-action="removeRow" title="Remove">×</button></div>`;

/* ---------- offers ---------- */
const offerText = (o) => (o.kind === "amount" ? `৳${o.value} off` : `${o.value}% off`);
const untilText = (d) => new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Asia/Dhaka" });
const dayValue = (d) => (d ? new Date(new Date(d).getTime() + 6 * 3600e3).toISOString().slice(0, 10) : ""); // Bangladesh date for <input type=date>

// The 3 boxes used in the product form and in "Offer for all products"
const offerFields = (o) => `<div class="offer-row">
    <div><label>Offer</label><select name="offerKind">${options([["percent", "% off"], ["amount", "৳ off"]], o?.kind || "percent")}</select></div>
    <div><label>How much</label><input type="number" name="offerValue" min="0" placeholder="e.g. 10" value="${o?.value || ""}"></div>
    <div><label>Until <span class="small muted">(optional)</span></label><input type="date" name="offerUntil" value="${dayValue(o?.until)}"></div>
  </div>`;
const offerFrom = (d) => ({ kind: d.offerKind, value: Number(d.offerValue) || 0, until: d.offerUntil || null });

export function offerForAll(refresh) {
  openModal({
    title: "🏷️ Offer for all products",
    body: `<p class="muted">The same offer on every product. The AI tells customers the sale price, and orders are charged at that price. To give an offer on one product only, open it with Edit.</p>
      <div class="mt">${offerFields(null)}</div>
      <p class="small muted mt">Leave "Until" empty to keep the offer on until you stop it.</p>`,
    buttons: [["stop", "Stop all offers", "danger"], ["start", "Start offer"]],
    onSubmit: async (d, button) => {
      if (button === "stop") { await post("/api/products/offer", { value: 0 }); toast("All offers stopped"); return refresh(); }
      const offer = offerFrom(d);
      if (!(offer.value > 0)) throw new Error("Write how much off, e.g. 10");
      await post("/api/products/offer", offer);
      toast(`Offer on: ${offerText(offer)} on every product`);
      refresh();
    },
  });
}

// Label ideas for every kind of shop. They are only suggestions: the shop can type anything.
const LABEL_IDEAS = ["Brand", "Model", "Warranty", "Fabric", "Size chart", "Colour", "Material", "RAM / Storage", "Battery", "Weight", "Ingredients", "Expiry", "Origin", "Delivery time", "In the box"];

// The photo box at the top of the product form
const photoBox = (url) => (url ? `<img src="${esc(url)}" alt="">` : `<span>${icon("camera")}</span>`);

// A section that opens on tap; closed it shows a one-line summary
const section = (key, title, summary, inner, open) => `<details class="pf-sec" data-sec="${key}" ${open ? "open" : ""}>
  <summary><b>${title}</b><span class="pf-sum">${summary}</span></summary><div class="pf-sec-body">${inner}</div></details>`;

export function productForm(p, refresh) {
  let newPhoto = null; // "data:image/jpeg;base64,…" chosen in this form
  let dropPhoto = false;
  const first = p?.variants?.[0];
  const named = (p?.variants || []).filter((v) => v.name && v.name !== "Default");
  const info = (p?.info || []).filter((i) => i.label || i.value);
  const offer = p?.offerOn ? p.offer : null;
  const body = openModal({
    title: p ? `Edit ${p.name}` : "Add product", wide: true,
    body: `<div class="pf-top">
        <button type="button" class="photo-box" id="photoBox" data-action="choosePhoto" title="Add or change the photo">${photoBox(p?.imageUrl)}</button>
        <div class="pf-fields">
          <div><label>Product name</label><input name="name" required placeholder="e.g. IQRA Abaya, Redmi 13, Honey" value="${esc(p?.name || "")}"></div>
          <div class="pf-two">
            <div><label>Price (৳)</label><input type="number" name="price" min="0" required value="${p?.price ?? ""}"></div>
            <div class="simple-stock" ${named.length ? "hidden" : ""}><label>Stock</label>${p && first
              ? `<input disabled value="${first.onHand} pcs" title="Change it with Stock +/−">`
              : `<input type="number" name="simpleStock" min="0" placeholder="e.g. 10">`}</div>
          </div>
        </div></div>
      <div class="row pf-photo-links"><button type="button" class="link" data-action="choosePhoto">${p?.imageUrl ? "Change photo" : "+ Add photo"}</button>
        <button type="button" class="link danger" data-action="dropPhoto" ${p?.imageUrl ? "" : "hidden"}>Remove photo</button></div>
      <label class="switch-row pf-always"><span><b>Always available</b><small>Pre-order or made to order: stock is not counted</small></span>
        <input type="checkbox" class="switch" name="alwaysAvailable" ${p?.alwaysAvailable ? "checked" : ""}></label>

      ${section("options", "Sizes / colours", named.length ? esc(named.map((v) => v.name).join(", ")) : "None · tap to add",
        `<p class="small muted">Each size or colour with its own stock. "Own ৳" only if it costs more or less than the main price.</p>
         <div id="variants">${named.map(variantRow).join("")}</div>
         <button type="button" class="btn sm light mt" data-action="addVariant">+ Add size / colour</button>`)}
      ${section("offer", "🏷️ Offer", offer ? offerText(offer) + (offer.until ? ` · until ${untilText(offer.until)}` : "") : p?.offerEnded ? "Ended · tap to start a new one" : "No offer",
        `${offerFields(offer)}<p class="small muted mt">Leave "How much" empty for no offer.</p>`)}
      ${section("details", "📝 Details for the AI", info.length || p?.description ? esc([...info.map((i) => `${i.label}: ${i.value}`), p?.description || ""].filter(Boolean).join(" · ").slice(0, 70)) : "Fabric, size chart, warranty… · optional",
        `<div id="infoRows">${(info.length ? info : [{}]).map(infoRow).join("")}</div>
         <datalist id="infoLabels">${LABEL_IDEAS.map((l) => `<option value="${l}">`).join("")}</datalist>
         <button type="button" class="btn sm light mt" data-action="addInfo">+ Add detail</button>
         <div class="mt"><label>Anything else the AI should know</label><textarea name="description" rows="2" placeholder="e.g. Free size, fits 50-56. Ready in 3-5 days.">${esc(p?.description || "")}</textarea></div>`)}`,
    onSubmit: async (d) => {
      const list = (x) => [].concat(x ?? []);
      let stockIndex = 0; // only new rows have a stock box
      const ids = list(d.vid), names = list(d.vname), prices = list(d.vprice), stocks = list(d.vstock);
      let variants = ids.map((id, i) => ({ id: id || undefined, name: names[i], price: prices[i], stock: id ? undefined : stocks[stockIndex++] }))
        .filter((v) => String(v.name || "").trim());
      // no sizes / colours: one kind, with the stock from the top
      if (!variants.length) variants = [{ id: first?._id, name: "", price: "", stock: first ? undefined : d.simpleStock }];
      const labels = list(d.ilabel), values = list(d.ivalue);
      const info = labels.map((label, i) => ({ label, value: values[i] }));
      const product = { name: d.name, price: d.price, description: d.description, info, variants, alwaysAvailable: !!d.alwaysAvailable, offer: offerFrom(d) };
      const saved = p ? await put(`/api/products/${p._id}`, product) : await post("/api/products", product);
      const id = p?._id || saved._id;
      if (newPhoto) await post(`/api/products/${id}/photo`, { image: newPhoto });
      else if (dropPhoto && p?.imageUrl) await del(`/api/products/${id}/photo`);
      toast(p ? "Product saved" : "Product added");
      refresh();
    },
  });
  const always = body.querySelector("[name=alwaysAvailable]");
  const showStock = () => {
    const hasOptions = body.querySelectorAll(".variant-row").length > 0;
    body.querySelector(".simple-stock").hidden = hasOptions || always.checked;
    body.querySelectorAll(".stock-box").forEach((b) => (b.style.visibility = always.checked ? "hidden" : ""));
  };
  always.onchange = showStock;
  showStock();
  onAction(body, {
    choosePhoto: async () => {
      const file = await pickPhoto();
      if (!file) return;
      newPhoto = await shrinkPhoto(file);
      dropPhoto = false;
      body.querySelector("#photoBox").innerHTML = photoBox(newPhoto);
      body.querySelector(".pf-photo-links [data-action=choosePhoto]").textContent = "Change photo";
      body.querySelector("[data-action=dropPhoto]").hidden = false;
    },
    dropPhoto: (el) => {
      newPhoto = null; dropPhoto = true;
      body.querySelector("#photoBox").innerHTML = photoBox(null);
      body.querySelector(".pf-photo-links [data-action=choosePhoto]").textContent = "+ Add photo";
      el.hidden = true;
    },
    addInfo: () => body.querySelector("#infoRows").insertAdjacentHTML("beforeend", infoRow({}, body.querySelectorAll(".info-row").length)),
    addVariant: () => {
      // the first size of a product that had none keeps its stock (it becomes that size)
      const reuse = !body.querySelector(".variant-row") && first && !named.length ? { ...first, name: "" } : {};
      body.querySelector("#variants").insertAdjacentHTML("beforeend", variantRow(reuse));
      body.querySelector("#variants .variant-row:last-child input[name='vname[]']").focus();
      showStock();
    },
    removeRow: (el) => { el.closest(".pf-row").remove(); showStock(); },
  });
}

/* ---------- stock change ---------- */
export function adjustForm(p, refresh) {
  openModal({
    title: `Stock +/− · ${p.name}`,
    body: `<div class="f2"><div><label>Option</label><select name="variantId">${options(p.variants.map((v) => [v._id, `${v.name === "Default" ? p.name : v.name} (in stock ${v.onHand}, free to sell ${v.available})`]))}</select></div>
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
      ["When", (m) => dateTime(m.createdAt)], ["Option", (m) => esc(m.label)], ["In shop", (m) => signed(m.onHandChange)],
      ["Reserved", (m) => signed(m.reservedChange)], ["Why", (m) => esc(reason[m.reason] || m.reason)], ["Order / note", (m) => esc([m.orderNo, m.note].filter(Boolean).join(" · "))],
    ], rows, { emptyText: "No changes yet" }),
  });
}
