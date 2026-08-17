// Tìm xem appendRow thực sự ghi vào dòng nào (quét rộng A1:M600).
//   node scripts/find-row.mjs [spreadsheetId]
const ID = process.argv[2] ?? "1tLx0SQUqWQ1q7qGpkdcH0ATMYGdCSPA9AUMqLRHyFRY";
const EXT = "bbhcmfeedghfopbijnbjnhdfenfdinli";

// token qua CDP từ trang options của extension
const targets = await (await fetch("http://localhost:9223/json/list")).json();
let tk = targets.find((t) => t.type === "page" && t.url.includes(EXT));
if (!tk) {
  // mở options page bằng cách tận dụng service worker
  const sw = targets.find((t) => t.type === "service_worker" && t.url.includes(EXT));
  if (!sw) throw new Error("Extension chưa chạy — mở Chrome dev và load extension trước");
  const ws0 = new WebSocket(sw.webSocketDebuggerUrl);
  await new Promise((r) => (ws0.onopen = r));
  ws0.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "chrome.runtime.openOptionsPage()" } }));
  await new Promise((r) => setTimeout(r, 2000));
  ws0.close();
  tk = (await (await fetch("http://localhost:9223/json/list")).json()).find((t) => t.type === "page" && t.url.includes(EXT));
  if (!tk) throw new Error("Không mở được trang options");
}

const ws = new WebSocket(tk.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m.result); } };
const ev = (expr) => new Promise((res) => { const id = ++seq; pending.set(id, res);
  ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise: true } })); });

const token = (await ev(`new Promise(r => chrome.identity.getAuthToken({interactive:false}, t => r(t)))`))?.result?.value;
ws.close();
if (!token) throw new Error("Không lấy được OAuth token");

const api = async (p) => {
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${p}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
};

const meta = await api(`${ID}?fields=sheets(properties(title,gridProperties(rowCount)),tables(name,range))`);
for (const s of meta.sheets) {
  console.log(`tab "${s.properties.title}" — ${s.properties.gridProperties.rowCount} dòng, table:`, JSON.stringify(s.tables?.[0]?.range ?? null));
}

const tab = meta.sheets[0].properties.title;
const vals = await api(`${ID}/values/${encodeURIComponent(`${tab}!A1:M600`)}`);
const rows = vals.values ?? [];
console.log(`\nĐọc ${rows.length} dòng có dữ liệu trong A1:M600`);
rows.forEach((r, i) => {
  if (i === 0) return;
  if (r.some((c) => String(c).trim())) console.log(`  dòng ${i + 1}: ${r.slice(0, 3).join(" | ").slice(0, 90)}`);
});
if (rows.length <= 1) console.log("  (không có dòng dữ liệu nào trong 600 dòng đầu)");
