// Nạp lại extension + trang Douyin rồi kiểm chứng nút ＋Q đã gắn lên card chưa.
// Dùng CDP thô (Playwright hay treo với target extension).

const EXT = "bbhcmfeedghfopbijnbjnhdfenfdinli";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = () => fetch("http://localhost:9223/json/list").then((r) => r.json());

function connect(target) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    let seq = 0;
    const pending = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      const p = pending.get(m.id);
      if (p) {
        pending.delete(m.id);
        m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
      }
    };
    ws.onerror = () => reject(new Error("WS lỗi"));
    ws.onopen = () =>
      resolve({
        send: (method, params = {}) =>
          Promise.race([
            new Promise((res, rej) => {
              const id = ++seq;
              pending.set(id, { res, rej });
              ws.send(JSON.stringify({ id, method, params }));
            }),
            new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${method}`)), 15000)),
          ]),
        eval: async function (expression) {
          const r = await this.send("Runtime.evaluate", { expression, returnByValue: true });
          if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
          return r.result.value;
        },
        close: () => ws.close(),
      });
  });
}

// 1. Nạp lại extension
const sw = (await list()).find((t) => t.type === "service_worker" && t.url.includes(EXT));
if (sw) {
  const c = await connect(sw);
  await c.eval("chrome.runtime.reload()").catch(() => {});
  c.close();
  console.log("✓ Đã nạp lại extension");
  await sleep(3000);
} else {
  console.log("! Không thấy service worker extension (có thể đang ngủ) — bỏ qua bước reload");
}

// 2. Nạp lại tab Douyin
const tab = (await list()).find((t) => t.type === "page" && t.url.includes("douyin.com"));
if (!tab) {
  console.log("✗ Không có tab Douyin đang mở");
  process.exit(0);
}
const page = await connect(tab);
await page.send("Page.enable").catch(() => {});
await page.send("Page.reload", { ignoreCache: true }).catch(() => {});
console.log(`… đã nạp lại ${tab.url} — chờ 12s cho trang + card render`);
await sleep(12000);

// 3. Kiểm chứng
const probe = await page.eval(`(() => {
  const cards = document.querySelectorAll('[data-dyq]');
  const btns = document.querySelectorAll('.duoyin-ingest-btn');
  const first = cards[0];
  let sample = null;
  if (first) {
    const b = first.querySelector('.duoyin-ingest-btn');
    const r = b ? b.getBoundingClientRect() : null;
    sample = {
      awemeId: first.getAttribute('data-dyq'),
      cardSize: Math.round(first.getBoundingClientRect().width) + 'x' + Math.round(first.getBoundingClientRect().height),
      hasButton: !!b,
      buttonText: b?.textContent ?? null,
      buttonRect: r ? Math.round(r.x) + ',' + Math.round(r.y) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) : null,
      buttonVisible: r ? (r.width > 0 && r.height > 0) : false,
    };
  }
  return { cards: cards.length, buttons: btns.length, sample };
})()`);

console.log("\n=== KẾT QUẢ ===");
console.log("card được pagehook đánh dấu :", probe.cards);
console.log("nút ＋Q đã gắn               :", probe.buttons);
console.log("mẫu                          :", JSON.stringify(probe.sample, null, 1));

// 4. Thử lấy metadata qua cầu postMessage (đúng đường content script sẽ đi)
if (probe.sample?.awemeId) {
  const meta = await page.eval(`new Promise((resolve) => {
    const id = ${JSON.stringify(probe.sample.awemeId)};
    const on = (e) => {
      if (e.source === window && e.data?.type === 'dyq-meta' && e.data.id === id) {
        window.removeEventListener('message', on);
        const m = e.data.meta;
        resolve(m ? { title: (m.title||'').slice(0,45), author: m.author, tags: m.tags,
                      likes: m.likes, dur: m.durationSeconds,
                      cover: (m.cover||'').slice(0,45), video: (m.videoUrl||'').slice(0,60) } : null);
      }
    };
    window.addEventListener('message', on);
    window.postMessage({ type: 'dyq-get', id }, '*');
    setTimeout(() => resolve('TIMEOUT'), 4000);
  })`);
  console.log("\nmetadata qua cầu postMessage :", JSON.stringify(meta, null, 1));
}

page.close();
