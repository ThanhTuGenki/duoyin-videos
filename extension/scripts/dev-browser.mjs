// Mở Chrome (profile dev riêng) với extension đã nạp, stream log của
// service worker + console các trang ra stdout để debug trực tiếp.
// Chạy: node scripts/dev-browser.mjs  (Ctrl+C để đóng)
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const extDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
const profileDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.dev-profile");

const context = await chromium.launchPersistentContext(profileDir, {
  channel: "chrome", // dùng Google Chrome thật trên máy (identity API hoạt động)
  headless: false,
  viewport: null,
  // Playwright mặc định thêm --disable-extensions → chặn cả Load unpacked.
  // Chrome ≥137 đã bỏ --load-extension nên phải Load unpacked bằng UI (1 lần,
  // profile nhớ). Bỏ các cờ chặn extension khỏi default args:
  ignoreDefaultArgs: ["--disable-extensions", "--disable-component-extensions-with-background-pages"],
  args: ["--no-first-run", "--lang=vi"],
});

console.log(`[dev] Chrome đã mở — extension nạp từ ${extDir}`);
console.log("[dev] Hãy thao tác trong cửa sổ đó. Log sẽ hiện ở đây.\n");

function hookPage(page) {
  page.on("console", (msg) => {
    const t = msg.type();
    if (t === "error" || t === "warning" || msg.text().includes("[ingest]")) {
      console.log(`[page:${t}] ${msg.text().slice(0, 300)}`);
    }
  });
  page.on("pageerror", (err) => console.log(`[pageerror] ${String(err).slice(0, 300)}`));
}
context.pages().forEach(hookPage);
context.on("page", hookPage);

// Poll ring-buffer log trong service worker của extension
let printed = 0;
setInterval(async () => {
  const workers = context.serviceWorkers().filter((w) => w.url().startsWith("chrome-extension://"));
  for (const w of workers) {
    try {
      const logs = await w.evaluate(() => globalThis.__ingestLogs ?? []);
      if (printed > logs.length) printed = 0; // worker restart → buffer mới
      for (; printed < logs.length; printed++) console.log(`[sw] ${logs[printed]}`);
    } catch {
      /* worker đang ngủ / vừa restart */
    }
  }
}, 1000);

const page = context.pages()[0] ?? (await context.newPage());
await page.goto("https://www.douyin.com").catch(() => {});

context.on("close", () => process.exit(0));
