export interface ExtensionConfig {
  inboxFolderId: string;
  spreadsheetId: string;
}

// Mặc định trỏ vào nơi lưu thật đã tạo 16.08.2026 (contract/sheet-columns.md)
export const DEFAULT_CONFIG: ExtensionConfig = {
  inboxFolderId: "1PbeSJv39pGnu0yLxqZpBkTZfpaUcRgLj",
  spreadsheetId: "1yrp2Jxp-Uj5WD5RIJMzXWkQaTe7TwHdNmWnmJuqPmTw",
};

export async function loadConfig(): Promise<ExtensionConfig> {
  const stored = await chrome.storage.sync.get(DEFAULT_CONFIG);
  return stored as ExtensionConfig;
}

export async function saveConfig(cfg: ExtensionConfig): Promise<void> {
  await chrome.storage.sync.set(cfg);
}
