// AI Training: the AI reads your Facebook Page and website, then shows what it learned.
// You check it, fix it, and press Save. Only then does the AI use it with customers.
//   1. start  -> POST /api/learn/start          (works in the background, we ask for progress every 3 s)
//   2. review -> shop knowledge (text you can edit) + products found (tick the ones to add)
//   3. save   -> POST /api/learn/save-knowledge, and POST /api/products for every ticked product
import { get, post } from "../api.js";
import { esc, taka, onAction, toast, loading, $, $$ } from "../ui.js";

let data = null; // last answer of GET /api/learn

export async function render(root) {
  onAction(root, {
    start: async () => {
      await post("/api/learn/start", { website: $("#website").value });
      await draw(root);
    },
    saveKnowledge: async () => {
      await post("/api/learn/save-knowledge", { knowledge: $("#knowledge").value, deliveryTime: $("#deliveryTime").value, returnPolicy: $("#returnPolicy").value });
      toast("Saved. The AI now answers from this.");
      await draw(root);
    },
    tickAll: (el) => $$(".found input[type=checkbox]:not(:disabled)").forEach((box) => (box.checked = el.dataset.on === "1")),
    addProducts: () => addProducts(root),
  });
  await draw(root);
}

async function draw(root) {
  data = await get("/api/learn");
  const scan = data.scan;
  root.innerHTML = `
    <div class="page-head"><div><h1>AI Training</h1><p>The AI reads your Facebook Page and your website, and learns your products, prices, delivery and return rules. You check everything before it is used.</p></div></div>
    ${!data.aiReady ? `<div class="note">The AI is not set up on this server yet (AI_API_KEY is missing).</div>` : ""}
    <div class="card">
      <h3>1. What should the AI read?</h3>
      <div class="sources mt">
        <div class="box"><span class="pill p-blue">Facebook Page</span>
          ${data.pageName ? `<p class="mt"><b>${esc(data.pageName)}</b></p><p class="small muted">About, contact info and your latest posts.</p>` : `<p class="mt small muted">No Page connected.</p><a class="btn sm light" href="#accounts">Connect Facebook</a>`}</div>
        <div class="box"><span class="pill p-purple">Website</span>
          <input class="mt" id="website" placeholder="https://yourshop.com" value="${esc(data.website)}" ${scan?.status === "running" ? "disabled" : ""}>
          <p class="small muted">Optional. It reads your delivery, return and about pages and your product pages.</p></div>
      </div>
      ${scan?.status === "running"
        ? `<div class="loading" style="padding:24px 0 8px"><span class="spin"></span><span id="step">${esc(scan.step || "Working…")}</span></div><p class="small muted center">This takes one or two minutes. You can leave this page and come back.</p>`
        : `<button class="btn mt" data-action="start" ${data.aiReady ? "" : "disabled"}>${scan ? "Read again" : "Start reading"}</button>`}
      ${scan?.status === "failed" ? `<div class="note mt">It didn't work: ${esc(scan.error || "unknown problem")}</div>` : ""}
    </div>
    ${scan?.status === "ready" ? review(scan) : ""}
    ${!scan && data.currentKnowledge ? `<div class="card"><h3>What the AI knows now</h3><p class="small muted">You wrote this in Settings. "Start reading" does not change it until you press Save.</p><pre class="pre">${esc(data.currentKnowledge)}</pre></div>` : ""}`;

  if (scan?.status === "running") setTimeout(() => root.isConnected && draw(root), 3000); // ask again until it is done
}

function review(scan) {
  const fresh = scan.products.filter((p) => !p.exists);
  return `
    <div class="card">
      <h3>2. Check what the AI learned about your shop</h3>
      <p class="sub">Read it carefully and fix anything wrong. The AI will tell customers exactly this.</p>
      ${scan.error ? `<div class="note small">${esc(scan.error)}</div>` : ""}
      <p class="small muted">Read: ${scan.sources.map((s) => (s.url ? `<a target="_blank" rel="noopener" href="${esc(s.url)}">${esc(s.title)}</a>` : esc(s.title))).join(" · ") || "nothing"}</p>
      ${scan.knowledge ? "" : `<div class="note small mt">The AI found no clear facts. Write your delivery, payment and return rules here yourself.</div>`}
      <textarea id="knowledge" rows="16" class="mt" placeholder="## Delivery&#10;- Inside Dhaka 2-3 days…">${esc(scan.knowledge)}</textarea>
      <div class="f2 mt">
        <div><label>Delivery time (the AI tells customers this)</label><input id="deliveryTime" value="${esc(scan.deliveryTime)}" placeholder="e.g. 2-3 days inside Dhaka"></div>
        <div><label>Return policy (printed on invoices)</label><input id="returnPolicy" value="${esc(scan.returnPolicy)}"></div>
      </div>
      ${data.currentKnowledge ? `<p class="small muted mt">Saving replaces what the AI knows now (${data.currentKnowledge.length} characters).</p>` : ""}
      <button class="btn mt" data-action="saveKnowledge">Save shop knowledge</button>
    </div>
    <div class="card">
      <div class="row between"><div><h3>3. Products the AI found (${scan.products.length})</h3>
        <p class="sub">Tick the ones to add to your Inventory. Check the prices: the AI can misread a post.</p></div>
        ${fresh.length ? `<div class="row"><button class="btn sm light" data-action="tickAll" data-on="1">Tick all</button><button class="btn sm light" data-action="tickAll" data-on="0">Untick all</button></div>` : ""}</div>
      ${scan.products.length ? `<div class="found">${scan.products.map(productRow).join("")}</div>
        <div class="row mt" style="align-items:flex-end">
          <div><label>How many of each do you have? (you can change it later in Inventory)</label><input type="number" id="stock" min="0" value="10" style="width:140px"></div>
          <button class="btn" data-action="addProducts" ${fresh.length ? "" : "disabled"}>Add ticked products</button></div>`
        : `<div class="empty"><b>No products with a price were found</b>Add them yourself in Inventory.</div>`}
    </div>`;
}

const productRow = (p, i) => `
  <label class="found-row ${p.exists ? "have" : ""}">
    <input type="checkbox" data-i="${i}" ${p.exists ? "disabled" : "checked"}>
    ${p.imageUrl ? `<img src="${esc(p.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="noimg"></span>`}
    <span class="what"><b>${esc(p.name)}</b>${p.nameBn ? ` <span class="muted">${esc(p.nameBn)}</span>` : ""}
      <small>${esc(p.category)}${p.variants.length ? ` · ${esc(p.variants.join(", "))}` : ""} · from your ${p.from === "page" ? "Page post" : "website"}${p.sourceUrl ? ` · <a target="_blank" rel="noopener" href="${esc(p.sourceUrl)}">see it</a>` : ""}</small>
      ${p.description ? `<small>${esc(p.description.slice(0, 140))}</small>` : ""}</span>
    <span class="price">${p.exists ? `<span class="pill p-grey">Already in Inventory</span>` : `৳ <input type="number" min="0" data-price="${i}" value="${p.price}">`}</span>
  </label>`;

async function addProducts(root) {
  const stock = Math.max(0, Number($("#stock").value) || 0);
  const ticked = $$(".found input[type=checkbox]:checked:not(:disabled)").map((box) => Number(box.dataset.i));
  if (!ticked.length) return toast("Tick at least one product", true);
  let added = 0;
  const failed = [];
  for (const i of ticked) {
    const p = data.scan.products[i];
    const price = Number($(`[data-price="${i}"]`).value);
    try {
      await post("/api/products", {
        name: p.name, nameBn: p.nameBn, category: p.category, price, description: p.description, imageUrl: p.imageUrl,
        variants: (p.variants.length ? p.variants : ["Default"]).map((name) => ({ name, stock })),
      });
      added++;
    } catch (e) { failed.push(`${p.name}: ${e.message}`); }
  }
  toast(`${added} product(s) added to Inventory`);
  if (failed.length) toast(`Not added: ${failed.slice(0, 3).join("; ")}`, true);
  await draw(root);
}
