// Hợp đồng ingest v1.0 — phải khớp contract/meta.schema.json và contract/sheet-columns.md.
// Đổi gì ở đây = đổi hợp đồng: bump SCHEMA_VERSION + sửa schema + sửa worker trong cùng 1 PR.

export const SCHEMA_VERSION = "1.0";

export interface CapturedPage {
  /** aweme id hoặc chuỗi nhận dạng nhặt từ URL trang */
  rawId: string;
  title: string;
  author: string;
  sourceUrl: string;
  description: string;
  tags: string[];
  stats: { likes: number; comments: number; shares: number };
  durationSeconds: number;
  /** URL video ứng viên do content script tìm được (có thể rỗng nếu chỉ có blob:) */
  videoUrl: string;
  thumbUrl: string;
}

export interface IngestMeta {
  schema_version: typeof SCHEMA_VERSION;
  id: string;
  title: string;
  author: string;
  source_url: string;
  description: string;
  tags: string[];
  stats: { likes: number; comments: number; shares: number };
  duration_seconds: number;
  captured_at: string;
  files: { video: string; thumbnail?: string };
}

/** id hợp lệ theo schema: ^[a-zA-Z0-9_-]+$ */
export function sanitizeId(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return cleaned || `v-${Date.now()}`;
}

export function buildMeta(page: CapturedPage, capturedAt: Date, hasThumb: boolean): IngestMeta {
  return {
    schema_version: SCHEMA_VERSION,
    id: sanitizeId(page.rawId),
    title: page.title,
    author: page.author,
    source_url: page.sourceUrl,
    description: page.description,
    tags: page.tags,
    stats: page.stats,
    duration_seconds: page.durationSeconds,
    captured_at: capturedAt.toISOString(),
    files: hasThumb ? { video: "video.mp4", thumbnail: "thumb.jpg" } : { video: "video.mp4" },
  };
}

/** Một dòng Sheet đúng thứ tự 13 cột A→M của contract/sheet-columns.md */
export function sheetRow(meta: IngestMeta, driveFolderLink: string): string[] {
  return [
    meta.id,               // A id
    meta.title,            // B title
    meta.author,           // C author
    meta.source_url,       // D source_url
    driveFolderLink,       // E drive_folder_link
    "default",             // F voice
    "cinematic",           // G translation_mode
    "NEW",                 // H status
    "",                    // I output_link
    "",                    // J error
    "",                    // K duration (worker ghi)
    "",                    // L process_time
    "",                    // M updated_at
  ];
}
