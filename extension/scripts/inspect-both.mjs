// Soi tất cả tab douyin: DOM quanh video + RENDER_DATA, tìm aweme khớp modal_id.
import { chromium } from "playwright";

const browser = await chromium.connectOverCDP("http://localhost:9223");
const context = browser.contexts()[0];
const tabs = context.pages().filter((p) => p.url().includes("douyin.com"));

for (const page of tabs) {
  const url = page.url();
  const modalId = url.match(/modal_id=(\d+)/)?.[1] || url.match(/\/video\/(\d+)/)?.[1] || null;
  console.log(`\n${"=".repeat(70)}\nTAB: ${url}\nmodal_id/videoId: ${modalId}\n${"=".repeat(70)}`);

  const r = await page.evaluate((modalId) => {
    const out = {};

    // 1. DOM: video thật (có src blob hoặc kích thước) + text quanh nó
    const vids = Array.from(document.querySelectorAll("video")).map((v) => ({
      hasBlobSrc: v.src.startsWith("blob:"),
      poster: v.poster.slice(0, 80),
      w: v.videoWidth, h: v.videoHeight,
      duration: Math.round(v.duration || 0),
      parent: (v.parentElement?.className || "").toString().slice(0, 60),
    }));
    out.videos = vids;

    // 2. data-e2e hiện có
    const e2e = {};
    document.querySelectorAll("[data-e2e]").forEach((el) => {
      const k = el.getAttribute("data-e2e");
      e2e[k] = (e2e[k] || 0) + 1;
    });
    out.dataE2E = Object.keys(e2e);

    // 3. text ứng viên title/author (mọi selector khả nghi)
    out.texts = {};
    for (const sel of [
      '[data-e2e="video-desc"]', '[data-e2e="detail-video-title"]',
      '[data-e2e="video-detail-nickname"]', '[data-e2e="detail-video-nickname"]',
      '[data-e2e="user-name"]', 'h1', '[class*="title"]', '[class*="desc"]', '[class*="Nickname"]', '[class*="account"]',
    ]) {
      const t = Array.from(document.querySelectorAll(sel)).map((e) => e.textContent?.trim().slice(0, 60)).filter(Boolean).slice(0, 3);
      if (t.length) out.texts[sel] = t;
    }

    // 4. RENDER_DATA / SSR: tìm object aweme khớp modal_id
    const getText = () => {
      const rd = document.querySelector("#RENDER_DATA")?.textContent || "";
      let dec = rd; try { dec = decodeURIComponent(rd); } catch {}
      let ssr = ""; try { ssr = typeof window.SSR_RENDER_DATA === "string" ? window.SSR_RENDER_DATA : JSON.stringify(window.SSR_RENDER_DATA || ""); } catch {}
      return dec.length > ssr.length ? dec : ssr;
    };
    const text = getText();
    out.renderData = { length: text.length, hasAwemeId: text.includes("aweme_id"), hasDesc: text.includes('"desc"'), hasPlayAddr: text.includes("play_addr") };

    // trích object bao quanh modal_id (nếu có) hoặc quanh "aweme_id" đầu tiên
    const anchor = modalId && text.includes(modalId) ? text.indexOf(modalId) : text.indexOf("aweme_id");
    if (anchor >= 0) {
      let start = text.lastIndexOf("{", anchor);
      for (let tries = 0; tries < 8 && start >= 0; tries++) {
        let depth = 0;
        for (let i = start; i < Math.min(text.length, start + 80000); i++) {
          if (text[i] === "{") depth++;
          else if (text[i] === "}") { depth--; if (depth === 0) {
            try { const o = JSON.parse(text.slice(start, i + 1)); if (o.aweme_id || o.desc) { out.aweme = {
              keys: Object.keys(o).slice(0, 40), aweme_id: o.aweme_id, desc: (o.desc||"").slice(0,90),
              nickname: o.author?.nickname, statistics: o.statistics,
              cover: o.video?.cover?.url_list?.[0] || o.video?.origin_cover?.url_list?.[0],
              playAddr: o.video?.play_addr?.url_list?.[0], duration: o.video?.duration,
              tags: (o.text_extra||[]).map((t)=>t.hashtag_name).filter(Boolean).slice(0,5),
            }; } } catch {}
            break; } }
        }
        if (out.aweme) break;
        start = text.lastIndexOf("{", start - 1);
      }
    }
    return out;
  }, modalId);

  console.log(JSON.stringify(r, null, 2));
}
await browser.close();
