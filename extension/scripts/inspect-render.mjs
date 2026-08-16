// Soi nguồn metadata thật: #RENDER_DATA, SSR_RENDER_DATA, pace RSC cache, mobx.
// Tìm object aweme (có aweme_id + desc) và in cấu trúc.
import { chromium } from "playwright";

const browser = await chromium.connectOverCDP("http://localhost:9223");
const context = browser.contexts()[0];
const page = context.pages().find((p) => p.url().includes("douyin.com")) || context.pages().at(-1);
console.log(`Tab: ${page.url()}`);
console.log(`pageType: ${/\/video\/\d+/.test(page.url()) ? "DETAIL" : "FEED/OTHER"}\n`);

const out = await page.evaluate(() => {
  const results = { sources: {}, awemeFound: null };

  // Gom các nguồn text/JSON khả nghi
  const candidates = {};

  // #RENDER_DATA (thường là URI-encoded JSON)
  const rd = document.querySelector("#RENDER_DATA")?.textContent;
  if (rd) {
    candidates["#RENDER_DATA"] = rd;
    try {
      candidates["#RENDER_DATA(decoded)"] = decodeURIComponent(rd);
    } catch { /* */ }
  }

  // window globals dạng object
  for (const k of ["SSR_RENDER_DATA", "__INIT_PROPS__", "__INITIAL_STATE__"]) {
    try {
      const v = window[k];
      if (v) candidates[k] = typeof v === "string" ? v : JSON.stringify(v);
    } catch { /* */ }
  }

  // pace RSC flight cache
  try {
    if (window.__pace_f) candidates["__pace_f"] = JSON.stringify(window.__pace_f).slice(0, 200000);
  } catch { /* */ }
  try {
    if (window.__pace_rsc_cache) candidates["__pace_rsc_cache"] = JSON.stringify([...(window.__pace_rsc_cache?.entries?.() ?? [])]).slice(0, 200000);
  } catch { /* */ }
  try {
    if (window.__MF_DATA_FETCH_MAP__) candidates["__MF_DATA_FETCH_MAP__"] = JSON.stringify(window.__MF_DATA_FETCH_MAP__).slice(0, 200000);
  } catch { /* */ }

  // Báo cáo nguồn nào có chứa dấu hiệu aweme
  for (const [name, text] of Object.entries(candidates)) {
    results.sources[name] = {
      length: text.length,
      hasAwemeId: text.includes("aweme_id"),
      hasDesc: text.includes('"desc"'),
      hasPlayAddr: text.includes("play_addr"),
      hasNickname: text.includes("nickname"),
    };
  }

  // Thử trích 1 object aweme từ nguồn giàu nhất
  const findAweme = (text) => {
    // tìm vị trí "aweme_id" rồi cắt object JSON bao quanh (heuristic)
    const idx = text.indexOf("aweme_id");
    if (idx < 0) return null;
    // lùi về dấu { gần nhất ở mức hợp lý, tiến tới } cân bằng
    let start = text.lastIndexOf("{", idx);
    for (let tries = 0; tries < 5 && start >= 0; tries++) {
      let depth = 0;
      for (let i = start; i < Math.min(text.length, start + 60000); i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}") {
          depth--;
          if (depth === 0) {
            try {
              const obj = JSON.parse(text.slice(start, i + 1));
              if (obj.aweme_id || obj.desc) return obj;
            } catch { /* */ }
            break;
          }
        }
      }
      start = text.lastIndexOf("{", start - 1);
    }
    return null;
  };

  for (const [name, text] of Object.entries(candidates)) {
    if (!text.includes("aweme_id")) continue;
    const obj = findAweme(text);
    if (obj) {
      results.awemeFound = {
        source: name,
        keys: Object.keys(obj).slice(0, 40),
        aweme_id: obj.aweme_id,
        desc: (obj.desc || "").slice(0, 100),
        nickname: obj.author?.nickname,
        statistics: obj.statistics,
        videoKeys: obj.video ? Object.keys(obj.video) : null,
        cover: obj.video?.cover?.url_list?.[0] || obj.video?.origin_cover?.url_list?.[0],
        playAddr: obj.video?.play_addr?.url_list?.[0],
        duration: obj.video?.duration ?? obj.duration,
        textExtra: (obj.text_extra || []).slice(0, 3).map((t) => t.hashtag_name),
      };
      break;
    }
  }

  return results;
});

console.log("=== NGUỒN CÓ DẤU HIỆU AWEME ===");
console.log(JSON.stringify(out.sources, null, 2));
console.log("\n=== AWEME TRÍCH ĐƯỢC ===");
console.log(JSON.stringify(out.awemeFound, null, 2));

await browser.close();
