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

/** popup → background: thực hiện ingest */
export interface IngestRequest {
  kind: "ingest";
  tabId: number;
  page: CapturedPage;
}

/** background → popup: cập nhật tiến độ (broadcast) */
export interface ProgressEvent {
  kind: "progress";
  step: string;
  done: boolean;
  error?: string;
}
