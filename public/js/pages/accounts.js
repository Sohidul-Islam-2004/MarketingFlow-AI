// Facebook Page + Instagram: add your own Meta app, connect your Page (and its Instagram), check, disconnect.
//   GET/PUT/DELETE /api/accounts/app  -> the shop's own Meta app (services/metaApp.js)
//   /api/meta/connect                 -> Facebook login (uses the own app if saved, otherwise the shared app)
//   /api/meta/connect?with=instagram  -> same login, also asks for Instagram and saves the linked account
import { get, post, put, del } from "../api.js";
import { esc, dateTime, onAction, toast, pill, table, confirmBox, $ } from "../ui.js";

let showForm = false;

export async function render(root, params) {
  if (params.connected) toast(Number(params.instagram) ? `Connected ${params.instagram} Instagram account(s)` : `Connected ${params.pages || 0} Page(s)`);
  if (params.taken) toast(`Not connected: ${params.taken}. This Page is already connected to another MarketingFlow account.`, true);
  if (params.error) toast(params.error, true);
  if (params.connected || params.error) history.replaceState(null, "", "#accounts");
  showForm = false;
  onAction(root, {
    check: async () => { await post("/api/accounts/check"); toast("Checked"); draw(root); },
    remove: async (el) => {
      const ig = el.dataset.platform === "Instagram";
      const q = ig ? "Disconnect this Instagram account? The AI will stop answering its messages and comments." : "Disconnect this Page? The AI will stop answering its messages and comments (and its Instagram, if connected).";
      if (!(await confirmBox(q, "Disconnect"))) return;
      await del(`/api/accounts/${el.dataset.id}`);
      draw(root);
    },
    openForm: () => { showForm = true; draw(root); },
    closeForm: () => { showForm = false; draw(root); },
    saveApp: async () => {
      const r = await put("/api/accounts/app", { appId: $("#appId").value, appSecret: $("#appSecret").value, configId: $("#configId").value });
      toast(r.webhookOk ? `Saved: ${r.name}` : `Saved ${r.name}, but messages are not switched on yet`, !r.webhookOk);
      showForm = false;
      draw(root);
    },
    removeApp: async () => {
      if (!(await confirmBox("Stop using your own Meta app?", "Remove"))) return;
      await del("/api/accounts/app");
      toast("Removed");
      draw(root);
    },
    copy: async (el) => {
      try { await navigator.clipboard.writeText(el.dataset.text); toast("Copied"); } catch { toast(el.dataset.text); }
    },
  });
  await draw(root, params.connected);
}

async function draw(root, justConnected) {
  const [all, app] = await Promise.all([get("/api/accounts"), get("/api/accounts/app")]);
  const pages = all.filter((a) => a.platform === "Facebook");
  const instagram = all.filter((a) => a.platform === "Instagram");
  const canConnect = !!(app.own || app.sharedApp);
  const formOpen = showForm || !canConnect; // no app at all: the form is the first step

  root.innerHTML = `
    <div class="page-head"><div><h1>Facebook & Instagram</h1><p>Connect the Page you sell from (and its Instagram). The AI answers chats and comments, and your posts are published there.</p></div>
      <div class="row">${pages.length ? `<button class="btn light" data-action="check">Check connection</button>` : ""}
        ${canConnect ? `<a class="btn ${pages.length ? "light" : ""}" href="/api/meta/connect">${pages.length ? "Add another Page" : "Connect Facebook"}</a>` : ""}</div></div>
    ${justConnected ? `<div class="card good-card"><b>Connected. Next: train the AI on your shop.</b><p class="small muted">It reads this Page and your website and learns your delivery, payment and return rules.</p><a class="btn mt" href="#train">Train the AI →</a></div>` : ""}

    <div class="card">
      <h3>Meta app</h3>
      ${appStatus(app)}
      ${formOpen ? appForm(app) : ""}
    </div>

    <div class="card">
      <h3>Connected Page</h3>
      ${table([
        ["Page", (a) => `<div class="row">${a.pictureUrl ? `<img src="${esc(a.pictureUrl)}" style="width:28px;height:28px;border-radius:50%">` : ""}<div><b>${esc(a.accountName)}</b><div class="small muted">${esc(a.accountId)}</div></div></div>`],
        ["Status", (a) => (a.status === "active" ? pill("Working", "green") : pill("Reconnect needed", "red")) + (a.statusNote ? `<div class="small muted">${esc(a.statusNote)}</div>` : "")],
        ["Messages & comments", (a) => (a.webhooksOn ? pill("On", "green") : pill("Off", "red"))],
        ["Last message from Facebook", (a) => (a.lastWebhookAt ? dateTime(a.lastWebhookAt) : `<span class="small muted">none yet</span>`)],
        ["", (a) => `<button class="btn sm danger" data-action="remove" data-platform="Facebook" data-id="${a._id}">Disconnect</button>`],
      ], pages, { emptyText: canConnect ? "No Page connected yet. Press Connect Facebook, log in, and tick the Page you sell from." : "First add your Meta app above." })}
    </div>
    ${pages.length ? instagramCard(instagram) : ""}
    <div class="card"><h3>If messages don't arrive</h3><ol class="small" style="padding-left:18px;line-height:1.9">
      <li>Press <b>Check connection</b>. "Messages & comments" must say <b>On</b>, and Status must say <b>Working</b>.</li>
      <li>Send your Page a message from another Facebook account. "Last message from Facebook" should show the time within a few seconds.</li>
      ${app.own ? `<li>Using your own app: in developers.facebook.com check that the <b>Messenger</b> product is added and the app is not restricted.</li>` : ""}
      <li>Still "none yet"? Press <b>Connect Facebook</b> again and tick your Page in the Facebook window.</li></ol></div>`;
}

// Instagram works through the Facebook Page, so this card shows only after a Page is connected
function instagramCard(list) {
  const rows = list.map((a) => `<div class="row between ig-row">
      <div class="row">${a.pictureUrl ? `<img src="${esc(a.pictureUrl)}" style="width:28px;height:28px;border-radius:50%">` : ""}
        <div><b>${esc(a.accountName)}</b><div class="small muted">${a.lastWebhookAt ? `Last message ${dateTime(a.lastWebhookAt)}` : "No message yet"}</div></div></div>
      <div class="row">${a.status === "active" ? pill("Working", "green") : pill("Reconnect needed", "red")}
        <button class="btn sm danger" data-action="remove" data-platform="Instagram" data-id="${a._id}">Disconnect</button></div></div>`).join("");
  return `<div class="card">
    <div class="row between"><h3>Instagram</h3><a class="btn ${list.length ? "light sm" : ""}" href="/api/meta/connect?with=instagram">${list.length ? "Reconnect Instagram" : "Connect Instagram"}</a></div>
    ${rows || `<p class="small muted">The AI can also answer Instagram DMs and comments, and post there.</p>`}
    <details class="mt small" ${list.length ? "" : "open"}><summary>Before you connect (one time)</summary>
      <ol class="small steps-list mt">
        <li>In the Instagram app: <b>Settings → Account type</b> → switch to a <b>Business</b> account, and link it to your Facebook Page.</li>
        <li>In the Instagram app: <b>Settings → Messages → Connected tools</b> → turn on <b>Allow access to messages</b>.</li>
        <li>In developers.facebook.com, open your Meta app and add the <b>Instagram</b> product (Instagram API with Facebook Login).</li>
        <li>Press <b>Connect Instagram</b> and tick your Page and your Instagram account.</li>
      </ol></details>
  </div>`;
}

function appStatus(app) {
  if (app.own) {
    return `<div class="row between">
        <div><b>${esc(app.own.name || "Your app")}</b> <span class="small muted">App ID ${esc(app.own.appId)}</span>
          <div class="mt">${app.own.webhookOk ? pill("Messages switched on", "green") : pill("Messages not switched on", "red")}
          ${app.own.webhookNote ? `<span class="small muted">${esc(app.own.webhookNote)}</span>` : ""}</div></div>
        <div class="row"><button class="btn sm light" data-action="openForm">Change</button><button class="btn sm danger" data-action="removeApp">Remove</button></div></div>`;
  }
  if (app.sharedApp) {
    return `<p class="small muted">You connect with MarketingFlow's app. Until it is approved by Meta, only people invited as Testers can connect.</p>
      ${showForm ? "" : `<button class="btn sm light" data-action="openForm">Use my own Meta app instead</button>`}`;
  }
  return `<p class="small muted">To connect your Page, make your own Meta app once (about 10 minutes) and paste its App ID and App Secret here.</p>`;
}

const copyRow = (label, text) => `<div class="copy-row"><span>${label}</span><code>${esc(text)}</code><button type="button" class="btn sm light" data-action="copy" data-text="${esc(text)}">Copy</button></div>`;

function appForm(app) {
  const c = app.copy;
  return `
    <ol class="small steps-list mt">
      <li>Open <a href="https://developers.facebook.com/apps" target="_blank" rel="noopener">developers.facebook.com/apps</a>, log in with the Facebook account that manages your Page, and press <b>Create app</b>. Choose the <b>Business</b> type.</li>
      <li>In <b>App settings → Basic</b> fill in these, then press <b>Save changes</b>:
        ${copyRow("App domain", c.domain)}${copyRow("Privacy policy URL", c.privacy)}${copyRow("Terms of service URL", c.terms)}${copyRow("User data deletion URL", c.deletion)}</li>
      <li>Add the products <b>Facebook Login for Business</b> (or Facebook Login) and <b>Messenger</b>. In the login product's <b>Settings</b>, add this to <b>Valid OAuth Redirect URIs</b>:
        ${copyRow("Redirect URI", c.redirectUri)}</li>
      <li>At the top of the app page, switch <b>App Mode</b> to <b>Live</b> (otherwise only you can message your Page).</li>
      <li>Back in <b>App settings → Basic</b>, copy the <b>App ID</b> and the <b>App secret</b> (press Show) into the boxes below.</li>
      <li>Press <b>Save app</b>. MarketingFlow checks it and switches on messages by itself. Then press <b>Connect Facebook</b>.</li>
    </ol>
    <div class="f2 mt">
      <div><label>App ID</label><input id="appId" inputmode="numeric" placeholder="e.g. 1234567890123456" value="${esc(app.own?.appId || "")}"></div>
      <div><label>App secret</label><input id="appSecret" type="password" autocomplete="off" placeholder="${app.own ? "type it again to change" : "32 letters and numbers"}"></div>
    </div>
    <details class="mt small"><summary>Advanced: Facebook Login for Business configuration</summary>
      <div class="mt"><label>Configuration ID (only if Facebook asks for one)</label><input id="configId" inputmode="numeric" value="${esc(app.own?.configId || "")}"></div></details>
    <div class="row mt"><button class="btn" data-action="saveApp">Save app</button>${app.own || app.sharedApp ? `<button class="btn light" data-action="closeForm">Cancel</button>` : ""}</div>`;
}
