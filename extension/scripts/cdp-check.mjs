// Kiểm tra nút ＋Q bằng CDP thô (WebSocket) — không qua Playwright, tránh bị
// treo khi có target hỏng. Tuỳ chọn --reload để nạp lại tab trước khi kiểm tra.
//   node scripts/cdp-check.mjs [--reload]

const RELOAD = process.argv.includes("--reload");

const targets = await (await fetch("http://localhost:9223/json/list")).json();
const target = targets.find((t) => t.type === "page" && t.url.includes("douyin.com"));
if (!target) {
  console.log("✗ Không thấy tab Douyin nào đang mở");
  process.exit(0);
}
console.log(`Tab: ${target.url}\n`);

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error("Không mở được WebSocket CDP"));
});

let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  const p = pending.get(msg.id);
  if (p) {
    pending.delete(msg.id);
    msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
  }
};
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });

const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};

if (RELOAD) {
  await send("Page.enable");
  await send("Page.reload", { ignoreCache: true });
  console.log("… đã nạp lại tab, chờ 9s cho content script chạy");
  await new Promise((r) => setTimeout(r, 9000));
}

const state = await evaluate(`(() => ({
  contentScriptRan: Boolean(window.__duoyinIngest),
  hasActiveContainer: Boolean(document.querySelector('[data-e2e="feed-active-video"]')),
  modalId: new URLSearchParams(location.search).get('modal_id'),
  button: (() => {
    const b = document.querySelector('#duoyin-ingest-btn');
    return b ? { text: b.textContent, bg: getComputedStyle(b).backgroundColor } : null;
  })(),
}))()`);

console.log("=== KẾT QUẢ ===");
console.log("content script đã chạy :", state.contentScriptRan ? "✓" : "✗");
console.log("có container active    :", state.hasActiveContainer ? "✓" : "✗");
console.log("modal_id               :", state.modalId ?? "(không có)");
console.log("nút ＋Q                :", state.button ? `✓ "${state.button.text}" nền ${state.button.bg}` : "✗ chưa thấy");

ws.close();
