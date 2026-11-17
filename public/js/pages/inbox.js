// Customer Inbox: chats on the left, the conversation in the middle, the order the AI is collecting on the right.
// Refreshes every 5 seconds while the page is open (the server answers "nothing new" when nothing changed).
// On a phone you see one part at a time: chat list -> chat -> order.
import { get, post, put, del } from "../api.js";
import { esc, taka, dateTime, onAction, openModal, toast, orderPill, $, confirmBox, debounce, icon, loading, options } from "../ui.js";
import { itemRow, readItems, districtList } from "../shared.js";
import { updateCounts } from "../app.js";

const state = { tab: "open", q: "", openId: null, chat: null };
const channelTag = (c) => `<span class="pill ${c === "Simulator" ? "p-grey" : c === "Instagram" ? "p-pink" : "p-blue"}">${esc(c)}</span>`;

export async function render(root, params) {
  if (params.tab) state.tab = params.tab;
  if (params.open) state.openId = params.open;
  root.innerHTML = `
    <div class="page-head"><div><h1>Customer Inbox</h1><p>Messenger chats. The AI answers and takes orders; you can take over any time.</p></div>
      <button class="btn light" data-action="simulate">Test the AI (simulator)</button></div>
    <div class="inbox ${state.openId ? "show-chat" : ""}" id="inbox">
      <div class="chats"><div class="filters"><div class="tabs" id="tabs" style="margin:0"></div><input id="search" placeholder="Search name, message, phone…" value="${esc(state.q)}"></div><div class="chat-list" id="chatList">${loading()}</div></div>
      <div class="thread" id="thread"></div>
      <div class="side-panel" id="sidePanel"></div>
    </div>`;

  onAction(root, {
    tab: (el) => { state.tab = el.dataset.tab; drawList(); },
    openChat: (el) => { state.openId = el.dataset.id; state.chat = null; $("#inbox").classList.add("show-chat"); $("#thread").innerHTML = loading(); return refreshAll(); },
    back: () => { state.openId = null; state.chat = null; $("#inbox").classList.remove("show-chat", "show-order"); return refreshAll(); },
    toggleOrder: () => $("#inbox").classList.toggle("show-order"),
    send: () => sendReply(),
    aiToggle: async () => { await post(`/api/inbox/${state.openId}/ai`, { on: state.chat.aiPaused }); refreshAll(); },
    closeChat: async () => { await post(`/api/inbox/${state.openId}/status`, { status: state.chat.status === "closed" ? "open" : "closed" }); refreshAll(); },
    deleteChat: async () => { if (!(await confirmBox("Delete this test chat?", "Delete"))) return; await del(`/api/inbox/${state.openId}`); state.openId = null; state.chat = null; $("#inbox").classList.remove("show-chat", "show-order"); refreshAll(); },
    suggest: async (el) => {
      el.disabled = true;
      try { const s = await post(`/api/inbox/${state.openId}/suggest`); $("#replyBox").value = s.reply || ""; toast(s.summary || "Suggestion ready"); }
      finally { el.disabled = false; }
    },
    editDraft: () => editDraft(),
    placeOrder: async () => {
      if (!(await confirmBox("Create the order from this chat? The customer gets a confirmation message.", "Create order", false))) return;
      const order = await post(`/api/inbox/${state.openId}/place-order`, { tellCustomer: true });
      toast(`Order ${order.orderNo} created`);
      refreshAll();
    },
    simulate: () => startSimulator(),
  });
  $("#search").addEventListener("input", debounce((e) => { state.q = e.target.value; drawList(); }));
  root.addEventListener("keydown", (e) => { if (e.target.id === "replyBox" && e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendReply().catch((err) => toast(err.message, true)); } });

  await refreshAll();
  if (params.simulate) startSimulator();
  const timer = setInterval(() => {
    if (!root.isConnected) return clearInterval(timer);
    if (!document.hidden) refreshAll(true); // no need to ask while the tab is in the background
  }, 5000);
}

async function refreshAll(quiet = false) {
  // the open chat first: opening it marks it as read, so the list shows the right unread count
  try { await drawChat(quiet); await drawList(); } catch (e) { if (!quiet) toast(e.message, true); }
}

/* ---------- left: chat list ---------- */
async function drawList() {
  const data = await get(`/api/inbox?tab=${state.tab}&q=${encodeURIComponent(state.q)}`);
  $("#tabs").innerHTML = [["open", "Open"], ["needs_human", `Needs you (${data.needsHuman})`], ["closed", "Closed"]]
    .map(([k, l]) => `<button class="tab ${state.tab === k ? "on" : ""}" data-action="tab" data-tab="${k}">${l}</button>`).join("");
  $("#chatList").innerHTML = data.rows.map((c) => `
    <div class="chat-row ${c._id === state.openId ? "on" : ""}" data-action="openChat" data-id="${c._id}">
      <div class="face">${c.avatar ? `<img src="${esc(c.avatar)}" alt="">` : esc(c.customerName[0] || "?")}</div>
      <div class="who"><b>${esc(c.customerName)} ${c.unread ? `<span class="pill p-red">${c.unread}</span>` : ""}</b>
        <small>${esc(c.lastMessage)}</small>
        <small>${channelTag(c.channel)} ${dateTime(c.updatedAt)} ${c.status === "needs_human" ? "· 🙋 needs you" : c.aiPaused ? "· AI off" : "· 🤖 AI"}${c.draftStatus === "placed" ? " · ✅ ordered" : ""}</small></div>
    </div>`).join("") || `<div class="empty"><b>No chats</b>New Messenger messages appear here.</div>`;
}

/* ---------- middle + right: one chat ---------- */
async function drawChat(quiet = false) {
  if (!state.openId) {
    $("#thread").innerHTML = `<div class="empty" style="margin:auto"><b>Choose a chat</b>or test your AI with the simulator.</div>`;
    $("#sidePanel").innerHTML = "";
    return;
  }
  const id = state.openId;
  const same = state.chat?._id === id;
  const c = await get(`/api/inbox/${id}${quiet && same ? `?since=${encodeURIComponent(state.chat.updatedAt)}` : ""}`);
  if (c.unchanged || id !== state.openId) return; // nothing new (keeps what you are typing)
  state.chat = c;
  const typing = same ? $("#replyBox")?.value || "" : "";
  const atBottom = !same || !$("#messages") || $("#messages").scrollHeight - $("#messages").scrollTop - $("#messages").clientHeight < 80;
  const oldScroll = $("#messages")?.scrollTop;

  $("#thread").innerHTML = `
    <div class="thread-head"><div class="row" style="flex-wrap:nowrap"><button class="btn sm light back" data-action="back" title="Back to all chats">${icon("back")}</button><div><b>${esc(c.customerName)}</b> ${channelTag(c.channel)}
      ${c.status === "needs_human" ? `<div class="small" style="color:var(--red)">Needs you: ${esc(c.handoffReason || "")}</div>` : ""}</div></div>
      <div class="row">
        <button class="btn sm light order-btn" data-action="toggleOrder">🧾 Order${c.draft?.items?.length && c.draft.status !== "placed" ? " •" : ""}</button>
        <button class="btn sm ${c.aiPaused ? "" : "light"}" data-action="aiToggle">${c.aiPaused ? "🤖 Turn AI on" : "✋ Take over (AI off)"}</button>
        <button class="btn sm light" data-action="closeChat">${c.status === "closed" ? "Reopen" : "Close chat"}</button>
        ${c.simulator ? `<button class="btn sm danger" data-action="deleteChat">Delete</button>` : ""}</div></div>
    <div class="messages" id="messages">${c.messages.map((m) => `<div class="bubble ${m.from}">${esc(m.text)}${m.error ? `<div class="error">Not delivered: ${esc(m.error)}</div>` : ""}<small>${{ customer: "Customer", ai: "AI", agent: "You", system: "" }[m.from]} ${dateTime(m.at)}</small></div>`).join("")}</div>
    <div class="composer">
      ${c.simulator
        ? `<textarea id="replyBox" placeholder="Type as the CUSTOMER to test the AI… (Enter to send)"></textarea><button class="btn" data-action="send">Send</button>`
        : `<textarea id="replyBox" placeholder="${c.canReply ? "Write a reply… (Enter to send). The AI pauses while you reply." : "The 24-hour reply window is closed. Wait for the customer to message again."}" ${c.canReply ? "" : "disabled"}></textarea>
           <button class="btn light" data-action="suggest" title="AI writes a reply for you">✨</button><button class="btn" data-action="send" ${c.canReply ? "" : "disabled"}>Send</button>`}
    </div>`;
  $("#replyBox").value = typing;
  $("#messages").scrollTop = atBottom ? 1e9 : oldScroll; // stay where you were reading unless you were at the end
  drawSidePanel(c);
}

function drawSidePanel(c) {
  const d = c.draft || { items: [] };
  const placed = d.status === "placed";
  $("#sidePanel").innerHTML = `
    <button class="btn sm light order-btn" data-action="toggleOrder">✕ Close</button>
    <div class="box"><h4>Order in this chat ${placed ? "· ✅ placed" : d.status === "awaiting_confirm" ? "· waiting for Confirm" : ""}</h4>
      ${placed ? `<p>Order <b>${esc(d.orderNo)}</b> was created.</p>` : `
        ${(d.items || []).map((i) => `<div class="line"><span>${esc(i.name)}${i.variantName ? ` (${esc(i.variantName)})` : ""} × ${i.qty}</span><b>${taka(i.price * i.qty)}</b></div>`).join("") || `<p class="small muted">No products yet.</p>`}
        ${d.items?.length ? `<div class="line"><span>Delivery ${esc(d.zone?.name || "")}</span><b>${taka(c.totals.fee)}</b></div><div class="line"><span><b>Total</b></span><b>${taka(c.totals.total)}</b></div>` : ""}
        <div class="small mt">👤 ${esc(d.name || "—")}<br>📞 ${esc(d.phone || "—")}<br>📍 ${esc(d.address || "—")}${d.district ? ", " + esc(d.district) : ""}</div>
        ${c.missing.length ? `<div class="note small mt">Still missing: ${esc(c.missing.join(", "))}</div>` : `<div class="good small mt">Ready to order</div>`}`}
      <div class="row mt"><button class="btn sm light" data-action="editDraft">${placed ? "Start a new order" : "Edit"}</button>
        ${!placed && !c.missing.length ? `<button class="btn sm" data-action="placeOrder">Create order</button>` : ""}</div></div>
    <div class="box"><h4>Orders from this customer</h4>${c.orders.map((o) => `<div class="line"><a href="#orders?open=${o._id}">${esc(o.orderNo)}</a>${orderPill(o.status)}</div>`).join("") || `<p class="small muted">None yet.</p>`}</div>`;
}

async function sendReply() {
  const box = $("#replyBox");
  const text = box.value.trim();
  if (!text) return;
  box.value = "";
  try {
    if (state.chat.simulator) {
      box.placeholder = "AI is typing…";
      $("#messages").insertAdjacentHTML("beforeend", `<div class="bubble customer">${esc(text)}</div><div class="bubble ai typing"><i></i><i></i><i></i></div>`);
      $("#messages").scrollTop = 1e9;
      await post("/api/inbox/simulate", { conversationId: state.openId, text });
    } else {
      await post(`/api/inbox/${state.openId}/reply`, { text });
    }
  } catch (e) {
    box.value = text;
    state.chat = null;
    refreshAll(true); // removes the "typing" dots
    throw e;
  }
  state.chat = null; // force a full redraw
  await refreshAll();
  updateCounts();
}

async function editDraft() {
  const [products, settings] = await Promise.all([get("/api/products"), get("/api/settings")]);
  const d = state.chat.draft?.status === "placed" ? { name: state.chat.draft.name, phone: state.chat.draft.phone, address: state.chat.draft.address, district: state.chat.draft.district, items: [] } : state.chat.draft || {};
  const body = openModal({
    title: "Order details", wide: true,
    body: `${districtList(settings.districts)}
      <div class="f3"><div><label>Name</label><input name="name" value="${esc(d.name || "")}"></div><div><label>Phone</label><input name="phone" value="${esc(d.phone || "")}"></div><div><label>District</label><input name="district" list="districts" value="${esc(d.district || "")}"></div></div>
      <div class="mt"><label>Address</label><input name="address" value="${esc(d.address || "")}"></div>
      <h4 class="mt">Products</h4><div id="itemRows">${(d.items?.length ? d.items : [{}]).map((i) => itemRow(products, i)).join("")}</div>
      <button type="button" class="btn sm light mt" data-action="addRow">+ Add product</button>`,
    onSubmit: async (f) => {
      await put(`/api/inbox/${state.openId}/draft`, { name: f.name, phone: f.phone, address: f.address, district: f.district, items: readItems(f) });
      toast("Order details saved");
      state.chat = null;
      refreshAll();
    },
  });
  onAction(body, {
    addRow: () => body.querySelector("#itemRows").insertAdjacentHTML("beforeend", itemRow(products)),
    removeRow: (el) => { if (body.querySelectorAll(".item-row").length > 1) el.closest(".item-row").remove(); },
  });
}

function startSimulator() {
  openModal({
    title: "Test the AI", buttons: [["start", "Start chat"]],
    body: `<p class="small muted">You play the customer. Nothing is sent to Facebook. The AI uses your real products, stock and delivery fees.</p>
      <div class="mt"><label>Customer name</label><input name="name" value="Test customer"></div>
      <div class="mt"><label>First message</label><input name="text" required value="Assalamu alaikum, ki ki product ache?"></div>`,
    onSubmit: async (f) => {
      const r = await post("/api/inbox/simulate", f);
      state.openId = r.conversationId;
      state.chat = null;
      state.tab = "open";
      $("#inbox").classList.add("show-chat");
      await refreshAll();
    },
  });
}
