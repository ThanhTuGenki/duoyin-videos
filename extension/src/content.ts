// Content script — adapter Douyin:
// 1. Nhặt metadata + URL video ứng viên (scoped theo container video đang bấm)
// 2. Chèn nút "＋Q" lên góc mỗi video: bấm là gửi thẳng video đó vào queue
// Douyin đổi giao diện thường xuyên: mọi selector đều best-effort nhiều tầng fallback.

import type { CapturedPage } from "./lib/contract";
import type { ExtractRequest, ExtractResponse, IngestRequest, ProgressEvent } from "./lib/messages";
import { parseCount } from "./lib/parse";

function textIn(root: ParentNode, selector: string): string {
  return root.querySelector(selector)?.textContent?.trim() ?? "";
}

function metaContent(name: string): string {
  return (
    document.querySelector<HTMLMetaElement>(`meta[property="${name}"]`)?.content ??
    document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content ??
    ""
  );
}

function extractId(): string {
  const m = location.href.match(/\/video\/(\d+)/) ?? location.href.match(/modal_id=(\d+)/);
  return m ? `dy-${m[1]}` : `dy-${Date.now()}`;
}

/** Container logic của 1 video trong feed (hoặc cả trang nếu là trang chi tiết). */
function containerOf(video: HTMLVideoElement): ParentNode {
  return (
    video.closest('[data-e2e="feed-active-video"]') ??
    video.closest("[data-e2e]")?.parentElement ??
    document
  );
}

function extractPage(video?: HTMLVideoElement): CapturedPage {
  const v = video ?? document.querySelector<HTMLVideoElement>("video") ?? undefined;
  const root: ParentNode = v ? containerOf(v) : document;

  let videoUrl = "";
  if (v) {
    const candidates = [v.src, ...Array.from(v.querySelectorAll("source")).map((s) => s.src)];
    videoUrl = candidates.find((u) => u && !u.startsWith("blob:")) ?? "";
  }
  const thumbUrl = v?.poster || metaContent("og:image") || "";
  const durationSeconds = v?.duration && isFinite(v.duration) ? Math.round(v.duration) : 0;

  const title =
    textIn(root, '[data-e2e="detail-video-title"]') ||
    textIn(root, '[data-e2e="video-desc"]') ||
    metaContent("og:title") ||
    document.title.replace(/\s*-\s*抖音.*$/, "").trim();

  const author =
    textIn(root, '[data-e2e="detail-video-nickname"]') ||
    textIn(root, '[data-e2e="video-author-name"]') ||
    textIn(root, '[data-e2e="feed-video-nickname"]');

  const tags = Array.from(
    new Set(
      Array.from(root.querySelectorAll('[data-e2e="detail-video-title"] a, [data-e2e="video-desc"] a'))
        .map((a) => a.textContent?.trim() ?? "")
        .filter((t) => t.startsWith("#"))
        .map((t) => t.replace(/^#/, "")),
    ),
  );

  const stats = {
    likes: parseCount(textIn(root, '[data-e2e="video-player-digg"], [data-e2e="like-count"]')),
    comments: parseCount(textIn(root, '[data-e2e="video-player-comment"], [data-e2e="comment-count"]')),
    shares: parseCount(textIn(root, '[data-e2e="video-player-share"], [data-e2e="share-count"]')),
  };

  return {
    rawId: extractId(),
    title,
    author,
    sourceUrl: location.href,
    description: metaContent("og:description") || title,
    tags,
    stats,
    durationSeconds,
    videoUrl,
    thumbUrl,
  };
}

// ── Nút "＋Q" trên từng video ────────────────────────────────────

const BTN_CLASS = "duoyin-ingest-btn";
let activeButton: HTMLButtonElement | null = null;

function setButtonState(btn: HTMLButtonElement, state: "idle" | "busy" | "ok" | "err", tip?: string): void {
  const map = { idle: "＋Q", busy: "⏳", ok: "✓", err: "✗" } as const;
  btn.textContent = map[state];
  btn.title = tip ?? "Gửi video này vào queue";
  btn.style.background = state === "err" ? "#c0392b" : state === "ok" ? "#0E7D6B" : "#D92B57";
}

function makeButton(video: HTMLVideoElement): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = BTN_CLASS;
  setButtonState(btn, "idle");
  Object.assign(btn.style, {
    position: "absolute",
    top: "12px",
    right: "12px",
    zIndex: "99999",
    width: "44px",
    height: "30px",
    border: "none",
    borderRadius: "15px",
    color: "#fff",
    fontSize: "13px",
    fontWeight: "700",
    cursor: "pointer",
    opacity: "0.85",
    fontFamily: "system-ui, sans-serif",
  } satisfies Partial<CSSStyleDeclaration>);

  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    e.preventDefault();
    activeButton = btn;
    setButtonState(btn, "busy", "Đang gửi vào queue…");
    try {
      const page = extractPage(video);
      const req: IngestRequest = { kind: "ingest", page };
      const res = (await chrome.runtime.sendMessage(req)) as { ok: boolean; error?: string };
      if (!res?.ok) throw new Error(res?.error ?? "Ingest thất bại");
      setButtonState(btn, "ok", "Đã vào queue");
    } catch (err) {
      setButtonState(btn, "err", err instanceof Error ? err.message : String(err));
    }
  });
  return btn;
}

function injectButtons(): void {
  document.querySelectorAll<HTMLVideoElement>("video").forEach((video) => {
    const host = video.parentElement;
    if (!host || host.querySelector(`.${BTN_CLASS}`)) return;
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    host.appendChild(makeButton(video));
  });
}

injectButtons();
new MutationObserver(() => injectButtons()).observe(document.documentElement, {
  childList: true,
  subtree: true,
});

// Tiến độ từ background → cập nhật nút đang xử lý
chrome.runtime.onMessage.addListener((msg: ProgressEvent) => {
  if (msg.kind !== "progress" || !activeButton) return;
  if (msg.error) setButtonState(activeButton, "err", msg.error);
  else if (msg.done) setButtonState(activeButton, "ok", msg.step);
  else setButtonState(activeButton, "busy", msg.step);
});

// ── API cho popup ────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: ExtractRequest, _sender, sendResponse) => {
  if (msg.kind !== "extract") return;
  try {
    const res: ExtractResponse = { ok: true, page: extractPage() };
    sendResponse(res);
  } catch (e) {
    const res: ExtractResponse = { ok: false, error: e instanceof Error ? e.message : String(e) };
    sendResponse(res);
  }
  return true;
});
