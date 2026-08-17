// Kiểm chứng: card trên feed có mang dữ liệu aweme trong React fiber/props không?
// Runtime.evaluate chạy ở MAIN world nên đọc được __reactFiber$ / __reactProps$.
const targets = await (await fetch("http://localhost:9223/json/list")).json();
const t = targets.find((x) => x.type === "page" && x.url.includes("douyin.com"));
if (!t) { console.log("Không có tab Douyin"); process.exit(0); }
console.log(`Tab: ${t.url}\n`);

const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
const ev = async (expr) => {
  const r = await new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true } })); });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};

const out = await ev(`(() => {
  const res = { cardClass: null, cardCount: 0, reactKeys: [], found: null, searchedDepth: 0 };

  // chọn class lặp nhiều nhất làm ứng viên card
  const counts = {};
  document.querySelectorAll('div[class]').forEach(d => {
    const c = d.className.toString().split(' ')[0];
    if (c) counts[c] = (counts[c] || 0) + 1;
  });
  const best = Object.entries(counts).filter(([, n]) => n >= 5 && n <= 60).sort((a,b)=>b[1]-a[1])[0];
  if (!best) return res;
  res.cardClass = best[0]; res.cardCount = best[1];

  const card = document.querySelector('.' + CSS.escape(best[0]));
  if (!card) return res;
  res.reactKeys = Object.keys(card).filter(k => k.startsWith('__react')).slice(0, 5);
  if (!res.reactKeys.length) return res;

  // leo fiber tìm object có aweme id
  const fiberKey = Object.keys(card).find(k => k.startsWith('__reactFiber'));
  let fiber = card[fiberKey];
  const seen = new Set();
  const looksLikeAweme = (o) => o && typeof o === 'object' &&
    (o.awemeId || o.aweme_id || (o.desc !== undefined && (o.author || o.authorInfo)));

  const dig = (obj, depth) => {
    if (!obj || depth > 4 || seen.has(obj)) return null;
    if (typeof obj !== 'object') return null;
    seen.add(obj);
    if (looksLikeAweme(obj)) return obj;
    for (const k of Object.keys(obj)) {
      if (k.startsWith('_') || k === 'stateNode' || k === 'return') continue;
      const hit = dig(obj[k], depth + 1);
      if (hit) return hit;
    }
    return null;
  };

  for (let up = 0; up < 12 && fiber; up++, fiber = fiber.return) {
    res.searchedDepth = up;
    const hit = dig(fiber.memoizedProps, 0) || dig(fiber.memoizedState, 0);
    if (hit) {
      res.found = {
        atFiberDepth: up,
        keys: Object.keys(hit).slice(0, 30),
        awemeId: hit.awemeId ?? hit.aweme_id ?? null,
        desc: (hit.desc ?? '').toString().slice(0, 70),
        author: hit.authorInfo?.nickname ?? hit.author?.nickname ?? null,
        cover: (hit.video?.cover ?? hit.video?.coverUrlList?.[0] ?? '').toString().slice(0, 80),
        stats: hit.statistics ?? hit.stats ?? null,
      };
      break;
    }
  }
  return res;
})()`);

console.log(JSON.stringify(out, null, 2));
ws.close();
