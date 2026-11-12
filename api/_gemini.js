// Gemini REST 호출 공통 함수 (API 키는 Vercel 환경변수에서만 읽는다)
// 수요 폭주(429/500/503)일 때는 재시도하고, 그래도 안 되면 다른 flash 모델로 자동 전환한다.
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

// 기본 모델이 계속 붐빌 때 쓸 대체 모델을 ListModels로 찾는다(이름을 코드에 박아 두지 않기 위해).
let discovered = null;
async function discoverFallbacks(exclude) {
  if (discovered) return discovered.filter(m => m !== exclude);
  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=100", {
      headers: { "x-goog-api-key": process.env.GEMINI_API_KEY }, signal: AbortSignal.timeout(5000) });
    const d = await r.json();
    discovered = (d.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map(m => m.name.replace(/^models\//, ""))
      .filter(n => /flash/.test(n) && !/image|tts|audio|live|embed|thinking|exp|preview-\d|robotics|computer/.test(n))
      .sort().reverse();
  } catch { discovered = []; }
  return discovered.filter(m => m !== exclude);
}

async function tryModel(model, body, attempts) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { return await callModel(model, body); }
    catch (e) {
      last = e;
      if (e.name === "TimeoutError") e.status = 503;
      if (!RETRYABLE.has(e.status) && e.status !== 404) throw e;   // 키 오류·잘못된 요청은 재시도 무의미
      if (e.status === 404) break;                                  // 없는 모델은 바로 포기
      if (i < attempts - 1) await sleep(800 * 2 ** i);
    }
  }
  throw last;
}

async function gemini(body) {
  const primary = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  let last;
  try { return await tryModel(primary, body, 2); } catch (e) { last = e; if (!RETRYABLE.has(e.status) && e.status !== 404) throw e; }
  const fallbacks = [];
  if (process.env.GEMINI_FALLBACK_MODEL) fallbacks.push(process.env.GEMINI_FALLBACK_MODEL);
  fallbacks.push(...(await discoverFallbacks(primary)));
  for (const m of [...new Set(fallbacks)].slice(0, 2)) {
    try { return await tryModel(m, body, 1); } catch (e) { last = e; if (!RETRYABLE.has(e.status) && e.status !== 404) throw e; }
  }
  throw new Error("지금 AI 모델에 요청이 몰려 응답하지 못했습니다. 잠시 후 다시 시도해 주세요. (" + (last && last.message) + ")");
}
module.exports = { gemini };
