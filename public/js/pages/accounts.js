// Facebook Page: connect your Page, check the connection, disconnect.
import { get, post, del } from "../api.js";
import { esc, dateTime, onAction, toast, pill, table, confirmBox } from "../ui.js";

export async function render(root, params) {
  if (params.connected) toast(`Connected ${params.pages || 0} Page(s)`);
  if (params.taken) toast(`Not connected: ${params.taken}. This Page is already connected to another MarketingFlow account.`, true);
  if (params.error) toast(params.error, true);
  if (params.connected || params.error) history.replaceState(null, "", "#accounts");
  onAction(root, {
    check: async () => { await post("/api/accounts/check"); toast("Checked"); draw(root); },
    remove: async (el) => { if (!(await confirmBox("Disconnect this Page? The AI will stop answering its messages and comments.", "Disconnect"))) return; await del(`/api/accounts/${el.dataset.id}`); draw(root); },
  });
  await draw(root, params.connected);
}

async function draw(root, justConnected) {
  const pages = await get("/api/accounts");
  root.innerHTML = `
    <div class="page-head"><div><h1>Facebook Page</h1><p>Connect the Page you sell from. The AI answers its Messenger chats and comments, and your posts are published to it.</p></div>
      <div class="row">${pages.length ? `<button class="btn light" data-action="check">Check connection</button>` : ""}<a class="btn ${pages.length ? "light" : ""}" href="/api/meta/connect">${pages.length ? "Add another Page" : "Connect Facebook"}</a></div></div>
    ${justConnected ? `<div class="card good-card"><b>Connected. Next: train the AI on your shop.</b><p class="small muted">It reads this Page and your website and learns your products, prices and rules.</p><a class="btn mt" href="#train">Train the AI →</a></div>` : ""}
    <div class="card">
      ${table([
        ["Page", (a) => `<div class="row">${a.pictureUrl ? `<img src="${esc(a.pictureUrl)}" style="width:28px;height:28px;border-radius:50%">` : ""}<div><b>${esc(a.accountName)}</b><div class="small muted">${esc(a.accountId)}</div></div></div>`],
        ["Status", (a) => (a.status === "active" ? pill("Working", "green") : pill("Reconnect needed", "red")) + (a.statusNote ? `<div class="small muted">${esc(a.statusNote)}</div>` : "")],
        ["Messages & comments", (a) => (a.webhooksOn ? pill("On", "green") : pill("Off", "red"))],
        ["Last message from Facebook", (a) => (a.lastWebhookAt ? dateTime(a.lastWebhookAt) : `<span class="small muted">none yet</span>`)],
        ["", (a) => `<button class="btn sm danger" data-action="remove" data-id="${a._id}">Disconnect</button>`],
      ], pages, { emptyText: "No Page connected yet. Press Connect Facebook, log in, and tick the Page you sell from." })}
    </div>
    <div class="card"><h3>If messages don't arrive</h3><ol class="small" style="padding-left:18px;line-height:1.9">
      <li>Press <b>Check connection</b>. "Messages & comments" must say <b>On</b>, and Status must say <b>Working</b>.</li>
      <li>Send your Page a message from another Facebook account. "Last message from Facebook" should show the time within a few seconds.</li>
      <li>Still "none yet"? Press <b>Connect Facebook</b> again and tick your Page in the Facebook window.</li></ol></div>`;
}
