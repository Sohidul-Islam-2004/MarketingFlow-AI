// Voice messages -> text, so the AI can answer them like typed messages.
// Uses the same AI service (AI_BASE_URL / AI_API_KEY) with a speech model (AI_VOICE_MODEL, default whisper-large-v3 on Groq).
const { AI } = require("../config");

const MAX_BYTES = 25 * 1024 * 1024; // the speech API's limit
const voiceReady = () => !!(AI.API_KEY && AI.VOICE_MODEL);

// url = the voice file Facebook / Instagram gives in the message. Returns the words, or null.
async function transcribe(url) {
  if (!voiceReady() || !url) return null;
  const audio = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!audio.ok) throw new Error(`Could not download the voice message (${audio.status})`);
  const bytes = Buffer.from(await audio.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_BYTES) return null;
  const type = audio.headers.get("content-type") || "audio/mp4";
  const form = new FormData();
  form.append("file", new Blob([bytes], { type }), `voice.${type.includes("ogg") ? "ogg" : type.includes("mpeg") ? "mp3" : "mp4"}`);
  form.append("model", AI.VOICE_MODEL);
  if (AI.VOICE_LANGUAGE) form.append("language", AI.VOICE_LANGUAGE);
  form.append("response_format", "json");
  const r = await fetch(`${AI.BASE_URL}/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${AI.API_KEY}` }, body: form, signal: AbortSignal.timeout(60000) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error?.message || `Speech to text failed (${r.status})`);
  const text = String(data.text || "").trim();
  return text.length > 1 ? text.slice(0, 1500) : null;
}

module.exports = { transcribe, voiceReady };
