// Reload extension rồi kiểm tra nút ＋Q có thật sự xuất hiện trên trang Douyin.
import { chromium } from "playwright";

const EXT_ID = "bbhcmfeedghfopbijnbjnhdfenfdinli";
const browser = await chromium.connectOverCDP("http://localhost:9223");
const context = browser.contexts()[0];

// 1. Nạp lại extension từ đĩa
const opt = await context.newPage();
await opt.goto(`chrome-extension://${EXT_ID}/options.html`);
await opt.waitForTimeout(500);
await opt.evaluate(() => chrome.runtime.reload()).catch(() => {});
console.log("✓ Đã gọi chrome.runtime.reload()");
// Trang options bị đóng ngay khi extension nạp lại — chờ ngoài context của nó
await new Promise((r) => setTimeout(r, 3000));
await opt.close().catch(() => {});

// 2. Nạp lại tab Douyin modal
const tab = context.pages().find((p) => p.url().includes("modal_id")) ||
            context.pages().find((p) => p.url().includes("douyin.com"));
if (!tab) {
  console.log("✗ Không có tab Douyin nào đang mở");
  await browser.close();
  process.exit(0);
}
console.log(`Tab: ${tab.url()}`);

const errors = [];
tab.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
tab.on("console", (m) => {
  if (m.type() === "error" && /content|SyntaxError|Unexpected/.test(m.text())) errors.push(m.text().slice(0, 200));
});

// Douyin tải tài nguyên liên tục nên không chờ sự kiện load, chỉ chờ cố định
await tab.reload({ waitUntil: "commit" }).catch(() => {});
await new Promise((r) => setTimeout(r, 8000));

// 3. Kiểm tra
const r = await tab.evaluate(() => ({
  contentScriptRan: Boolean(window.__duoyinIngest),
  hasActiveContainer: Boolean(document.querySelector('[data-e2e="feed-active-video"]')),
  modalId: new URLSearchParams(location.search).get("modal_id"),
  button: (() => {
    const b = document.querySelector("#duoyin-ingest-btn");
    return b ? { text: b.textContent, bg: getComputedStyle(b).backgroundColor } : null;
  })(),
}));

console.log("\n=== KẾT QUẢ ===");
console.log("content script đã chạy :", r.contentScriptRan ? "✓" : "✗");
console.log("có container active    :", r.hasActiveContainer ? "✓" : "✗");
console.log("modal_id               :", r.modalId ?? "(không có — đang ở feed thuần)");
console.log("nút ＋Q                 :", r.button ? `✓ "${r.button.text}" ${r.button.bg}` : "✗ chưa thấy");
if (errors.length) console.log("\nlỗi trang:", errors.slice(0, 5));

await browser.close();
