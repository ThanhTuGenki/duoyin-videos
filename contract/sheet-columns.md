# Hợp đồng ingest — v1.0 (chốt 2026-08-16)

Worker chỉ đọc hợp đồng này, không biết nguồn video. Extension (hoặc tay, khi dự phòng) ghi vào.

## Nơi lưu thật (đã tạo)

| Thứ | Link |
|---|---|
| Folder gốc `duoyin-videos/` | https://drive.google.com/drive/folders/14sfsTkv-k8S2rqR5kFj6EoVr_RBqXsjh |
| `inbox/` — video vào | https://drive.google.com/drive/folders/1PbeSJv39pGnu0yLxqZpBkTZfpaUcRgLj |
| `output/` — thành phẩm ra | https://drive.google.com/drive/folders/1GRQTbjnEsjGa_VSD3z6ZCa3_LvVlyPwD |
| Folder video mẫu `inbox/sample-001/` | https://drive.google.com/drive/folders/1MhEPLa7JcyEjOYKuN_B_97OR9zWCcVXL |
| Sheet queue `duoyin-videos-queue` (đang dùng) | https://docs.google.com/spreadsheets/d/1yrp2Jxp-Uj5WD5RIJMzXWkQaTe7TwHdNmWnmJuqPmTw/edit |
| **Sheet MẪU** — bấm link này để tự tạo bản sao | https://docs.google.com/spreadsheets/d/1I263JkylKlgeglImqQNEF6F-loDozMFpOgTKuOY9WW4/copy |

Sheet mẫu đã có sẵn: header đậm + freeze, dropdown cho `voice`/`translation_mode`/`status`, màu theo trạng thái, dòng ERROR ửng đỏ, sọc xen kẽ, bộ lọc, chú thích hover trên từng tiêu đề. Dùng cho người mới: copy về, dán ID mới vào Options của extension là chạy.

Trang trí lại bất cứ lúc nào (không cần nút trong extension):
```bash
cd extension && node scripts/format-sheet.mjs <spreadsheetId> [--clear-data]
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

## Vòng đời status

```
NEW → DOWNLOADING → PROCESSING → MUXING → UPLOADING → DONE
                        └──────────── lỗi ở bất kỳ đâu ────→ ERROR (+ cột error)
```

- Worker chỉ nhận dòng `status=NEW` có đủ `id` + `drive_folder_link`, folder chứa `video.mp4` + `meta.json` hợp lệ.
- Muốn chạy lại dòng lỗi: sửa tay `status` về `NEW`.

## Quy tắc đổi hợp đồng

Đổi cột / đổi meta.json = bump `schema_version` trong meta.schema.json + cập nhật file này + sửa cả extension lẫn worker trong cùng 1 PR.
