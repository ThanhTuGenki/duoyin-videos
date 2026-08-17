// Service worker: sniff URL video từ network + điều phối ingest
// (tải video → up Drive inbox/<id>/ → ghi dòng Sheet).

import { buildMeta, sheetRow, type CapturedPage } from "./lib/contract";
import { withFreshToken } from "./lib/auth";
import { createFolder, uploadSmall, uploadVideo, folderLink } from "./lib/drive";
import { appendRow, assertSheetReachable } from "./lib/sheets";
import { loadConfig } from "./lib/config";
import type { IngestRequest, ProgressEvent } from "./lib/messages";

// ── Media sniffing ───────────────────────────────────────────────
// Douyin phát video qua MSE (src=blob:) nên content script thường không lấy
// được URL. Nghe network: request media/mp4 lớn nhất của mỗi tab chính là video.

interface Sniffed {
  url: string;
  contentLength: number;
}
const sniffedByTab = new Map<number, Sniffed>();

const MEDIA_URL_RE = /\.mp4($|\?)|douyinvod\.com|zjcdn\.com|\/media\//i;

chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const isMediaType = details.type === "media";
    if (!isMediaType && !MEDIA_URL_RE.test(details.url)) return;

    const lenHeader = details.responseHeaders?.find((h) => h.name.toLowerCase() === "content-length");
    const contentLength = lenHeader?.value ? parseInt(lenHeader.value, 10) : 0;
    const current = sniffedByTab.get(details.tabId);
    // Giữ URL có content-length lớn nhất (video chính > preroll/audio nhỏ)
    if (!current || contentLength >= current.contentLength) {
      dlog(`sniff tab=${details.tabId} len=${contentLength} ${details.url.slice(0, 110)}`);
      // Bỏ tham số byte-range (bytes=...) khỏi URL nếu Douyin nhét vào query
      const url = details.url.replace(/([?&])range=[^&]*/,"$1").replace(/[?&]$/, "");
      sniffedByTab.set(details.tabId, { url, contentLength });
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"],
);

chrome.tabs.onRemoved.addListener((tabId) => sniffedByTab.delete(tabId));
chrome.webNavigation?.onCommitted?.addListener?.((d) => {
  if (d.frameId === 0) sniffedByTab.delete(d.tabId);
});

// ── Ingest ───────────────────────────────────────────────────────

// Ring buffer log để debug từ bên ngoài (Playwright poll qua worker.evaluate)
const debugLogs: string[] = [];
(globalThis as Record<string, unknown>).__ingestLogs = debugLogs;
function dlog(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}`;
  debugLogs.push(line);
  if (debugLogs.length > 500) debugLogs.shift();
  console.log("[ingest]", msg);
}

function progress(step: string, done = false, error?: string): void {
  dlog(error ? `ERROR: ${error}` : step);
  const ev: ProgressEvent = { kind: "progress", step, done, error };
  chrome.runtime.sendMessage(ev).catch(() => {
    /* popup có thể đã đóng */
  });
}

/** Douyin trả cover dạng WebP là chính; đặt đuôi khớp nội dung thật. */
function thumbExt(mime: string): string {
  const map: Record<string, string> = {
    "image/webp": "webp",
    "image/png": "png",
    "image/avif": "avif",
    "image/jpeg": "jpg",
  };
  return map[mime.split(";")[0].trim()] ?? "jpg";
}

async function fetchBlob(url: string, referer: string): Promise<Blob> {
  // fetch từ SW mang cookie của site nhờ host_permissions + credentials include
  const res = await fetch(url, { credentials: "include", headers: { Referer: referer } as HeadersInit });
  if (!res.ok) throw new Error(`Tải media thất bại ${res.status}: ${url.slice(0, 120)}`);
  return res.blob();
}

async function runIngest(req: IngestRequest, tabId: number): Promise<void> {
  const cfg = await loadConfig();
  const page: CapturedPage = req.page;

  // 1. Chốt URL video: ứng viên từ DOM, không có thì lấy URL sniff được
  const sniffed = sniffedByTab.get(tabId);
  const videoUrl = page.videoUrl || sniffed?.url || "";
  if (!videoUrl) {
    throw new Error(
      "Không tìm được URL video (DOM chỉ có blob: và chưa sniff được từ network). Thử phát video vài giây rồi bấm lại.",
    );
  }

  // Kiểm tra Sheet TRƯỚC khi tải/upload — cấu hình sai thì báo ngay, khỏi phí băng thông
  progress("Kiểm tra Sheet đích…");
  await withFreshToken((token) => assertSheetReachable(token, cfg.spreadsheetId));

  progress("Đang tải video từ trang…");
  const videoBlob = await fetchBlob(videoUrl, page.sourceUrl);
  if (videoBlob.size < 100_000) {
    throw new Error(`File tải về quá nhỏ (${videoBlob.size} bytes) — có thể sniff nhầm. Phát lại video rồi thử lại.`);
  }

  let thumbBlob: Blob | null = null;
  if (page.thumbUrl) {
    try {
      thumbBlob = await fetchBlob(page.thumbUrl, page.sourceUrl);
    } catch {
      thumbBlob = null; // thumbnail là tùy chọn, không chặn ingest
    }
  }

  const thumbName = thumbBlob ? `thumb.${thumbExt(thumbBlob.type)}` : null;
  const meta = buildMeta(page, new Date(), thumbName);

  await withFreshToken(async (token) => {
    progress(`Tạo folder inbox/${meta.id}/ trên Drive…`);
    const folderId = await createFolder(token, meta.id, cfg.inboxFolderId);

    progress(`Upload video.mp4 (${(videoBlob.size / 1e6).toFixed(1)} MB)…`);
    await uploadVideo(token, folderId, "video.mp4", videoBlob);

    if (thumbBlob && thumbName) {
      // Douyin trả WebP là chính — dùng đúng mime/đuôi thay vì hardcode .jpg
      progress(`Upload ${thumbName}…`);
      await uploadSmall(token, folderId, thumbName, thumbBlob.type || "image/jpeg", thumbBlob);
    }

    progress("Upload meta.json…");
    await uploadSmall(
      token,
      folderId,
      "meta.json",
      "application/json",
      new Blob([JSON.stringify(meta, null, 2)], { type: "application/json" }),
    );

    progress("Ghi dòng NEW vào Sheet…");
    await appendRow(token, cfg.spreadsheetId, sheetRow(meta, folderLink(folderId)));
  });

  progress(`Xong: ${meta.id} đã vào queue`, true);
  chrome.notifications?.create?.({
    type: "basic",
    iconUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    title: "Duoyin Ingest",
    message: `${meta.id} đã vào queue`,
  });
}

chrome.runtime.onMessage.addListener((msg: IngestRequest, sender, sendResponse) => {
  if (msg.kind !== "ingest") return;
  const tabId = sender.tab?.id ?? msg.tabId;
  if (tabId === undefined) {
    sendResponse({ ok: false, error: "Không xác định được tab nguồn" });
    return;
  }
  runIngest(msg, tabId)
    .then(() => sendResponse({ ok: true }))
    .catch((e) => {
      const message = e instanceof Error ? e.message : String(e);
      progress("Lỗi", true, message);
      sendResponse({ ok: false, error: message });
    });
  return true; // async sendResponse
});
