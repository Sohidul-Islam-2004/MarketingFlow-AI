// Calendar: posts by month. Drag a post to another day to move it. Click a day's "+" to plan a post.
import { get, post } from "../api.js";
import { esc, onAction, toast, ymd } from "../ui.js";
import { openPostEditor } from "../postEditor.js";

let month = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let posts = [];

export async function render(root) {
  onAction(root, {
    prev: () => { month = new Date(month.getFullYear(), month.getMonth() - 1, 1); draw(root); },
    next: () => { month = new Date(month.getFullYear(), month.getMonth() + 1, 1); draw(root); },
    today: () => { month = new Date(new Date().getFullYear(), new Date().getMonth(), 1); draw(root); },
    open: (el) => openPostEditor({ _id: el.dataset.id }, { onDone: () => draw(root) }),
    add: (el) => openPostEditor(null, { date: new Date(`${el.dataset.day}T19:00`), onDone: () => draw(root) }),
  });

  // Drag and drop: keep the time, change the day
  root.addEventListener("dragstart", (e) => { const id = e.target.dataset?.id; if (id) e.dataTransfer.setData("text/plain", id); });
  root.addEventListener("dragover", (e) => { const day = e.target.closest(".cal-day"); if (day) { e.preventDefault(); day.classList.add("drop"); } });
  root.addEventListener("dragleave", (e) => e.target.closest(".cal-day")?.classList.remove("drop"));
  root.addEventListener("drop", async (e) => {
    const day = e.target.closest(".cal-day");
    if (!day) return;
    e.preventDefault();
    const id = e.dataTransfer.getData("text/plain");
    const item = posts.find((p) => p._id === id);
    const time = item?.scheduledAt ? new Date(item.scheduledAt) : new Date(new Date().setHours(19, 0, 0, 0));
    const when = new Date(`${day.dataset.day}T${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`);
    try { await post(`/api/content/${id}/move`, { scheduledAt: when.toISOString() }); toast("Moved"); } catch (err) { toast(err.message, true); }
    draw(root);
  });
  await draw(root);
}

async function draw(root) {
  const first = new Date(month);
  const start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7)); // Monday before the 1st
  const end = new Date(start); end.setDate(start.getDate() + 42);
  posts = await get(`/api/content?from=${start.toISOString()}&to=${end.toISOString()}`);
  const unscheduled = (await get("/api/content?status=Draft")).filter((p) => !p.scheduledAt);
  const days = Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
  const today = ymd(new Date());

  root.innerHTML = `
    <div class="page-head"><div><h1>Calendar</h1><p>Drag posts between days. Scheduled posts publish automatically.</p></div>
      <div class="row"><button class="btn light" data-action="prev">‹</button><b style="min-width:150px;text-align:center">${month.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}</b><button class="btn light" data-action="next">›</button><button class="btn light" data-action="today">Today</button></div></div>
    <div class="card"><div class="calendar">
      ${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => `<div class="cal-head">${d}</div>`).join("")}
      ${days.map((d) => {
        const key = ymd(d);
        const dayPosts = posts.filter((p) => p.scheduledAt && ymd(p.scheduledAt) === key).sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
        return `<div class="cal-day ${d.getMonth() !== month.getMonth() ? "other" : ""} ${key === today ? "today" : ""}" data-day="${key}">
          <div class="row between"><b>${d.getDate()}</b><button class="btn sm light" style="padding:0 6px" data-action="add" data-day="${key}">+</button></div>
          ${dayPosts.map((p) => `<div class="cal-post ${p.status.split(" ")[0]}" draggable="true" data-action="open" data-id="${p._id}" title="${esc(p.status)}">${new Date(p.scheduledAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} ${esc(p.title || p.text.slice(0, 30))}</div>`).join("")}
        </div>`;
      }).join("")}
    </div></div>
    ${unscheduled.length ? `<div class="card"><h3>Drafts without a date</h3><p class="sub">Drag one onto a day to plan it.</p><div class="row">${unscheduled.map((p) => `<div class="cal-post" draggable="true" data-action="open" data-id="${p._id}">${esc(p.title || p.text.slice(0, 30))}</div>`).join("")}</div></div>` : ""}`;
}
