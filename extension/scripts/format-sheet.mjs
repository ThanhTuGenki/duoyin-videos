// Trang trí Sheet queue theo hợp đồng 13 cột.
// Mượn OAuth token của extension qua CDP (Chrome dev mở sẵn cổng 9223) rồi gọi
// Sheets API từ Node — nên extension không cần nút "Trang trí Sheet" nào cả.
//
//   node scripts/format-sheet.mjs [spreadsheetId] [--clear-data]
//
// --clear-data: xoá sạch dòng dữ liệu (dùng khi tạo file mẫu để copy).

import { chromium } from "playwright";

const SPREADSHEET_ID = process.argv[2]?.startsWith("--")
  ? "1yrp2Jxp-Uj5WD5RIJMzXWkQaTe7TwHdNmWnmJuqPmTw"
  : (process.argv[2] ?? "1yrp2Jxp-Uj5WD5RIJMzXWkQaTe7TwHdNmWnmJuqPmTw");
const CLEAR_DATA = process.argv.includes("--clear-data");
const MAX_ROWS = 2000;
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";

// ── Bảng màu (slate + accent theo trạng thái) ────────────────────
const hex = (h) => ({
  red: parseInt(h.slice(1, 3), 16) / 255,
  green: parseInt(h.slice(3, 5), 16) / 255,
  blue: parseInt(h.slice(5, 7), 16) / 255,
});

const INK = "#0F172A";
const HEADER_BG = "#1E293B";
const BAND_A = "#FFFFFF";
const BAND_B = "#F1F5F9";

const STATUS = {
  NEW:         { bg: "#DBEAFE", fg: "#1D4ED8" },
  DOWNLOADING: { bg: "#FEF3C7", fg: "#92400E" },
  PROCESSING:  { bg: "#FEF3C7", fg: "#92400E" },
  MUXING:      { bg: "#FEF3C7", fg: "#92400E" },
  UPLOADING:   { bg: "#FEF3C7", fg: "#92400E" },
  DONE:        { bg: "#D1FAE5", fg: "#047857" },
  ERROR:       { bg: "#FEE2E2", fg: "#B91C1C" },
};

const VOICES = ["default", "nu-mien-bac", "nam-mien-bac", "nu-mien-nam", "nam-mien-nam"];
const MODES = ["fast", "cinematic", "autofit"];

// cột: [width, alignment, wrap, note]
const COLUMNS = [
  ["id",               160, "LEFT",   "CLIP", "Trùng tên folder trong inbox/ và id trong meta.json"],
  ["title",            320, "LEFT",   "WRAP", "Title gốc extension nhặt từ trang video"],
  ["author",           140, "LEFT",   "CLIP", "Kênh/tác giả gốc"],
  ["source_url",       130, "LEFT",   "CLIP", "Link gốc — chỉ để tra cứu, worker KHÔNG dùng để tải"],
  ["drive_folder_link",130, "LEFT",   "CLIP", "Folder inbox/<id>/ chứa video.mp4 + thumb.jpg + meta.json"],
  ["voice",            120, "CENTER", "CLIP", "Giọng lồng tiếng — chọn từ danh sách"],
  ["translation_mode", 130, "CENTER", "CLIP", "fast (nhanh) / cinematic (thoại tự nhiên) / autofit (khớp timing)"],
  ["status",           130, "CENTER", "CLIP", "NEW → DOWNLOADING → PROCESSING → MUXING → UPLOADING → DONE / ERROR"],
  ["output_link",      130, "LEFT",   "CLIP", "Link thành phẩm trong output/ — worker ghi"],
  ["error",            220, "LEFT",   "WRAP", "Message lỗi khi status = ERROR"],
  ["duration",          90, "CENTER", "CLIP", "Thời lượng video (giây) — worker ghi"],
  ["process_time",     110, "CENTER", "CLIP", "Thời gian xử lý (giây) — để tính chi phí ⚡"],
  ["updated_at",       150, "LEFT",   "CLIP", "Lần cập nhật gần nhất (ISO 8601) — worker ghi"],
];

// ── Lấy token từ service worker của extension ────────────────────
const EXT_ID = "bbhcmfeedghfopbijnbjnhdfenfdinli";

async function getToken() {
  const browser = await chromium.connectOverCDP("http://localhost:9223");
  const context = browser.contexts()[0];
  // Trang options của extension có đầy đủ chrome.identity (service worker qua CDP thì không)
  const page = await context.newPage();
  await page.goto(`chrome-extension://${EXT_ID}/options.html`);
  await page.waitForTimeout(800);

  const token = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        if (!globalThis.chrome?.identity) return reject(new Error("chrome.identity không khả dụng"));
        chrome.identity.getAuthToken({ interactive: false }, (t) =>
          chrome.runtime.lastError || !t
            ? reject(new Error(chrome.runtime.lastError?.message ?? "không lấy được token"))
            : resolve(t),
        );
      }),
  );
  await page.close().catch(() => {});
  await browser.close();
  return token;
}

// ── Gọi API ──────────────────────────────────────────────────────
async function api(token, path, init = {}) {
  const res = await fetch(`${SHEETS}/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`Sheets ${res.status}: ${(await res.text()).slice(0, 400)}`);
  return res.json();
}

const token = await getToken();
console.log("✓ Lấy được OAuth token từ extension");

const meta = await api(
  token,
  `${SPREADSHEET_ID}?fields=sheets(properties(sheetId,title,gridProperties),conditionalFormats,bandedRanges)`,
);
const sheet = meta.sheets[0];
const sheetId = sheet.properties.sheetId;
console.log(`✓ Sheet "${sheet.properties.title}" (id=${sheetId})`);

const all = { sheetId, startRowIndex: 0, endRowIndex: MAX_ROWS, startColumnIndex: 0, endColumnIndex: 13 };
const data = { sheetId, startRowIndex: 1, endRowIndex: MAX_ROWS, startColumnIndex: 0, endColumnIndex: 13 };
const header = { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 13 };
const col = (i) => ({ sheetId, startRowIndex: 1, endRowIndex: MAX_ROWS, startColumnIndex: i, endColumnIndex: i + 1 });

const requests = [];

// 0. Dọn format cũ (chạy lại được nhiều lần)
for (const b of sheet.bandedRanges ?? []) requests.push({ deleteBanding: { bandedRangeId: b.bandedRangeId } });
for (let i = (sheet.conditionalFormats ?? []).length - 1; i >= 0; i--) {
  requests.push({ deleteConditionalFormatRule: { sheetId, index: i } });
}

// 1. Lưới đủ rộng + freeze hàng tiêu đề và cột id
requests.push({
  updateSheetProperties: {
    properties: {
      sheetId,
      title: "queue",
      gridProperties: {
        rowCount: Math.max(MAX_ROWS, sheet.properties.gridProperties.rowCount),
        columnCount: Math.max(13, sheet.properties.gridProperties.columnCount),
        frozenRowCount: 1,
        frozenColumnCount: 1,
      },
    },
    fields: "title,gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount)",
  },
});

// 2. Tiêu đề: nền đậm, chữ trắng, căn giữa, cao 38px
requests.push({
  repeatCell: {
    range: header,
    cell: {
      userEnteredFormat: {
        backgroundColor: hex(HEADER_BG),
        horizontalAlignment: "CENTER",
        verticalAlignment: "MIDDLE",
        wrapStrategy: "CLIP",
        textFormat: { bold: true, fontSize: 10, foregroundColor: hex("#FFFFFF") },
      },
    },
    fields: "userEnteredFormat(backgroundColor,horizontalAlignment,verticalAlignment,wrapStrategy,textFormat)",
  },
});
requests.push({
  updateDimensionProperties: {
    range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: 1 },
    properties: { pixelSize: 38 },
    fields: "pixelSize",
  },
});

// 3. Chú thích trên từng ô tiêu đề (hover để đọc)
requests.push({
  updateCells: {
    range: header,
    rows: [{ values: COLUMNS.map(([, , , , note]) => ({ note })) }],
    fields: "note",
  },
});

// 4. Vùng dữ liệu: chữ nhỏ, căn giữa theo chiều dọc
requests.push({
  repeatCell: {
    range: data,
    cell: {
      userEnteredFormat: {
        verticalAlignment: "MIDDLE",
        textFormat: { fontSize: 10, foregroundColor: hex(INK) },
      },
    },
    fields: "userEnteredFormat(verticalAlignment,textFormat)",
  },
});

// 4b. Dòng dữ liệu cao hơn một chút cho dễ đọc
requests.push({
  updateDimensionProperties: {
    range: { sheetId, dimension: "ROWS", startIndex: 1, endIndex: MAX_ROWS },
    properties: { pixelSize: 26 },
    fields: "pixelSize",
  },
});

// 5. Độ rộng + canh lề + xuống dòng theo từng cột
COLUMNS.forEach(([, width, align, wrap], i) => {
  requests.push({
    updateDimensionProperties: {
      range: { sheetId, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 },
      properties: { pixelSize: width },
      fields: "pixelSize",
    },
  });
  requests.push({
    repeatCell: {
      range: col(i),
      cell: { userEnteredFormat: { horizontalAlignment: align, wrapStrategy: wrap } },
      fields: "userEnteredFormat(horizontalAlignment,wrapStrategy)",
    },
  });
});

// 6. Kẻ sọc xen kẽ cho dễ dò dòng
requests.push({
  addBanding: {
    bandedRange: {
      range: all,
      rowProperties: {
        headerColor: hex(HEADER_BG),
        firstBandColor: hex(BAND_A),
        secondBandColor: hex(BAND_B),
      },
    },
  },
});

// 7. Dropdown: voice, translation_mode, status
const dropdown = (index, values) => ({
  setDataValidation: {
    range: col(index),
    rule: {
      condition: { type: "ONE_OF_LIST", values: values.map((v) => ({ userEnteredValue: v })) },
      strict: true,
      showCustomUi: true,
    },
  },
});
requests.push(dropdown(5, VOICES));
requests.push(dropdown(6, MODES));
requests.push(dropdown(7, Object.keys(STATUS)));

// 8. Ô status đổi màu theo giá trị (chip)
let ruleIndex = 0;
for (const [value, { bg, fg }] of Object.entries(STATUS)) {
  requests.push({
    addConditionalFormatRule: {
      index: ruleIndex++,
      rule: {
        ranges: [col(7)],
        booleanRule: {
          condition: { type: "TEXT_EQ", values: [{ userEnteredValue: value }] },
          format: { backgroundColor: hex(bg), textFormat: { bold: true, foregroundColor: hex(fg) } },
        },
      },
    },
  });
}

// 9. Cả dòng ửng đỏ nhạt khi ERROR để đập vào mắt
requests.push({
  addConditionalFormatRule: {
    index: ruleIndex++,
    rule: {
      ranges: [data],
      booleanRule: {
        condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: '=$H2="ERROR"' }] },
        format: { backgroundColor: hex("#FEF2F2") },
      },
    },
  },
});

// 10. Định dạng số cho duration / process_time
for (const i of [10, 11]) {
  requests.push({
    repeatCell: {
      range: col(i),
      cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: '0" s"' } } },
      fields: "userEnteredFormat.numberFormat",
    },
  });
}

// 11. Bộ lọc trên hàng tiêu đề
requests.push({ setBasicFilter: { filter: { range: all } } });

// 12. (tuỳ chọn) xoá sạch dữ liệu — dùng cho file mẫu
if (CLEAR_DATA) {
  requests.push({ updateCells: { range: data, fields: "userEnteredValue" } });
}

await api(token, `${SPREADSHEET_ID}:batchUpdate`, {
  method: "POST",
  body: JSON.stringify({ requests }),
});

console.log(`✓ Đã trang trí ${requests.length} thay đổi${CLEAR_DATA ? " (đã xoá dữ liệu)" : ""}`);
console.log(`→ https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`);
