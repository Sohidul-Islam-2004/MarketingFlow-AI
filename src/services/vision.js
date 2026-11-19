// The AI looks at a photo the customer sent (a product photo, a screenshot of a post…) and says what it shows
// and which of the shop's products it is. It compares the photo with the shop's own product photos (up to 6)
// and with the product names. The chat AI then answers as if the customer had typed it.
// Needs a model that can see: AI_VISION_MODEL (+ AI_VISION_BASE_URL / AI_VISION_API_KEY for another service, e.g. Gemini).
const { AI } = require("../config");
const { askAI } = require("../lib/ai");
const { Photo } = require("../models");

const visionReady = () => !!(AI.VISION_MODEL && (AI.VISION_API_KEY || /localhost|127\.0\.0\.1/.test(AI.VISION_BASE_URL)));
const MAX_BYTES = 4 * 1024 * 1024; // what the AI providers accept
const COMPARE = 6; // product photos sent with the customer's photo

// Meta's photo links (and the shop's product photos) are sent as data, so the AI service doesn't have to download them
async function asDataUrl(url) {
  if (String(url).startsWith("data:image/")) return url.length < MAX_BYTES * 1.4 ? url : null;
  if (String(url).startsWith("/photos/")) {
    const p = await Photo.findById(url.split("/").pop()).lean().catch(() => null);
    return p ? `data:${p.mimeType};base64,${p.data}` : null;
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) }).catch(() => null);
  if (!res || !res.ok) return null;
  const type = res.headers.get("content-type") || "image/jpeg";
  if (!type.startsWith("image/")) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) return null;
  return `data:${type};base64,${buf.toString("base64")}`;
}

// -> { text: "beige panjabi with embroidered collar", productId: "…" | null } or null when it can't look
async function describePhoto(url, products = []) {
  if (!visionReady()) return null;
  const image = await asDataUrl(url);
  if (!image) return null;
  // the shop's own product photos to compare with
  const withPhoto = [];
  for (const p of products.filter((x) => x.imageUrl)) {
    if (withPhoto.length >= COMPARE) break;
    const data = await asDataUrl(p.imageUrl);
    if (data) withPhoto.push({ p, data });
  }
  const list = products.slice(0, 150).map((p) => `${p._id} | ${p.name}${p.info?.length ? " | " + p.info.map((i) => i.value).join(", ").slice(0, 80) : ""}`).join("\n");
  const compare = withPhoto.length ? `\n\nIMAGE 1 is the customer's photo. The next images are the shop's own product photos, in this order:\n${withPhoto.map((x, i) => `IMAGE ${i + 2} = ${x.p._id} | ${x.p.name}`).join("\n")}` : "";
  const answer = await askAI({
    model: AI.VISION_MODEL, baseUrl: AI.VISION_BASE_URL, apiKey: AI.VISION_API_KEY,
    temperature: 0.1, maxTokens: 300, images: [image, ...withPhoto.map((x) => x.data)],
    system: `A customer of an online shop sent a photo in a chat. Say in one short English line what it shows: the product type, colour, pattern, and any readable text (name, price, size). If it is clearly one of the shop's products (same item in a shop photo, or the name/details match), give its id, otherwise null. Never guess an id.
Return JSON only: {"text":"","productId":null}`,
    user: `SHOP PRODUCTS (id | name | details):\n${list || "(none)"}${compare}`,
  });
  const productId = products.some((p) => p._id === answer.productId) ? answer.productId : null;
  return { text: String(answer.text || "").slice(0, 300), productId };
}

module.exports = { describePhoto, visionReady };
