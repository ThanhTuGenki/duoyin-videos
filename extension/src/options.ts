import { loadConfig, saveConfig } from "./lib/config";
import { withFreshToken } from "./lib/auth";
import { formatQueueSheet } from "./lib/sheets";

const inboxInput = document.getElementById("inboxFolderId") as HTMLInputElement;
const sheetInput = document.getElementById("spreadsheetId") as HTMLInputElement;
const status = document.getElementById("status") as HTMLSpanElement;

loadConfig().then((cfg) => {
  inboxInput.value = cfg.inboxFolderId;
  sheetInput.value = cfg.spreadsheetId;
});

document.getElementById("save")?.addEventListener("click", async () => {
  await saveConfig({
    inboxFolderId: inboxInput.value.trim(),
    spreadsheetId: sheetInput.value.trim(),
  });
  status.textContent = "Đã lưu";
  setTimeout(() => (status.textContent = ""), 2000);
});

document.getElementById("format")?.addEventListener("click", async () => {
  status.textContent = "Đang trang trí Sheet…";
  try {
    const cfg = await loadConfig();
    await withFreshToken((token) => formatQueueSheet(token, cfg.spreadsheetId));
    status.textContent = "Xong — mở Sheet xem thử";
  } catch (e) {
    status.textContent = `Lỗi: ${e instanceof Error ? e.message : String(e)}`;
  }
});
