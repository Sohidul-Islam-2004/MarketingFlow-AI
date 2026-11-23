// Many options made of choices ("কালো / 50", "কালো / 50 + ম্যাচিং হিজাব সহ"…) said in one short line, so the
// AI's product list stays small: "কালো, বেইজ × 50, 52, 54, 56, 58; + ম্যাচিং হিজাব সহ ৳1,349".
// list = [{ name, price }]. Returns null when the names are not such a grid.
const taka = (n) => `৳${Number(n || 0).toLocaleString("en-IN")}`;

function optionGrid(list) {
  if (!list || list.length < 4) return null;
  const parsed = list.map((o) => {
    const [base, ...add] = String(o.name).split(" + ");
    return { parts: base.split(" / ").map((s) => s.trim()), addon: add.join(" + ").trim(), price: o.price };
  });
  const width = parsed[0].parts.length;
  if (!parsed.every((p) => p.parts.length === width)) return null;
  const groups = Array.from({ length: width }, (_, i) => [...new Set(parsed.map((p) => p.parts[i]))]);
  const addons = [...new Set(parsed.map((p) => p.addon).filter(Boolean))];
  const plain = parsed.some((p) => !p.addon) ? 1 : 0;
  if (groups.reduce((n, g) => n * g.length, 1) * (addons.length + plain) !== parsed.length) return null;
  return { groups, addons, parsed };
}

function optionLine(list) {
  const g = optionGrid(list);
  if (!g) return null;
  const choose = g.groups.filter((v) => !(v.length === 1 && /^শুধু|^only/i.test(v[0]))).map((v) => v.join(", ")).join(" × ");
  const adds = g.addons.map((a) => {
    const prices = [...new Set(g.parsed.filter((p) => p.addon === a).map((p) => p.price))];
    return `+ ${a} ${prices.length === 1 ? taka(prices[0]) : `${taka(Math.min(...prices))}–${taka(Math.max(...prices))}`}`;
  });
  return [choose, ...adds].filter(Boolean).join("; ");
}

module.exports = { optionGrid, optionLine };
