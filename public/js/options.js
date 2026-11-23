// Many options built from choices ("কালো / 50", "কালো / 50 + ম্যাচিং হিজাব সহ"…) shown short and readable:
//   কালো · বেইজ
//   50 · 52 · 54 · 56 · 58
//   + ম্যাচিং হিজাব সহ ৳1,349
//   500 pcs each
// list = [{ name, price, stock }] (stock: a number, or null = not counted). Returns null when the names are not
// such a grid (then show them one by one).
import { esc } from "./ui.js";

const taka = (n) => `৳${Number(n || 0).toLocaleString("en-IN")}`;
const range = (nums) => { const a = [...new Set(nums.filter((x) => x != null))].sort((x, y) => x - y); return !a.length ? "" : a.length === 1 ? taka(a[0]) : `${taka(a[0])}–${taka(a.at(-1))}`; };

export function optionGrid(list) {
  if (!list || list.length < 4) return null;
  const parsed = list.map((o) => {
    const [base, ...add] = String(o.name).split(" + ");
    return { parts: base.split(" / ").map((s) => s.trim()), addon: add.join(" + ").trim(), price: o.price, stock: o.stock };
  });
  const width = parsed[0].parts.length;
  if (!parsed.every((p) => p.parts.length === width)) return null;
  const groups = Array.from({ length: width }, (_, i) => [...new Set(parsed.map((p) => p.parts[i]))]);
  const addons = [...new Set(parsed.map((p) => p.addon).filter(Boolean))];
  const plain = parsed.filter((p) => !p.addon);
  const cells = groups.reduce((n, g) => n * g.length, 1);
  if (cells * (addons.length + (plain.length ? 1 : 0)) !== parsed.length) return null; // not a full grid
  return { groups, addons, parsed, plain };
}

// HTML lines; stockLabel(stock) lets each page word the stock its own way
export function optionSummary(list) {
  const g = optionGrid(list);
  if (!g) return null;
  const lines = g.groups.filter((vals) => !(vals.length === 1 && /^শুধু|^only/i.test(vals[0]))).map((vals) => `<div class="og-line">${vals.map(esc).join(" · ")}</div>`);
  for (const a of g.addons) lines.push(`<div class="og-line og-add">+ ${esc(a)} <b>${range(g.parsed.filter((p) => p.addon === a).map((p) => p.price))}</b></div>`);
  const stocks = [...new Set(g.parsed.map((p) => p.stock))];
  const out = g.parsed.filter((p) => p.stock === 0).length;
  const stock = stocks.length === 1
    ? stocks[0] === null ? "always available" : `${stocks[0]} pcs each`
    : `${Math.min(...stocks.filter((s) => s != null))}–${Math.max(...stocks.filter((s) => s != null))} pcs`;
  lines.push(`<div class="og-line small muted">${list.length} options · ${stock}${out && stocks.length > 1 ? ` · <span class="og-out">${out} sold out</span>` : ""}</div>`);
  return `<div class="og">${lines.join("")}</div>`;
}

// Every option has the same stock (a website that counts stock per product): that number, else null
export function sameStock(list) {
  const g = optionGrid(list);
  if (!g) return null;
  const s = [...new Set(g.parsed.map((p) => p.stock))];
  return s.length === 1 && s[0] != null ? s[0] : null;
}

// One short line for a phone list: "কালো, বেইজ · 5 sizes · + ম্যাচিং হিজাব সহ · 500 each"
export function optionShort(list) {
  const g = optionGrid(list);
  if (!g) return null;
  const parts = g.groups.filter((v) => !(v.length === 1 && /^শুধু|^only/i.test(v[0]))).map((v) => (v.length <= 3 ? v.join(", ") : `${v.length} sizes`));
  const stocks = [...new Set(g.parsed.map((p) => p.stock))];
  return [...parts, ...g.addons.map((a) => `+ ${a}`), stocks.length === 1 ? (stocks[0] === null ? "always available" : `${stocks[0]} each`) : `${list.length} options`].map(esc).join(" · ");
}
