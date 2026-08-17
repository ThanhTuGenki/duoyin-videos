// Chẩn đoán nút ＋Q trên MỌI tab Douyin đang mở, bằng CDP thô (WebSocket).
//   node scripts/cdp-check.mjs
// Báo cáo từng tab: content script chạy chưa, có container active không,
// nút đã chèn chưa, và nếu có thì nó nằm ở đâu / có nhìn thấy được không.

const targets = await (await fetch("http://localhost:9223/json/list")).json();
const tabs = targets.filter((t) => t.type === "page" && t.url.includes("douyin.com"));
if (!tabs.length) {
  console.log("✗ Không có tab Douyin nào đang mở");
  process.exit(0);
}

async function evalOn(target, expression) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("WS lỗi"));
  });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    const p = pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    }
  };
  const send = (method, params = {}) =>
    Promise.race([
      new Promise((res, rej) => {
        const id = ++seq;
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params }));
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("CDP timeout 15s")), 15000)),
    ]);
  try {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  } finally {
    ws.close();
  }
}

const PROBE = `(() => {
  const active = document.querySelector('[data-e2e="feed-active-video"]');
  const btn = document.querySelector('#duoyin-ingest-btn');
  let btnInfo = null;
  if (btn) {
    const cs = getComputedStyle(btn);
    const r = btn.getBoundingClientRect();
    btnInfo = {
      text: btn.textContent,
      display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
      zIndex: cs.zIndex, position: cs.position,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      inViewport: r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 &&
                  r.top < innerHeight && r.left < innerWidth,
      parent: btn.parentElement ? (btn.parentElement.getAttribute('data-e2e') || btn.parentElement.className || '').toString().slice(0, 60) : null,
    };
  }
  return {
    url: location.href,
    contentScriptRan: Boolean(window.__duoyinIngest),
    modalId: new URLSearchParams(location.search).get('modal_id'),
    activeCount: document.querySelectorAll('[data-e2e="feed-active-video"]').length,
    activePos: active ? getComputedStyle(active).position : null,
    activeOverflow: active ? getComputedStyle(active).overflow : null,
    videoCount: document.querySelectorAll('video').length,
    button: btnInfo,
  };
})()`;

for (const t of tabs) {
  console.log(`\n${"=".repeat(66)}\n${t.url}\n${"=".repeat(66)}`);
  try {
    const s = await evalOn(t, PROBE);
    console.log("content script đã chạy :", s.contentScriptRan ? "✓" : "✗ CHƯA CHẠY");
    console.log("modal_id               :", s.modalId ?? "(không có → đang ở feed, nút sẽ không hiện)");
    console.log("container active       :", s.activeCount, s.activePos ? `(position: ${s.activePos}, overflow: ${s.activeOverflow})` : "");
    console.log("số <video>             :", s.videoCount);
    if (s.button) {
      console.log("nút ＋Q                : ✓ ĐÃ CHÈN —", JSON.stringify(s.button));
    } else {
      console.log("nút ＋Q                : ✗ chưa chèn");
    }
  } catch (e) {
    console.log("Lỗi khi soi tab:", e.message);
  }
}
