// Meta Accounts: connect Facebook Pages + Instagram, check them, disconnect.
import { get, post, del } from "../api.js";
import { esc, dateTime, onAction, toast, pill, table, confirmBox } from "../ui.js";

export async function render(root, params) {
  if (params.connected) toast(`Connected ${params.pages || 0} Page(s) and ${params.instagram || 0} Instagram account(s)`);
  if (params.taken) toast(`Not connected: ${params.taken}. This Page is already connected to another MarketingFlow account.`, true);
  if (params.error) toast(params.error, true);
  if (params.connected || params.error) history.replaceState(null, "", "#accounts");
  onAction(root, {
    check: async (el) => { el.disabled = true; await post("/api/accounts/check"); toast("Checked"); draw(root); },
    remove: async (el) => { if (!(await confirmBox("Disconnect this account? The AI will stop answering its messages.", "Disconnect"))) return; await del(`/api/accounts/${el.dataset.id}`); draw(root); },
  });
  await draw(root);
}

async function draw(root) {
  const accounts = await get("/api/accounts");
  root.innerHTML = `
    <div class="page-head"><div><h1>Meta Accounts</h1><p>Connect your Facebook Page. Its Instagram account (if linked) is added automatically.</p></div>
      <div class="row"><button class="btn light" data-action="check">Check connections</button><a class="btn" href="/api/meta/connect">Connect Facebook</a></div></div>
    <div class="card">
      ${table([
        ["Account", (a) => `<div class="row">${a.pictureUrl ? `<img src="${esc(a.pictureUrl)}" style="width:28px;height:28px;border-radius:50%">` : ""}<div><b>${esc(a.accountName)}</b><div class="small muted">${esc(a.platform)} · ${esc(a.accountId)}</div></div></div>`],
        ["Status", (a) => (a.status === "active" ? pill("Working", "green") : pill("Reconnect needed", "red")) + (a.statusNote ? `<div class="small muted">${esc(a.statusNote)}</div>` : "")],
        ["Messages & comments", (a) => (a.platform === "Facebook" ? (a.webhooksOn ? pill("On", "green") : pill("Off", "red")) : `<span class="small muted">through its Page</span>`)],
        ["Last event", (a) => (a.lastWebhookAt ? dateTime(a.lastWebhookAt) : `<span class="small muted">none yet</span>`)],
        ["", (a) => `<button class="btn sm danger" data-action="remove" data-id="${a._id}">Disconnect</button>`],
      ], accounts, { emptyText: "Nothing connected yet. Press Connect Facebook, log in, and tick the Page you sell from." })}
    </div>
    <div class="card"><h3>If messages don't arrive</h3><ol class="small" style="padding-left:18px;line-height:1.9">
      <li>Press <b>Check connections</b>. "Messages & comments" must say <b>On</b>, and Status must say <b>Working</b>.</li>
      <li>Send your Page a message from another Facebook account. "Last event" should show the time within a few seconds.</li>
      <li>Still "none yet"? Press <b>Connect Facebook</b> again and tick your Page in the Facebook window.</li>
      <li>If that doesn't help, contact support.</li></ol></div>`;
}
