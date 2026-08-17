import { loadConfig, saveConfig } from "./lib/config";

const inboxInput = document.getElementById("inboxFolderId") as HTMLInputElement;
const sheetInput = document.getElementById("spreadsheetId") as HTMLInputElement;
const webIdInput = document.getElementById("webClientId") as HTMLInputElement;
const webSecretInput = document.getElementById("webClientSecret") as HTMLInputElement;
const status = document.getElementById("status") as HTMLSpanElement;

loadConfig().then((cfg) => {
  inboxInput.value = cfg.inboxFolderId;
  sheetInput.value = cfg.spreadsheetId;
  webIdInput.value = cfg.webClientId;
  webSecretInput.value = cfg.webClientSecret;
});

document.getElementById("save")?.addEventListener("click", async () => {
  await saveConfig({
    inboxFolderId: inboxInput.value.trim(),
    spreadsheetId: sheetInput.value.trim(),
    webClientId: webIdInput.value.trim(),
    webClientSecret: webSecretInput.value.trim(),
  });
  status.textContent = "Đã lưu";
  setTimeout(() => (status.textContent = ""), 2000);
});
