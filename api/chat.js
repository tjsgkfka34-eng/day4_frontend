// Vercel 서버리스 함수: Gemini 함수 호출(tool calling) 에이전트.
// 환경변수: GEMINI_API_KEY (필수), GEMINI_MODEL (선택, 기본 gemini-2.5-flash)
const { impl, declarations } = require("./_tools");
const { gemini } = require("./_gemini");

const SYSTEM = `너는 한국 여행·나들이 추천 에이전트다. 항상 한국어로 간결하게 답한다.
도구 두 개를 상황에 맞게 직접 골라 호출한다:
- get_weather: 지역의 실시간 날씨·미세먼지·예보
- find_spots: 지역 주변 장소 검색(카페, 식당, 관광지, 박물관, 공원, 해변)
규칙:
1) 장소를 추천할 때는 먼저 get_weather로 날씨를 확인하고, 비·눈·미세먼지 나쁨이면 실내(박물관, 카페, 식당) 위주로, 맑으면 야외(공원, 해변, 관광지) 위주로 find_spots를 호출한다.
2) 날씨만 묻는 질문에는 get_weather만 호출한다. 일반 대화는 도구 없이 답한다.
3) 추천 장소는 반드시 find_spots 결과에 있는 것만 말한다. 지어내지 않는다. 결과가 없으면 반경이나 카테고리를 바꿔 다시 검색한다.
4) 미세먼지 기준(㎍/㎥): PM10 30↓좋음/80↓보통/150↓나쁨, PM2.5 15↓좋음/35↓보통/75↓나쁨. 대기질 값은 모델 추정이라는 점을 필요하면 언급한다.
5) 답변은 날씨 요약 한두 줄 + 추천 목록(이름, 이유, 거리) 순서로 쓴다.`;

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: "서버에 GEMINI_API_KEY 환경변수가 설정되지 않았습니다." });

  const hist = Array.isArray(req.body && req.body.messages) ? req.body.messages.slice(-12) : [];
  const contents = hist
    .filter(m => m && (m.role === "user" || m.role === "model") && typeof m.text === "string" && m.text.trim())
    .map(m => ({ role: m.role, parts: [{ text: m.text.slice(0, 1000) }] }));
  if (!contents.length || contents[contents.length - 1].role !== "user")
    return res.status(400).json({ error: "마지막 메시지는 user여야 합니다." });

  const trace = [], spots = [];
  try {
    for (let step = 0; step < 5; step++) {
      const data = await gemini({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents,
        tools: [{ functionDeclarations: declarations }],
        toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      });
      const cand = data.candidates && data.candidates[0];
      const content = cand && cand.content;
      const parts = (content && content.parts) || [];
      const calls = parts.filter(p => p.functionCall);

      if (!calls.length) {
        const reply = parts.map(p => p.text || "").join("").trim();
        return res.json({ reply: reply || "답변을 생성하지 못했습니다. 다시 질문해 주세요.", trace, spots });
      }

      contents.push({ role: "model", parts });          // 모델의 도구 호출을 그대로 기록
      const results = await Promise.all(calls.map(async ({ functionCall: fc }) => {
        let out;
        try {
          if (!impl[fc.name]) throw new Error("알 수 없는 도구: " + fc.name);
          out = await impl[fc.name](fc.args || {});
        } catch (e) { out = { error: String(e.message || e) }; }
        trace.push({ name: fc.name, args: fc.args || {}, ok: !out.error });
        if (fc.name === "find_spots" && out.spots) spots.push(...out.spots.map(s => ({ ...s, category: out.category })));
        return { functionResponse: { name: fc.name, response: out } };
      }));
      contents.push({ role: "user", parts: results });   // 도구 결과를 모델에게 돌려줌
    }
    return res.json({ reply: "도구 호출이 너무 많아 중단했습니다. 질문을 조금 더 구체적으로 해주세요.", trace, spots });
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e), trace });
  }
};
