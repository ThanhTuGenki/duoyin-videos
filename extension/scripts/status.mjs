// Chẩn đoán nhanh, CHỈ ĐỌC — không reload gì cả (tránh kích hoạt chống bot Douyin).
//   node scripts/status.mjs
const t = (await (await fetch("http://localhost:9223/json/list")).json())
  .find((x) => x.type === "page" && x.url.includes("douyin.com"));
if (!t) { console.log("✗ Không có tab Douyin đang mở"); process.exit(0); }

const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m.result); } };
const ev = (expr) => new Promise((res) => { const id = ++seq; pending.set(id, res);
  ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true } })); });

const r = await ev(`(() => {
  const d = document.documentElement;
  return {
    url: location.href,
    pagehookRan: d.getAttribute('data-dyq-hook') === '1',
    contentScriptRan: d.getAttribute('data-dyq-cs') === '1',
    cardsAnnotated: Number(d.getAttribute('data-dyq-count') || 0),
    cardsInDom: document.querySelectorAll('[data-dyq]').length,
    buttons: document.querySelectorAll('.duoyin-ingest-btn').length,
    imgs: document.querySelectorAll('img').length,
    videos: document.querySelectorAll('video').length,
  };
})()`);

const s = r?.result?.value;
console.log(`Tab: ${s?.url}\n`);
console.log("pagehook (MAIN world) chạy :", s?.pagehookRan ? "✓" : "✗");
console.log("content script chạy        :", s?.contentScriptRan ? "✓" : "✗");
console.log("card pagehook đọc được     :", s?.cardsAnnotated);
console.log("card có data-dyq trong DOM :", s?.cardsInDom);
console.log("nút ＋Q đã gắn              :", s?.buttons);
console.log("ảnh / video trên trang     :", s?.imgs, "/", s?.videos);

if (!s?.pagehookRan) console.log("\n→ Extension chưa nạp lại: vào chrome://extensions bấm ⟳ rồi F5 trang.");
else if (!s?.cardsInDom) console.log("\n→ Trang chưa render grid video: cuộn feed vài nhịp rồi chạy lại lệnh này.");
else if (!s?.buttons) console.log("\n→ Có card nhưng chưa vẽ nút — lỗi ở content script, cần soi tiếp.");
else console.log("\n✓ Mọi thứ sẵn sàng — nút ＋Q đã có trên card.");

ws.close();
