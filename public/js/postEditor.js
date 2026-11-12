// The post editor pop-up, used by Content Studio and the Calendar.
import { get, post, put, del, uploadFiles } from "./api.js";
import { esc, onAction, openModal, toast, toLocalInput, confirmBox } from "./ui.js";

const LOCKED = ["Publishing", "Published", "Partly published"];

// openPostEditor(existingPost | { text, hashtags } | null, { date, onDone })
export async function openPostEditor(item, { date = null, onDone = () => {} } = {}) {
  const [accounts, media] = await Promise.all([get("/api/accounts"), get("/api/media")]);
  const saved = item?._id ? await get(`/api/content/${item._id}`) : null;
  const p = saved || { text: item?.text || "", hashtags: item?.hashtags || [], mediaIds: [], targets: [], status: "Draft" };
  const locked = LOCKED.includes(p.status);
  let picked = [...(p.mediaIds || [])];
  const chosenAccounts = new Set((p.targets || []).map((t) => t.accountId));
  const when = p.scheduledAt || date;

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
        </div>
        <div class="stack">
          <div><label>Post to</label>${accounts.map((a) => `<label class="check"><input type="checkbox" name="account[]" value="${a._id}" ${chosenAccounts.has(a._id) ? "checked" : ""} ${locked ? "disabled" : ""}> ${esc(a.accountName)}</label>`).join("") || `<p class="note small">No Page connected. Go to Channels first.</p>`}</div>
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
      const data = { text: f.text, hashtags: f.hashtags, mediaIds: picked, accountIds: f.account || [] };
      const savedPost = saved ? await put(`/api/content/${p._id}`, data) : await post("/api/content", data);
      if (button === "schedule") {
        if (!f.when) { toast("Choose a date and time", true); return true; }
        await post(`/api/content/${savedPost._id}/schedule`, { scheduledAt: new Date(f.when).toISOString() });
        toast("Post scheduled");
      } else if (button === "now") {
        const r = await post(`/api/content/${savedPost._id}/publish`);
        toast(r.status === "Published" ? "Published! 🎉" : `Status: ${r.status}${r.lastError ? " · " + r.lastError : ""}`, r.status === "Failed");
      } else toast("Draft saved");
      onDone();
    },
  });

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
