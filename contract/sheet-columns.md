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

Thành phẩm: `output/<id>/no_sub_vi.mp4` (+ log nếu có).

## Cột Sheet (tab đầu tiên của duoyin-videos-queue)

| # | Cột | Ai ghi | Mô tả |
|---|---|---|---|
| A | `id` | Extension | Trùng tên folder trong inbox/ và `id` trong meta.json |
| B | `title` | Extension | Title gốc |
| C | `author` | Extension | Kênh/tác giả gốc |
| D | `source_url` | Extension | Link gốc — tham khảo, worker KHÔNG dùng để tải |
| E | `drive_folder_link` | Extension | Link folder `inbox/<id>/` |
| F | `voice` | Người dùng (default: `default`) | Giọng lồng tiếng |
| G | `translation_mode` | Người dùng (default: `cinematic`) | `fast` / `cinematic` / `autofit` |
| H | `status` | Worker | Xem vòng đời bên dưới. Extension ghi `NEW` |
| I | `output_link` | Worker | Link thành phẩm trong output/ |
| J | `error` | Worker | Message lỗi (khi status=ERROR) |
| K | `duration` | Worker | Thời lượng video (giây) |
| L | `process_time` | Worker | Tổng thời gian xử lý (giây) — để tính chi phí ⚡ |
| M | `updated_at` | Worker | ISO 8601 |

## Vòng đời status — 2 giai đoạn độc lập

Dub và xóa sub chạy **container riêng** (quyết định 17.08: dựng VSR hay vấp môi
trường, tách ra để nhánh dub không bị chặn).

```
GIAI ĐOẠN A — dub (worker --stage dub)
  NEW ──► DUBBING ──► DUBBED
                        └─ Drive output/<id>/: audio_vi.wav + <id>_preview.mp4

GIAI ĐOẠN B — xóa sub (worker --stage vsr)
  DUBBED ──► CLEANING ──► DONE
                            └─ Drive output/<id>/: <id>_vi.mp4  ← thành phẩm

  lỗi ở bất kỳ đâu → ERROR (+ message ở cột error)
```

| Status | Nghĩa | Ai xử lý |
|---|---|---|
| `NEW` | chờ dub | worker stage dub |
| `DUBBING` | đang dịch + lồng tiếng | — |
| `DUBBED` | có audio Việt + preview, **duyệt được rồi** | worker stage vsr |
| `CLEANING` | đang xóa sub + ghép thành phẩm | — |
| `DONE` | thành phẩm hoàn chỉnh | — |
| `ERROR` | lỗi, xem cột error | bạn quyết |

**Preview để làm gì:** `<id>_preview.mp4` là video **gốc (còn sub Trung) + tiếng
Việt** — nghe/duyệt giọng và bản dịch **trước** khi chạy VSR (phần đắt nhất,
~2.4× thời lượng video). Bản dịch dở thì khỏi tốn tiền xóa sub.

Quy tắc chạy lại:
- Worker chỉ nhận dòng đúng status đầu vào của stage, đủ `id` + `drive_folder_link`.
- Lỗi "sạch" → sửa tay status về `NEW` (dub lại) hoặc `DUBBED` (chỉ VSR lại).
- Crash/mất mạng: worker khởi động lại **tự đòi**: kẹt `DUBBING`→`NEW`,
  kẹt `CLEANING`→`DUBBED` (không dub lại). Quá 2 lần tự chạy lại → dừng ở `ERROR`.

## Quy tắc đổi hợp đồng

Đổi cột / đổi meta.json = bump `schema_version` trong meta.schema.json + cập nhật file này + sửa cả extension lẫn worker trong cùng 1 PR.
