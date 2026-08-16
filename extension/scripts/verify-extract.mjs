// Chạy logic extractActive (bản rút gọn) trực tiếp trên trang modal đang mở để
// xác nhận metadata đúng TRƯỚC khi bảo user test extension.
import { chromium } from "playwright";
const browser = await chromium.connectOverCDP("http://localhost:9223");
const page = browser.contexts()[0].pages().find((p) => p.url().includes("modal_id"));
if (!page) { console.log("Không có tab modal_id nào đang mở"); process.exit(0); }
console.log(`Tab: ${page.url()}\n`);

const result = await page.evaluate(() => {
  const id = new URLSearchParams(location.search).get("modal_id");
  const active = document.querySelector('[data-e2e="feed-active-video"]');
  if (!id || !active) return { error: "no active/modal" };
  const clean = (s) => (s || "").replace(/(展开|收起|展開)$/u, "").trim();
  const q = (sel) => active.querySelector(sel)?.textContent?.trim() || "";
  const count = (s) => { const m = (s||"").match(/([\d.]+)\s*(万|w|k)?/i); if(!m) return 0; const n=parseFloat(m[1]); const u=m[2]; return Math.round(u==="万"||/w/i.test(u||"")?n*1e4:/k/i.test(u||"")?n*1e3:n); };

  // RENDER_DATA
  let rd = null;
  const raw = document.querySelector("#RENDER_DATA")?.textContent || "";
  let text = raw; try { text = decodeURIComponent(raw); } catch {}
  const anchor = text.indexOf(id);
  if (anchor >= 0) {
    let start = text.lastIndexOf("{", anchor);
    for (let t=0;t<8&&start>=0;t++){let d=0;for(let i=start;i<Math.min(text.length,start+90000);i++){if(text[i]==="{")d++;else if(text[i]==="}"){if(--d===0){try{const o=JSON.parse(text.slice(start,i+1));if((o.awemeId===id||o.desc)&&(o.desc||o.video)){rd={desc:clean(o.desc),author:o.authorInfo?.nickname||"",cover:o.video?.cover||o.video?.coverUrlList?.[0]||"",tags:(o.textExtra||[]).map(x=>x.hashtagName).filter(Boolean)};}}catch{}break;}}}if(rd)break;start=text.lastIndexOf("{",start-1);}
  }

  const imgs = [...active.querySelectorAll("img")].filter(im=>im.src.startsWith("http")&&im.naturalWidth>=300).sort((a,b)=>b.naturalWidth-a.naturalWidth);
  return {
    id: `dy-${id}`,
    title: rd?.desc || clean(q('[data-e2e="video-desc"]')),
    author: rd?.author || q('[data-e2e="feed-video-nickname"]').replace(/^@/,""),
    tags: rd?.tags || [],
    likes: count(q('[data-e2e="video-player-digg"]')),
    shares: count(q('[data-e2e="video-player-share"]')),
    thumbUrl: (rd?.cover || imgs[0]?.src || "").slice(0,80),
    titleSource: rd?.desc ? "RENDER_DATA(gốc TQ)" : "DOM(dịch)",
  };
});
console.log(JSON.stringify(result, null, 2));
await browser.close();
