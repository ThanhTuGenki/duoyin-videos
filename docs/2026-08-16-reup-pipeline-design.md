# Thiết kế Pipeline Reup Video Tự Động

**Ngày:** 2026-08-16
**Trạng thái:** Đã triển khai, nhưng **phạm vi đã thu hẹp** — xem ghi chú dưới.
**Mục tiêu:** Tự động hóa flow reup video: xóa hardsub + lồng tiếng Việt, tối ưu chi phí GPU thuê theo giờ.

---

> **Cập nhật 18.08.2026 — đã bỏ phần xoá hardsub (VSR).**
>
> Tài liệu này giữ nguyên như lúc thiết kế để làm hồ sơ. Thực tế sau khi chạy
> production: dây chuyền **kết thúc ở lồng tiếng**, thành phẩm là
> `<id>_dubbed.mp4` + `<id>_vi.srt`, và việc che sub làm ngoài bằng CapCut
> hoặc `ffmpeg delogo` trên máy cá nhân.
>
> Lý do là **chi phí, không phải lỗi**: VSR xoá sub sạch (đã kiểm bằng trích
> frame) nhưng tốn ~262s cho video 122s — khoảng 2× thời lượng, tức
> ~475⚡/video, gấp ~3 lần chặng lồng tiếng. Hai hướng tối ưu đã thử đều không
> ăn: máy không nghẽn CPU (32 core, load 26), và cho chạy 3 luồng song song
> chỉ đổi 268s → 262s mỗi video vì từng job chậm đi tương ứng.
>
> Vì thế mọi chỗ nói "video sạch sub" trong tài liệu này nên đọc là "video đã
> lồng tiếng, sub che ở bước hậu kỳ ngoài dây chuyền". Quy trình vận hành thật
> nằm ở `RUNBOOK.md`.

---

## 1. Mục tiêu & Phạm vi

- **Đầu vào:** Extension tự viết (Chrome) — 1 click trên trang video đang xem: nhặt file video + toàn bộ metadata (title, thumbnail, description, author...) đẩy lên Google Drive và ghi dòng vào Google Sheet. Dự phòng khi extension hỏng: tải tay + up Drive + điền Sheet (cùng hợp đồng dữ liệu). Không dùng nguồn public → không có yt-dlp trong hệ thống.
- **Đầu ra:** Video sạch sub + lồng tiếng Việt, lưu trên Google Drive, link ghi vào Google Sheet.
- **Ngoài phạm vi (giai đoạn sau):** Tự động upload lên YouTube/TikTok. Giai đoạn đầu upload tay.
- **Ưu tiên số 1:** Tối ưu chi phí thuê container GPU (trả theo giờ bật máy, không phải giờ GPU chạy).

## 2. Công cụ sử dụng

| Công cụ | Vai trò | Ghi chú |
|---|---|---|
| [video-subtitle-remover (VSR)](https://github.com/YaoFANGUK/video-subtitle-remover) | Xóa hardsub trên track hình | Đã chạy tốt trên container, mode `sttn-auto` tự phát hiện vùng sub. CLI: `-i -o -c --inpaint-mode` |
| [VoiceStudio](https://github.com/debpalash/VoiceStudio) | Lồng tiếng: ASR → dịch → TTS → mix | Headless chính thức (`OMNIVOICE_SERVER_MODE=1`, port 3900), REST API đầy đủ, tiếng Việt 8.482h data train |
| Extension tự viết (Chrome, Manifest V3) | Cổng ingest duy nhất: bắt video + metadata + thumbnail từ trang đang xem, up Drive, ghi Sheet | Tải bằng session đăng nhập thật trong browser — không dính risk-control như cookies + IP datacenter |
| ffmpeg | Ghép hình sạch + tiếng Việt | Có sẵn trên container |
| Google Sheet + gspread | Queue + dashboard + lịch sử | Service account, không cần OAuth tay |
| Google Drive + rclone | Kho video vào/ra | Container xóa được mà không mất data |
| Telegram Bot | Thông báo tiến độ, nhắc tắt máy | |
| ezycloudx | Thuê container GPU | Console: https://www.ezycloudx.com/console/gpu-mgmt |

## 3. Kiến trúc tổng quan

```
[Bạn - local/điện thoại]                [Google Cloud]              [Container GPU - chỉ bật khi có việc]
                                                                    
 Extension 1-click trên ───────►  Google Sheet (queue)  ◄─────────  Worker poll mỗi 30s, update status
 trang video: ghi metadata              │                                    │
        │                               │                            Với mỗi dòng NEW:
        └─ video + thumb ──────►  Google Drive (kho)   ◄─────────►  1. Tải từ Drive (rclone)
           + meta.json                  │                           2. CHẠY SONG SONG trên cùng video:
                                        │                              ├─ VSR xóa sub (track hình)
 ◄──── Telegram: tiến độ, ─────         │                              └─ VoiceStudio dub (track tiếng)
       lỗi, "queue rỗng            Thành phẩm +                     3. ffmpeg mux hình sạch + tiếng Việt
       tắt máy đi"                 link trong Sheet                 4. Up Drive, ghi link vào Sheet
```

**Điểm mấu chốt — song song trong 1 video:** VSR chỉ đụng track hình, VoiceStudio chỉ đụng track tiếng → hai việc độc lập hoàn toàn, chạy đồng thời trên cùng video. Thời gian xử lý ≈ thời gian nhánh chậm nhất (VSR). Bước lồng tiếng "trốn" trong lúc VSR chạy → gần như miễn phí về giờ thuê.

```
video_goc.mp4 ──┬─► VSR: xóa sub trên frame          (~2.4× thời lượng video)
                └─► VoiceStudio: dub tiếng Việt      (~0.4× thời lượng, chạy cùng lúc)
                Cả 2 xong ─► ffmpeg mux ─► thanh_pham.mp4 (vài giây)
```

Lấy audio đã dub qua `GET /dub/download-audio/{job_id}` (không dùng video mux sẵn của VoiceStudio vì hình của nó chưa xóa sub).

## 4. Flow xử lý 1 video (chuỗi API cụ thể)

1. Worker thấy dòng `status=NEW` trong Sheet → set `DOWNLOADING`
2. Tải từ Drive: `rclone copy` folder của video (video.mp4 + meta.json)
3. Set `PROCESSING`, chạy song song:
   - **Nhánh hình:** `venv_vsr/bin/python backend/main.py -i video.mp4 -o clean.mp4 --inpaint-mode sttn-auto` (không cần tọa độ, tự phát hiện)
   - **Nhánh tiếng:** VoiceStudio API:
     - `POST /dub/upload` → job_id
     - `POST /dub/transcribe/{job_id}` (WhisperX + Demucs tách giọng/nhạc nền + diarization)
     - `POST /dub/generate/{job_id}` (dịch + TTS từng segment theo speaker, giữ nhạc nền gốc)
     - `POST /dub/qc/{job_id}` (QC tự động)
     - `GET /dub/download-audio/{job_id}` → audio tiếng Việt
     - Theo dõi tiến độ: `GET /jobs/{job_id}` + `/jobs/{job_id}/events`
4. Set `MUXING`: `ffmpeg -i clean.mp4 -i dubbed_audio -c:v copy -map 0:v -map 1:a out.mp4`
5. Set `UPLOADING`: `rclone copy out.mp4 drive:reup-output/` → ghi `output_link` vào Sheet
6. Set `DONE` (hoặc `ERROR` + message). Gửi Telegram.
7. Queue rỗng liên tục N phút → Telegram nhắc tắt máy.

**Dịch thuật:** Google Translate/MyMemory miễn phí không cần key; khuyên dùng chế độ **Cinematic** (cần 1 LLM key rẻ — Gemini Flash/GPT-4o-mini) cho thoại tự nhiên. Trung→Việt: Cinematic đáng tiền.

### 4b. Ingest: extension là cổng vào duy nhất (quyết định cập nhật 16.08)

**Hợp đồng ingest (bất biến)** — worker chỉ đọc hợp đồng này, không biết và không quan tâm nguồn video là gì:
- **Sheet row:** theo schema mục 5
- **Drive folder mỗi video:** `video.mp4` + `thumb.jpg` + `meta.json` (title, description, tags, author, stats, source_url)

| Đường | Vai trò | Cách hoạt động |
|---|---|---|
| Extension tự viết | **Chính — duy nhất** | 1 click trên trang video: bắt file + metadata + thumbnail → up Drive → ghi dòng Sheet |
| Tải tay + up Drive + điền Sheet | Dự phòng khi extension hỏng | Cùng hợp đồng → worker không đổi |

Lý do bỏ hướng yt-dlp + cookies (đề xuất cũ): không dùng nguồn public nên yt-dlp không có việc; cookies + IP datacenter dính risk-control Douyin (dễ vô hiệu, rủi ro flag tài khoản); metadata phải cào riêng trong khi extension nhặt sẵn trong DOM. Mọi coupling với trang nguồn dồn về extension — Douyin đổi giao diện chỉ sửa extension, **worker xử lý video không đổi một dòng**.

## 5. Schema Google Sheet

| Cột | Ai điền | Mô tả |
|---|---|---|
| `id` | Extension | STT / UUID |
| `title` | Extension | Title gốc nhặt từ trang video |
| `author` | Extension | Kênh/tác giả gốc |
| `source_url` | Extension | Link gốc — chỉ để tham khảo/tra cứu, worker KHÔNG dùng để tải |
| `drive_folder_link` | Extension | Folder trên Drive chứa `video.mp4` + `thumb.jpg` + `meta.json` |
| `voice` / `translation_mode` | Bạn (có default) | Giọng lồng · fast / cinematic / autofit |
| `status` | Worker | NEW → DOWNLOADING → PROCESSING → MUXING → UPLOADING → DONE / ERROR |
| `output_link` | Worker | Link thành phẩm trên Drive |
| `error` | Worker | Message lỗi nếu có |
| `duration` / `process_time` / `updated_at` | Worker | Đo lường & ước chi phí |

## 6. Lựa chọn GPU: RTX 3090

| | RTX 3060 (12GB) | RTX 3090 (24GB) |
|---|---|---|
| Giá | 3.200⚡/h | 6.500⚡/h (2.03×) |
| Sức mạnh thực tế | 1× | ~2.2–2.5× (TFLOPS + bandwidth) |
| Specs container | 100GB disk | 32 cores / 60GB RAM / 923GB disk |
| **Chi phí / video** | 1× | **≈ 0.8–0.9× (rẻ hơn)** |

Lý do chọn 3090:
- Nhanh 2.2–2.5× nhưng chỉ đắt 2.03× → mỗi video rẻ hơn, chờ ít hơn một nửa.
- **VRAM 24GB quyết định:** VoiceStudio trên VRAM nhỏ phải swap TTS model xuống CPU nhường chỗ cho ASR (chậm, từng có bug kẹt model ở CPU chậm 10-50×). 24GB → mọi model nằm yên trên GPU + đủ chỗ chạy VSR song song (VSR ~2GB + VoiceStudio ~6-8GB).
- Disk 923GB chứa thoải mái video batch + model cache (~15-20GB).

Chỉ dùng 3060 nếu làm 1-2 video ngắn/ngày, chấp nhận chạy tuần tự.

## 7. Chiến lược tối ưu chi phí GPU

1. **Batch theo phiên:** dồn link cả ngày → bật máy 1 lần → chạy hết queue → tắt. KHÔNG bật 24/7 (76.800–156.000⚡/ngày).
2. **`setup.sh` idempotent:** dựng lại toàn bộ môi trường ~10 phút nếu container bị xóa. Model cache trên disk.
3. **Song song hình ∥ tiếng** trong 1 video (mục 3).
4. **Pipeline nhiều video** (tầng tối ưu 2, làm sau khi tầng 1 ổn): video A đang xóa sub thì video B bắt đầu dub.
5. **Nhắc tắt máy** qua Telegram khi queue rỗng (ezycloudx chưa thấy API public để tự tắt).

**Ước tính chi phí (3090):** video 10 phút ≈ 10-12 phút máy ≈ **~1.200⚡/video**. Batch 10 video/phiên ≈ ~2h ≈ 13.000⚡.

## 8. Số liệu thực tế đã đo (2026-08-16, RTX 3060)

- VSR `sttn-auto`, video 1080p 3511 frames (~2.5 phút): **356 giây ≈ 2.4× thời lượng**, VRAM 1.7GB, GPU 100%.
- Môi trường VSR trên container hiện tại đã fix xong và chạy tốt (libxkbcommon0, scipy 1.13.1, app.py gọi đúng CLI `-i -o -c`).

## 9. Rủi ro & việc cần xác minh (spike trước khi code)

| # | Rủi ro | Cách xác minh | Phương án B |
|---|---|---|---|
| 1 | VoiceStudio headless trên container ezycloudx (cài từ source, không Docker-in-Docker được) | Spike: cài + dub thử `1.mp4` sang tiếng Việt qua API, đo thời gian + VRAM | Tự ghép pipeline: WhisperX + LLM dịch + edge-tts (giọng Việt miễn phí) |
| 2 | Chất lượng giọng Việt của engine mặc định | Nghe kết quả spike | Đổi TTS engine trong catalogue (16 engines) hoặc edge-tts |
| 3 | ezycloudx: tắt container có mất data / còn tính phí không? | **Bạn kiểm tra trên console** | Nếu mất data: `setup.sh` + mọi thứ quan trọng nằm trên Drive/Sheet |
| 4 | Douyin đổi giao diện làm extension hỏng | Chấp nhận — coupling đã cô lập ở tầng ingest | Dự phòng: tải tay + up Drive + điền Sheet — cùng hợp đồng, worker không đổi |
| 5 | Bản quyền / Content ID khi reup | — | Quyết định của bạn về nguồn video & nền tảng đích |

## 10. Lộ trình triển khai (thứ tự cập nhật 16.08: extension lên trước)

Extension chỉ phụ thuộc **hợp đồng ingest** — không phụ thuộc worker/VoiceStudio → làm trước an toàn. Spike VoiceStudio không chặn gì, tranh thủ chạy lúc container đang bật sẵn.

### Phase 1 — Nơi lưu trước: Drive + Sheet + hợp đồng — ✅ XONG 16.08.2026
1. Tạo cấu trúc **Google Drive** thật: `duoyin-videos/inbox/` (mỗi video 1 folder: `video.mp4` + `thumb.jpg` + `meta.json`) và `duoyin-videos/output/` (thành phẩm)
2. Tạo **Google Sheet** thật với đầy đủ cột theo schema mục 5, kèm 1 dòng mẫu
3. Tạo **service account** (Google Cloud) + share quyền Editor vào Sheet & Drive folder — worker và extension dùng chung điểm truy cập này
4. Repo GitHub private (cấu trúc mục 11) + văn bản hóa những gì vừa tạo thành `contract/meta.schema.json` + `contract/sheet-columns.md`
- **Deliverable:** nơi lưu chạy được ngay (up tay 1 video mẫu vào inbox, điền 1 dòng Sheet) + hợp đồng v1 chốt — hai phía code theo nó

### Phase 2 — Extension ingest (TypeScript, Manifest V3) — ✅ XONG 17.08.2026
- Nút 1-click trên trang video: bắt file video + title/description/tags/author + thumbnail
- Up Drive (resumable upload qua `chrome.identity`), ghi dòng Sheet theo hợp đồng
- **Deliverable:** xem video → 1 click → `video.mp4` + `thumb.jpg` + `meta.json` nằm đúng chỗ trên Drive, dòng NEW xuất hiện trong Sheet

### Phase 3 — Spike VoiceStudio + worker lõi (Python)
- Cài VoiceStudio headless (port 3900), dub thử `1.mp4` sang tiếng Việt qua API — đo thời gian/VRAM/chất lượng giọng, chốt GO/NO-GO + quyết định thuê 3090
- Worker CLI: nhận 1 file video → song song VSR ∥ dub → mux (chưa cần Sheet)
- **Đúng 1 quy trình xử lý video, không chứa bất kỳ logic ingest nào**
- **Deliverable:** chạy 1 lệnh, vào video ra thành phẩm

### Phase 4 — Nối vòng: Sheet + Drive + Telegram
- Service account, worker poll Sheet, rclone Drive 2 chiều, Telegram bot, `setup.sh` hoàn chỉnh
- **Deliverable:** click extension → thành phẩm tự về Drive + thông báo, không đụng terminal

### Phase 5 — Tối ưu vận hành & tiện ích
- Pipeline nhiều video đồng thời, retry lỗi, log chi phí ⚡/video vào Sheet
- Sinh title/description/tags tiếng Việt bằng LLM từ metadata gốc extension đã nhặt
- (Tùy chọn) Auto-upload: YouTube Data API (app chưa verify sẽ khóa video ở private) / TikTok Content Posting API

## 11. Ngôn ngữ, tổ chức code & quy trình khi thuê máy

### Ngôn ngữ
| Thành phần | Ngôn ngữ | Lý do |
|---|---|---|
| Extension | TypeScript (Manifest V3, build bằng Vite) | Chrome bắt buộc JS; TS thêm type cho hợp đồng ingest + payload Drive/Sheets API |
| Worker | Python 3.12 (quản lý bằng `uv`) | Cùng hệ sinh thái VSR (CLI) + AI stack; gspread, requests (VoiceStudio REST), subprocess (ffmpeg/rclone) |
| Hợp đồng | JSON Schema (`contract/meta.schema.json`) | Một nguồn sự thật: extension sinh TS types, worker validate bằng pydantic |

### Cấu trúc repo (GitHub private, monorepo)
```
duoyin-videos/
├── contract/         # meta.schema.json + sheet-columns.md — hợp đồng ingest
├── extension/        # TypeScript — chạy trên Chrome máy local, không liên quan container
├── worker/           # Python — chạy trên container GPU
├── setup.sh          # bootstrap container thuê mới (~10-15 phút)
└── docs/             # design doc, ghi chú
```

### Quy trình code khi thuê máy
1. **Code luôn ở local + GitHub** — container chỉ là nơi chạy, xóa không mất gì
2. Thuê máy mới → SSH → `git clone … && ./setup.sh` (apt deps, clone VSR + VoiceStudio, venv, tải models ~10-15 phút)
3. `scp` secrets **một lần**: `.env`, `service-account.json`, `rclone.conf` — không bao giờ commit secrets
4. `./start.sh` — worker chạy trong tmux, tự poll Sheet
5. Sửa code: push từ local → container `git pull` → restart worker. Không sửa code trực tiếp trên container
6. Queue rỗng → tắt máy. Thuê lại → lặp bước 2-4 (ezycloudx giữ disk thì chỉ cần `git pull`)
7. Extension: dev hoàn toàn ở local — `chrome://extensions` → Load unpacked → `extension/dist`

## 12. Tài liệu liên quan
- Sơ đồ trực quan toàn luồng (artifact): https://claude.ai/code/artifact/ee85d9b4-1dd3-4d58-be9e-79b41e9e72b5 (file nguồn: `flow-overview.html` cùng thư mục)
