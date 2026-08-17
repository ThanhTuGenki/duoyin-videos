// Soi cấu trúc feed /jingxuan lúc đang có video thật, để quyết định có thể
// gắn nút vào từng video trên feed hay không (và lấy được id/metadata gì).
const targets = await (await fetch("http://localhost:9223/json/list")).json();
const t = targets.find((x) => x.type === "page" && x.url.includes("douyin.com"));
if (!t) { console.log("Không có tab Douyin"); process.exit(0); }
console.log(`Tab: ${t.url}\n`);

const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } };
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; };

const out = await ev(`(() => {
  const res = { videos: [], e2eKeys: {}, videoLinks: 0, sampleLink: null, cards: {} };

  document.querySelectorAll('[data-e2e]').forEach(el => {
    const k = el.getAttribute('data-e2e');
    res.e2eKeys[k] = (res.e2eKeys[k] || 0) + 1;
  });

  const links = document.querySelectorAll('a[href*="/video/"]');
  res.videoLinks = links.length;
  res.sampleLink = links[0]?.getAttribute('href') || null;

  // với mỗi <video>, leo cây cha tìm container "thẻ video" có link /video/<id>
  document.querySelectorAll('video').forEach((v, i) => {
    const info = { i, hasSrc: !!v.src, blob: v.src.startsWith('blob:'), w: v.videoWidth, h: v.videoHeight,
                   dur: Math.round(v.duration || 0), parentClass: (v.parentElement?.className||'').toString().slice(0,50) };
    let el = v.parentElement, foundAt = null, link = null, txt = null;
    for (let d = 0; d < 10 && el; d++, el = el.parentElement) {
      const a = el.querySelector?.('a[href*="/video/"]');
      if (a && !foundAt) {
        foundAt = d;
        link = a.getAttribute('href');
        txt = (el.innerText || '').replace(/\\n/g, ' | ').slice(0, 100);
      }
    }
    info.cardDepth = foundAt; info.cardLink = link; info.cardText = txt;
    res.videos.push(info);
  });

  // các container lặp lại nhiều lần (ứng viên "thẻ video" trong grid)
  const counts = {};
  document.querySelectorAll('div[class]').forEach(d => {
    const c = d.className.toString().split(' ')[0];
    if (c) counts[c] = (counts[c] || 0) + 1;
  });
  res.cards = Object.entries(counts).filter(([, n]) => n >= 4 && n <= 40)
    .sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([c, n]) => c + ' x' + n);

  return res;
})()`);

console.log(JSON.stringify(out, null, 2));
ws.close();
