// Content Studio: AI writer on the left, your posts on the right.
import { get, post } from "../api.js";
import { esc, dateTime, onAction, options, pill } from "../ui.js";
import { openPostEditor } from "../postEditor.js";

const STATUS_COLOR = { Draft: "yellow", Scheduled: "blue", Publishing: "blue", Published: "green", "Partly published": "red", Failed: "red" };
let statusFilter = "";
let versions = [];

export async function render(root) {
  const products = await get("/api/products");
  root.innerHTML = `
    <div class="page-head"><div><h1>Content Studio</h1><p>Write posts with AI, then schedule or publish them to your Page and Instagram.</p></div>
      <button class="btn" data-action="newPost">+ New post</button></div>
    <div class="split">
      <div class="card"><h3>✨ AI writer</h3><p class="sub">Uses your shop info and product prices. Nothing is invented.</p>
        <form id="aiForm" class="stack">
          <div><label>Type</label><select name="kind">${options([["facebook_post", "Facebook post"], ["instagram_caption", "Instagram caption"], ["product_post", "Product post"], ["offer_post", "Offer post"]])}</select></div>
          <div><label>Product (optional)</label><select name="productId"><option value="">—</option>${products.map((p) => `<option value="${p._id}">${esc(p.name)}</option>`).join("")}</select></div>
          <div><label>Language</label><select name="language">${options([["bn", "বাংলা"], ["mixed", "Bangla + English"], ["en", "English"]])}</select></div>
          <div><label>What is the post about?</label><textarea name="topic" rows="3" placeholder="Eid collection arrived, cotton panjabi, free size chart in inbox"></textarea></div>
          <button class="btn full" data-action="write">Write 3 versions</button>
        </form>
        <div id="versions" class="stack mt"></div>
      </div>
      <div class="card"><div class="row between"><h3>Your posts</h3>
        <select id="statusFilter" style="width:auto">${options([["", "All"], ["Draft", "Drafts"], ["Scheduled", "Scheduled"], ["Published", "Published"], ["Failed", "Failed"]], statusFilter)}</select></div>
        <div id="posts" class="mt"></div></div>
    </div>`;

  onAction(root, {
    newPost: () => openPostEditor(null, { onDone: () => drawPosts(root) }),
    open: (el) => openPostEditor({ _id: el.dataset.id }, { onDone: () => drawPosts(root) }),
    write: async (el) => {
      el.disabled = true;
      el.textContent = "Writing…";
      try {
        versions = await post("/api/content/ai-write", Object.fromEntries(new FormData(root.querySelector("#aiForm"))));
        root.querySelector("#versions").innerHTML = versions.map((v, i) => `<div class="version">${esc(v.text)}\n<span class="muted">${esc(v.hashtags.join(" "))}</span><div class="row mt"><button class="btn sm" data-action="use" data-i="${i}">Use this</button></div></div>`).join("");
      } finally { el.disabled = false; el.textContent = "Write 3 versions"; }
    },
    use: (el) => openPostEditor(versions[el.dataset.i], { onDone: () => drawPosts(root) }),
  });
  root.querySelector("#statusFilter").addEventListener("change", (e) => { statusFilter = e.target.value; drawPosts(root); });
  await drawPosts(root);
}

async function drawPosts(root) {
  const items = await get(`/api/content${statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : ""}`);
  root.querySelector("#posts").innerHTML = items.map((p) => `
    <div class="box click" data-action="open" data-id="${p._id}" style="cursor:pointer;margin-bottom:8px">
      <div class="row between"><b>${esc(p.title || p.text.slice(0, 50) || "Untitled")}</b>${pill(p.status, STATUS_COLOR[p.status] || "grey")}</div>
      <div class="small muted">${p.targets.map((t) => esc(t.accountName)).join(", ") || "No Page chosen"} · ${p.scheduledAt ? (p.status === "Published" ? "published " : "for ") + dateTime(p.scheduledAt) : "not scheduled"}</div>
      ${p.lastError ? `<div class="small" style="color:var(--red)">${esc(p.lastError)}</div>` : ""}
    </div>`).join("") || `<div class="empty"><b>No posts yet</b>Write one with AI or press "New post".</div>`;
}

