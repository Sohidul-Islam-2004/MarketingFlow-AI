// The post editor pop-up, used by Posts and the Calendar.
// A post can carry an offer: when the post goes live, the offer goes on all products or the chosen ones,
// so the AI quotes the sale price and orders use it (see services/publisher.js → startPostOffer).
import { get, post, put, del, uploadFiles } from "./api.js";
import { esc, onAction, openModal, toast, toLocalInput, confirmBox, options } from "./ui.js";

const LOCKED = ["Publishing", "Published", "Partly published"];

// openPostEditor(existingPost | { text, hashtags } | null, { date, onDone })
export async function openPostEditor(item, { date = null, onDone = () => {} } = {}) {
  const [accounts, media, products] = await Promise.all([get("/api/accounts"), get("/api/media"), get("/api/products")]);
  const saved = item?._id ? await get(`/api/content/${item._id}`) : null;
  const p = saved || { text: item?.text || "", hashtags: item?.hashtags || [], mediaIds: [], targets: [], status: "Draft" };
  const locked = LOCKED.includes(p.status);
  let picked = [...(p.mediaIds || [])];
  const chosenAccounts = new Set((p.targets || []).map((t) => t.accountId));
  const when = p.scheduledAt || date;
  const o = p.offer || null;
  const chosenProducts = new Set(o?.productIds || []);

  const thumbs = () => media.map((m) => {
    const n = picked.indexOf(m._id);
    return `<div class="thumb ${n >= 0 ? "on" : ""}" data-action="pick" data-id="${m._id}">${n >= 0 ? `<span class="n">${n + 1}</span>` : ""}${m.kind === "video" ? `<video src="${esc(m.url)}" muted></video>` : `<img src="${esc(m.url)}" alt="">`}</div>`;
  }).join("") || `<p class="small muted">No photos yet. Upload one.</p>`;

  const body = openModal({
    title: saved ? `Post · ${p.status}` : "New post", wide: true,
    buttons: locked ? [] : [["draft", "Save draft", "light"], ["schedule", "Schedule"], ["now", "Publish now", "dark"], ...(saved ? [["delete", "Delete", "danger"]] : [])],
    body: `
      ${p.lastError ? `<div class="note">${esc(p.lastError)}</div>` : ""}
      ${(p.targets || []).some((t) => t.permalink) ? `<div class="good">${p.targets.filter((t) => t.permalink).map((t) => `<a target="_blank" href="${esc(t.permalink)}">View on ${esc(t.accountName)}</a>`).join(" · ")}</div>` : ""}
      <div class="grid2 mt">
        <div class="stack">
          <div><label>Caption</label><textarea name="text" rows="8" ${locked ? "disabled" : ""}>${esc(p.text)}</textarea></div>
          <div><label>Hashtags</label><input name="hashtags" value="${esc((p.hashtags || []).join(" "))}" placeholder="#eid #panjabi" ${locked ? "disabled" : ""}></div>
          ${offerBox(o, products, chosenProducts, locked)}
        </div>
        <div class="stack">
          <div><label>Post to</label>${accounts.map((a) => `<label class="check"><input type="checkbox" name="account[]" value="${a._id}" ${chosenAccounts.has(a._id) ? "checked" : ""} ${locked ? "disabled" : ""}> ${esc(a.accountName)} <span class="small muted">${a.platform === "Instagram" ? "Instagram" : "Facebook"}</span></label>`).join("") || `<p class="note small">No Page connected. Go to Facebook & Instagram first.</p>`}</div>
          <div><label>Date & time (for Schedule)</label><input type="datetime-local" name="when" value="${toLocalInput(when)}"></div>
          <div><div class="row between"><label>Photos / video (click to choose, in order)</label><label class="btn sm light" style="margin:0">Upload<input type="file" id="upload" accept="image/*,video/*" multiple hidden></label></div>
            <div class="thumbs" id="thumbs">${thumbs()}</div>
            <p class="small muted mt">One video, or several photos.</p></div>
        </div>
      </div>`,
    onSubmit: async (f, button) => {
      if (button === "delete") {
        if (!(await confirmBox("Delete this post?", "Delete"))) return true;
        await del(`/api/content/${p._id}`);
        toast("Post deleted");
        return onDone();
      }
      const data = { text: f.text, hashtags: f.hashtags, mediaIds: picked, accountIds: f.account || [], offer: offerFromForm(f) };
      const savedPost = saved ? await put(`/api/content/${p._id}`, data) : await post("/api/content", data);
      if (button === "schedule") {
        if (!f.when) { toast("Choose a date and time", true); return true; }
        await post(`/api/content/${savedPost._id}/schedule`, { scheduledAt: new Date(f.when).toISOString() });
        toast("Post scheduled");
      } else if (button === "now") {
        const r = await post(`/api/content/${savedPost._id}/publish`);
        const offerOn = r.offer?.appliedAt ? " · offer started 🏷️" : "";
        toast(r.status === "Published" ? `Published! 🎉${offerOn}` : `Status: ${r.status}${r.lastError ? " · " + r.lastError : ""}`, r.status === "Failed");
      } else toast("Draft saved");
      onDone();
    },
  });

  // "All products" / "Choose products": show the product list only when choosing
  const scope = body.querySelector("[name=offerScope]");
  const showList = () => { const list = body.querySelector("#offerProducts"); if (list && scope) list.hidden = scope.value !== "some"; };
  scope?.addEventListener("change", showList);
  showList();

  onAction(body, {
    pick: (el) => {
      if (locked) return;
      const id = el.dataset.id;
      picked = picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id];
      body.querySelector("#thumbs").innerHTML = thumbs();
    },
  });
  body.querySelector("#upload").addEventListener("change", async (e) => {
    try {
      const added = await uploadFiles(e.target.files);
      media.unshift(...added);
      picked.push(...added.map((m) => m._id));
      body.querySelector("#thumbs").innerHTML = thumbs();
    } catch (err) { toast(err.message, true); }
  });
}

/* ---------- offer with this post ---------- */
const offerLabel = (o) => (o.kind === "amount" ? `৳${o.value} off` : `${o.value}% off`);
const bdDate = (d) => (d ? new Date(new Date(d).getTime() + 6 * 3600e3).toISOString().slice(0, 10) : "");

function offerBox(o, products, chosen, locked) {
  const live = products.filter((x) => !x.archived);
  if (locked) {
    if (!o?.value) return "";
    return `<div class="box"><h4>🏷️ Offer with this post</h4><p>${offerLabel(o)} on ${o.all ? "all products" : `${o.productIds.length} product(s)`}${o.until ? ` until ${bdDate(o.until)}` : ""}</p>
      <p class="small muted">${o.appliedAt ? "Started when the post went live." : "Starts when the post goes live."}</p></div>`;
  }
  return `<details class="box offer-box" ${o?.value ? "open" : ""}>
    <summary>🏷️ Offer with this post <span class="small muted">(optional)</span></summary>
    <p class="small muted mt">When the post goes live, this discount goes on the products. The AI quotes the sale price and orders are charged at it.</p>
    <div class="offer-row mt">
      <div><label>Discount</label><select name="offerKind">${options([["percent", "% off"], ["amount", "৳ off"]], o?.kind || "percent")}</select></div>
      <div><label>How much</label><input type="number" name="offerValue" min="0" placeholder="e.g. 10" value="${o?.value || ""}"></div>
      <div><label>Until <span class="small muted">(optional)</span></label><input type="date" name="offerUntil" value="${bdDate(o?.until)}"></div>
    </div>
    <div class="mt"><label>On</label><select name="offerScope">${options([["all", "All products"], ["some", "Choose products"]], o && !o.all ? "some" : "all")}</select></div>
    <div id="offerProducts" class="offer-products mt">
      ${live.map((x) => `<label class="check"><input type="checkbox" name="offerProduct[]" value="${x._id}" ${chosen.has(x._id) ? "checked" : ""}> ${esc(x.name)}</label>`).join("") || `<p class="small muted">No products yet.</p>`}
    </div>
  </details>`;
}

function offerFromForm(f) {
  const value = Number(f.offerValue) || 0;
  if (!value) return null;
  const all = f.offerScope !== "some";
  return { kind: f.offerKind, value, until: f.offerUntil || null, all, productIds: all ? [] : [].concat(f.offerProduct || []) };
}
