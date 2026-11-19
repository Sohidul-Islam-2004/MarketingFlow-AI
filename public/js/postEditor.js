// The post editor pop-up, used by Posts and the Calendar.
// A post can carry an offer: when the post goes live, the offer goes on all products or the chosen ones,
// so the AI quotes the sale price and orders use it (see services/publisher.js → startPostOffer).
import { get, post, put, del, uploadFiles } from "./api.js";

// Photos are not kept by MarketingFlow: they are chosen from the device, uploaded only when you press
// Publish now / Schedule, sent to Facebook / Instagram and then deleted (services/tempMedia.js).
import { esc, onAction, openModal, toast, toLocalInput, confirmBox, options } from "./ui.js";

const LOCKED = ["Publishing", "Published", "Partly published"];

// openPostEditor(existingPost | { text, hashtags } | null, { date, onDone })
export async function openPostEditor(item, { date = null, onDone = () => {} } = {}) {
  const [accounts, products] = await Promise.all([get("/api/accounts"), get("/api/products")]);
  const saved = item?._id ? await get(`/api/content/${item._id}`) : null;
  const p = saved || { text: item?.text || "", hashtags: item?.hashtags || [], mediaIds: [], targets: [], status: "Draft" };
  const locked = LOCKED.includes(p.status);
  let files = []; // File objects chosen on this device, in order
  const onFacebook = (p.targets || []).some((t) => t.status === "on_facebook");
  const chosenAccounts = new Set((p.targets || []).map((t) => t.accountId));
  const when = p.scheduledAt || date;
  const o = p.offer || null;
  const chosenProducts = new Set(o?.productIds || []);

  const thumbs = () => files.map((f, i) => {
    const url = f._url || (f._url = URL.createObjectURL(f));
    return `<div class="thumb on"><span class="n">${i + 1}</span>${f.type.startsWith("video") ? `<video src="${url}" muted></video>` : `<img src="${url}" alt="">`}
      <button type="button" class="thumb-x" data-action="unpick" data-i="${i}" title="Remove">×</button></div>`;
  }).join("");

  const body = openModal({
    title: saved ? `Post · ${p.status}` : "New post", wide: true,
    buttons: locked ? [] : onFacebook ? [["unschedule", "Unschedule", "light"], ["delete", "Delete", "danger"]]
      : [["draft", "Save draft", "light"], ["schedule", "Schedule"], ["now", "Publish now", "dark"], ...(saved ? [["delete", "Delete", "danger"]] : [])],
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
          ${mediaBox(p, locked || onFacebook)}
        </div>
      </div>`,
    onSubmit: async (f, button) => {
      if (button === "delete") {
        if (!(await confirmBox("Delete this post?", "Delete"))) return true;
        await del(`/api/content/${p._id}`);
        toast("Post deleted");
        return onDone();
      }
      if (button === "unschedule") {
        if (!(await confirmBox("Unschedule? Facebook removes the scheduled post. Its photos are not kept, so add them again before scheduling.", "Unschedule"))) return true;
        await post(`/api/content/${p._id}/unschedule`);
        toast("Back to draft. Add the photos again.");
        return onDone();
      }
      if (button === "schedule" && !f.when) { toast("Choose a date and time", true); return true; }
      // Photos go up only now, and only for Publish now / Schedule (drafts keep the text only)
      let mediaIds = [];
      if (files.length && button !== "draft") mediaIds = (await uploadFiles(files)).map((m) => m._id);
      try {
        const data = { text: f.text, hashtags: f.hashtags, mediaIds, accountIds: f.account || [], offer: offerFromForm(f) };
        const savedPost = saved ? await put(`/api/content/${p._id}`, data) : await post("/api/content", data);
        if (button === "schedule") {
          await post(`/api/content/${savedPost._id}/schedule`, { scheduledAt: new Date(f.when).toISOString() });
          toast(mediaIds.length ? "Scheduled on Facebook ✅" : "Post scheduled");
        } else if (button === "now") {
          const r = await post(`/api/content/${savedPost._id}/publish`);
          const offerOn = r.offer?.appliedAt ? " · offer started 🏷️" : "";
          toast(r.status === "Published" ? `Published! 🎉${offerOn}` : `Status: ${r.status}${r.lastError ? " · " + r.lastError : ""}`, r.status === "Failed");
        } else toast(files.length ? "Draft saved (text only: photos are added when you publish)" : "Draft saved");
      } catch (e) {
        if (mediaIds.length) post("/api/media/discard", { ids: mediaIds }).catch(() => {}); // don't keep photos of a post that didn't go out
        throw e;
      }
      onDone();
    },
  });

  // "All products" / "Choose products": show the product list only when choosing
  const scope = body.querySelector("[name=offerScope]");
  const showList = () => { const list = body.querySelector("#offerProducts"); if (list && scope) list.hidden = scope.value !== "some"; };
  scope?.addEventListener("change", showList);
  showList();

  onAction(body, {
    unpick: (el) => { files.splice(Number(el.dataset.i), 1); body.querySelector("#thumbs").innerHTML = thumbs(); },
  });
  body.querySelector("#choose")?.addEventListener("change", (e) => {
    const chosen = [...e.target.files].filter((f) => /^(image|video)\//.test(f.type));
    if (chosen.some((f) => f.size > 200 * 1024 * 1024)) toast("A file is bigger than 200 MB", true);
    files = [...files, ...chosen.filter((f) => f.size <= 200 * 1024 * 1024)].slice(0, 10);
    e.target.value = "";
    body.querySelector("#thumbs").innerHTML = thumbs();
  });
}

// Photos: chosen from this device. Nothing is stored before Publish now / Schedule.
function mediaBox(p, readOnly) {
  if (readOnly) {
    const n = p.mediaCount || p.mediaIds?.length || 0;
    return n ? `<div><label>Photos / video</label><p class="small muted">${n} file(s) sent with this post.${(p.targets || []).some((t) => t.status === "on_facebook") ? " Facebook is keeping the post for its time." : ""}</p></div>` : "";
  }
  return `<div><div class="row between"><label style="margin:0">Photos / video</label>
      <label class="btn sm light" style="margin:0">+ Choose from device<input type="file" id="choose" accept="image/*,video/*" multiple hidden></label></div>
    <div class="thumbs mt" id="thumbs"></div>
    <p class="small muted mt">One video, or up to 10 photos. They are sent when you publish and are not kept on MarketingFlow.
      Instagram with photos: use Publish now. Facebook: Schedule works too (10 minutes to 30 days ahead).</p></div>`;
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
