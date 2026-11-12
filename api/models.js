// 진단용: 이 키로 쓸 수 있는 flash 계열 모델을 짧게 시험해서 상태·응답시간을 보여준다.
// 브라우저에서 /api/models 로 열어 보면 된다. 원인 파악이 끝나면 이 파일을 지워도 된다.
module.exports = async (req, res) => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: "GEMINI_API_KEY 환경변수가 없습니다." });
  try {
    const l = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=100", { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(8000) });
    const d = await l.json();
    if (!l.ok) return res.status(502).json({ error: d.error && d.error.message });
    const names = (d.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map(m => m.name.replace(/^models\//, ""))
      .filter(n => /^gemini-[\d.]+-flash(-lite)?$/.test(n))
      .sort().reverse().slice(0, 8);
    const results = await Promise.all(names.map(async n => {
      const t = Date.now();
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${n}:generateContent`, {
          method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "안녕이라고만 답해" }] }] }),
          signal: AbortSignal.timeout(12000) });
        const j = await r.json().catch(() => ({}));
        return { model: n, ok: r.ok, status: r.status, ms: Date.now() - t, note: r.ok ? undefined : ((j.error && j.error.message) || "").slice(0, 120) };
      } catch (e) { return { model: n, ok: false, status: 0, ms: Date.now() - t, note: e.name === "TimeoutError" ? "12초 안에 응답 없음" : String(e.message) }; }
    }));
    res.json({ configured_model: process.env.GEMINI_MODEL || "(미설정: 기본 gemini-3.1-flash-lite)", results });
  } catch (e) { res.status(502).json({ error: String(e.message || e) }); }
};
