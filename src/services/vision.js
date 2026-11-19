// The AI looks at a photo the customer sent (a product photo, a screenshot of a post…) and says what it shows
// and which of the shop's products it looks like. The chat AI then answers as if the customer had typed it.
// Needs AI.VISION_MODEL (on Groq a Llama 4 model is used by default). Without it, photos go to a person.
const { AI } = require("../config");
const { askAI, aiReady } = require("../lib/ai");

const visionReady = () => aiReady() && !!AI.VISION_MODEL;
const MAX_BYTES = 4 * 1024 * 1024; // what the AI providers accept

// Meta's photo links are downloaded and sent as data so the AI provider doesn't have to reach Meta
async function asDataUrl(url) {
  if (String(url).startsWith("data:image/")) return url.length < MAX_BYTES * 1.4 ? url : null;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) }).catch(() => null);
  if (!res || !res.ok) return null;
  const type = res.headers.get("content-type") || "image/jpeg";
  if (!type.startsWith("image/")) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) return null;
  return `data:${type};base64,${buf.toString("base64")}`;
}

// -> { text: "red cotton panjabi with white embroidery", productId: "…" | null } or null when it can't look
async function describePhoto(url, products = []) {
  if (!visionReady()) return null;
  const image = await asDataUrl(url);
  if (!image) return null;
  const list = products.slice(0, 150).map((p) => `${p._id} | ${p.name}${p.info?.length ? " | " + p.info.map((i) => i.value).join(", ").slice(0, 80) : ""}`).join("\n");
  const answer = await askAI({
    model: AI.VISION_MODEL, temperature: 0.1, maxTokens: 300, images: [image],
    system: `A customer of an online shop sent this photo in a chat. Say in one short English line what it shows: the product type, colour, pattern, and any readable text (name, price, size). If it is clearly one of the shop's products below, give its id, otherwise null. Never guess an id.
Return JSON only: {"text":"","productId":null}`,
    user: `SHOP PRODUCTS (id | name | details):\n${list || "(none)"}`,
  });
  const productId = products.some((p) => p._id === answer.productId) ? answer.productId : null;
  return { text: String(answer.text || "").slice(0, 300), productId };
}

module.exports = { describePhoto, visionReady };
