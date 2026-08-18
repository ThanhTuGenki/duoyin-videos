# Hợp đồng ingest — v1.0 (chốt 2026-08-16)

Worker chỉ đọc hợp đồng này, không biết nguồn video. Extension (hoặc tay, khi dự phòng) ghi vào.

## Nơi lưu thật (đã tạo)

| Thứ | Link |
|---|---|
| Folder gốc `duoyin-videos/` | https://drive.google.com/drive/folders/14sfsTkv-k8S2rqR5kFj6EoVr_RBqXsjh |
| `inbox/` — video vào | https://drive.google.com/drive/folders/1PbeSJv39pGnu0yLxqZpBkTZfpaUcRgLj |
| `output/` — thành phẩm ra | https://drive.google.com/drive/folders/1GRQTbjnEsjGa_VSD3z6ZCa3_LvVlyPwD |
| Folder video mẫu `inbox/sample-001/` | https://drive.google.com/drive/folders/1MhEPLa7JcyEjOYKuN_B_97OR9zWCcVXL |
| **Sheet queue đang dùng** (Table 13 cột) | https://docs.google.com/spreadsheets/d/1tLx0SQUqWQ1q7qGpkdcH0ATMYGdCSPA9AUMqLRHyFRY/edit |
| Bấm để tự tạo bản sao dùng cho sheet mới | https://docs.google.com/spreadsheets/d/1tLx0SQUqWQ1q7qGpkdcH0ATMYGdCSPA9AUMqLRHyFRY/copy |
| Sheet mẫu cũ (kiểu format thường, giữ để tham khảo) | https://docs.google.com/spreadsheets/d/1I263JkylKlgeglImqQNEF6F-loDozMFpOgTKuOY9WW4/copy |

> **Đổi sheet thì phải đổi ở 2 nơi**: `DEFAULT_CONFIG.spreadsheetId` trong `extension/src/lib/config.ts` (mặc định cho máy mới) **và** Options của extension nếu đã từng bấm Lưu. ID cũ đã xoá được liệt vào `STALE_SPREADSHEET_IDS` để tự rơi về mặc định thay vì lỗi 404.

Sheet mẫu chuẩn dùng **Google Sheets Table** (`queue`): header xanh + freeze, dropdown chip gốc cho `voice`/`translation_mode`/`status`, `duration`/`process_time` kiểu số, màu theo trạng thái, dòng ERROR ửng đỏ, sọc xen kẽ, chú thích hover trên từng tiêu đề. Dùng cho sheet mới: copy về, dán ID vào Options của extension là chạy.

Áp/dựng lại định dạng bất cứ lúc nào (không cần nút trong extension):
```bash
cd extension
node scripts/setup-table.mjs <spreadsheetId> [rows]   # sheet có Table (khuyên dùng)
node scripts/format-sheet.mjs <spreadsheetId> [--clear-data]   # sheet thường
node scripts/inspect-sheet.mjs <spreadsheetId>        # soi cấu trúc hiện tại
```

## Cấu trúc folder Drive cho mỗi video

```
inbox/<id>/
├── video.mp4     # bắt buộc
├── thumb.jpg     # tùy chọn
└── meta.json     # bắt buộc — theo meta.schema.json
```

Thành phẩm ra `output/<id>/` — xem bảng ở mục "Vòng đời status" bên dưới.

## Cột Sheet (tab đầu tiên của duoyin-videos-queue)

| # | Cột | Ai ghi | Mô tả |
|---|---|---|---|
| A | `id` | Extension | Trùng tên folder trong inbox/ và `id` trong meta.json |
| B | `title` | Extension | Title gốc |
| C | `author` | Extension | Kênh/tác giả gốc |
| D | `source_url` | Extension | Link gốc — tham khảo, worker KHÔNG dùng để tải |
| E | `drive_folder_link` | Extension | Link folder `inbox/<id>/` |
| F | `voice` | Người dùng (default: `default`) | Giọng lồng tiếng |
| G | `translation_mode` | Người dùng (default: `cinematic`) | `fast` (Google MT, thô) / `cinematic` (LLM, **nên dùng**) / `autofit` (đã đo 17.08: KHÔNG ngắn hơn cinematic, không cần) |
| H | `status` | Worker | Xem vòng đời bên dưới. Extension ghi `NEW` |
| I | `output_link` | Worker | Link thành phẩm trong output/ |
| J | `error` | Worker | Message lỗi (khi status=ERROR) |
| K | `duration` | Worker | Thời lượng video (giây) |
| L | `process_time` | Worker | Tổng thời gian xử lý (giây) — để tính chi phí ⚡ |
| M | `updated_at` | Worker | ISO 8601 |

## Vòng đời status

```
QUY TRÌNH ĐANG DÙNG — dub (worker --stage dub)
  NEW ──► DUBBING ──► DUBBED   ← thành phẩm
                        └─ Drive output/<id>/: <id>_dubbed.mp4 + <id>_vi.srt

  lỗi ở bất kỳ đâu → ERROR (+ message ở cột error)
```

`DUBBED` là trạng thái cuối. Việc che sub làm ngoài (CapCut hoặc ffmpeg
`delogo` trên máy mình) — miễn phí, không cần GPU.

```
KHÔNG DÙNG NỮA — xoá sub (worker --stage vsr)
  DUBBED ──► CLEANING ──► DONE
                            └─ Drive output/<id>/: <id>_vi.mp4
```

Bỏ ngày 18.08 vì chi phí: ~262s cho video 122s (~2× thời lượng), ~475⚡/video,
gấp ~3 lần chặng dub. Code vẫn chạy đúng và vẫn giữ lại; đo cụ thể ở RUNBOOK.

| Status | Nghĩa | Ai xử lý |
|---|---|---|
| `NEW` | chờ dub | worker stage dub |
| `DUBBING` | đang dịch + lồng tiếng | — |
| `DUBBED` | **thành phẩm** — video tiếng Việt + .srt | — (che sub làm ngoài) |
| `CLEANING` | đang xóa sub (stage vsr, không dùng nữa) | — |
| `DONE` | đã xoá sub (stage vsr, không dùng nữa) | — |
| `ERROR` | lỗi, xem cột error | bạn quyết |

**`<id>_dubbed.mp4`** là video gốc (còn sub Trung) đã nói tiếng Việt. Không có
bước ghép audio riêng: VoiceStudio xuất video đã trộn sẵn (h264+aac, 1 track
tiếng Việt, `preserve_bg=true` giữ nhạc nền).

Vùng sub cần che, đo trên video 1920×1080: `y 860→1010, x 100→1820`. Xem
RUNBOOK để biết lệnh `ffmpeg delogo` và cách đo lại khi đổi độ phân giải.

**`<id>_vi.srt` lưu rời, KHÔNG burn vào video** (quyết định 17.08). Muốn có sub
tiếng Việt thì gắn ở CapCut hoặc script phụ — giữ video sạch để linh hoạt.

Quy tắc chạy lại:
- Worker chỉ nhận dòng đúng status đầu vào của stage, đủ `id` + `drive_folder_link`.
- Lỗi "sạch" → sửa tay status về `NEW` để dub lại.
- Crash/mất mạng: worker khởi động lại **tự đòi**: kẹt `DUBBING`→`NEW`,
  kẹt `CLEANING`→`DUBBED` (không dub lại). Quá 2 lần tự chạy lại → dừng ở `ERROR`.

## Quy tắc đổi hợp đồng

Đổi cột / đổi meta.json = bump `schema_version` trong meta.schema.json + cập nhật file này + sửa cả extension lẫn worker trong cùng 1 PR.
