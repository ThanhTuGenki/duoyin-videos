// Nghe network 25s (bạn cuộn feed / mở video trong lúc này) + tìm title đang hiển thị.
// Dump: URL các response chứa aweme_id, cấu trúc key của aweme đầu tiên.
import { chromium } from "playwright";

const browser = await chromium.connectOverCDP("http://localhost:9223");
const context = browser.contexts()[0];
const page =
  context.pages().find((p) => p.url().includes("douyin.com")) ||
  context.pages()[context.pages().length - 1];

console.log(`Tab: ${page.url()}`);
console.log("Đang nghe network 25s — HÃY CUỘN FEED và/hoặc mở 1 video trong lúc này…\n");

const seen = new Set();
page.on("response", async (res) => {
  const url = res.url();
  if (!/aweme|feed|jingxuan|detail|related|post/.test(url)) return;
  const ct = res.headers()["content-type"] || "";
  if (!ct.includes("json")) return;
  try {
    const body = await res.text();
    if (!body.includes("aweme_id")) return;
    const json = JSON.parse(body);

    // Tìm mảng aweme đầu tiên trong response
    let sample = json.aweme_detail;
    let listKey = "aweme_detail";
    for (const k of ["aweme_list", "data", "cards", "aweme"]) {
      if (Array.isArray(json[k]) && json[k].length) {
        const first = json[k][0];
        sample = first?.aweme_info ?? first?.aweme ?? first;
        listKey = k;
        break;
      }
    }
    const key = url.split("?")[0];
    if (seen.has(key)) return;
    seen.add(key);

    console.log(`\n########## ${key}`);
    console.log(`listKey=${listKey}`);
    if (sample && typeof sample === "object") {
      console.log("aweme keys:", Object.keys(sample).slice(0, 40).join(", "));
      console.log("aweme_id:", sample.aweme_id);
      console.log("desc:", (sample.desc || "").slice(0, 80));
      console.log("author.nickname:", sample.author?.nickname);
      console.log("statistics:", JSON.stringify(sample.statistics));
      console.log("video keys:", sample.video ? Object.keys(sample.video).join(", ") : "(no video)");
      console.log("cover url_list[0]:", sample.video?.cover?.url_list?.[0]?.slice(0, 90));
      console.log("play_addr url_list[0]:", sample.video?.play_addr?.url_list?.[0]?.slice(0, 90));
      console.log("text_extra sample:", JSON.stringify(sample.text_extra?.slice(0, 2)));
    }
  } catch {
    /* bỏ qua */
  }
});

await page.waitForTimeout(25000);

// Tìm phần tử chứa title đang hiển thị (bất kỳ text có #hashtag hoặc dài)
const domFind = await page.evaluate(() => {
  const results = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seenTxt = new Set();
  while (walker.nextNode()) {
    const t = walker.currentNode.textContent?.trim() ?? "";
    if (t.length > 12 && (t.includes("#") || /[一-龥]{6,}/.test(t)) && !seenTxt.has(t)) {
      seenTxt.add(t);
      const el = walker.currentNode.parentElement;
      // ancestry data-e2e
      const anc = [];
      let e = el;
      for (let i = 0; i < 5 && e; i++, e = e.parentElement) {
        anc.push(`${e.tagName}.${(e.className || "").toString().slice(0, 40)}${e.getAttribute?.("data-e2e") ? `[e2e=${e.getAttribute("data-e2e")}]` : ""}`);
      }
      results.push({ text: t.slice(0, 70), el: `${el?.tagName}.${(el?.className || "").toString().slice(0, 50)}`, anc });
      if (results.length >= 8) break;
    }
  }
  return results;
});

console.log("\n\n=== TEXT DÀI/HASHTAG TRONG DOM (title/author ứng viên) ===");
console.log(JSON.stringify(domFind, null, 2));

await browser.close();
