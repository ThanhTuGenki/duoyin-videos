const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";

interface SheetProps {
  title: string;
  sheetId: number;
}

/** Tab đầu tiên (Sheet convert từ CSV có tên tab không cố định). */
async function firstSheet(token: string, spreadsheetId: string): Promise<SheetProps> {
  const res = await fetch(`${SHEETS}/${spreadsheetId}?fields=sheets.properties(title,sheetId)`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Sheets API ${res.status}: ${await res.text().catch(() => "")}`);
  const json = (await res.json()) as { sheets: { properties: SheetProps }[] };
  const props = json.sheets?.[0]?.properties;
  if (!props) throw new Error("Không tìm thấy tab nào trong spreadsheet");
  return props;
}

async function firstSheetTitle(token: string, spreadsheetId: string): Promise<string> {
  return (await firstSheet(token, spreadsheetId)).title;
}

export async function appendRow(token: string, spreadsheetId: string, row: string[]): Promise<void> {
  const tab = await firstSheetTitle(token, spreadsheetId);
  const range = encodeURIComponent(`${tab}!A:M`);
  const res = await fetch(
    `${SHEETS}/${spreadsheetId}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [row] }),
    },
  );
  if (!res.ok) throw new Error(`Ghi Sheet thất bại ${res.status}: ${await res.text().catch(() => "")}`);
}

// ── Trang trí sheet queue (chạy 1 lần từ Options) ────────────────

const STATUS_COLORS: Record<string, { bg: [number, number, number]; fg: [number, number, number] }> = {
  NEW: { bg: [0.86, 0.92, 1], fg: [0.11, 0.31, 0.85] },
  DONE: { bg: [0.82, 0.98, 0.9], fg: [0.02, 0.47, 0.34] },
  ERROR: { bg: [1, 0.89, 0.89], fg: [0.73, 0.11, 0.11] },
  DOWNLOADING: { bg: [1, 0.95, 0.78], fg: [0.57, 0.25, 0.05] },
  PROCESSING: { bg: [1, 0.95, 0.78], fg: [0.57, 0.25, 0.05] },
  MUXING: { bg: [1, 0.95, 0.78], fg: [0.57, 0.25, 0.05] },
  UPLOADING: { bg: [1, 0.95, 0.78], fg: [0.57, 0.25, 0.05] },
};

function rgb([red, green, blue]: [number, number, number]) {
  return { red, green, blue };
}

const MAX_ROWS = 2000;
const COL = { voice: 5, translation_mode: 6, status: 7 }; // index 0-based: F, G, H
const WIDTHS = [170, 340, 140, 240, 240, 120, 140, 130, 240, 240, 90, 110, 170];

function oneOfList(values: string[]) {
  return {
    condition: { type: "ONE_OF_LIST", values: values.map((v) => ({ userEnteredValue: v })) },
    strict: false,
    showCustomUi: true,
  };
}

/** Header đậm nền tối + freeze, dropdown cho voice/translation_mode/status, màu theo status, độ rộng cột. */
export async function formatQueueSheet(token: string, spreadsheetId: string): Promise<void> {
  const { sheetId } = await firstSheet(token, spreadsheetId);
  const dvRange = (col: number) => ({
    sheetId, startRowIndex: 1, endRowIndex: MAX_ROWS, startColumnIndex: col, endColumnIndex: col + 1,
  });
  const statusRange = dvRange(COL.status);

  const requests: unknown[] = [
    // Freeze hàng header
    {
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
        fields: "gridProperties.frozenRowCount",
      },
    },
    // Header: nền tối chữ trắng đậm, căn giữa
    {
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 13 },
        cell: {
          userEnteredFormat: {
            backgroundColor: rgb([0.12, 0.16, 0.22]),
            horizontalAlignment: "CENTER",
            textFormat: { bold: true, foregroundColor: rgb([1, 1, 1]) },
          },
        },
        fields: "userEnteredFormat(backgroundColor,horizontalAlignment,textFormat)",
      },
    },
    // Dropdowns
    { setDataValidation: { range: dvRange(COL.voice), rule: oneOfList(["default", "nu-mien-bac", "nam-mien-bac", "nu-mien-nam", "nam-mien-nam"]) } },
    { setDataValidation: { range: dvRange(COL.translation_mode), rule: oneOfList(["fast", "cinematic", "autofit"]) } },
    { setDataValidation: { range: dvRange(COL.status), rule: oneOfList(Object.keys(STATUS_COLORS)) } },
    // Độ rộng cột
    ...WIDTHS.map((pixelSize, i) => ({
      updateDimensionProperties: {
        range: { sheetId, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 },
        properties: { pixelSize },
        fields: "pixelSize",
      },
    })),
    // Màu theo status
    ...Object.entries(STATUS_COLORS).map(([value, { bg, fg }], index) => ({
      addConditionalFormatRule: {
        index,
        rule: {
          ranges: [statusRange],
          booleanRule: {
            condition: { type: "TEXT_EQ", values: [{ userEnteredValue: value }] },
            format: { backgroundColor: rgb(bg), textFormat: { bold: true, foregroundColor: rgb(fg) } },
          },
        },
      },
    })),
  ];

  const res = await fetch(`${SHEETS}/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) throw new Error(`Trang trí Sheet thất bại ${res.status}: ${await res.text().catch(() => "")}`);
}
