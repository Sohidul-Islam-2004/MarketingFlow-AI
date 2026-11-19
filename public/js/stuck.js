// "Where the AI got stuck this week" on the AI Training page: each question has 🧠 Teach (saved into the
// shop knowledge, the AI answers it next time) and Skip. Server: src/services/stuck.js
import { get, post } from "./api.js";
import { esc, openModal, toast, shortTime } from "./ui.js";

export async function drawStuck(box) {
  const data = await get("/api/learn/stuck");
  if (!box.isConnected) return;
  const { items } = data;
  box.innerHTML = `<div class="card stuck-card">
    <div class="row between"><h3>🧠 Where the AI got stuck this week</h3>
      <span class="small muted">${data.handedOver} handed to you · ${data.staffAnswered} answered by you</span></div>
    ${items.length ? `<p class="small muted">Teach the right answer once and the AI answers it by itself next time.</p>
      <div class="stuck-list mt">${items.map((it, i) => `<div class="stuck-item">
        <div class="stuck-q">“${esc(it.question.slice(0, 200))}”</div>
        <div class="small muted">${esc(it.customerName)} · ${shortTime(it.at)}${it.reason ? ` · AI handed over: ${esc(it.reason)}` : ""}</div>
        ${it.answer ? `<div class="stuck-a"><b>You answered:</b> ${esc(it.answer.slice(0, 300))}</div>` : ""}
        <div class="row mt"><button type="button" class="btn sm" data-stuck="teach" data-i="${i}">🧠 Teach the AI</button><button type="button" class="btn sm light" data-stuck="skip" data-i="${i}">Skip</button></div>
      </div>`).join("")}</div>`
      : `<p class="muted mt">Nothing to teach right now. When the AI hands a chat to you or you answer a customer yourself, the question shows up here.</p>`}
  </div>`;
  const done = (it) => post("/api/learn/stuck/done", { conversationId: it.conversationId, at: it.at });
  box.querySelectorAll("[data-stuck]").forEach((b) => (b.onclick = async () => {
    const it = items[Number(b.dataset.i)];
    if (b.dataset.stuck === "skip") { await done(it); return drawStuck(box); }
    openModal({
      title: "🧠 Teach the AI",
      buttons: [["save", "Teach"]],
      body: `<p class="muted">Next time a customer asks this, the AI answers by itself. Write the answer so it works for every customer (no names or order numbers).</p>
        <div class="mt"><label>Customer's question</label><input name="question" value="${esc(it.question)}"></div>
        <div class="mt"><label>The right answer</label><textarea name="answer" rows="4" placeholder="e.g. Yes, we deliver all over Bangladesh. Inside Dhaka 1-2 days, outside 3-5 days.">${esc(it.answer)}</textarea></div>`,
      onSubmit: async (f) => { await post("/api/settings/teach", f); await done(it); toast("The AI learned it ✅"); drawStuck(box); },
    });
  }));
}
