# worker — xử lý video trên container GPU

## Phase 3 — spike VoiceStudio (đã xong 17.08)

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
   Bản sao lưu ngoài máy: xem "Khôi phục secrets khi đổi máy" bên dưới.
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

## Khôi phục secrets khi đổi máy

`secrets/` bị gitignore (đúng — không bao giờ commit khoá), nên **clone repo
về máy mới là chưa chạy được**. Bản sao lưu đã mã hoá nằm trên Drive:

```bash
rclone copy tyziiu:duoyin-secrets/duoyin-secrets.tar.gz.enc /tmp/
cd <repo> && openssl enc -d -aes-256-cbc -pbkdf2 -in /tmp/duoyin-secrets.tar.gz.enc | tar xzf -
```

Gõ mật khẩu **bằng tay**; dán nhiều dòng một lúc thì dòng sau bị nuốt vào ô
mật khẩu (đã dính 17.08). Kiểm mà không đè `secrets/` đang dùng: thay `tar xzf -`
bằng `tar tzf -` để chỉ liệt kê.

Sau khi khôi phục: `./deploy.sh <IP> <PORT> '<PASS>'` — không phải login lại gì.

Trong gói có 5 file, mất mỗi thứ tốn công khác nhau:

| File | Mất thì phải |
|---|---|
| `sa.json` | tạo lại service account key, share lại folder Drive cho nó |
| `rclone-user-token.json` | `rclone authorize "drive"` + đăng nhập browser |
| `cli-proxy-api/antigravity-*.json` | login lại Antigravity qua tunnel cổng 51121 |
| `extension-key.pem` | **nặng nhất** — extension ID đổi → redirect URI OAuth sai → sửa lại Google Cloud + cài lại extension |
| `extension-pub.der` | sinh lại từ `.pem` |

Cập nhật bản sao lưu sau khi đổi/ thêm khoá (lệnh mã hoá rồi đẩy lên, ghi đè
file cũ):

```bash
cd <repo> && tar czf - secrets/ \
  | openssl enc -aes-256-cbc -pbkdf2 -out /tmp/duoyin-secrets.tar.gz.enc \
  && rclone copy /tmp/duoyin-secrets.tar.gz.enc tyziiu:duoyin-secrets/ \
  && rm /tmp/duoyin-secrets.tar.gz.enc
```

Mã hoá chứ không để trần vì `rclone-user-token.json` cho quyền **ghi toàn bộ
Drive** — ai đọc được file đó là ghi được Drive. Mất mật khẩu là mất luôn gói,
không có đường khôi phục.

## Phase 4 — worker (đã chạy thật 17-18.08)

Dây chuyền **kết thúc ở lồng tiếng**. Stage `vsr` (xoá sub) còn trong code và
vẫn chạy đúng, nhưng đã bỏ khỏi quy trình 18.08 vì chi phí — xem mục
"Vì sao bỏ VSR" bên dưới. Vận hành hằng ngày xem `RUNBOOK.md`.

```bash
bash /root/start_worker.sh dub     # NEW → DUBBING → DUBBED  ← đang dùng
bash /root/start_worker.sh vsr     # DUBBED → CLEANING → DONE (không dùng nữa)
# chạy 1 lượt để thử:
/root/worker-venv/bin/python /root/duoyin-videos/worker/worker.py --stage dub --once
```

Đầu ra (Drive `output/<id>/`):

| File | Nội dung |
|---|---|
| `<id>_dubbed.mp4` | **thành phẩm** — video đã lồng tiếng Việt, còn sub Trung |
| `<id>_vi.srt` | phụ đề Việt rời (gắn ở CapCut nếu cần) |

Che sub làm ngoài, miễn phí: `ffmpeg -vf "delogo=x=100:y=860:w=1720:h=150"`
cho video 1920×1080. Toạ độ và cách đo lại ở `RUNBOOK.md`.

**Không tự ghép audio nữa** (đổi 17.08). Worker lấy thẳng video VoiceStudio đã
trộn: `GET /dub/download/{job}?include_tracks=vi&default_track=vi&preserve_bg=true`
→ h264+aac, 1 track tiếng Việt, giữ nhạc nền. Trước đây worker chỉ tải audio rồi
tự `ffmpeg` ghép vào video gốc — bỏ mất phần VoiceStudio canh lại timeline video,
nên câu dài bị cắt cụt.

Số đo thật (RTX 3090, video ~110-120s):

| Chỉ số | Giá trị |
|---|---|
| dub, tuần tự | ~155s/video |
| dub, `DUB_CONCURRENCY=3` | ~86s/video (đo 16 video/22m59s) → **nhanh 1.8×**, không phải 3× |
| Video ra bị giãn | +5.5% ~ +6.5% (do `smart_fit`, mắt thường không thấy) |
| Dung lượng ra | ~85MB/2 phút (VoiceStudio encode lại vì retime video) |

`health_check` chỉ kiểm thứ stage đó cần — VSR chưa dựng xong không chặn stage dub.

### Vì sao bỏ VSR khỏi quy trình (đo 18.08)

Không phải vì lỗi — VSR xoá sub sạch, đã kiểm bằng cách trích frame. Bỏ vì
**chi phí**: ~262s cho video 122s (≈2× thời lượng), tức **~475⚡/video**, gấp
~3 lần chặng dub. Che sub bằng CapCut/`ffmpeg delogo` ngoài máy thì miễn phí.

Đã thử hai hướng tối ưu, **cả hai đều không ăn** — ghi lại để đừng thử lại:

1. Nghi thiếu CPU → sai. Máy 32 core, load 26, không nghẽn.
2. Cho chạy 3 luồng song song (trước đó `workers` bị ép cứng 1 cho stage vsr):
   **262s/video so với 268s tuần tự**. Từng job chậm hẳn đi (328-455s so với
   220-275s khi chạy một mình) nên tổng lại như cũ. Giả thuyết "pha CPU dò sub
   của job này chồng lên pha GPU vá frame của job kia" — sai.

Nay `VSR_CONCURRENCY` vẫn để mặc định 3; ai chạy lại thì tự đo trước.

#### Nếu chạy lại: BẮT BUỘC đặt `VSR_SUB_AREA`

```bash
VSR_SUB_AREA="860,1010,100,1820" bash /root/start_worker.sh vsr   # 1080p
```

Không đặt thì VSR tự dò vùng sub bằng PaddleOCR — và **bản CPU dò không ra
gì**, nên nó chỉ encode lại, phụ đề còn nguyên. Nguy hiểm là VSR vẫn **thoát
mã 0** và tạo file hợp lệ, worker báo `DONE` giả:

| | Không `-c` | Có `-c 860 1010 100 1820` |
|---|---|---|
| GPU trong lúc chạy | **2%** (không hề inpaint) | **95-100%** |
| Frame giây 40 | còn nguyên `外边再扩建成这么大` | **chữ mất sạch** |

GPU 2% là dấu hiệu nhận biết nhanh nhất. `vsr_remove_subs` nay ném lỗi nếu
output VSR không nhắc tới vùng sub nào dò được, không im lặng báo DONE nữa.

Toạ độ là **pixel**, thứ tự `ymin,ymax,xmin,xmax`, và `-c` của VSR khai báo
`nargs=4` nên `vsr_command` tách thành 4 tham số rời. Đổi độ phân giải là phải
đo lại (trích 1 frame, xem sub ở đâu).

Muốn dò tự động thì cần **paddle GPU** — chỉ có trên mirror Trung Quốc, tải từ
datacenter hay treo (xem `PADDLE_MODE` trong setup.sh).

### Vì sao `smart_fit` chứ không phải `concise`/`stretch_video` (đo 17.08)

Vấn đề user báo: *"nó hay bị dừng ngang ở từ cuối cùng không được tự nhiên"*.

Nguyên nhân đo được: tiếng Việt cần **~2× thời gian** tiếng Trung cho cùng ý —
80-100% câu có `rate_ratio` > 1, cao nhất 2.5. Đây là tính chất cặp ngôn ngữ,
không phải lỗi bản dịch.

| `TIMING_STRATEGY` | Cách xử lý câu lố | Kết quả |
|---|---|---|
| `concise` (default của VoiceStudio) | **cắt cứng** ở biên slot | → cụt từ cuối. Đây là thứ user nghe thấy. |
| `strict_slot` | nén audio cho vừa slot | giọng nhanh bất thường |
| **`smart_fit`** ← đang dùng | audio nhanh ≤1.2× **+** video chậm ≤2.0×, có bản ghi cue đã khớp | không cắt, `.srt` vẫn đúng timestamp |
| `stretch_video` | chỉ giãn video | **KHÔNG** có bản ghi cue đã khớp → `.srt` lệch. Tránh, vì ta cần `.srt` dùng ở CapCut. |

Chỉ giãn +6% tổng thời lượng dù `rate_ratio` tối đa 2.5 — vì đó là câu lố *nhất*,
còn khoảng lặng giữa các câu hấp thụ gần hết phần dư.

Đã thử `translation_mode=autofit` (cinematic + ép ngắn) kỳ vọng giảm lố: **không
có tác dụng** (34/34 câu vẫn lố, so với 31/33 của cinematic). Giữ `cinematic`.

Đổi bằng env, không phải sửa code:
```bash
TIMING_STRATEGY=strict_slot DUB_CONCURRENCY=3 bash /root/start_worker.sh dub
```

Cấu trúc:
- `wcontract.py` — pure functions theo hợp đồng (33 unit tests, chạy local:
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
