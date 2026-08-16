// Gắn vào Chrome đang chạy (mở sẵn với --remote-debugging-port=9223) để đọc log:
// console các trang + ring-buffer __ingestLogs trong service worker của extension.
// KHÔNG điều khiển browser — chỉ đọc, nên Google không coi là automation khi đăng nhập.
import { chromium } from "playwright";

const context = (await chromium.connectOverCDP("http://localhost:9223")).contexts()[0];
console.log("[dev] Đã gắn vào Chrome (cổng 9223). Log sẽ hiện ở đây.\n");

function hookPage(page) {
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.text().includes("[ingest]")) {
      console.log(`[page:${msg.type()}] ${msg.text().slice(0, 300)}`);
    }
  });
}
context.pages().forEach(hookPage);
context.on("page", hookPage);

let printed = 0;
setInterval(async () => {
  const workers = context.serviceWorkers().filter((w) => w.url().startsWith("chrome-extension://"));
  for (const w of workers) {
    try {
      const logs = await w.evaluate(() => globalThis.__ingestLogs ?? []);
      if (printed > logs.length) printed = 0;
      for (; printed < logs.length; printed++) console.log(`[sw] ${logs[printed]}`);
    } catch {
      /* worker đang ngủ */
    }
  }
}, 1000);
