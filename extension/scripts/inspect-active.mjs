// Soi kỹ container video đang active trong modal: stats, thumbnail, cấu trúc.
import { chromium } from "playwright";
const browser = await chromium.connectOverCDP("http://localhost:9223");
const context = browser.contexts()[0];
const page = context.pages().find((p) => p.url().includes("modal_id")) ||
             context.pages().find((p) => p.url().includes("douyin.com"));
console.log(`Tab: ${page.url()}\n`);

const r = await page.evaluate(() => {
  const out = {};
  const active = document.querySelector('[data-e2e="feed-active-video"]');
  out.hasActive = !!active;
  if (!active) return out;

  const q = (sel) => active.querySelector(sel)?.textContent?.trim() || null;
  out.desc = q('[data-e2e="video-desc"]');
  out.nickname = q('[data-e2e="feed-video-nickname"]');
  out.digg = q('[data-e2e="video-player-digg"]');
  out.comment = q('[data-e2e="video-player-comment"]');
  out.collect = q('[data-e2e="video-player-collect"]');
  out.share = q('[data-e2e="video-player-share"]');

  // video-info block: dump text từng dòng
  const info = active.querySelector('[data-e2e="video-info"]');
  out.videoInfoText = info?.innerText?.slice(0, 300);

  // thumbnail: mọi img trong active + background-image
  out.imgs = Array.from(active.querySelectorAll("img"))
    .map((im) => ({ w: im.naturalWidth, h: im.naturalHeight, src: im.src.slice(0, 100) }))
    .filter((x) => x.src.startsWith("http"));
  out.posterBg = [];
  active.querySelectorAll('[class*="poster"], [class*="Poster"], xg-poster').forEach((el) => {
    const bg = getComputedStyle(el).backgroundImage;
    if (bg && bg !== "none") out.posterBg.push(bg.slice(0, 120));
  });

  // link video trong active
  out.videoLink = active.querySelector('a[href*="/video/"]')?.getAttribute("href") || null;

  // video element trong active
  const v = active.querySelector("video");
  out.activeVideo = v ? { blob: v.src.startsWith("blob:"), poster: v.poster.slice(0,80), dur: Math.round(v.duration||0) } : null;

  return out;
});
console.log(JSON.stringify(r, null, 2));

// Lấy cover từ RENDER_DATA (camelCase) cho đúng aweme
const cover = await page.evaluate((modalId) => {
  const rd = document.querySelector("#RENDER_DATA")?.textContent || "";
  let text = rd; try { text = decodeURIComponent(rd); } catch {}
  const anchor = text.indexOf(modalId);
  if (anchor < 0) return { note: "modal_id không có trong RENDER_DATA (data động theo swipe)" };
  let start = text.lastIndexOf("{", anchor);
  for (let t = 0; t < 8 && start >= 0; t++) {
    let d = 0;
    for (let i = start; i < Math.min(text.length, start + 90000); i++) {
      if (text[i] === "{") d++;
      else if (text[i] === "}") { d--; if (d === 0) {
        try { const o = JSON.parse(text.slice(start, i+1)); if (o.awemeId || o.desc) {
          return { awemeId: o.awemeId, desc: (o.desc||"").slice(0,90), author: o.authorInfo?.nickname,
            videoKeys: o.video ? Object.keys(o.video) : null,
            cover: o.video?.cover || o.video?.coverUrl || o.video?.originCover || o.video?.dynamicCover,
            playApi: o.video?.playApi, playAddr: o.video?.playAddr,
            tags: (o.textExtra||[]).map(x=>x.hashtagName).filter(Boolean) }; } } catch {}
        break; } }
    }
    start = text.lastIndexOf("{", start - 1);
  }
  return { note: "không trích được" };
}, (page.url().match(/modal_id=(\d+)/)||[])[1] || "");
console.log("\n=== RENDER_DATA aweme (camelCase) ===");
console.log(JSON.stringify(cover, null, 2));
await browser.close();
