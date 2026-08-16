// Content script — adapter Douyin: nhặt metadata + URL video ứng viên từ DOM.
// Douyin đổi giao diện thường xuyên: mọi phép nhặt đều best-effort nhiều tầng fallback.
// Nếu video là blob: (MSE), background sẽ dùng URL sniff được từ network thay thế.

import type { CapturedPage } from "./lib/contract";
import type { ExtractRequest, ExtractResponse } from "./lib/messages";
import { parseCount } from "./lib/parse";

function text(selector: string): string {
  return document.querySelector(selector)?.textContent?.trim() ?? "";
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

function extractVideo(): { videoUrl: string; thumbUrl: string; durationSeconds: number } {
  const video = document.querySelector<HTMLVideoElement>("video");
  let videoUrl = "";
  if (video) {
    // src trực tiếp hoặc <source> con; bỏ qua blob: — không fetch được
    const candidates = [video.src, ...Array.from(video.querySelectorAll("source")).map((s) => s.src)];
    videoUrl = candidates.find((u) => u && !u.startsWith("blob:")) ?? "";
  }
  const thumbUrl = video?.poster || metaContent("og:image") || "";
  const durationSeconds = video?.duration && isFinite(video.duration) ? Math.round(video.duration) : 0;
  return { videoUrl, thumbUrl, durationSeconds };
}

function extractPage(): CapturedPage {
  const { videoUrl, thumbUrl, durationSeconds } = extractVideo();

  // Title: og:title → data-e2e → document.title (bỏ đuôi " - 抖音")
  const title =
    metaContent("og:title") ||
    text('[data-e2e="detail-video-title"]') ||
    text('[data-e2e="video-desc"]') ||
    document.title.replace(/\s*-\s*抖音.*$/, "").trim();

  const author =
    text('[data-e2e="detail-video-nickname"]') ||
    text('[data-e2e="video-author-name"]') ||
    metaContent("og:site_name");

  // Hashtag trong phần mô tả
  const tags = Array.from(
    new Set(
      Array.from(document.querySelectorAll('[data-e2e="detail-video-title"] a, .video-info-detail a'))
        .map((a) => a.textContent?.trim() ?? "")
        .filter((t) => t.startsWith("#"))
        .map((t) => t.replace(/^#/, "")),
    ),
  );

  const stats = {
    likes: parseCount(text('[data-e2e="video-player-digg"], [data-e2e="like-count"]')),
    comments: parseCount(text('[data-e2e="video-player-comment"], [data-e2e="comment-count"]')),
    shares: parseCount(text('[data-e2e="video-player-share"], [data-e2e="share-count"]')),
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

chrome.runtime.onMessage.addListener((msg: ExtractRequest, _sender, sendResponse) => {
  if (msg.kind !== "extract") return;
  try {
    const page = extractPage();
    const res: ExtractResponse = { ok: true, page };
    sendResponse(res);
  } catch (e) {
    const res: ExtractResponse = { ok: false, error: e instanceof Error ? e.message : String(e) };
    sendResponse(res);
  }
  return true;
});
