// Card feed có kèm URL mp4 không? Dò đúng cách: leo __reactFiber → memoizedProps
// → đệ quy tìm object aweme → soi video.playAddr / playApi / bitRateList.
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
  const findAweme = (el) => {
    const fk = Object.keys(el).find(k => k.startsWith('__reactFiber'));
    if (!fk) return null;
    const isAweme = (o) => o && typeof o === 'object' && (o.awemeId || o.aweme_id);
    const seen = new Set();
    const dig = (o, d) => {
      if (!o || typeof o !== 'object' || d > 4 || seen.has(o)) return null;
      seen.add(o);
      if (isAweme(o)) return o;
      for (const k of Object.keys(o)) {
        if (k.startsWith('_') || k === 'stateNode' || k === 'return') continue;
        const hit = dig(o[k], d + 1);
        if (hit) return hit;
      }
      return null;
    };
    let f = el[fk];
    for (let up = 0; up < 12 && f; up++, f = f.return) {
      const hit = dig(f.memoizedProps, 0) || dig(f.memoizedState, 0);
      if (hit) return hit;
    }
    return null;
  };

  const cards = document.querySelectorAll('.OeaWUf2h');
  const results = [];
  for (let i = 0; i < Math.min(2, cards.length); i++) {
    const a = findAweme(cards[i]);
    if (!a) { results.push({ i, err: 'không tìm thấy aweme' }); continue; }
    const v = a.video || {};
    const bit = Array.isArray(v.bitRateList) ? v.bitRateList[0] : null;
    results.push({
      i,
      awemeId: a.awemeId,
      desc: (a.desc || '').slice(0, 45),
      allKeys: Object.keys(a).length,
      hasVideoObj: !!a.video,
      videoKeys: Object.keys(v),
      playAddrIsArray: Array.isArray(v.playAddr),
      playAddr0: Array.isArray(v.playAddr) ? (v.playAddr[0]?.src || '').slice(0, 110) : String(v.playAddr || '').slice(0, 110),
      playApi: String(v.playApi || '').slice(0, 110),
      bitRateCount: Array.isArray(v.bitRateList) ? v.bitRateList.length : 0,
      bitRate0: bit ? { gear: bit.gearName, w: bit.width, h: bit.height,
                        url: String(bit.playAddr?.[0]?.src || bit.playApi || '').slice(0, 110) } : null,
      duration: v.duration,
      cover: String(v.cover || '').slice(0, 60),
      textExtra: (a.textExtra || []).map(x => x.hashtagName).filter(Boolean).slice(0, 5),
    });
  }
  return { total: cards.length, results };
})()`);

console.log(JSON.stringify(out, null, 2));
ws.close();
