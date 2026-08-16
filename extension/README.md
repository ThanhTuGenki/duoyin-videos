# Duoyin Ingest — Chrome Extension

Nút **＋ Queue** trên video Douyin đang xem: bắt `video.mp4` + metadata + thumbnail → up Drive `inbox/<id>/` → ghi dòng `NEW` vào Sheet queue. Theo hợp đồng `contract/`.

## Build

```bash
npm install
npm run build     # bundle vào dist/ + typecheck
npm test          # unit test phần hợp đồng
```

## Cài vào Chrome (1 lần)

1. `chrome://extensions` → bật **Developer mode** → **Load unpacked** → chọn `extension/dist/`
2. Extension ID phải là `bbhcmfeedghfopbijnbjnhdfenfdinli` (pin bằng `key` trong manifest; private key ở `secrets/extension-key.pem`, đã gitignore — đừng xoá)
3. OAuth client đã cấu hình sẵn trong `manifest.json`. Nếu cần tạo lại: Google Cloud Console → enable **Drive API** + **Sheets API** → OAuth client type **Chrome Extension** với Item ID ở trên.

## Dùng

1. Mở Douyin, **bấm vào 1 video để xem ở chế độ chi tiết** (URL có `?modal_id=...`)
2. Phát video vài giây (để background sniff được URL mp4)
3. Bấm nút **＋ Queue** ở góc trên trái khung video

Nút giữ trạng thái riêng cho từng video: `＋ Queue` → `⏳ …` → `✓ Đã thêm` / `✗ Lỗi` (hover xem chi tiết lỗi).

Cấu hình folder inbox / Sheet ID: chuột phải icon → **Options**.

## Kiến trúc

Điều tra thực tế trang Douyin PC (app RSC/Pace) ngày 16.08.2026:

| Nguồn | Feed thuần `/jingxuan` | Modal detail `?modal_id=` |
|---|---|---|
| DOM `data-e2e` | ✗ chỉ có nav/searchbar | ✓ `feed-active-video`, `video-desc`, `feed-video-nickname`, `video-player-digg/collect/share` |
| `<video>` | ✗ chỉ 1 player ẩn pre-create | ✓ blob 1280×720 trong `xg-video-container` |
| `#RENDER_DATA` | ✗ thiếu `awemeId` | ✓ camelCase: `awemeId`/`desc`/`authorInfo`/`textExtra`/`video.cover` |

Vì vậy extension **chỉ ingest ở modal detail**. Không có Shadow DOM, không có XHR JSON kiểu cũ — mọi giả định về API mobile snake_case đều sai.

- `src/content.ts` — đọc `#RENDER_DATA` (title gốc tiếng Trung + cover HD) khi khớp `modal_id`, fallback DOM; chèn và quản lý nút ＋ Queue
- `src/background.ts` — sniff URL mp4 qua `webRequest` (giữ request media lớn nhất mỗi tab), tải bằng cookie session thật, upload Drive (resumable), append Sheet
- `src/lib/contract.ts` — types + builders theo hợp đồng v1.0 (có unit test)

Douyin đổi giao diện → chỉ sửa `content.ts`; worker và hợp đồng không đổi.

## Script dev (`scripts/`)

| Script | Việc |
|---|---|
| `format-sheet.mjs <id> [--clear-data]` | Trang trí Sheet queue (mượn OAuth token của extension qua CDP) |
| `shot-sheet.mjs <id> [out.png]` | Chụp ảnh Sheet để kiểm tra |
| `attach-logs.mjs` | Gắn vào Chrome đang chạy, stream log service worker |
| `inspect*.mjs` | Soi DOM/network/RENDER_DATA của trang Douyin thật |

Các script cần Chrome mở sẵn cổng debug:

```bash
/Applications/"Google Chrome.app"/Contents/MacOS/"Google Chrome" \
  --user-data-dir="$PWD/.dev-profile" --remote-debugging-port=9223 --no-first-run &
```

## Hạn chế đã biết

- Chỉ hoạt động ở modal detail; feed thuần không có metadata (giới hạn của Douyin, không phải bug)
- Video sniff theo content-length lớn nhất — chỉ hỗ trợ mp4 nguyên file, chưa xử lý m3u8 nhiều segment
- `#RENDER_DATA` chỉ chứa video ban đầu; swipe nhiều video thì fallback sang DOM (title là bản đã dịch của Douyin)
