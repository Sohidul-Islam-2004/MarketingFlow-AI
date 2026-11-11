// Fraud Shield: orders held because of a high risk score, phone check, block list.
import { get, post, del } from "../api.js";
import { esc, taka, table, dateTime, onAction, openModal, toast, $ } from "../ui.js";
import { updateCounts } from "../app.js";

export async function render(root) {
  onAction(root, {
    approve: async (el) => { await post(`/api/orders/${el.dataset.id}/status`, { status: "confirmed", note: "Approved after checking" }); toast("Order confirmed"); draw(root); updateCounts(); },
    cancel: (el) => openModal({
      title: "Cancel this order?", buttons: [["ok", "Cancel order", "danger"]],
      body: `<label>Reason</label><input name="note" required placeholder="Fake order"><label class="check mt"><input type="checkbox" name="block"> Also block this phone number</label>`,
      onSubmit: async (d) => {
        await post(`/api/orders/${el.dataset.id}/status`, { status: "cancelled", note: d.note });
        if (d.block) await post("/api/fraud/blocked", { phone: el.dataset.phone, reason: d.note });
        toast("Order cancelled"); draw(root); updateCounts();
      },
    }),
    check: async () => {
      const phone = $("#checkPhone").value;
      const r = await get(`/api/fraud/check?phone=${encodeURIComponent(phone)}`);
      const history = Object.entries(r.history).map(([s, n]) => `${n} ${s}`).join(", ") || "no orders yet";
      $("#checkResult").innerHTML = `<div class="box mt"><b>Risk ${r.score}/100</b>${r.blocked ? ' <span class="pill p-red">Blocked</span>' : ""}
        <div class="small muted">Orders: ${esc(history)}</div>${r.reasons.map((x) => `<div class="small">• ${esc(x)}</div>`).join("")}</div>`;
    },
    block: async () => { await post("/api/fraud/blocked", { phone: $("#blockPhone").value, reason: $("#blockReason").value }); toast("Number blocked"); draw(root); },
    unblock: async (el) => { await del(`/api/fraud/blocked/${el.dataset.id}`); toast("Number unblocked"); draw(root); },
  });
  await draw(root);
}

async function draw(root) {
  const [held, blocked] = await Promise.all([get("/api/fraud/on-hold"), get("/api/fraud/blocked")]);
  root.innerHTML = `
    <div class="page-head"><div><h1>Fraud Shield</h1><p>Cash-on-delivery orders with a high risk score wait here until you approve them. Change the score limit in Settings.</p></div></div>
    <div class="card"><h3>Orders on hold (${held.length})</h3><p class="sub">Call the customer, then approve or cancel.</p>
      ${table([
        ["Order", (o) => `<b>${esc(o.orderNo)}</b><div class="small muted">${dateTime(o.createdAt)}</div>`],
        ["Customer", (o) => `${esc(o.customerName)}<div class="small muted">${esc(o.phone)}</div><div class="small muted">${esc(o.address)}</div>`],
        ["Total", (o) => taka(o.total)],
        ["Why", (o) => `<b>Risk ${o.riskScore}</b>${o.riskReasons.map((r) => `<div class="small">• ${esc(r)}</div>`).join("")}`],
        ["", (o) => `<div class="row" style="flex-wrap:nowrap"><button class="btn sm" data-action="approve" data-id="${o._id}">Approve</button><button class="btn sm danger" data-action="cancel" data-id="${o._id}" data-phone="${esc(o.phone)}">Cancel</button></div>`],
      ], held, { emptyText: "Nothing on hold 🎉" })}
    </div>
    <div class="grid2 mt">
      <div class="card"><h3>Check a phone number</h3><p class="sub">See the risk before you confirm a phone order.</p>
        <div class="row"><input id="checkPhone" placeholder="01XXXXXXXXX" style="flex:1"><button class="btn" data-action="check">Check</button></div><div id="checkResult"></div></div>
      <div class="card"><h3>Block list</h3><p class="sub">Blocked numbers can't order (or are held, see Settings).</p>
        <div class="f2"><input id="blockPhone" placeholder="01XXXXXXXXX"><input id="blockReason" placeholder="Reason"></div>
        <button class="btn sm mt" data-action="block">Block number</button>
        <div class="mt">${table([["Phone", (b) => esc(b.phone)], ["Reason", (b) => esc(b.reason)], ["", (b) => `<button class="btn sm light" data-action="unblock" data-id="${b._id}">Unblock</button>`]], blocked, { emptyText: "No blocked numbers" })}</div></div>
    </div>`;
}
