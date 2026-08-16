// Soi trang Douyin đang mở (qua CDP cổng 9223): URL, cấu trúc DOM quanh video,
// data-e2e có sẵn, video/poster, og:meta. KHÔNG sửa gì — chỉ đọc.
import { chromium } from "playwright";

const browser = await chromium.connectOverCDP("http://localhost:9223");
const context = browser.contexts()[0];
const pages = context.pages();

console.log("=== CÁC TAB ĐANG MỞ ===");
pages.forEach((p, i) => console.log(`[${i}] ${p.url()}`));

// Chọn tab douyin video/feed
const page =
  pages.find((p) => /douyin\.com\/(video|jingxuan|discover|user|search)/.test(p.url())) ||
  pages.find((p) => p.url().includes("douyin.com")) ||
  pages[pages.length - 1];

console.log(`\n=== SOI TAB: ${page.url()} ===\n`);

const report = await page.evaluate(() => {
  const out = {};
  out.url = location.href;
  out.pageType = /\/video\/\d+/.test(location.href)
    ? "DETAIL"
    : /\/(jingxuan|discover|follow|user)/.test(location.href)
      ? "FEED/LIST"
      : "OTHER";

  // og meta
  out.og = {};
  document.querySelectorAll('meta[property^="og:"], meta[name^="og:"]').forEach((m) => {
    out.og[m.getAttribute("property") || m.getAttribute("name")] = m.content.slice(0, 120);
  });

  // Tất cả data-e2e trên trang (đếm)
  const e2e = {};
  document.querySelectorAll("[data-e2e]").forEach((el) => {
    const k = el.getAttribute("data-e2e");
    e2e[k] = (e2e[k] || 0) + 1;
  });
  out.dataE2E = e2e;

  // Video elements
  out.videos = Array.from(document.querySelectorAll("video")).map((v) => ({
    src: v.src.slice(0, 80),
    poster: v.poster.slice(0, 100),
    duration: v.duration,
    w: v.videoWidth,
    h: v.videoHeight,
    parentClass: v.parentElement?.className?.slice(0, 80),
    grandParentClass: v.parentElement?.parentElement?.className?.slice(0, 80),
  }));

  // Với video đầu tiên: leo cây cha 6 tầng, xem có data-e2e/link/text gì
  const v0 = document.querySelector("video");
  out.ancestryOfFirstVideo = [];
  let el = v0?.parentElement;
  for (let i = 0; i < 8 && el; i++, el = el.parentElement) {
    out.ancestryOfFirstVideo.push({
      tag: el.tagName,
      class: (el.className || "").toString().slice(0, 90),
      dataE2E: el.getAttribute?.("data-e2e") || null,
      hasVideoLink: !!el.querySelector?.('a[href*="/video/"]'),
      videoLinkHref: el.querySelector?.('a[href*="/video/"]')?.getAttribute("href")?.slice(0, 60) || null,
    });
  }

  // Text quanh video đầu (tìm title/author ứng viên)
  out.candidateTexts = {};
  for (const sel of [
    '[data-e2e="detail-video-title"]',
    '[data-e2e="video-desc"]',
    '[data-e2e="feed-video-desc"]',
    '[data-e2e="video-title"]',
    '[data-e2e="detail-video-nickname"]',
    '[data-e2e="feed-video-nickname"]',
    '[data-e2e="video-author-name"]',
    '[data-e2e="user-name"]',
  ]) {
    const found = Array.from(document.querySelectorAll(sel)).map((e) => e.textContent?.trim().slice(0, 60));
    if (found.length) out.candidateTexts[sel] = found;
  }

  // Ảnh lớn (thumbnail ứng viên)
  out.bigImages = Array.from(document.querySelectorAll("img"))
    .filter((im) => im.naturalWidth >= 150)
    .slice(0, 8)
    .map((im) => ({ w: im.naturalWidth, h: im.naturalHeight, src: im.src.slice(0, 90) }));

  return out;
});

console.log(JSON.stringify(report, null, 2));
await browser.close();
