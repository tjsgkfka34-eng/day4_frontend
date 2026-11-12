// Gemini REST 호출 공통 함수 (API 키는 Vercel 환경변수에서만 읽는다)
async function gemini(body) {
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data.error && data.error.message) || "Gemini HTTP " + r.status);
  return data;
}
module.exports = { gemini };
