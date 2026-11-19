// Products whose name is in a text ("cotton panjabi er notun collection" -> Cotton Panjabi). Bangla names work too.
// Used by the AI writer (Posts) and when a customer shares one of the shop's posts or reels.
function productsIn(text, products, max = 5) {
  const t = String(text || "").toLowerCase();
  const words = (s) => String(s || "").toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u).filter((w) => w.length >= 3);
  return products.filter((p) => [p.name, p.nameBn].some((name) => {
    if (!name) return false;
    if (t.includes(String(name).toLowerCase())) return true;
    const w = words(name);
    return w.length > 0 && w.filter((x) => t.includes(x)).length / w.length >= 0.6;
  })).slice(0, max);
}

module.exports = { productsIn };
