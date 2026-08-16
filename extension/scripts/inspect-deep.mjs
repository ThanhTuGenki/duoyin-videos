// Điều tra sâu: Shadow DOM, biến global, và TẤT CẢ url network khi cuộn.
import { chromium } from "playwright";

const browser = await chromium.connectOverCDP("http://localhost:9223");
const context = browser.contexts()[0];
const page = context.pages().find((p) => p.url().includes("douyin.com")) || context.pages().at(-1);
console.log(`Tab: ${page.url()}\n`);

// 1. Globals + shadow DOM (đọc ngay)
const probe = await page.evaluate(() => {
  const out = { globals: [], shadowHosts: [], activeVideoProbe: {} };

  // Biến global khả nghi
  for (const k of Object.keys(window)) {
    if (/state|store|aweme|render|__|SSR|INITIAL|reactRoot|pace/i.test(k)) out.globals.push(k);
  }

  // Đếm shadow root + tìm title trong shadow
  const walkShadow = (root, depth) => {
    root.querySelectorAll("*").forEach((el) => {
      if (el.shadowRoot) {
        out.shadowHosts.push(`${el.tagName}.${(el.className || "").toString().slice(0, 40)} depth=${depth}`);
        walkShadow(el.shadowRoot, depth + 1);
      }
    });
  };
  walkShadow(document, 0);

  // Thử các selector video/active phổ biến
  for (const sel of [
    "video",
    '[data-e2e="feed-active-video"]',
    ".swiper-slide-active",
    '[class*="playerContainer"]',
    '[class*="videoInfo"]',
    '[class*="basePlayer"]',
    'xg-video-container',
  ]) {
    out.activeVideoProbe[sel] = document.querySelectorAll(sel).length;
  }

  // Có INITIAL_STATE / RENDER_DATA script không?
  out.hasRenderData = !!document.querySelector("#RENDER_DATA");
  out.scriptIds = Array.from(document.querySelectorAll("script[id]")).map((s) => s.id).slice(0, 20);

  return out;
});
console.log("=== PROBE ===");
console.log(JSON.stringify(probe, null, 2));

// 2. Toàn bộ URL network 20s (bạn cuộn feed trong lúc này)
console.log("\n=== NGHE URL NETWORK 20s — HÃY CUỘN QUA 2-3 VIDEO ===");
const urls = new Set();
page.on("request", (r) => {
  const u = r.url();
  if (/aweme|feed|jingxuan|detail|related|post|slides|module/i.test(u) && !u.match(/\.(js|css|png|jpg|webp|woff)/)) {
    const short = u.split("?")[0];
    if (!urls.has(short)) {
      urls.add(short);
      console.log("→", short);
    }
  }
});
await page.waitForTimeout(20000);

await browser.close();
