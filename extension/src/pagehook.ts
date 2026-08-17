// Chạy trong MAIN world (page context) — chỉ nơi này đọc được React fiber.
//
// Điều tra thực tế 17.08.2026 trên /jingxuan:
//   - Card feed KHÔNG có data-e2e, KHÔNG có link /video/<id>, class là chuỗi băm.
//   - Nhưng mỗi card mang nguyên object aweme trong React fiber: awemeId, desc,
//     authorInfo, textExtra, statistics, video.cover, video.playAddr,
//     video.bitRateList (23-26 mức, cao nhất 1920x1080) → tải được thẳng, không cần sniff.
//   - Bám ổn định: từ mỗi <img> leo lên, gặp aweme ở đúng độ sâu 2 (56 img → 27 card).
//
// Cách phối hợp: đánh dấu card bằng thuộc tính data-dyq="<awemeId>" (thuộc tính DOM
// dùng chung được giữa hai world), giữ metadata trong Map, trả về khi content script hỏi.

interface Meta {
  id: string;
  title: string;
  author: string;
  tags: string[];
  likes: number;
  comments: number;
  shares: number;
  durationSeconds: number;
  cover: string;
  videoUrl: string;
}

const ATTR = "data-dyq";
const metaById = new Map<string, Meta>();

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Leo React fiber của phần tử, tìm object aweme (có awemeId + video). */
function awemeOf(el: Element): any {
  const fiberKey = Object.keys(el).find((k) => k.startsWith("__reactFiber"));
  if (!fiberKey) return null;
  const seen = new Set<unknown>();
  const dig = (o: any, depth: number): any => {
    if (!o || typeof o !== "object" || depth > 3 || seen.has(o)) return null;
    seen.add(o);
    if (o.awemeId && o.video) return o;
    for (const k of Object.keys(o)) {
      if (k.startsWith("_") || k === "stateNode" || k === "return") continue;
      const hit = dig(o[k], depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  let fiber = (el as any)[fiberKey];
  for (let up = 0; up < 3 && fiber; up++, fiber = fiber.return) {
    const hit = dig(fiber.memoizedProps, 0);
    if (hit) return hit;
  }
  return null;
}

/** Bản mp4 nét nhất; ưu tiên H.264 cho chắc ăn với ffmpeg/VSR phía sau. */
function bestVideoUrl(video: any): string {
  const list: any[] = Array.isArray(video?.bitRateList) ? video.bitRateList : [];
  const candidates = list
    .map((b) => ({
      url: b?.playAddr?.[0]?.src ?? "",
      pixels: (b?.width ?? 0) * (b?.height ?? 0),
      h265: b?.isH265 === 1 || /h265|bytevc1/i.test(b?.gearName ?? ""),
    }))
    .filter((c) => c.url);
  const h264 = candidates.filter((c) => !c.h265);
  const pool = h264.length ? h264 : candidates;
  pool.sort((a, b) => b.pixels - a.pixels);
  return pool[0]?.url ?? video?.playAddr?.[0]?.src ?? "";
}

function toMeta(a: any): Meta | null {
  if (!a?.awemeId) return null;
  const v = a.video ?? {};
  const s = a.statistics ?? {};
  return {
    id: String(a.awemeId),
    title: (a.desc ?? a.itemTitle ?? "").trim(),
    author: a.authorInfo?.nickname ?? a.author?.nickname ?? "",
    tags: (a.textExtra ?? []).map((t: any) => t?.hashtagName).filter(Boolean),
    likes: s.diggCount ?? 0,
    comments: s.commentCount ?? 0,
    shares: s.shareCount ?? 0,
    durationSeconds: Math.round((v.duration ?? 0) / 1000),
    cover: v.cover ?? v.coverUrlList?.[0] ?? v.originCoverUrlList?.[0] ?? "",
    videoUrl: bestVideoUrl(v),
  };
}

/** Gắn data-dyq lên mọi card tìm được (feed grid + khung video trong modal). */
function annotate(): void {
  const mark = (el: Element) => {
    const aweme = awemeOf(el);
    const meta = aweme ? toMeta(aweme) : null;
    if (!meta) return false;
    metaById.set(meta.id, meta);
    if (el.getAttribute(ATTR) !== meta.id) el.setAttribute(ATTR, meta.id);
    return true;
  };

  // Card trong feed: leo từ ảnh cover (bám được kể cả khi class đổi)
  for (const img of Array.from(document.querySelectorAll("img"))) {
    let el: Element | null = img;
    for (let d = 0; d < 8 && el; d++, el = el.parentElement) {
      if (el.hasAttribute?.(ATTR) || mark(el)) break;
    }
  }
  // Khung video đang xem trong modal
  for (const el of Array.from(document.querySelectorAll('[data-e2e="feed-active-video"]'))) {
    if (!el.hasAttribute(ATTR)) mark(el);
  }
}

let timer = 0;
function scheduleAnnotate(): void {
  clearTimeout(timer);
  timer = window.setTimeout(() => {
    annotate();
    document.documentElement.setAttribute("data-dyq-count", String(metaById.size));
  }, 300);
}

// Dấu hiệu để chẩn đoán từ bên ngoài: hook đã chạy + số card đã đánh dấu
document.documentElement.setAttribute("data-dyq-hook", "1");
const reportCount = () => document.documentElement.setAttribute("data-dyq-count", String(metaById.size));

annotate();
reportCount();
new MutationObserver(scheduleAnnotate).observe(document.documentElement, { childList: true, subtree: true });
window.addEventListener("scroll", scheduleAnnotate, { passive: true });

// Content script (isolated world) hỏi metadata theo id
window.addEventListener("message", (e: MessageEvent) => {
  if (e.source !== window || e.data?.type !== "dyq-get") return;
  const id = String(e.data.id ?? "");
  if (!metaById.has(id)) annotate(); // card mới render
  window.postMessage({ type: "dyq-meta", id, meta: metaById.get(id) ?? null }, "*");
});
