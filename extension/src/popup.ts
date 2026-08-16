import type { ExtractRequest, ExtractResponse, IngestRequest, ProgressEvent } from "./lib/messages";

const btn = document.getElementById("go") as HTMLButtonElement;
const log = document.getElementById("log") as HTMLDivElement;

function line(text: string, isError = false): void {
  const div = document.createElement("div");
  div.textContent = text;
  if (isError) div.className = "err";
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

chrome.runtime.onMessage.addListener((msg: ProgressEvent) => {
  if (msg.kind !== "progress") return;
  line(msg.error ? `✗ ${msg.error}` : (msg.done ? `✓ ${msg.step}` : `… ${msg.step}`), Boolean(msg.error));
  if (msg.done) btn.disabled = false;
});

btn.addEventListener("click", async () => {
  btn.disabled = true;
  log.textContent = "";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("Không xác định được tab hiện tại");

    line("… Nhặt metadata từ trang");
    const extract: ExtractRequest = { kind: "extract" };
    const res = (await chrome.tabs.sendMessage(tab.id, extract)) as ExtractResponse;
    if (!res?.ok || !res.page) throw new Error(res?.error ?? "Trang này chưa được hỗ trợ (content script không chạy)");
    line(`✓ ${res.page.title || "(không có title)"}`);

    const ingest: IngestRequest = { kind: "ingest", tabId: tab.id, page: res.page };
    const done = (await chrome.runtime.sendMessage(ingest)) as { ok: boolean; error?: string };
    if (!done?.ok) throw new Error(done?.error ?? "Ingest thất bại không rõ lý do");
  } catch (e) {
    line(`✗ ${e instanceof Error ? e.message : String(e)}`, true);
    btn.disabled = false;
  }
});

document.getElementById("opts")?.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
