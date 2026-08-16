# Duoyin Ingest — Chrome Extension

1-click trên trang video Douyin: bắt `video.mp4` + metadata + thumbnail → up Drive `inbox/<id>/` → ghi dòng `NEW` vào Sheet queue. Theo hợp đồng `contract/`.

## Build

```bash
npm install
npm run build     # bundle vào dist/ + typecheck
npm test          # unit test phần hợp đồng
```

## Cài vào Chrome (1 lần)

1. `chrome://extensions` → bật **Developer mode** → **Load unpacked** → chọn thư mục `extension/dist/`
2. Extension ID phải là `bbhcmfeedghfopbijnbjnhdfenfdinli` (đã pin bằng `key` trong manifest — máy nào load cũng ra ID này)

## Tạo OAuth client (1 lần, ~5 phút)

Extension upload Drive/ghi Sheet bằng chính tài khoản Google của bạn qua `chrome.identity`, cần OAuth client:

1. https://console.cloud.google.com → tạo (hoặc chọn) project
2. **APIs & Services → Library**: Enable **Google Drive API** và **Google Sheets API**
3. **OAuth consent screen**: External → điền tên app tùy ý → thêm email của bạn vào **Test users**
4. **Credentials → Create Credentials → OAuth client ID** → Application type: **Chrome Extension** → Item ID: `bbhcmfeedghfopbijnbjnhdfenfdinli`
5. Copy Client ID (dạng `xxxx.apps.googleusercontent.com`) → dán vào `manifest.json` trường `oauth2.client_id` → `npm run build` lại → bấm nút reload extension trong `chrome://extensions`

## Dùng

1. Mở trang video Douyin, **phát video vài giây** (để background sniff được URL mp4 khi player dùng blob:)
2. Bấm icon extension → **Gửi video này vào queue**
3. Lần đầu Google sẽ hiện popup xin quyền Drive/Sheets → đồng ý
4. Theo dõi log trong popup; xong sẽ có notification + dòng NEW trong Sheet

Cấu hình folder inbox / Sheet ID: chuột phải icon → Options (mặc định đã trỏ đúng nơi lưu thật).

## Kiến trúc

- `src/content.ts` — adapter Douyin: nhặt title/author/tags/stats từ DOM (nhiều tầng fallback), URL video nếu không phải blob:
- `src/background.ts` — sniff URL mp4 từ network (webRequest, giữ request media lớn nhất mỗi tab), tải video bằng cookie session thật, upload Drive (resumable), append Sheet
- `src/lib/contract.ts` — types + builders theo hợp đồng v1.0 (có unit test)
- Douyin đổi giao diện → chỉ sửa `content.ts`; worker và hợp đồng không đổi

## Hạn chế đã biết (v0.1)

- Selector DOM của Douyin (`data-e2e=...`) là best-effort — cần test trên trang thật, sẽ chỉnh sau lần chạy đầu
- Video sniff theo content-length lớn nhất — video dài nhiều segment (m3u8) chưa xử lý, chỉ hỗ trợ mp4 nguyên file
- Notification dùng icon 1px placeholder
