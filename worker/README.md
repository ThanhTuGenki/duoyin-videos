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

Lưu ý:
- **Token `/root/.cli-proxy-api/*.json` là secret** — backup như service account,
  không commit. Mất container = login lại (1 lần, cần tunnel).
- Bind loopback (VoiceStudio và proxy đều không có xác thực).
- Dùng quota subscription qua proxy là vùng xám ToS — phương án thay thế:
  API key Gemini Flash trả phí, đổi mỗi `base_url`/`api_key`.
- Phase 4: đưa vào setup.sh + start script; worker fallback `cinematic → fast`
  khi proxy không phản hồi.

## Phase 4 (chưa làm)

Worker poll Sheet → rclone kéo video từ Drive → chạy song song VSR ∥ VoiceStudio
→ ffmpeg mux → đẩy Drive → cập nhật status → Telegram báo.
