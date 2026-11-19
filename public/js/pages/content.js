// Posts: say what you want to post, the AI writes 3 versions, you pick one and publish or schedule it.
// The AI decides the kind of post itself (offer / product / normal) and finds the products you name.
import { get, post } from "../api.js";
import { esc, shortTime, onAction, chips, $ } from "../ui.js";
import { openPostEditor } from "../postEditor.js";
import { row, leadIcon } from "../mobile/kit.js";

const STATUS_COLOR = { Draft: "yellow", Scheduled: "blue", Publishing: "blue", Published: "green", "Partly published": "red", Failed: "red" };
const STATUS_TONE = { yellow: "amber", blue: "blue", green: "green", red: "red" };
let statusFilter = "";
let language = "bn";
let versions = [];

export async function render(root) {
  root.innerHTML = `
    <div class="page-head"><div><h1>Posts</h1><p>Tell the AI what to post. It writes it with your real prices; you publish now or schedule it.</p></div></div>
    <div class="card writer">
      <label for="topic" class="writer-label">What do you want to post?</label>
      <textarea id="topic" rows="3" placeholder="e.g. Eid collection is here: cotton panjabi, 10% off until Friday"></textarea>
      <div class="writer-foot">
        <div id="lang"></div>
        <div class="row"><button type="button" class="btn light" data-action="newPost">Write it myself</button><button type="button" class="btn" data-action="write">✨ Write with AI</button></div>
      </div>
    </div>
    <div id="versions" class="versions"></div>
    <div class="card posts-card">
      <div class="row between"><h3>Your posts</h3><div id="postFilter"></div></div>
      <div id="posts" class="mt"></div>
    </div>`;

  const drawLang = () => ($("#lang", root).innerHTML = chips([["bn", "বাংলা"], ["en", "English"]], language, "lang"));
  drawLang();
  onAction(root, {
    lang: (el) => { language = el.dataset.value; drawLang(); },
    filter: (el) => { statusFilter = el.dataset.value; return drawPosts(root); },
    newPost: () => openPostEditor(null, { onDone: () => drawPosts(root) }),
    open: (el) => openPostEditor({ _id: el.dataset.id }, { onDone: () => drawPosts(root) }),
    write: async () => {
      const topic = $("#topic", root).value.trim();
      if (!topic) { $("#topic", root).focus(); throw new Error("Write what the post is about first"); }
      const box = $("#versions", root);
      box.innerHTML = [1, 2, 3].map(() => `<div class="version-card loading-card"><span class="spin"></span> Writing…</div>`).join("");
      try { versions = await post("/api/content/ai-write", { topic, language }); }
      catch (e) { box.innerHTML = ""; throw e; }
      box.innerHTML = versions.map((v, i) => `<div class="version-card">
        <div class="version-text">${esc(v.text)}</div>
        ${v.hashtags.length ? `<div class="version-tags">${esc(v.hashtags.join(" "))}</div>` : ""}
        <button type="button" class="btn sm" data-action="use" data-i="${i}">Use this</button></div>`).join("");
    },
    use: (el) => openPostEditor(versions[el.dataset.i], { onDone: () => drawPosts(root) }),
  });
  await drawPosts(root);
}

async function drawPosts(root) {
  const items = await get(`/api/content${statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : ""}`);
  if (!$("#posts", root)) return;
  $("#postFilter", root).innerHTML = chips([["", "All"], ["Draft", "Drafts"], ["Scheduled", "Scheduled"], ["Published", "Published"], ["Failed", "Failed"]], statusFilter, "filter");
  $("#posts", root).innerHTML = items.length ? `<div class="m-list">${items.map((p) => {
    const color = STATUS_COLOR[p.status] || "grey";
    const when = p.scheduledAt ? `${p.status === "Published" ? "" : "for "}${shortTime(p.scheduledAt)}` : "not scheduled";
    const where = p.targets.map((t) => t.accountName).join(", ") || "No Page chosen";
    return row({
      action: "open", id: p._id, lead: leadIcon("content", STATUS_TONE[color] || "grey"),
      title: esc(p.title || p.text.slice(0, 70) || "Untitled"),
      sub: p.lastError ? `<span style="color:var(--red)">${esc(p.lastError)}</span>` : `${esc(where)} · ${esc(when)}`,
      side: `<small class="st st-${STATUS_TONE[color] || "grey"}">${esc(p.status)}</small>`,
    });
  }).join("")}</div>` : `<div class="empty"><b>${statusFilter ? "Nothing here" : "No posts yet"}</b>${statusFilter ? "" : "Tell the AI what to post above, or write it yourself."}</div>`;
}
