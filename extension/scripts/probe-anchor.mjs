// Chiến lược bám card không phụ thuộc class băm:
// từ mỗi <img> cover leo lên tối đa N tầng, tìm phần tử có React fiber chứa aweme.
// Kiểm chứng: tìm được bao nhiêu card, có trùng lặp không, độ sâu bao nhiêu.
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
  const awemeOf = (el) => {
    const fk = Object.keys(el).find(k => k.startsWith('__reactFiber'));
    if (!fk) return null;
    const seen = new Set();
    const dig = (o, d) => {
      if (!o || typeof o !== 'object' || d > 3 || seen.has(o)) return null;
      seen.add(o);
      if (o.awemeId && o.video) return o;
      for (const k of Object.keys(o)) {
        if (k.startsWith('_') || k === 'stateNode' || k === 'return') continue;
        const hit = dig(o[k], d + 1);
        if (hit) return hit;
      }
      return null;
    };
    let f = el[fk];
    for (let up = 0; up < 3 && f; up++, f = f.return) {
      const hit = dig(f.memoizedProps, 0);
      if (hit) return hit;
    }
    return null;
  };

  const found = new Map();      // awemeId -> {depth, tag, cls, rectW}
  const depths = {};
  let imgsScanned = 0;

  document.querySelectorAll('img').forEach(img => {
    imgsScanned++;
    let el = img;
    for (let d = 0; d < 8 && el; d++, el = el.parentElement) {
      const a = awemeOf(el);
      if (a) {
        depths[d] = (depths[d] || 0) + 1;
        if (!found.has(a.awemeId)) {
          const r = el.getBoundingClientRect();
          found.set(a.awemeId, {
            depth: d,
            tag: el.tagName,
            cls: (el.className || '').toString().split(' ')[0],
            w: Math.round(r.width), h: Math.round(r.height),
            desc: (a.desc || '').slice(0, 35),
          });
        }
        break;
      }
    }
  });

  return {
    imgsScanned,
    uniqueCards: found.size,
    depthHistogram: depths,
    samples: [...found.entries()].slice(0, 4).map(([id, v]) => ({ id, ...v })),
  };
})()`);

console.log(JSON.stringify(out, null, 2));
ws.close();
