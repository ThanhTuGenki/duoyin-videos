// Chụp ảnh Sheet queue để tự kiểm tra kết quả trang trí.
import { chromium } from "playwright";

const id = process.argv[2] ?? "1yrp2Jxp-Uj5WD5RIJMzXWkQaTe7TwHdNmWnmJuqPmTw";
const out = process.argv[3] ?? "/private/tmp/claude-501/-Users-genkisystem/66ddc9f6-8229-4d87-8234-36ad39826bf5/scratchpad/sheet.png";

const browser = await chromium.connectOverCDP("http://localhost:9223");
const context = browser.contexts()[0];
const page = await context.newPage();
await page.setViewportSize({ width: 1600, height: 900 });
await page.goto(`https://docs.google.com/spreadsheets/d/${id}/edit`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(7000);
await page.screenshot({ path: out });
console.log("saved", out);
await page.close();
await browser.close();
