# worker — xử lý video trên container GPU

## Phase 3 (đang làm): spike VoiceStudio

Mục tiêu: trả lời 2 câu hỏi rủi ro nhất **trước khi** xây worker hoàn chỉnh.

1. API headless `/dub/*` của VoiceStudio có chạy trên Linux server không?
2. Giọng Việt clone từ `MinhQuanVoice.mp3` nghe có dùng được không?

### Chạy trên container thuê

```bash
# 0. trên máy local: đẩy code lên container
git clone https://github.com/ThanhTuGenki/duoyin-videos.git /root/duoyin-videos

# 1. dựng môi trường (~15-25 phút, tải model ~4-20GB)
bash /root/duoyin-videos/worker/setup.sh

# 2. bật VoiceStudio API
bash /root/start_voicestudio.sh
tail -f /tmp/voicestudio.log        # chờ "Application startup complete"

# 3. chạy spike với 1 clip NGẮN (1-2 phút) cho vòng lặp nhanh
/root/VoiceStudio/.venv/bin/python /root/duoyin-videos/worker/spike_voicestudio.py \
  --video /root/test.mp4

# 4. tải audio về máy để nghe
scp -P <PORT> root@<IP>:/root/spike_out/dubbed_vi.mp3 ~/Desktop/
```

### Kết quả spike để ở đâu

| File | Nội dung |
|---|---|
| `/root/spike_out/dubbed_vi.mp3` | **Audio tiếng Việt — nghe cái này để chấm chất lượng giọng** |
| `/root/spike_out/summary.json` | Thời gian generate, số segment, VRAM |
| `/root/spike_out/*.json` | Phản hồi thật của từng endpoint (hợp đồng API thực tế) |

Script cố tình in ra **thứ máy chủ thực sự trả về** thay vì giả định hợp đồng —
bước nào lệch tài liệu thì thấy ngay chứ không phải đoán.

## Bảo mật: API chỉ mở ở loopback

VoiceStudio **không có xác thực** (tài liệu của chính họ nói vậy), mà container
thuê có IP public. Vì thế `start_voicestudio.sh` chỉ bind `127.0.0.1:3900` —
spike và worker đều chạy trên container nên không cần mở ra ngoài.

Muốn mở web UI của VoiceStudio từ máy local thì dùng SSH tunnel, đừng đổi bind:

```bash
ssh -p <PORT> -L 3900:127.0.0.1:3900 root@<IP>
# rồi mở http://127.0.0.1:3900 trên máy mình
```

(Lưu ý: `setup.sh` bỏ qua build frontend nên web UI có thể không hiển thị —
API vẫn đầy đủ. Cần UI thì build thêm bằng bun.)

## Giọng mặc định

`assets/voice/MinhQuanVoice.mp3` (9.67s, 128kbps mono) + `MinhQuanVoice.txt` (transcript).

Transcript quan trọng: theo tài liệu VoiceStudio, voice profile có ô Transcript
rỗng sẽ phải chạy ASR lại **mỗi lần sinh giọng** — chậm hơn nhiều. Spike truyền
transcript qua trường `ref_text` của `POST /profiles`.

Giọng được gán cho **mọi segment** qua `DubSegment.profile_id` khi gọi
`POST /dub/generate/{job_id}`.

Các file giọng khác (NgocNgan, NguyetNga, NgocHuyen, ManhDung, PhongVienNam) còn
trên Drive; thêm sau khi chốt được giọng mặc định chạy tốt.

## Vì sao hai venv riêng

VSR cần torch 2.3 + numpy 1.x; VoiceStudio cần torch 2.8. Không thể chung một
venv. `setup.sh` dựng `venv_vsr` và `.venv` tách biệt — dùng chung một GPU thì
không vấn đề gì.

Lỗi đã gặp và đã xử lý sẵn trong `setup.sh`:
- VSR thiếu `libxkbcommon0` → import PySide6 chết ngay
- `scipy` mới cần numpy≥2 trong khi torch cu118 kéo numpy 1.x → ghim `scipy==1.13.1`

## Dịch LLM qua CLIProxyAPI + Antigravity (đã kiểm chứng 17.08)

Bản dịch `fast` (Google MT) thô; chế độ `cinematic` dùng LLM cho kết quả tự
nhiên hơn hẳn. Đã chạy thật trên container qua CLIProxyAPI:

```bash
# 1. Cài (binary Go, không phụ thuộc gì)
mkdir -p /root/cliproxy && cd /root/cliproxy
curl -fsSL -o cpa.tar.gz https://github.com/router-for-me/CLIProxyAPI/releases/download/v7.2.135/CLIProxyAPI_7.2.135_linux_amd64.tar.gz
tar xzf cpa.tar.gz
printf 'host: "127.0.0.1"\nport: 8317\nauth-dir: "/root/.cli-proxy-api"\n' > config.yaml

# 2. Login Antigravity MỘT LẦN (OAuth callback về cổng 51121 → cần SSH tunnel):
#    máy local:  ssh -p <PORT> -L 51121:127.0.0.1:51121 root@<IP>
./cli-proxy-api --config config.yaml --antigravity-login --no-browser
# → mở URL nó in ra, đăng nhập, token lưu /root/.cli-proxy-api/*.json

# 3. Chạy server
setsid nohup ./cli-proxy-api --config config.yaml > /tmp/cliproxy.log 2>&1 &

# 4. Trỏ VoiceStudio vào proxy (lưu bền qua prefs.json, restart không mất)
curl -X PUT http://127.0.0.1:3900/api/settings/llm-endpoint \
  -H 'Content-Type: application/json' \
  -d '{"base_url":"http://127.0.0.1:8317/v1","model":"gemini-3.5-flash-low","api_key":"dummy"}'
```

Số đo: cinematic 25 đoạn, generate 46s, VRAM 4.453 MiB. `quality_used=cinematic`.

### Vòng đời token & cơ chế khi hết hạn

Hai loại token, hành xử khác nhau:

| Token | Sống bao lâu | Ai lo |
|---|---|---|
| Access token | ~1 giờ | **CLIProxyAPI tự refresh mỗi 15 phút** khi đang chạy (log: `core auth auto-refresh started`) — không cần làm gì |
| Refresh token | Rất lâu (OAuth client là của chính Google/Antigravity, không dính hạn 7 ngày của app Testing) | Chỉ chết khi: bạn revoke trong Google Account, đổi mật khẩu, hoặc **không dùng >6 tháng** |

Cơ chế 4 lớp (đã cài vào setup.sh, worker Phase 4 dùng lớp 3-4):

1. **Backup**: token nằm ở `secrets/cli-proxy-api/` trên máy local (gitignore).
   Thuê máy mới → scp thư mục `secrets/` lên `/root/secrets/` → `setup.sh` tự
   khôi phục vào `/root/.cli-proxy-api/` — **không phải login lại**.
2. **Tự refresh**: proxy đang chạy thì token không bao giờ hết hạn giữa chừng.
3. **Health check trước mỗi phiên** (worker Phase 4): gọi `GET /v1/models` của
   proxy; lỗi/401 → báo Telegram "cần login lại Antigravity" kèm lệnh sẵn.
4. **Fallback không đứng dây chuyền** (worker Phase 4): dịch `cinematic` lỗi
   → tự hạ về `fast` (Google MT, không cần token), ghi chú vào Sheet cột
   translation_mode để biết video nào cần chạy lại bản đẹp.

Login lại (hiếm khi cần, ~2 phút): xem cảnh báo setup.sh in ra — mở tunnel
`ssh -L 51121:...`, chạy `--antigravity-login --no-browser`, mở URL, đăng nhập.
Xong **nhớ backup token mới về secrets/**.

Lưu ý khác:
- Bind loopback (VoiceStudio và proxy đều không có xác thực).
- Dùng quota subscription qua proxy là vùng xám ToS — phương án thay thế:
  API key Gemini Flash trả phí, đổi mỗi `base_url`/`api_key`.

## Phase 4 — worker 2 giai đoạn (dub đã chạy thật 17.08)

Dub và xóa sub **tách container riêng**. Lý do: dựng VSR hay vấp môi trường
(Python 3.12, OpenGL, paddle từ mirror TQ), tách ra thì nhánh dub chạy được
ngay; thêm nữa preview cho phép **duyệt trước khi tốn tiền VSR**.

```bash
bash /root/start_worker.sh dub     # NEW → DUBBING → DUBBED  (máy này)
bash /root/start_worker.sh vsr     # DUBBED → CLEANING → DONE (container khác)
bash /root/start_worker.sh all     # cả hai trên cùng máy
# chạy 1 lượt để thử:
/root/worker-venv/bin/python /root/duoyin-videos/worker/worker.py --stage dub --once
```

Đầu ra mỗi giai đoạn (Drive `output/<id>/`):

| Giai đoạn | File | Dùng để |
|---|---|---|
| dub | `audio_vi.wav` | nguyên liệu cho stage vsr |
| dub | `<id>_preview.mp4` | video gốc + tiếng Việt — **duyệt giọng/bản dịch** |
| vsr | `<id>_vi.mp4` | thành phẩm: sạch sub + tiếng Việt |

Số đo thật (RTX 3090, video ~118s): dub **155s/video** (TTS 80s + tải/mux/upload
52MB). `health_check` chỉ kiểm thứ stage đó cần — VSR chưa dựng xong không
chặn stage dub.

Cấu trúc:
- `wcontract.py` — pure functions theo hợp đồng (21 unit tests, chạy local:
  `.venv-dev/bin/python -m pytest tests/`)
- `worker.py` — vòng lặp + client mỏng (Sheet/rclone/VSR/VoiceStudio/ffmpeg)

Hành vi có chủ đích:
- **Video không lời thoại** (<3 đoạn hoặc nói <10% thời lượng) → ERROR với
  message rõ, không tạo bản dub vô nghĩa (ca thật: video nhạc 助眠 17.08)
- **Dịch fallback** `cinematic → fast` khi proxy LLM lỗi; cả hai fail hoặc
  kết quả trông như chưa dịch (≥nửa số câu y hệt gốc) → ERROR
- Lỗi 1 job không làm sập vòng lặp; job xong dọn sạch thư mục tạm
- Chạy lại dòng lỗi: sửa tay status → NEW trên Sheet

### Drive: đọc bằng SA, GHI bằng OAuth user (bắt buộc)

Service account không có quota lưu trữ → không upload được
(`storageQuotaExceeded`). Worker dùng 2 remote rclone:

| Remote | Auth | Dùng cho |
|---|---|---|
| `gdrive` | service account (`sa.json`) | đọc inbox |
| `gdrive-user` | OAuth cá nhân qua client chính chủ của rclone (app verified → refresh token KHÔNG dính hạn 7 ngày) | ghi output |

Lấy token 1 lần trên máy local: `rclone authorize "drive"` → dán JSON vào
`secrets/rclone-user-token.json` → scp `secrets/` lên → `setup.sh` tự tạo remote.

### Telegram (tuỳ chọn)

Đặt env `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` trước khi chạy worker.
Không đặt thì thông báo chỉ ra log.
