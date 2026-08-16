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
