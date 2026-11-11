// FB Comments: what the comment engine did, and the comments that need you.
import { get, post } from "../api.js";
import { esc, dateTime, onAction, openModal, toast, pill, confirmBox } from "../ui.js";
import { updateCounts } from "../app.js";

const TABS = [["needs_you", "Needs you"], ["waiting", "Replying soon"], ["replied", "Replied"], ["spam", "Spam"], ["all", "All"]];
const CATEGORY = { price: ["Price", "blue"], stock: ["In stock?", "blue"], size: ["Size/colour", "blue"], delivery: ["Delivery", "purple"], order: ["Wants to order", "green"], complaint: ["Complaint", "red"], praise: ["Praise", "green"], spam: ["Spam", "grey"], other: ["Other", "grey"] };
const STATUS = { new: "New", waiting: "Reply scheduled", approval: "Waiting for your OK", replied: "Replied", needs_human: "Needs you", spam: "Spam", ignored: "Skipped", failed: "Failed" };
let tab = "needs_you";
let rows = [];

export async function render(root) {
  onAction(root, {
    tab: (el) => { tab = el.dataset.tab; draw(root); },
    reply: (el) => {
      const c = rows.find((x) => x._id === el.dataset.id);
      openModal({
        title: `Reply to ${c.fromName}`, buttons: [["send", "Post reply"]],
        body: `<p class="small muted">“${esc(c.message)}”</p><label class="mt">Public reply</label><textarea name="text" rows="3" required>${esc(c.reply)}</textarea>`,
        onSubmit: async (d) => { await post(`/api/comments/${c._id}/reply`, d); toast("Reply posted"); draw(root); updateCounts(); },
      });
    },
    dm: async (el) => { await post(`/api/comments/${el.dataset.id}/dm`); toast("Message sent. The chat is in the inbox."); draw(root); },
    skip: async (el) => { await post(`/api/comments/${el.dataset.id}/skip`); draw(root); updateCounts(); },
    hide: async (el) => { if (!(await confirmBox("Hide this comment on Facebook?", "Hide"))) return; await post(`/api/comments/${el.dataset.id}/hide`); draw(root); updateCounts(); },
    simulate: () => openModal({
      title: "Test a comment", buttons: [["go", "Run"]],
      body: `<p class="small muted">Runs the comment engine without Facebook. Try "dam koto?", "L size ache?", "fake page".</p><div class="f2 mt"><div><label>Name</label><input name="name" value="Test customer"></div><div><label>Comment</label><input name="message" required></div></div>`,
      onSubmit: async (d) => { const c = await post("/api/comments/simulate", d); toast(`Seen as "${CATEGORY[c.category][0]}" → ${STATUS[c.status]}`); tab = "all"; draw(root); },
    }),
  });
  await draw(root);
}

async function draw(root) {
  const data = await get(`/api/comments?tab=${tab}`);
  rows = data.rows;
  root.innerHTML = `
    <div class="page-head"><div><h1>FB Comments</h1><p>Buying questions get a private message and a public reply with your real prices. Complaints wait for you. Change the rules in Settings.</p></div>
      <button class="btn light" data-action="simulate">Test a comment</button></div>
    <div class="tabs">${TABS.map(([k, l]) => `<button class="tab ${tab === k ? "on" : ""}" data-action="tab" data-tab="${k}">${l}${k === "needs_you" ? `<span class="n">${data.needsYou}</span>` : ""}</button>`).join("")}</div>
    <div class="stack">${rows.map(card).join("") || `<div class="card"><div class="empty"><b>Nothing here</b>New comments on your Page posts show up within seconds.</div></div>`}</div>`;
}

function card(c) {
  const [label, color] = CATEGORY[c.category] || CATEGORY.other;
  const open = !["replied", "spam", "ignored"].includes(c.status);
  return `<div class="card">
    <div class="row between"><div><b>${esc(c.fromName)}</b> <span class="small muted">${dateTime(c.createdAt)}${c.commentId.startsWith("sim_") ? " · test" : ""}</span></div>
      <div class="row">${pill(label, color)} ${pill(STATUS[c.status] || c.status, c.status === "needs_human" || c.status === "failed" ? "red" : c.status === "replied" ? "green" : "grey")}</div></div>
    <p class="mt">“${esc(c.message)}”</p>
    ${c.note ? `<p class="small muted">${esc(c.note)}</p>` : ""}
    ${c.reply ? `<div class="box mt small">↳ ${c.status === "replied" ? "Replied" : c.status === "waiting" ? `Will reply at ${dateTime(c.replySendAt)}` : "Suggested reply"}: ${esc(c.reply)}</div>` : ""}
    ${c.dmSent ? `<p class="small mt">✉️ Private message sent. The chat continues in the inbox.</p>` : ""}
    ${c.error ? `<p class="small mt" style="color:var(--red)">${esc(c.error)}</p>` : ""}
    <div class="row mt">
      ${open ? `<button class="btn sm" data-action="reply" data-id="${c._id}">${c.reply ? "Check & send reply" : "Write reply"}</button>` : ""}
      ${!c.dmSent && c.status !== "spam" ? `<button class="btn sm light" data-action="dm" data-id="${c._id}">Send private message</button>` : ""}
      ${open ? `<button class="btn sm light" data-action="skip" data-id="${c._id}">Don't reply</button>` : ""}
      ${c.status !== "spam" ? `<button class="btn sm light" data-action="hide" data-id="${c._id}">Hide</button>` : ""}
    </div></div>`;
}
