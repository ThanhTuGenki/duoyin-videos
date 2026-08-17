// Mượn OAuth token của extension qua CDP (đánh thức service worker nếu đang ngủ).
export const EXT_ID = "bbhcmfeedghfopbijnbjnhdfenfdinli";
const CDP = "http://localhost:9223";

const list = () => fetch(`${CDP}/json/list`).then((r) => r.json());

function attach(target) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    let seq = 0;
    const pending = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      const p = pending.get(m.id);
      if (p) { pending.delete(m.id); p(m.result); }
    };
    ws.onerror = () => reject(new Error("WS lỗi"));
    ws.onopen = () =>
      resolve({
        eval: (expression) =>
          new Promise((res) => {
            const id = ++seq;
            pending.set(id, res);
            ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
          }),
        close: () => ws.close(),
      });
  });
}

export async function getToken() {
  let page = (await list()).find((t) => t.type === "page" && t.url.includes(EXT_ID));
  if (!page) {
    // mở trang options (đánh thức luôn service worker)
    await fetch(`${CDP}/json/new?url=chrome-extension://${EXT_ID}/options.html`, { method: "PUT" }).catch(() => {});
    await new Promise((r) => setTimeout(r, 2500));
    page = (await list()).find((t) => t.type === "page" && t.url.includes(EXT_ID));
  }
  if (!page) throw new Error("Không mở được trang options của extension — Chrome dev đã chạy và load extension chưa?");

  const c = await attach(page);
  const r = await c.eval(`new Promise(res => chrome.identity.getAuthToken({interactive:false}, t => res(t || null)))`);
  c.close();
  const token = r?.result?.value;
  if (!token) throw new Error("Không lấy được OAuth token từ extension");
  return token;
}

export function sheetsApi(token) {
  return async (path, init = {}) => {
    const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    if (!r.ok) throw new Error(`Sheets ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return r.json();
  };
}
