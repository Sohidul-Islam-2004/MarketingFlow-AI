// Connections → Chat on your website: the code to paste, on/off, colour, and a page to try it
import { get, put } from "./api.js";
import { esc, onAction, toast } from "./ui.js";

export async function drawWebChat(box) {
  const w = await get("/api/settings/widget");
  box.innerHTML = `
    <label class="switch-row"><span><b>Chat bubble on my website</b><small>Visitors write without Facebook; the same AI answers and takes orders. Chats show in the Inbox as "Website".</small></span>
      <input type="checkbox" class="switch" name="widgetOn" ${w.on ? "checked" : ""}></label>
    <ol class="store-steps small mt">
      <li>Copy this code: <div class="code-row mt"><code>${esc(w.code)}</code><button type="button" class="btn sm" data-action="copyCode">Copy</button></div></li>
      <li>Paste it in your website, just before <code>&lt;/body&gt;</code> (every page, or the main layout).
        WordPress: Appearance → Theme File Editor → footer.php, or a "header &amp; footer code" plugin.</li>
      <li>A chat button appears at the bottom right of your website. <a href="${esc(w.testUrl)}" target="_blank" rel="noopener">Try it here first →</a></li></ol>
    <div class="row mt"><label class="small" style="display:flex;align-items:center;gap:8px">Colour <input type="color" name="widgetColor" value="${esc(w.color)}" style="width:44px;height:32px;padding:0;border:0;background:none"></label></div>`;
  onAction(box, {
    copyCode: async () => { try { await navigator.clipboard.writeText(w.code); toast("Copied: paste it in your website"); } catch { toast("Could not copy", true); } },
  });
  box.querySelector("[name=widgetOn]").addEventListener("change", async (e) => {
    await put("/api/settings/widget", { on: e.target.checked }).catch((err) => { e.target.checked = !e.target.checked; toast(err.message, true); });
    toast(e.target.checked ? "Website chat is on" : "Website chat is off (the bubble disappears)");
  });
  box.querySelector("[name=widgetColor]").addEventListener("change", async (e) => { await put("/api/settings/widget", { color: e.target.value }); toast("Colour saved"); });
}
