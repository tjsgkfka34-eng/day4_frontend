// 에이전트가 호출하는 두 개의 도구: get_weather, find_spots
// get_weather는 Open-Meteo(키 불필요), find_spots는 카카오 로컬 API 또는 Gemini 검색을 사용합니다.
const { gemini } = require("./_gemini");

async function jget(url, opts = {}, timeout = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(url, { ...opts, signal: ac.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

const WMO = {0:"맑음",1:"대체로 맑음",2:"구름 조금",3:"흐림",45:"안개",48:"서리 안개",51:"약한 이슬비",53:"이슬비",55:"강한 이슬비",
  56:"어는 이슬비",57:"어는 이슬비",61:"약한 비",63:"비",65:"강한 비",66:"어는 비",67:"어는 비",71:"약한 눈",73:"눈",75:"강한 눈",77:"싸락눈",
  80:"약한 소나기",81:"소나기",82:"강한 소나기",85:"약한 눈보라",86:"강한 눈보라",95:"뇌우",96:"우박 동반 뇌우",99:"우박 동반 뇌우"};
const wmo = c => WMO[c] || "알 수 없음";

// 한글 → 로마자 (국어의 로마자 표기법, 단순형). Open-Meteo 지오코딩은 한글 검색이 약해서 영어로 재시도한다.
const L_INI = ["g","kk","n","d","tt","r","m","b","pp","s","ss","","j","jj","ch","k","t","p","h"];
const L_VOW = ["a","ae","ya","yae","eo","e","yeo","ye","o","wa","wae","oe","yo","u","wo","we","wi","yu","eu","ui","i"];
const L_FIN = ["","k","k","k","n","n","n","t","l","k","m","p","l","l","p","l","m","p","p","t","t","ng","t","t","k","t","p","t"];
const romanize = t => [...t].map(ch => {
  const c = ch.charCodeAt(0) - 0xAC00;
  return c < 0 || c > 11171 ? ch : L_INI[Math.floor(c / 588)] + L_VOW[Math.floor(c % 588 / 28)] + L_FIN[c % 28];
}).join("");

async function geoOne(name) {
  const d = await jget(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=5&language=ko`);
  const rs = d.results || [];
  return rs.find(p => p.country_code === "KR") || rs[0] || null;
}

async function geocode(name) {
  name = String(name).trim();
  const tries = [name];
  if (/[가-힣]/.test(name)) {
    const stripped = name.replace(/(특별자치도|특별자치시|광역시|특별시|시|군|구|도)$/, "");
    tries.push(romanize(stripped), romanize(name));
  }
  for (const t of [...new Set(tries)].filter(Boolean)) {
    const p = await geoOne(t);
    if (p) return { name: [p.name, p.admin1].filter(Boolean).join(", "), lat: p.latitude, lon: p.longitude };
  }
  return null;
}

// ───────── 도구 1: 실시간 날씨
async function get_weather({ location } = {}) {
  if (!location) return { error: "location(지명)이 필요합니다." };
  const g = await geocode(location);
  if (!g) return { error: `'${location}' 지역을 찾지 못했습니다. 영어 지명이나 더 큰 지역명으로 다시 시도하세요.` };
  const q = new URLSearchParams({
    latitude: g.lat, longitude: g.lon, timezone: "auto", forecast_days: 3,
    current: "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
  });
  const w = await jget("https://api.open-meteo.com/v1/forecast?" + q);
  let air = null;
  try {
    const a = await jget(`https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${g.lat}&longitude=${g.lon}&current=pm10,pm2_5`);
    air = { pm10: a.current.pm10, pm25: a.current.pm2_5 };
  } catch {}
  const c = w.current;
  return {
    place: g.name, lat: g.lat, lon: g.lon,
    now: { temp_c: c.temperature_2m, feels_like_c: c.apparent_temperature, humidity: c.relative_humidity_2m,
      precipitation_mm: c.precipitation, wind_kmh: c.wind_speed_10m, condition: wmo(c.weather_code) },
    air_quality_ug_m3: air,
    forecast: w.daily.time.map((t, i) => ({
      date: t, condition: wmo(w.daily.weather_code[i]),
      min_c: w.daily.temperature_2m_min[i], max_c: w.daily.temperature_2m_max[i],
      rain_probability: w.daily.precipitation_probability_max[i],
    })),
  };
}

// ───────── 도구 2: 장소 검색
// KAKAO_REST_API_KEY 가 있으면 카카오 로컬 API(좌표 포함, 정확),
// 없으면 Gemini 의 Google 검색 그라운딩으로 검색한다(키 추가 불필요, 좌표 없음).
const CATEGORY = {
  cafe:       { label: "카페",            query: "카페",           code: "CE7" },
  restaurant: { label: "맛집 식당",        query: "맛집",           code: "FD6" },
  attraction: { label: "관광 명소",        query: "관광명소",       code: "AT4" },
  museum:     { label: "박물관 미술관(실내)", query: "박물관 미술관",  code: "CT1" },
  park:       { label: "공원 산책로",      query: "공원" },
  beach:      { label: "해수욕장 해변",    query: "해수욕장" },
};

async function spotsKakao(g, cat, rad, n) {
  const q = new URLSearchParams({ query: `${g.keyword} ${cat.query}`, x: g.lon, y: g.lat, radius: rad, size: Math.min(n * 2, 15) });
  if (cat.code) q.set("category_group_code", cat.code);
  const d = await jget("https://dapi.kakao.com/v2/local/search/keyword.json?" + q,
    { headers: { Authorization: "KakaoAK " + process.env.KAKAO_REST_API_KEY } });
  return (d.documents || []).slice(0, n).map(p => ({
    name: p.place_name, lat: Number(p.y), lon: Number(p.x), distance_m: Number(p.distance) || undefined,
    info: [p.category_name, p.road_address_name || p.address_name].filter(Boolean).join(" · "), url: p.place_url,
  }));
}

async function spotsGemini(g, cat, n, deadline) {
  const data = await gemini({
    contents: [{ role: "user", parts: [{ text:
      `"${g.keyword}" 지역의 ${cat.label} 추천 장소 ${n}곳을 웹 검색으로 찾아서, 다른 말 없이 JSON 배열만 출력해라. ` +
      `형식: [{"name":"장소명","area":"동네/주소","why":"한 줄 특징"}]` }] }],
    tools: [{ googleSearch: {} }],
  }, deadline);
  const text = ((data.candidates?.[0]?.content?.parts) || []).map(p => p.text || "").join("");
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) throw new Error("검색 결과를 해석하지 못했습니다.");
  return JSON.parse(m[0]).slice(0, n).map(p => ({ name: p.name, info: [p.area, p.why].filter(Boolean).join(" · ") }));
}

async function find_spots({ location, category, radius_m, limit } = {}, ctx = {}) {
  if (!location) return { error: "location(지명)이 필요합니다." };
  const cat = CATEGORY[category];
  if (!cat) return { error: "category는 " + Object.keys(CATEGORY).join(", ") + " 중 하나여야 합니다." };
  const g = await geocode(location);
  if (!g) return { error: `'${location}' 지역을 찾지 못했습니다. 영어 지명이나 더 큰 지역명으로 다시 시도하세요.` };
  g.keyword = String(location).trim();
  const rad = Math.min(Math.max(Number(radius_m) || 3000, 500), 20000);
  const n = Math.min(Math.max(Number(limit) || 6, 1), 10);
  try {
    const spots = process.env.KAKAO_REST_API_KEY ? await spotsKakao(g, cat, rad, n) : await spotsGemini(g, cat, n, ctx.deadline);
    return { search_center: g.name, category, source: process.env.KAKAO_REST_API_KEY ? "kakao" : "gemini-search", count: spots.length, spots };
  } catch (e) {
    return { error: "장소 검색 실패: " + (e.message || e) };
  }
}

const impl = { get_weather, find_spots };

const declarations = [
  {
    name: "get_weather",
    description: "특정 지역의 실시간 날씨(기온·체감·습도·강수·풍속), 미세먼지(PM10/PM2.5), 3일 예보를 조회한다. 외출·여행·야외활동 추천 전에 날씨를 확인할 때 사용한다.",
    parameters: { type: "OBJECT", properties: {
      location: { type: "STRING", description: "지명. 한국어 또는 영어 (예: 제주, 서울, Gangneung). 한국어로 못 찾으면 영어로 재시도." } },
      required: ["location"] },
  },
  {
    name: "find_spots",
    description: "특정 지역 주변의 장소(카페, 식당, 관광지, 박물관/미술관, 공원, 해변)를 검색한다. 사용자가 갈 만한 곳·먹을 곳을 물을 때 사용한다.",
    parameters: { type: "OBJECT", properties: {
      location: { type: "STRING", description: "검색 중심 지명 (예: 제주, 부산 해운대)" },
      category: { type: "STRING", enum: Object.keys(CATEGORY),
        description: "cafe=카페, restaurant=식당, attraction=관광명소, museum=박물관·미술관(실내), park=공원, beach=해변" },
      radius_m: { type: "INTEGER", description: "검색 반경(미터). 기본 3000, 최대 20000" },
      limit: { type: "INTEGER", description: "결과 개수. 기본 6, 최대 10" } },
      required: ["location", "category"] },
  },
];

module.exports = { impl, declarations };
