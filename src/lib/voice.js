// Voice messages -> text, so the AI can answer them like typed messages.
//   1. Gemini (when the photo model is set up on Gemini: AI_VISION_*) listens best to Bangla, so it goes first.
//   2. Otherwise / if that fails: the speech model of the main AI service (Groq whisper-large-v3),
//      helped with the shop's product names and common shop words so it spells them right.
const { AI } = require("../config");
const { askAI } = require("./ai");

const MAX_BYTES = 20 * 1024 * 1024;
// AI_VOICE_WITH=vision: use the photo model for voice too (any model that can listen, not only Gemini)
const geminiReady = () => (/generativelanguage\.googleapis\.com/.test(AI.VISION_BASE_URL) || process.env.AI_VOICE_WITH === "vision") && !!(AI.VISION_MODEL && AI.VISION_API_KEY);
const whisperReady = () => !!(AI.API_KEY && AI.VOICE_MODEL);
const voiceReady = () => geminiReady() || whisperReady();
const SHOP_WORDS = "অর্ডার, দাম কত, ডেলিভারি চার্জ, সাইজ, কালার, স্টক আছে, ক্যাশ অন ডেলিভারি, বিকাশ, ঢাকা, ঠিকানা";

async function download(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Could not download the voice message (${r.status})`);
  const bytes = Buffer.from(await r.arrayBuffer());
  return { bytes, type: (r.headers.get("content-type") || "audio/mp4").split(";")[0] };
}

async function withGemini({ bytes, type }, productNames) {
  const format = ({ "audio/mpeg": "mp3", "audio/x-wav": "wav", "audio/wave": "wav" })[type] || type.split("/")[1] || "mp4";
  const out = await askAI({
    model: AI.VISION_MODEL, baseUrl: AI.VISION_BASE_URL, apiKey: AI.VISION_API_KEY, temperature: 0, maxTokens: 600,
    audio: { data: bytes.toString("base64"), format },
    system: `You write down voice messages that customers send to a Bangladeshi online shop. Write exactly what is said, in the language spoken: Bangla in Bangla script, English words in English. Do not answer, explain or translate. If no words can be heard, return an empty text.
Product names of this shop (spell them like this): ${productNames || "-"}
Return JSON only: {"text":""}`,
    user: "Write down this voice message.",
  });
  return String(out.text || "").trim();
}

async function withWhisper({ bytes, type }, productNames) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type }), `voice.${type.includes("ogg") ? "ogg" : type.includes("mpeg") ? "mp3" : "mp4"}`);
  form.append("model", AI.VOICE_MODEL);
  if (AI.VOICE_LANGUAGE) form.append("language", AI.VOICE_LANGUAGE);
  form.append("temperature", "0");
  form.append("prompt", `${SHOP_WORDS}${productNames ? `, ${productNames}` : ""}`.slice(0, 600)); // words it should expect
  form.append("response_format", "json");
  const r = await fetch(`${AI.BASE_URL}/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${AI.API_KEY}` }, body: form, signal: AbortSignal.timeout(60000) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error?.message || `Speech to text failed (${r.status})`);
  return String(data.text || "").trim();
}

// url = the voice file from Facebook / Instagram; productNames = "Cotton Panjabi, Redmi 13…". Returns the words, or null.
async function transcribe(url, productNames = "") {
  if (!voiceReady() || !url) return null;
  const audio = await download(url);
  if (!audio.bytes.length || audio.bytes.length > MAX_BYTES) return null;
  let text = "";
  if (geminiReady()) text = await withGemini(audio, productNames).catch((e) => { console.warn("voice (Gemini):", e.message); return ""; });
  if (!text && whisperReady()) text = await withWhisper(audio, productNames);
  return text.length > 1 ? text.slice(0, 1500) : null;
}

module.exports = { transcribe, voiceReady };
