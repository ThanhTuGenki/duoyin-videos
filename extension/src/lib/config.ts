export interface ExtensionConfig {
  inboxFolderId: string;
  spreadsheetId: string;
}

// Nơi lưu đang dùng (contract/sheet-columns.md)
export const DEFAULT_CONFIG: ExtensionConfig = {
  inboxFolderId: "1PbeSJv39pGnu0yLxqZpBkTZfpaUcRgLj",
  spreadsheetId: "1tLx0SQUqWQ1q7qGpkdcH0ATMYGdCSPA9AUMqLRHyFRY",
};

/** Sheet đã bỏ/đã xoá — tự chuyển về mặc định thay vì để người dùng gặp lỗi 404 khó hiểu. */
const STALE_SPREADSHEET_IDS = new Set(["1yrp2Jxp-Uj5WD5RIJMzXWkQaTe7TwHdNmWnmJuqPmTw"]);

export async function loadConfig(): Promise<ExtensionConfig> {
  const stored = (await chrome.storage.sync.get(DEFAULT_CONFIG)) as ExtensionConfig;
  const spreadsheetId =
    !stored.spreadsheetId || STALE_SPREADSHEET_IDS.has(stored.spreadsheetId)
      ? DEFAULT_CONFIG.spreadsheetId
      : stored.spreadsheetId;
  return {
    inboxFolderId: stored.inboxFolderId || DEFAULT_CONFIG.inboxFolderId,
    spreadsheetId,
  };
}

export async function saveConfig(cfg: ExtensionConfig): Promise<void> {
  await chrome.storage.sync.set(cfg);
}
