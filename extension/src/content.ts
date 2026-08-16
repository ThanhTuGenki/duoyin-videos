// Content script — adapter Douyin PC (app RSC/Pace).
// Điều tra thực tế (2026-08-16) cho thấy:
//  - Feed thuần /jingxuan KHÔNG có metadata dùng được (chỉ 1 <video> ẩn pre-create).
//  - Modal detail /jingxuan?modal_id=<id> có ĐỦ: container [data-e2e="feed-active-video"]
//    với video-desc / feed-video-nickname / video-player-digg|collect|share, video blob thật,
//    ảnh cover 640x360; và #RENDER_DATA (camelCase: awemeId/desc/authorInfo/textExtra/video.cover)
//    cho title gốc tiếng Trung + cover HD khi awemeId === modal_id.
// => Extension chỉ ingest khi đang ở modal detail. 1 nút ＋Q gắn vào container active.

import type { CapturedPage } from "./lib/contract";
import type { ExtractRequest, ExtractResponse, IngestRequest, ProgressEvent } from "./lib/messages";
import { parseCount } from "./lib/parse";

// Guard: tránh chạy 2 lần nếu bị inject lại (manifest + popup executeScript)
if ((window as unknown as { __duoyinIngest?: boolean }).__duoyinIngest) {
  // đã chạy rồi
} else {
  (window as unknown as { __duoyinIngest?: boolean }).__duoyinIngest = true;
  main();
}

function main(): void {
  observeActiveVideo();
  chrome.runtime.onMessage.addListener((msg: ExtractRequest, _s, sendResponse) => {
    if (msg.kind !== "extract") return;
    const page = extractActive();
    sendResponse(
      page ? { ok: true, page } : { ok: false, error: "Chưa mở video ở chế độ xem chi tiết (modal). Bấm vào 1 video rồi thử lại." } as ExtractResponse,
    );
    return true;
  });
}

// ── Trích metadata từ video đang active trong modal ──────────────

function modalId(): string | null {
  return new URLSearchParams(location.search).get("modal_id") ?? location.href.match(/\/video\/(\d+)/)?.[1] ?? null;
}

function cleanDesc(raw: string): string {
  return raw.replace(/(展开|收起|展開)$/u, "").trim();
}

/** Đọc #RENDER_DATA (camelCase) tìm object aweme khớp id. Trả null nếu không khớp. */
function renderDataAweme(id: string): { desc: string; author: string; cover: string; tags: string[] } | null {
  const raw = document.querySelector("#RENDER_DATA")?.textContent;
  if (!raw) return null;
  let text = raw;
  try {
    text = decodeURIComponent(raw);
  } catch {
    /* đã là plain */
  }
  const anchor = text.indexOf(id);
  if (anchor < 0) return null; // data động: user đã swipe khác video ban đầu
  let start = text.lastIndexOf("{", anchor);
  for (let tries = 0; tries < 8 && start >= 0; tries++) {
    let depth = 0;
    for (let i = start; i < Math.min(text.length, start + 90000); i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") {
        if (--depth === 0) {
          try {
            const o = JSON.parse(text.slice(start, i + 1));
            if ((o.awemeId === id || o.desc) && (o.desc || o.video)) {
              return {
                desc: cleanDesc(o.desc ?? ""),
                author: o.authorInfo?.nickname ?? o.author?.nickname ?? "",
                cover: o.video?.cover ?? o.video?.coverUrlList?.[0] ?? o.video?.originCoverUrlList?.[0] ?? "",
                tags: (o.textExtra ?? []).map((t: { hashtagName?: string }) => t.hashtagName).filter(Boolean),
              };
            }
          } catch {
            /* không phải JSON hợp lệ */
          }
          break;
        }
      }
    }
    start = text.lastIndexOf("{", start - 1);
  }
  return null;
}

/** Ảnh cover 640x360 (tos-cn-p) trong container active — bỏ avatar/icon nhỏ. */
function domCover(active: Element): string {
  const imgs = Array.from(active.querySelectorAll("img")) as HTMLImageElement[];
  const cover = imgs
    .filter((im) => im.src.startsWith("http") && im.naturalWidth >= 300)
    .sort((a, b) => b.naturalWidth - a.naturalWidth)[0];
  return cover?.src ?? "";
}

function activeContainer(): Element | null {
  return document.querySelector('[data-e2e="feed-active-video"]');
}

export function extractActive(): CapturedPage | null {
  const id = modalId();
  const active = activeContainer();
  if (!id || !active) return null;

  const q = (sel: string) => active.querySelector(sel)?.textContent?.trim() ?? "";
  const domDesc = cleanDesc(q('[data-e2e="video-desc"]'));
  const domAuthor = q('[data-e2e="feed-video-nickname"]').replace(/^@/, "");

  // Ưu tiên RENDER_DATA (title gốc tiếng Trung sạch + cover HD) khi khớp id
  const rd = renderDataAweme(id);

  const stats = {
    likes: parseCount(q('[data-e2e="video-player-digg"]')),
    comments: parseCount(q('[data-e2e="video-player-comment"]')),
    shares: parseCount(q('[data-e2e="video-player-share"]')),
  };

  const active_video = active.querySelector("video");
  const durationSeconds = active_video?.duration && isFinite(active_video.duration) ? Math.round(active_video.duration) : 0;

  return {
    rawId: `dy-${id}`,
    title: rd?.desc || domDesc,
    author: rd?.author || domAuthor,
    sourceUrl: `https://www.douyin.com/video/${id}`,
    description: rd?.desc || domDesc,
    tags: rd?.tags ?? [],
    stats,
    durationSeconds,
    videoUrl: "", // để background dùng URL sniff (theo đúng video đang phát)
    thumbUrl: rd?.cover || domCover(active),
  };
}

// ── Nút ＋Q trên container video active ──────────────────────────

const BTN_ID = "duoyin-ingest-btn";
type BtnState = "idle" | "busy" | "ok" | "err";
const stateById = new Map<string, { state: BtnState; tip: string }>();

function paint(btn: HTMLButtonElement, state: BtnState, tip: string): void {
  const label = { idle: "＋ Queue", busy: "⏳ …", ok: "✓ Đã thêm", err: "✗ Lỗi" }[state];
  btn.textContent = label;
  btn.title = tip;
  btn.style.background = state === "err" ? "#c0392b" : state === "ok" ? "#0E7D6B" : "#D92B57";
  btn.disabled = state === "busy";
  btn.style.cursor = state === "busy" ? "default" : "pointer";
}

function ensureButton(): void {
  const active = activeContainer();
  const id = modalId();
  if (!active || !id) return;

  let btn = active.querySelector<HTMLButtonElement>(`#${BTN_ID}`);
  if (!btn) {
    btn = document.createElement("button");
    btn.id = BTN_ID;
    Object.assign(btn.style, {
      position: "absolute", top: "16px", left: "16px", zIndex: "9999",
      minWidth: "104px", height: "34px", padding: "0 14px",
      border: "none", borderRadius: "17px", color: "#fff",
      fontSize: "13px", fontWeight: "700", fontFamily: "system-ui, sans-serif",
      boxShadow: "0 2px 8px rgba(0,0,0,.3)", opacity: "0.95",
    } satisfies Partial<CSSStyleDeclaration>);
    if (getComputedStyle(active).position === "static") (active as HTMLElement).style.position = "relative";
    active.appendChild(btn);

    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      e.preventDefault();
      const curId = modalId();
      if (!curId) return;
      if (stateById.get(curId)?.state === "busy") return; // chống double-click
      stateById.set(curId, { state: "busy", tip: "Đang gửi…" });
      paint(btn!, "busy", "Đang gửi…");
      try {
        const page = extractActive();
        if (!page) throw new Error("Không đọc được video active");
        const res = (await chrome.runtime.sendMessage({ kind: "ingest", page } as IngestRequest)) as { ok: boolean; error?: string };
        if (!res?.ok) throw new Error(res?.error ?? "Ingest thất bại");
        stateById.set(curId, { state: "ok", tip: "Đã vào queue" });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        stateById.set(curId, { state: "err", tip: msg });
      }
      // chỉ cập nhật nếu vẫn đang ở đúng video đó
      if (modalId() === curId) applyState(btn!);
    });
  }
  applyState(btn);
}

function applyState(btn: HTMLButtonElement): void {
  const id = modalId();
  const s = id ? stateById.get(id) : undefined;
  paint(btn, s?.state ?? "idle", s?.tip ?? "Gửi video này vào queue");
}

function observeActiveVideo(): void {
  ensureButton();
  const mo = new MutationObserver(() => ensureButton());
  mo.observe(document.documentElement, { childList: true, subtree: true });
  // URL đổi khi swipe (modal_id) → cập nhật trạng thái nút theo video mới
  let lastId = modalId();
  setInterval(() => {
    const now = modalId();
    if (now !== lastId) {
      lastId = now;
      const btn = document.querySelector<HTMLButtonElement>(`#${BTN_ID}`);
      if (btn) applyState(btn);
    }
  }, 500);
}

// Tiến độ từ background → cập nhật nút của đúng video
chrome.runtime.onMessage.addListener((msg: ProgressEvent) => {
  if (msg.kind !== "progress") return;
  const id = modalId();
  if (!id) return;
  const prev = stateById.get(id);
  if (msg.error) stateById.set(id, { state: "err", tip: msg.error });
  else if (msg.done) stateById.set(id, { state: "ok", tip: msg.step });
  else if (prev?.state === "busy") stateById.set(id, { state: "busy", tip: msg.step });
  const btn = document.querySelector<HTMLButtonElement>(`#${BTN_ID}`);
  if (btn) applyState(btn);
});
