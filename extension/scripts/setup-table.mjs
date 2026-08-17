// Biến một Google Sheets Table sẵn có thành queue 13 cột theo hợp đồng.
// Giữ nguyên tông màu Table mà người dùng đã chọn; chỉ đổi tên/loại cột,
// mở rộng phạm vi, thêm dropdown chip + màu trạng thái + chú thích.
//
//   node scripts/setup-table.mjs <spreadsheetId> [rows]

import { chromium } from "playwright";

const ID = process.argv[2];
if (!ID) throw new Error("Thiếu spreadsheetId");
const ROWS = Number(process.argv[3] ?? 300);
const EXT_ID = "bbhcmfeedghfopbijnbjnhdfenfdinli";
const API = "https://sheets.googleapis.com/v4/spreadsheets";

const hex = (h) => ({
  red: parseInt(h.slice(1, 3), 16) / 255,
  green: parseInt(h.slice(3, 5), 16) / 255,
  blue: parseInt(h.slice(5, 7), 16) / 255,
});

const VOICES = ["default", "nu-mien-bac", "nam-mien-bac", "nu-mien-nam", "nam-mien-nam"];
const MODES = ["fast", "cinematic", "autofit"];
const STATUS = {
  NEW: { bg: "#DBEAFE", fg: "#1D4ED8" },
  DOWNLOADING: { bg: "#FEF3C7", fg: "#92400E" },
  PROCESSING: { bg: "#FEF3C7", fg: "#92400E" },
  MUXING: { bg: "#FEF3C7", fg: "#92400E" },
  UPLOADING: { bg: "#FEF3C7", fg: "#92400E" },
  DONE: { bg: "#D1FAE5", fg: "#047857" },
  ERROR: { bg: "#FEE2E2", fg: "#B91C1C" },
};

// [tên, loại cột Table, danh sách dropdown | null, độ rộng, wrap, chú thích]
const COLUMNS = [
  ["id", "TEXT", null, 165, "CLIP", "Trùng tên folder trong inbox/ và id trong meta.json"],
  ["title", "TEXT", null, 320, "WRAP", "Title gốc extension nhặt từ trang video"],
  ["author", "TEXT", null, 140, "CLIP", "Kênh/tác giả gốc"],
  ["source_url", "TEXT", null, 130, "CLIP", "Link gốc — chỉ để tra cứu, worker KHÔNG dùng để tải"],
  ["drive_folder_link", "TEXT", null, 130, "CLIP", "Folder inbox/<id>/ chứa video.mp4 + thumb + meta.json"],
  ["voice", "DROPDOWN", VOICES, 130, "CLIP", "Giọng lồng tiếng"],
  ["translation_mode", "DROPDOWN", MODES, 150, "CLIP", "fast (nhanh) / cinematic (thoại tự nhiên) / autofit (khớp timing)"],
  ["status", "DROPDOWN", Object.keys(STATUS), 145, "CLIP", "NEW → DOWNLOADING → PROCESSING → MUXING → UPLOADING → DONE / ERROR"],
  ["output_link", "TEXT", null, 130, "CLIP", "Link thành phẩm trong output/ — worker ghi"],
  ["error", "TEXT", null, 220, "WRAP", "Message lỗi khi status = ERROR"],
  ["duration", "DOUBLE", null, 95, "CLIP", "Thời lượng video (giây) — worker ghi"],
  ["process_time", "DOUBLE", null, 115, "CLIP", "Thời gian xử lý (giây) — để tính chi phí ⚡"],
  ["updated_at", "TEXT", null, 155, "CLIP", "Lần cập nhật gần nhất (ISO 8601) — worker ghi"],
];

// ── token từ extension ───────────────────────────────────────────
const browser = await chromium.connectOverCDP("http://localhost:9223");
const context = browser.contexts()[0];
const optPage = await context.newPage();
await optPage.goto(`chrome-extension://${EXT_ID}/options.html`);
await optPage.waitForTimeout(800);
const token = await optPage.evaluate(
  () =>
    new Promise((res, rej) =>
      chrome.identity.getAuthToken({ interactive: false }, (t) =>
        chrome.runtime.lastError || !t ? rej(new Error(chrome.runtime.lastError?.message ?? "no token")) : res(t),
      ),
    ),
);
await optPage.close();
await browser.close();

const api = async (path, init = {}) => {
  const r = await fetch(`${API}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (!r.ok) throw new Error(`Sheets ${r.status}: ${(await r.text()).slice(0, 500)}`);
  return r.json();
};

const meta = await api(
  `${ID}?fields=sheets(properties(sheetId,title,gridProperties),tables,conditionalFormats)`,
);
const sheet = meta.sheets[0];
const sheetId = sheet.properties.sheetId;
const table = sheet.tables?.[0];
if (!table) throw new Error("Tab đầu tiên không có Table nào — hãy Insert → Table trước.");
console.log(`✓ Table "${table.name}" (id=${table.tableId}) trên tab "${sheet.properties.title}"`);

const requests = [];

// 1. Xoá conditional format cũ (chạy lại nhiều lần được)
for (let i = (sheet.conditionalFormats ?? []).length - 1; i >= 0; i--) {
  requests.push({ deleteConditionalFormatRule: { sheetId, index: i } });
}

// 2. Lưới đủ chỗ cho 13 cột × ROWS dòng
requests.push({
  updateSheetProperties: {
    properties: {
      sheetId,
      gridProperties: {
        rowCount: Math.max(ROWS, sheet.properties.gridProperties.rowCount),
        columnCount: Math.max(13, sheet.properties.gridProperties.columnCount),
        frozenRowCount: 1,
      },
    },
    fields: "gridProperties(rowCount,columnCount,frozenRowCount)",
  },
});

// 3. Mở rộng + đặt tên/loại cho từng cột của Table (giữ nguyên màu Table)
requests.push({
  updateTable: {
    table: {
      tableId: table.tableId,
      name: "queue",
      range: { sheetId, startRowIndex: 0, endRowIndex: ROWS, startColumnIndex: 0, endColumnIndex: 13 },
      columnProperties: COLUMNS.map(([name, type, options], columnIndex) => ({
        columnIndex,
        columnName: name,
        columnType: type,
        ...(options
          ? {
              dataValidationRule: {
                condition: { type: "ONE_OF_LIST", values: options.map((v) => ({ userEnteredValue: v })) },
              },
            }
          : {}),
      })),
    },
    fields: "name,range,columnProperties",
  },
});

// 4. Độ rộng + xuống dòng theo cột
COLUMNS.forEach(([, , , width, wrap], i) => {
  requests.push({
    updateDimensionProperties: {
      range: { sheetId, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 },
      properties: { pixelSize: width },
      fields: "pixelSize",
    },
  });
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 1, endRowIndex: ROWS, startColumnIndex: i, endColumnIndex: i + 1 },
      cell: { userEnteredFormat: { wrapStrategy: wrap, verticalAlignment: "MIDDLE" } },
      fields: "userEnteredFormat(wrapStrategy,verticalAlignment)",
    },
  });
});

// 5. Chú thích hover trên từng ô tiêu đề
requests.push({
  updateCells: {
    range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 13 },
    rows: [{ values: COLUMNS.map(([, , , , , note]) => ({ note })) }],
    fields: "note",
  },
});

// 6. Màu cho chip trạng thái + cả dòng ửng đỏ khi ERROR
const statusCol = { sheetId, startRowIndex: 1, endRowIndex: ROWS, startColumnIndex: 7, endColumnIndex: 8 };
let idx = 0;
for (const [value, { bg, fg }] of Object.entries(STATUS)) {
  requests.push({
    addConditionalFormatRule: {
      index: idx++,
      rule: {
        ranges: [statusCol],
        booleanRule: {
          condition: { type: "TEXT_EQ", values: [{ userEnteredValue: value }] },
          format: { backgroundColor: hex(bg), textFormat: { bold: true, foregroundColor: hex(fg) } },
        },
      },
    },
  });
}
requests.push({
  addConditionalFormatRule: {
    index: idx++,
    rule: {
      ranges: [{ sheetId, startRowIndex: 1, endRowIndex: ROWS, startColumnIndex: 0, endColumnIndex: 13 }],
      booleanRule: {
        condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: '=$H2="ERROR"' }] },
        format: { backgroundColor: hex("#FEF2F2") },
      },
    },
  },
});

await api(`${ID}:batchUpdate`, { method: "POST", body: JSON.stringify({ requests }) });
console.log(`✓ Đã áp ${requests.length} thay đổi — Table "queue" 13 cột`);
console.log(`→ https://docs.google.com/spreadsheets/d/${ID}/edit`);
