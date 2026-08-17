// Dồn các dòng dữ liệu bị ghi lạc xuống đáy Table lên ngay dưới header.
// Nguyên nhân cũ: values:append ghi xuống cuối vùng Table (dòng 301).
//   node scripts/repair-rows.mjs [spreadsheetId]
import { getToken, sheetsApi } from "./lib/token.mjs";

const ID = process.argv[2] ?? "1tLx0SQUqWQ1q7qGpkdcH0ATMYGdCSPA9AUMqLRHyFRY";
const api = sheetsApi(await getToken());

const meta = await api(`${ID}?fields=sheets.properties(title,gridProperties(rowCount))`);
const tab = meta.sheets[0].properties.title;
const rowCount = meta.sheets[0].properties.gridProperties.rowCount;
console.log(`tab "${tab}" — ${rowCount} dòng`);

const all = await api(`${ID}/values/${encodeURIComponent(`${tab}!A1:M${rowCount}`)}`);
const rows = all.values ?? [];
const data = rows.slice(1).filter((r) => r.some((c) => String(c ?? "").trim()));
console.log(`tìm thấy ${data.length} dòng dữ liệu`);
if (!data.length) {
  console.log("không có gì để dồn");
  process.exit(0);
}

// xoá sạch vùng dữ liệu rồi ghi lại từ dòng 2
await api(`${ID}/values/${encodeURIComponent(`${tab}!A2:M${rowCount}`)}:clear`, { method: "POST", body: "{}" });
const padded = data.map((r) => Array.from({ length: 13 }, (_, i) => r[i] ?? ""));
await api(`${ID}/values/${encodeURIComponent(`${tab}!A2:M${1 + padded.length}`)}?valueInputOption=RAW`, {
  method: "PUT",
  body: JSON.stringify({ values: padded }),
});

console.log(`✓ đã dồn ${padded.length} dòng lên vị trí 2..${1 + padded.length}`);
padded.forEach((r, i) => console.log(`  dòng ${i + 2}: ${r[0]} | ${String(r[1]).slice(0, 50)}`));
