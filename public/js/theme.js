// The shop's own look: main colour, menu colour and text size.
// Saved in this browser (localStorage) and applied by setting CSS variables on <html>.
// app.css uses: --accent (buttons), --on-accent (text on buttons), --accent-soft, --accent-ink,
//               --side / --side-ink / --side-strong / --side-line / --side-tile (side menu)

export const COLOURS = [
  ["#4f46e5", "Indigo"], ["#2563eb", "Blue"], ["#0d9488", "Teal"], ["#16a34a", "Green"], ["#b8f03a", "Lime"],
  ["#7c3aed", "Purple"], ["#db2777", "Pink"], ["#ea580c", "Orange"], ["#111827", "Black"],
];
export const MENUS = [["dark", "Dark"], ["light", "Light"], ["colour", "Colour"]];
export const SIZES = [["normal", "Normal"], ["large", "Large"]];
export const DEFAULT = { accent: "#4f46e5", menu: "dark", size: "normal" };

const KEY = "mf-theme";

export function loadTheme() {
  try { return { ...DEFAULT, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch { return { ...DEFAULT }; }
}

export function saveTheme(theme) {
  try { localStorage.setItem(KEY, JSON.stringify(theme)); } catch {}
  applyTheme(theme);
}

/* ---------- colour maths ---------- */
const rgb = (hex) => { const n = parseInt(String(hex).replace("#", "").padEnd(6, "0").slice(0, 6), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
const toHex = (c) => "#" + c.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0")).join("");
const mix = (hex, other, t) => { const a = rgb(hex), b = rgb(other); return toHex(a.map((x, i) => x + (b[i] - x) * t)); };
const light = (hex) => { const [r, g, b] = rgb(hex).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const alpha = (hex, a) => `rgba(${rgb(hex).join(",")},${a})`;

export function applyTheme(theme = loadTheme()) {
  const t = { ...DEFAULT, ...theme };
  const accent = /^#[0-9a-f]{6}$/i.test(t.accent) ? t.accent : DEFAULT.accent;
  const bright = light(accent) > 0.45; // lime, yellow… need dark text on them
  const v = {
    "--accent": accent,
    "--accent-d": mix(accent, "#000000", 0.1),
    "--on-accent": bright ? "#0d1b2a" : "#ffffff",
    "--accent-soft": alpha(accent, bright ? 0.22 : 0.12),
    "--accent-text": bright ? mix(accent, "#000000", 0.55) : light(accent) < 0.03 ? accent : mix(accent, "#000000", 0.12), // links on white
  };
  if (t.menu === "light") {
    Object.assign(v, { "--side": "#ffffff", "--side-ink": "#4b5563", "--side-strong": "#0e1a14", "--side-line": "#e5e7eb", "--side-tile": "#f3f4f6",
      "--accent-ink": bright ? mix(accent, "#000000", 0.45) : accent });
  } else {
    const side = t.menu === "colour" ? mix(accent, "#0b1020", 0.7) : "#0f1424";
    Object.assign(v, { "--side": side, "--side-ink": "rgba(255,255,255,.72)", "--side-strong": "#ffffff", "--side-line": "rgba(255,255,255,.14)", "--side-tile": "rgba(255,255,255,.07)",
      "--accent-ink": bright ? accent : mix(accent, "#ffffff", 0.45) });
  }
  const root = document.documentElement;
  for (const [k, val] of Object.entries(v)) root.style.setProperty(k, val);
  root.classList.toggle("menu-light", t.menu === "light");
  root.style.fontSize = t.size === "large" ? "16.5px" : "";
  document.body?.classList.toggle("text-large", t.size === "large");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t.menu === "light" ? "#ffffff" : v["--side"]);
}
