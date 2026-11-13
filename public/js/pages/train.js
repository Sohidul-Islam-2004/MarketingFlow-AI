// AI Training: the AI reads your Facebook Page and website, then shows what it learned.
// You check it, fix it, and press Save. Only then does the AI use it with customers.
//   1. start  -> POST /api/learn/start          (works in the background, we ask for progress every 3 s)
//   2. review -> shop knowledge (text you can edit)
//   3. save   -> POST /api/learn/save-knowledge
import { get, post } from "../api.js";
import { esc, onAction, toast, $ } from "../ui.js";

let data = null; // last answer of GET /api/learn

export async function render(root) {
  onAction(root, {
    start: async () => {
      await post("/api/learn/start", { website: $("#website").value });
      await draw(root);
    },
    saveKnowledge: async () => {
      await post("/api/learn/save-knowledge", { knowledge: $("#knowledge").value, deliveryTime: $("#deliveryTime").value, returnPolicy: $("#returnPolicy").value });
      toast("Saved. The AI now answers from this.");
      await draw(root);
    },
  });
  await draw(root);
}

async function draw(root) {
  data = await get("/api/learn");
  const scan = data.scan;
  root.innerHTML = `
    <div class="page-head"><div><h1>AI Training</h1><p>The AI reads your Facebook Page and your website, and learns your delivery, payment and return rules, stores and common questions. You check everything before it is used.</p></div></div>
    ${!data.aiReady ? `<div class="note">The AI is not set up on this server yet (AI_API_KEY is missing).</div>` : ""}
    <div class="card">
      <h3>1. What should the AI read?</h3>
      <div class="sources mt">
        <div class="box"><span class="pill p-blue">Facebook Page</span>
          ${data.pageName ? `<p class="mt"><b>${esc(data.pageName)}</b></p><p class="small muted">About and contact info.</p>` : `<p class="mt small muted">No Page connected.</p><a class="btn sm light" href="#accounts">Connect Facebook</a>`}</div>
        <div class="box"><span class="pill p-purple">Website</span>
          <input class="mt" id="website" placeholder="https://yourshop.com" value="${esc(data.website)}" ${scan?.status === "running" ? "disabled" : ""}>
          <p class="small muted">Optional. It reads your home, delivery, return and about pages.</p></div>
      </div>
      ${scan?.status === "running"
      ? `<div class="loading" style="padding:24px 0 8px"><span class="spin"></span><span id="step">${esc(scan.step || "Working…")}</span></div><p class="small muted center">This takes one or two minutes. You can leave this page and come back.</p>`
      : `<button class="btn mt" data-action="start" ${data.aiReady ? "" : "disabled"}>${scan ? "Read again" : "Start reading"}</button>`}
      ${scan?.status === "failed" ? `<div class="note mt">It didn't work: ${esc(scan.error || "unknown problem")}</div>` : ""}
    </div>
    ${scan?.status === "ready" ? review(scan) : ""}
    ${!scan && data.currentKnowledge ? `<div class="card"><h3>What the AI knows now</h3><p class="small muted">You wrote this in Settings. "Start reading" does not change it until you press Save.</p><pre class="pre">${esc(data.currentKnowledge)}</pre></div>` : ""}`;

  if (scan?.status === "running") setTimeout(() => root.isConnected && draw(root), 3000); // ask again until it is done
}

function review(scan) {
  return `
    <div class="card">
      <h3>2. Check what the AI learned about your shop</h3>
      <p class="sub">Read it carefully and fix anything wrong. The AI will tell customers exactly this.</p>
      ${scan.error ? `<div class="note small">${esc(scan.error)}</div>` : ""}
      <p class="small muted">Read: ${scan.sources.map((s) => (s.url ? `<a target="_blank" rel="noopener" href="${esc(s.url)}">${esc(s.title)}</a>` : esc(s.title))).join(" · ") || "nothing"}</p>
      ${scan.knowledge ? "" : `<div class="note small mt">The AI found no clear facts. Write your delivery, payment and return rules here yourself.</div>`}
      <textarea id="knowledge" rows="16" class="mt" placeholder="## Delivery&#10;- Inside Dhaka 2-3 days…">${esc(scan.knowledge)}</textarea>
      <div class="f2 mt">
        <div><label>Delivery time (the AI tells customers this)</label><input id="deliveryTime" value="${esc(scan.deliveryTime)}" placeholder="e.g. 2-3 days inside Dhaka"></div>
        <div><label>Return policy (printed on invoices)</label><input id="returnPolicy" value="${esc(scan.returnPolicy)}"></div>
      </div>
      ${data.currentKnowledge ? `<p class="small muted mt">Saving replaces what the AI knows now (${data.currentKnowledge.length} characters).</p>` : ""}
      <button class="btn mt" data-action="saveKnowledge">Save shop knowledge</button>
    </div>
`;
}