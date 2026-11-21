// The AI looks at a photo the customer sent (a product photo, a screenshot of a post…) and says what it shows
// and which of the shop's products it is. It compares the photo with the shop's own product photos (up to 6)
// and with the product names. The chat AI then answers as if the customer had typed it.
// Needs a model that can see: AI_VISION_MODEL (+ AI_VISION_BASE_URL / AI_VISION_API_KEY for another service, e.g. Gemini).
const { AI } = require("../config");
const { askAI } = require("../lib/ai");
const { Photo } = require("../models");

const visionReady = () => !!(AI.VISION_MODEL && (AI.VISION_API_KEY || /localhost|127\.0\.0\.1/.test(AI.VISION_BASE_URL)));
const MAX_BYTES = 4 * 1024 * 1024; // what the AI providers accept
const COMPARE = 4; // product photos sent with the customer's photo (more = slower)

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

// -> { text: "black abaya with grey trim", writing: "name, address… written in the photo", productId: "…" | null }
// Throws with the reason when the photo can't be looked at (shown in the chat for the shop).
async function describePhoto(url, products = []) {
  if (!visionReady()) throw new Error("photo AI is not set up (AI_VISION_* in Render)");
  const image = await asDataUrl(url);
  if (!image) throw new Error("could not download the photo");
  // the shop's own product photos to compare with
  const withPhoto = [];
  for (const p of products.filter((x) => x.imageUrl)) {
    if (withPhoto.length >= COMPARE) break;
    const data = await asDataUrl(p.imageUrl);
    if (data) withPhoto.push({ p, data });
  }
  const list = products.slice(0, 150).map((p) => `${p._id} | ${p.name}${p.info?.length ? " | " + p.info.map((i) => i.value).join(", ").slice(0, 80) : ""}`).join("\n");
  const compare = withPhoto.length ? `\n\nIMAGE 1 is the customer's photo. The next images are the shop's own product photos, in this order:\n${withPhoto.map((x, i) => `IMAGE ${i + 2} = ${x.p._id} | ${x.p.name}`).join("\n")}` : "";
  const ask = (extra) => askAI({
    model: AI.VISION_MODEL, baseUrl: AI.VISION_BASE_URL, apiKey: AI.VISION_API_KEY,
    temperature: 0.1, maxTokens: 500, images: [image, ...extra.map((x) => x.data)], quick: true, timeoutMs: extra.length ? 25000 : 20000,
    system: `A customer of a Bangladeshi online shop sent a photo in a chat.
"text": one short English line on what it shows: product type, colour, pattern, or what kind of picture it is (a screenshot of a post, a payment receipt, a note…).
"writing": copy any written words in the photo exactly, in their own language and script (names, phone numbers, addresses, prices, sizes, transaction ids). Empty if there are none.
"productId": if it is clearly one of the shop's products (the same item as a shop photo, or the name/details match), its id, otherwise null. Never guess an id.
Return JSON only: {"text":"","writing":"","productId":null}`,
    user: `SHOP PRODUCTS (id | name | details):\n${list || "(none)"}${extra.length ? compare : ""}`,
  });
  // many photos in one request can hit the free plan's limits: then look at the customer's photo alone
  // (not after "limit reached": that would only use up more of the day's quota)
  const answer = await ask(withPhoto).catch((e) => (withPhoto.length && !e.limit ? ask([]) : Promise.reject(e)));
  const productId = products.some((p) => p._id === answer.productId) ? answer.productId : null;
  return { text: String(answer.text || "").slice(0, 300), writing: String(answer.writing || "").trim().slice(0, 600), productId };
}

module.exports = { describePhoto, visionReady };
