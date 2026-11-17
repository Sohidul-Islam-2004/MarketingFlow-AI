// Setup → Look: the shop picks its main colour, menu colour and text size. Saved in this browser.
import { esc, onAction, toast } from "../ui.js";
import { COLOURS, MENUS, SIZES, DEFAULT, loadTheme, saveTheme } from "../theme.js";

export async function render(root) {
  let theme = loadTheme();
  const set = (patch) => { theme = { ...theme, ...patch }; saveTheme(theme); draw(); };

  onAction(root, {
    colour: (el) => set({ accent: el.dataset.value }),
    menu: (el) => set({ menu: el.dataset.value }),
    size: (el) => set({ size: el.dataset.value }),
    reset: () => { set({ ...DEFAULT }); toast("Back to the original look"); },
  });
  root.addEventListener("input", (e) => { if (e.target.id === "ownColour") { theme = { ...theme, accent: e.target.value }; saveTheme(theme); } });
  root.addEventListener("change", (e) => { if (e.target.id === "ownColour") draw(); });

  const choice = (action, value, label, on, extra = "") =>
    `<button type="button" class="look-choice ${on ? "on" : ""}" data-action="${action}" data-value="${esc(value)}">${extra}<span>${esc(label)}</span></button>`;

  function draw() {
    const custom = !COLOURS.some(([c]) => c === theme.accent);
    root.innerHTML = `
      <div class="page-head"><div><h1>Look</h1><p>Make the dashboard yours. Changes show straight away and are saved on this device.</p></div>
        <button class="btn light" data-action="reset">Reset</button></div>
      <div class="card">
        <h3>Main colour</h3><p class="small muted">Buttons, highlights and the selected menu item.</p>
        <div class="look-grid mt">
          ${COLOURS.map(([c, name]) => choice("colour", c, name, theme.accent === c, `<i class="swatch" style="background:${c}"></i>`)).join("")}
          <label class="look-choice ${custom ? "on" : ""}"><input type="color" id="ownColour" value="${esc(theme.accent)}"><span>Your own</span></label>
        </div>
      </div>
      <div class="card mt">
        <h3>Side menu</h3>
        <div class="look-grid mt">
          ${MENUS.map(([m, name]) => choice("menu", m, name, theme.menu === m, `<i class="menu-sample ${m}"></i>`)).join("")}
        </div>
      </div>
      <div class="card mt">
        <h3>Text size</h3>
        <div class="look-grid mt">
          ${SIZES.map(([s, name]) => choice("size", s, name, theme.size === s, `<i class="size-sample ${s}">Aa</i>`)).join("")}
        </div>
      </div>
      <div class="card mt">
        <h3>Preview</h3>
        <div class="row mt"><button type="button" class="btn">Main button</button><button type="button" class="btn light">Light button</button><span class="pill p-green">Working</span></div>
      </div>`;
  }
  draw();
}
