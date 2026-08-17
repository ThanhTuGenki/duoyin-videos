const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";

/** Tên tab đầu tiên (Sheet convert từ CSV/xlsx có tên tab không cố định). */
async function firstSheetTitle(token: string, spreadsheetId: string): Promise<string> {
  const res = await fetch(`${SHEETS}/${spreadsheetId}?fields=sheets.properties.title`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Sheets API ${res.status}: ${await res.text().catch(() => "")}`);
  const json = (await res.json()) as { sheets: { properties: { title: string } }[] };
  const title = json.sheets?.[0]?.properties?.title;
  if (!title) throw new Error("Không tìm thấy tab nào trong spreadsheet");
  return title;
}

/**
 * Ghi một dòng vào ngay dưới dữ liệu hiện có.
 *
 * KHÔNG dùng `values:append`: khi sheet có Google Sheets Table, append coi cả
 * vùng Table là đã chiếm chỗ nên ghi xuống dòng cuối (vd. dòng 301) — dữ liệu
 * vào thật nhưng người dùng phải cuộn hết bảng mới thấy. Ở đây tự tính dòng
 * trống đầu tiên theo cột A rồi ghi thẳng vào đó.
 */
export async function appendRow(token: string, spreadsheetId: string, row: string[]): Promise<void> {
  const tab = await firstSheetTitle(token, spreadsheetId);
  const auth = { Authorization: `Bearer ${token}` };

  const used = await fetch(`${SHEETS}/${spreadsheetId}/values/${encodeURIComponent(`${tab}!A1:A`)}`, {
    headers: auth,
  });
  if (!used.ok) throw new Error(`Đọc Sheet thất bại ${used.status}: ${(await used.text().catch(() => "")).slice(0, 200)}`);
  const filled = ((await used.json()) as { values?: string[][] }).values?.length ?? 0;
  const target = Math.max(filled, 1) + 1; // dòng 1 là header → dòng dữ liệu đầu tiên là 2

  const range = encodeURIComponent(`${tab}!A${target}:M${target}`);
  const res = await fetch(`${SHEETS}/${spreadsheetId}/values/${range}?valueInputOption=RAW`, {
    method: "PUT",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [row] }),
  });
  if (!res.ok) throw new Error(`Ghi Sheet thất bại ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
}

/**
 * Kiểm tra Sheet có truy cập được không — gọi TRƯỚC khi tải/upload video nặng,
 * để cấu hình sai không làm phí cả trăm MB băng thông rồi mới báo lỗi.
 */
export async function assertSheetReachable(token: string, spreadsheetId: string): Promise<void> {
  const res = await fetch(`${SHEETS}/${spreadsheetId}?fields=spreadsheetId`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) {
    throw new Error(
      `Không tìm thấy Sheet (${spreadsheetId}) — sheet đã bị xoá hoặc ID sai. ` +
        `Sửa lại trong Options của extension.`,
    );
  }
  if (!res.ok) {
    throw new Error(`Không truy cập được Sheet ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }
}
