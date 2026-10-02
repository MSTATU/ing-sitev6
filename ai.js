// Netlify Function: Google Gemini (native generateContent endpoint) proxy.
// Auth: x-goog-api-key header (works for both AIza... and AQ.... keys). No OpenAI-compatible path is used.
const MODELS = {
  fast: process.env.MODEL_FAST || "gemini-3.8-flash",   // vocabulary, grammar, exercises
  smart: process.env.MODEL_SMART || "gemini-3.8-flash", // speaking/writing evaluation, OCR
};
const LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 8);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 9000); // Netlify's default function limit is ~10 s
const hits = new Map(); // best-effort limiter (resets when the function instance recycles)

// Env vars are often pasted with spaces, newlines or quotes; clean them.
const cleanKey = () => (process.env.GEMINI_API_KEY || "").trim().replace(/^["']+|["']+$/g, "").trim();

async function gemini(key, model, parts, generationConfig, signal) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig }),
    signal,
  });
  const d = await r.json().catch(() => ({}));
  return { r, d };
}
const errText = (d) => (d && d.error ? [d.error.status, d.error.message].filter(Boolean).join(": ") : "");

exports.handler = async (event) => {
  const headers = { "Content-Type": "application/json" };
  const out = (statusCode, body) => ({ statusCode, headers, body: JSON.stringify(body) });
  const key = cleanKey();

  const ip = String(event.headers["x-nf-client-connection-ip"] || event.headers["x-forwarded-for"] || "?").split(",")[0].trim();
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);

  // GET = health check. GET ?test=1 = real test call to Gemini (shows Google's actual answer, never the key).
  if (event.httpMethod === "GET") {
    const info = { ok: true, keySet: !!key, keyStartsWith: key ? key.slice(0, 3) : null, keyLength: key.length, models: MODELS };
    if (!(event.queryStringParameters || {}).test) return out(200, info);
    if (!key) return out(200, { ...info, test: "GEMINI_API_KEY yok" });
    if (arr.length >= LIMIT_PER_MIN) return out(429, { error: "Çok fazla istek, biraz bekle." });
    arr.push(now); hits.set(ip, arr);
    try {
      const { r, d } = await gemini(key, MODELS.fast, [{ text: "Reply with the single word: OK" }], { maxOutputTokens: 50 });
      const text = ((((d.candidates || [])[0] || {}).content || {}).parts || []).map((p) => p.text || "").join("");
      return out(200, { ...info, googleStatus: r.status, googleError: errText(d) || null, reply: text || null });
    } catch (e) {
      return out(200, { ...info, test: "bağlantı hatası: " + e.message });
    }
  }

  if (event.httpMethod !== "POST") return out(405, { error: "POST only" });

  const allow = process.env.ALLOWED_ORIGIN; // e.g. https://my-site.netlify.app (optional)
  const origin = event.headers.origin || "";
  if (allow && origin && origin !== allow) return out(403, { error: "forbidden" });

  if (arr.length >= LIMIT_PER_MIN) return out(429, { error: "Çok fazla istek, biraz bekle." });
  arr.push(now); hits.set(ip, arr);

  if (!key) return out(500, { error: "server not configured" });

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { return out(400, { error: "bad json" }); }
  const { prompt, tier, image, json } = body;
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 8000) return out(400, { error: "bad prompt" });

  const parts = [{ text: prompt }];
  if (image) {
    const okType = ["image/jpeg", "image/png", "image/webp"].includes(image.type);
    if (!okType || typeof image.data !== "string" || image.data.length > 4_000_000) return out(400, { error: "bad image" });
    parts.unshift({ inlineData: { mimeType: image.type, data: image.data } });
  }

  const generationConfig = { maxOutputTokens: 8192, temperature: 0.7 };
  if (json) generationConfig.responseMimeType = "application/json";
  if (process.env.THINKING_BUDGET !== undefined && process.env.THINKING_BUDGET !== "")
    generationConfig.thinkingConfig = { thinkingBudget: Number(process.env.THINKING_BUDGET) };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const { r, d } = await gemini(key, MODELS[tier] || MODELS.fast, parts, generationConfig, ctl.signal);
    if (r.status === 429) return out(429, { error: "Ücretsiz kota doldu, biraz sonra tekrar dene." });
    if (r.status === 503) return out(503, { error: "Google sunucuları şu an yoğun, birkaç saniye sonra tekrar dene." });
    if (r.status === 401 || r.status === 403) return out(401, { error: "Anahtar reddedildi (" + (errText(d) || r.status) + ")" });
    if (!r.ok) return out(502, { error: errText(d) || "upstream error" });
    if (d.promptFeedback && d.promptFeedback.blockReason) return out(422, { error: "İçerik reddedildi." });
    const cand = (d.candidates || [])[0];
    const text = ((cand && cand.content && cand.content.parts) || []).map((p) => p.text || "").join("");
    if (!text) return out(502, { error: "empty response" });
    return out(200, { text });
  } catch (e) {
    return out(504, { error: "timeout" });
  } finally {
    clearTimeout(timer);
  }
};
