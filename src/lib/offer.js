// Product offers ("10% off", "৳100 off", until a date). Saved as product.offer = { kind: "percent" | "amount", value, until }. One place for the maths, used by
// stock.priceOf (orders), the AI's product list, comment replies and the Products page (via the API).

// The offer if it is running now, otherwise null
function activeOffer(product, now = new Date()) {
  const o = product && product.offer;
  if (!o || !(Number(o.value) > 0)) return null;
  if (o.until && new Date(o.until) < now) return null;
  return { kind: o.kind === "amount" ? "amount" : "percent", value: Number(o.value), until: o.until || null };
}

// Sale price for one price (whole taka, never below 0)
function applyOffer(price, offer) {
  if (!offer) return price;
  const off = offer.kind === "amount" ? offer.value : (price * offer.value) / 100;
  return Math.max(0, Math.round(price - off));
}

// "10% off" / "৳100 off"
const offerLabel = (offer) => (offer ? (offer.kind === "amount" ? `৳${offer.value} off` : `${offer.value}% off`) : "");

// Form input { kind, value, until } -> what is saved. value 0 / empty = no offer. until "2026-11-25" = the end of that day in Bangladesh.
function cleanOffer(input) {
  if (!input || !(Number(input.value) > 0)) return null;
  const kind = (input.kind || input.type) === "amount" ? "amount" : "percent";
  const value = kind === "percent" ? Math.min(90, Number(input.value)) : Number(input.value);
  const day = String(input.until || "").slice(0, 10);
  const until = /^\d{4}-\d{2}-\d{2}$/.test(day) ? new Date(`${day}T23:59:59+06:00`) : null;
  return { kind, value, until };
}

module.exports = { activeOffer, applyOffer, offerLabel, cleanOffer };
