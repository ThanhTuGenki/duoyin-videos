import type { CapturedPage } from "./contract";

/** popup → content script: nhặt metadata trang hiện tại */
export interface ExtractRequest {
  kind: "extract";
}
export interface ExtractResponse {
  ok: boolean;
  page?: CapturedPage;
  error?: string;
}

/** popup/content → background: thực hiện ingest.
 *  tabId chỉ cần khi gửi từ popup — content script để background tự lấy sender.tab.id */
export interface IngestRequest {
  kind: "ingest";
  tabId?: number;
  page: CapturedPage;
}

/** background → popup: cập nhật tiến độ (broadcast) */
export interface ProgressEvent {
  kind: "progress";
  step: string;
  done: boolean;
  error?: string;
}
