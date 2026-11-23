/* MarketingFlow website chat. A shop pastes one line on its website:
     <script src="https://<marketingflow>/widget.js" data-shop="<key>" async></script>
   A chat bubble appears at the bottom right; the shop's AI answers (and the shop can take over in its Inbox).
   Self-contained: no other files, styles live in a shadow root so the website's own CSS can't break it. */
(function () {
  var me = document.currentScript || document.querySelector("script[data-shop][src*='widget.js']");
  if (!me || window.__mfChat) return;
  window.__mfChat = true;
  var KEY = me.getAttribute("data-shop");
  var API = new URL(me.src).origin + "/api/widget/" + KEY;

  // the visitor's id, kept by this browser (so a returning visitor sees their chat)
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
  var V = store("mf_chat_v");
  if (!V) { V = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()).replace(/[^a-zA-Z0-9]/g, "").slice(0, 32); store("mf_chat_v", V); }

  var shop = { name: "", color: "#5b47e0" }, lastAt = null, open = false, busy = false, timer = null, started = !!store("mf_chat_started");

  function api(path, body) {
    return fetch(API + path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {})
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || "Error"); return j; }); });
  }

  var host = document.createElement("div");
  host.style.cssText = "position:fixed;z-index:2147483000;bottom:0;right:0;";
  document.body.appendChild(host);
  var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
  root.innerHTML = '<style>' +
    ':host{all:initial}*{box-sizing:border-box;font-family:"Hind Siliguri","Noto Sans Bengali",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}' +
    '.bub{position:fixed;right:18px;bottom:18px;width:60px;height:60px;border-radius:50%;border:0;cursor:pointer;background:var(--c);color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.22);display:grid;place-items:center;transition:transform .15s}' +
    '.bub:hover{transform:scale(1.06)}.bub svg{width:28px;height:28px}.dot{position:absolute;top:4px;right:4px;width:14px;height:14px;border-radius:50%;background:#ef4444;border:2px solid #fff;display:none}' +
    '.win{position:fixed;right:18px;bottom:90px;width:370px;height:min(600px,calc(100vh - 110px));background:#fff;border-radius:18px;box-shadow:0 16px 48px rgba(0,0,0,.22);display:none;flex-direction:column;overflow:hidden;color:#1f2430}' +
    '.win.on{display:flex}.head{background:var(--c);color:#fff;padding:14px 16px;display:flex;align-items:center;gap:10px}.head b{font-size:16px;display:block}.head small{opacity:.85;font-size:12.5px}' +
    '.x{margin-left:auto;background:rgba(255,255,255,.18);border:0;color:#fff;width:32px;height:32px;border-radius:50%;font-size:18px;cursor:pointer}' +
    '.list{flex:1;overflow-y:auto;padding:14px 12px;display:flex;flex-direction:column;gap:8px;background:#f6f7fb}' +
    '.m{max-width:82%;padding:9px 12px;border-radius:16px;font-size:14.5px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word}' +
    '.shop{align-self:flex-start;background:#fff;border:1px solid #e7e9f0;border-bottom-left-radius:6px}.me{align-self:flex-end;background:var(--c);color:#fff;border-bottom-right-radius:6px}' +
    '.m img{display:block;max-width:100%;border-radius:10px;margin:2px 0}.btns{display:flex;flex-wrap:wrap;gap:6px;align-self:flex-start;max-width:90%}' +
    '.btns button{border:1px solid var(--c);color:var(--c);background:#fff;border-radius:999px;padding:6px 12px;font-size:13.5px;cursor:pointer}.btns button:hover{background:var(--c);color:#fff}' +
    '.typing{align-self:flex-start;background:#fff;border:1px solid #e7e9f0;border-radius:16px;padding:10px 14px;display:none}.typing i{display:inline-block;width:7px;height:7px;margin:0 2px;border-radius:50%;background:#9aa0ae;animation:b 1s infinite}' +
    '.typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}@keyframes b{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-5px)}}' +
    '.hello{align-self:center;text-align:center;color:#6b7280;font-size:13px;padding:8px 18px}.err{align-self:center;color:#b91c1c;font-size:12.5px}' +
    'form{display:flex;gap:8px;padding:10px;border-top:1px solid #eceef3;background:#fff}textarea{flex:1;resize:none;border:1px solid #dfe2ea;border-radius:14px;padding:10px 12px;font-size:15px;max-height:110px;outline:none;color:#1f2430}' +
    'textarea:focus{border-color:var(--c)}.send{width:44px;height:44px;flex:none;align-self:flex-end;border:0;border-radius:50%;background:var(--c);color:#fff;cursor:pointer;display:grid;place-items:center}.send svg{width:20px;height:20px}' +
    '.by{text-align:center;font-size:11px;color:#9aa0ae;padding:0 0 8px;background:#fff}' +
    '@media (max-width:520px){.win{right:0;bottom:0;width:100vw;height:100%;border-radius:0}.win.on~.bub{display:none}}' +
    '</style>' +
    '<div class="win" role="dialog" aria-label="Chat"><div class="head"><div><b class="name">Chat</b><small>AI assistant · উত্তর দেয় সাথে সাথে</small></div><button class="x" aria-label="Close">×</button></div>' +
    '<div class="list"><div class="hello">আসসালামু আলাইকুম 👋 দাম, সাইজ, ছবি, অর্ডার, যা জানতে চান লিখুন।</div><div class="typing"><i></i><i></i><i></i></div></div>' +
    '<form><textarea rows="1" placeholder="মেসেজ লিখুন…" aria-label="Message"></textarea><button class="send" type="submit" aria-label="Send"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/></svg></button></form>' +
    '<div class="by">Powered by MarketingFlow AI</div></div>' +
    '<button class="bub" aria-label="Chat with us"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.1A8 8 0 1 1 21 12z"/></svg><span class="dot"></span></button>';

  var $ = function (s) { return root.querySelector(s); };
  var win = $(".win"), list = $(".list"), typing = $(".typing"), box = $("textarea"), dot = $(".dot");

  function esc(t) { var d = document.createElement("div"); d.textContent = t; return d.innerHTML; }
  function add(m) {
    if (m.at && (!lastAt || new Date(m.at) > new Date(lastAt))) lastAt = m.at;
    var el = document.createElement("div");
    el.className = "m " + (m.from === "me" ? "me" : "shop");
    el.innerHTML = (m.image ? '<img src="' + esc(m.image) + '" alt="">' : "") + (m.text ? esc(m.text) : "");
    if (!m.image && !m.text) return;
    list.insertBefore(el, typing);
    if (m.buttons && m.buttons.length) {
      var b = document.createElement("div");
      b.className = "btns";
      m.buttons.forEach(function (t) { var x = document.createElement("button"); x.type = "button"; x.textContent = t; x.onclick = function () { b.remove(); send(t); }; b.appendChild(x); });
      list.insertBefore(b, typing);
    }
    list.scrollTop = list.scrollHeight;
  }
  function clearButtons() { root.querySelectorAll(".btns").forEach(function (b) { b.remove(); }); }
  function showErr(t) { var e = document.createElement("div"); e.className = "err"; e.textContent = t; list.insertBefore(e, typing); list.scrollTop = list.scrollHeight; }

  function load() {
    if (busy) return Promise.resolve(); // a message is on its way: its answer comes with it
    return api("/messages?v=" + V + (lastAt ? "&after=" + encodeURIComponent(lastAt) : "")).then(function (j) {
      if (j.messages.length && lastAt) clearButtons();
      j.messages.forEach(add);
      if (!open && j.messages.some(function (m) { return m.from === "shop"; })) dot.style.display = "block";
    }).catch(function () {});
  }

  function send(text) {
    text = String(text || "").trim();
    if (!text || busy) return;
    busy = true; clearButtons();
    add({ from: "me", text: text });
    box.value = ""; box.style.height = "";
    typing.style.display = "block"; list.scrollTop = list.scrollHeight;
    if (!started) { started = true; store("mf_chat_started", "1"); }
    api("/messages", { v: V, text: text }).then(function (j) {
      j.messages.forEach(function (m) { if (m.from === "shop") add(m); else if (m.at && (!lastAt || new Date(m.at) > new Date(lastAt))) lastAt = m.at; });
    }).catch(function (e) { showErr(e.message || "Could not send. Try again."); })
      .then(function () { busy = false; typing.style.display = "none"; });
  }

  function toggle(on) {
    open = on;
    win.classList.toggle("on", on);
    dot.style.display = "none";
    clearInterval(timer);
    if (on) { load(); timer = setInterval(load, 4000); setTimeout(function () { box.focus(); }, 50); } // the shop may answer from its Inbox
    else if (started) timer = setInterval(load, 30000);
  }

  $(".bub").onclick = function () { toggle(!open); };
  $(".x").onclick = function () { toggle(false); };
  $("form").onsubmit = function (e) { e.preventDefault(); send(box.value); };
  box.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(box.value); } });
  box.addEventListener("input", function () { box.style.height = "auto"; box.style.height = Math.min(box.scrollHeight, 110) + "px"; });

  api("").then(function (s) {
    shop = s;
    host.style.setProperty("--c", s.color);
    root.querySelector(".name").textContent = s.name;
    if (started) { load(); timer = setInterval(load, 30000); }
  }).catch(function () { host.remove(); }); // chat turned off or wrong key: show nothing
  host.style.setProperty("--c", shop.color);
})();
