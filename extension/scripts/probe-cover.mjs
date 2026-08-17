// So sánh: ảnh <img> trang đang hiển thị trên card VS các trường cover trong
// React props (cover / cover169UrlList / originCover / rawCover / dynamicCover…)
// để chọn đúng biến thể không bị cắt lệch khung.
const t = (await (await fetch("http://localhost:9223/json/list")).json())
  .find((x) => x.type === "page" && x.url.includes("douyin.com"));
if (!t) { console.log("Không có tab Douyin đang mở"); process.exit(0); }
console.log(`Tab: ${t.url}\n`);

const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m.result); } };
const ev = (expr) => new Promise((res) => { const id = ++seq; pending.set(id, res);
  ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true } })); });

const r = await ev(`(() => {
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

  // lấy card đầu tiên có aweme + ảnh hiển thị
  const cards = [...document.querySelectorAll('[data-dyq]')];
  const out = { cards: cards.length, sample: null };
  for (const card of cards) {
    const a = awemeOf(card);
    const img = card.querySelector('img');
    if (!a || !img) continue;
    const v = a.video || {};
    const shown = { src: img.currentSrc || img.src, natural: img.naturalWidth + 'x' + img.naturalHeight };
    const variant = (u) => {
      const m = String(u || '').match(/~([^?]+)/);
      return m ? m[1] : '(không có template)';
    };
    out.sample = {
      awemeId: a.awemeId,
      desc: (a.desc || '').slice(0, 40),
      videoWH: v.width + 'x' + v.height + ' ratio=' + v.ratio,
      imgTrangHienThi: { ...shown, variant: variant(shown.src) },
      cover:               { url: String(v.cover||'').slice(0,95), variant: variant(v.cover) },
      coverUrlList0:       { url: String(v.coverUrlList?.[0]||'').slice(0,95), variant: variant(v.coverUrlList?.[0]) },
      cover169UrlList0:    { url: String(v.cover169UrlList?.[0]||'').slice(0,95), variant: variant(v.cover169UrlList?.[0]) },
      cover169BigUrlList0: { url: String(v.cover169BigUrlList?.[0]||'').slice(0,95), variant: variant(v.cover169BigUrlList?.[0]) },
      originCover:         { url: String(v.originCover||'').slice(0,95), variant: variant(v.originCover) },
      originCoverUrlList0: { url: String(v.originCoverUrlList?.[0]||'').slice(0,95), variant: variant(v.originCoverUrlList?.[0]) },
      rawCover:            { url: String(v.rawCover||'').slice(0,95), variant: variant(v.rawCover) },
      columnsCover:        { url: String(v.columnsCover||'').slice(0,95), variant: variant(v.columnsCover) },
      dynamicCover:        { url: String(v.dynamicCover||'').slice(0,95), variant: variant(v.dynamicCover) },
    };
    break;
  }
  return out;
})()`);

console.log(JSON.stringify(r?.result?.value, null, 1));
ws.close();
