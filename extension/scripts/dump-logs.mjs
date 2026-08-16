// Đọc một phát toàn bộ ring buffer log của extension rồi thoát.
// Bền hơn attach-logs.mjs (streamer chạy dài hay bị kill).
//   node scripts/dump-logs.mjs [số dòng cuối, mặc định 40]
import { chromium } from "playwright";

const tail = Number(process.argv[2] ?? 40);
const browser = await chromium.connectOverCDP("http://localhost:9223");
const context = browser.contexts()[0];

let worker = context.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"));
if (!worker) {
  // đánh thức service worker qua trang options
  const page = await context.newPage();
  await page.goto("chrome-extension://bbhcmfeedghfopbijnbjnhdfenfdinli/options.html").catch(() => {});
  await page.waitForTimeout(1200);
  worker = context.serviceWorkers().find((w) => w.url().startsWith("chrome-extension://"));
  await page.close().catch(() => {});
}
if (!worker) {
  console.log("Không thấy service worker — extension đã load chưa?");
} else {
  const logs = await worker.evaluate(() => globalThis.__ingestLogs ?? []);
  console.log(logs.length ? logs.slice(-tail).join("\n") : "(chưa có log nào)");
}
await browser.close();
