// AI gateway: any OpenAI-compatible API (Groq, OpenAI, OpenRouter, Ollama ...).
// askAI() always returns parsed JSON, so prompts must ask for JSON.
const { AI } = require("../config");
const { fail } = require("./errors");
const { sleep } = require("./utils");

const aiReady = () => !!AI.API_KEY || /localhost|127\.0\.0\.1/.test(AI.BASE_URL);

function parseJSON(text) {
  const t = String(text || "").replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try { return JSON.parse(t); } catch {}
  const start = t.indexOf("{"), end = t.lastIndexOf("}");
  if (start >= 0 && end > start) { try { return JSON.parse(t.slice(start, end + 1)); } catch {} }
  throw fail(502, "The AI returned an unreadable answer. Please try again.");
}

// images: data: URLs or https links, sent with the user message (needs a model that can see: AI.VISION_MODEL)
// baseUrl / apiKey: another AI service (the photo model can be on Gemini while chats run on Groq)
// audio: { data: base64, format: "mp4" | "mp3" | "ogg" | "wav"… } for models that can listen (Gemini)
// quick: for photos / voice. Gemini "thinks" before answering by default (slow); quick asks it to think little,
// and gives up sooner so the customer is not kept waiting.
async function askAI({ system, user, temperature = 0.5, maxTokens = 1500, images = [], audio = null, model = AI.MODEL, baseUrl = AI.BASE_URL, apiKey = AI.API_KEY, quick = false, timeoutMs = 40000 }) {
  if (!apiKey && !/localhost|127\.0\.0\.1/.test(baseUrl)) throw fail(503, "AI is not set up. Add AI_API_KEY to .env");
  const content = images.length || audio
    ? [{ type: "text", text: user }, ...images.map((url) => ({ type: "image_url", image_url: { url } })), ...(audio ? [{ type: "input_audio", input_audio: audio }] : [])]
    : user;
  const body = {
    model, temperature, max_tokens: maxTokens,
    response_format: { type: "json_object" },
    messages: [{ role: "system", content: system }, { role: "user", content }],
    ...(quick && /generativelanguage\.googleapis\.com/.test(baseUrl) ? { reasoning_effort: "low" } : {}),
  };
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
  const call = () => fetch(`${baseUrl}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
    .catch((e) => { throw fail(502, e.name === "TimeoutError" ? "The AI took too long to answer" : "Could not reach the AI provider"); });

  let res = await call();
  if (res.status === 400) { // some providers don't support response_format (or reasoning_effort): try once without
    delete body.response_format; delete body.reasoning_effort;
    res = await call();
  }
  // Busy (rate limit) or a provider hiccup: wait a little and try again, twice at most
  for (let attempt = 1; attempt <= 2 && (res.status === 429 || res.status >= 500); attempt++) {
    const wait = Math.min(8, Number(res.headers.get("retry-after")) || attempt * 2);
    await sleep(wait * 1000);
    res = await call();
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw fail(502, `AI provider error: ${json.error?.message || res.status}`);
  return parseJSON(json.choices?.[0]?.message?.content);
}

module.exports = { askAI, aiReady };
