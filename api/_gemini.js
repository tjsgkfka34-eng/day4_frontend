// Gemini REST 호출 공통 함수 (API 키는 Vercel 환경변수에서만 읽는다)
// 수요 폭주(429/500/503)일 때는 잠깐 쉬었다가 재시도하고, 그래도 안 되면
// GEMINI_FALLBACK_MODEL(선택)로 한 번 더 시도한다.
const sleep = ms => new Promise(r => setTimeout(r, ms));
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

async function callModel(model, body) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(22000),            // 한 번의 호출이 멈춰도 전체가 타임아웃되지 않게
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error((data.error && data.error.message) || "Gemini HTTP " + r.status);
    e.status = r.status;
    throw e;
  }
  return data;
}

async function gemini(body) {
  const models = [process.env.GEMINI_MODEL || "gemini-3.8-flash"];
  if (process.env.GEMINI_FALLBACK_MODEL) models.push(process.env.GEMINI_FALLBACK_MODEL);
  let last;
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await callModel(model, body); }
      catch (e) {
        last = e;
        if (e.name === "TimeoutError") e.status = 503;
        if (!RETRYABLE.has(e.status)) throw e;          // 키 오류·잘못된 요청은 재시도해도 소용없음
        await sleep(800 * 2 ** attempt);                // 0.8s → 1.6s
      }
    }
  }
  throw new Error("지금 AI 모델에 요청이 몰려 응답하지 못했습니다. 잠시 후 다시 시도해 주세요. (" + (last && last.message) + ")");
}
module.exports = { gemini };
