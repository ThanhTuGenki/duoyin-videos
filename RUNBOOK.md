# Runbook — chạy dây chuyền trên máy thuê

Dành cho lúc vận hành thật. Chi tiết kỹ thuật xem `worker/README.md`.

Dây chuyền ra **bản đăng được luôn**: lồng tiếng Việt → che sub Trung → đốt sub
Việt, tất cả trên cùng máy thuê. Xoá sub bằng VSR đã bị bỏ (lý do ở mục cuối);
thay bằng che sub bằng ffmpeg — rẻ hơn hàng chục lần.

## Trước khi thuê: hiểu chi phí

Số đo thật trên RTX 3090 (6.800⚡/h):

| Chặng | Thời gian/video | Song song |
|---|---|---|
| dub (dịch + lồng tiếng, GPU) | ~90-170s với 3 luồng | có, nhanh ~1.8× |
| hậu kỳ (che sub + đốt sub, CPU) | **chưa đo** — ước 30-60s | chạy xen, CPU đang rảnh |

→ 100 video ≈ **2.5-5 giờ ≈ 17.000-34.000⚡** (hậu kỳ dùng CPU rảnh nên gần như
không thêm giờ máy, nhưng con số này **chưa kiểm chứng trên máy thật**).

Chênh lệch lớn vì video dài ngắn khác nhau. Muốn biết chính xác thì chạy ~20
phút rồi đo (xem mục Theo dõi).

## Bước 1 — trên Terminal của Mac (1 lệnh)

Phải chạy từ Mac vì `secrets/` nằm ở đây, không có trong git.

```bash
cd ~/Desktop/Project/duoyin-videos
./deploy.sh <IP> <PORT> '<PASSWORD>'
```

Nó tự: đóng gói code + secrets → đẩy lên → dựng môi trường → bật CLIProxyAPI
+ VoiceStudio → **dừng lại, không tự chạy worker**. Lần đầu ~5-10 phút.

Muốn bỏ luôn 7 phút chờ mirror paddle (chỉ cần cho VSR, mà ta không dùng nữa):

```bash
PADDLE_MODE=cpu ./deploy.sh <IP> <PORT> '<PASSWORD>'
```

### Cập nhật code sau này

Repo đã public nên không cần đẩy file. Sửa code ở máy mình → commit + push →
trên container:

```bash
cd /root/duoyin-videos && git pull
```

`deploy.sh` cũng lấy code bằng git chứ không đóng gói scp nữa (scp treo giữa
phiên ngày 18.08 làm kẹt cả buổi; git thì luôn chạy). Chỉ `secrets/` là vẫn
phải scp — nó gitignore, và chỉ làm một lần cho mỗi máy.

## Bước 2 — trên Termius: kiểm môi trường

Kết nối `root@<IP>` đúng **cổng SSH** (panel ezycloudx ghi ở dòng `SSH Cmd`,
KHÔNG phải cổng Jupyter — dễ nhầm), rồi:

```bash
cat /root/worker.env          # cấu hình đang dùng
rclone listremotes            # phải có CẢ gdrive: lẫn gdrive-user:
curl -s localhost:3900/health # VoiceStudio đã lên chưa
```

Thiếu `gdrive-user:` là lát nữa upload sẽ lỗi — sửa trước khi chạy.

## Bước 3 — thử 1 video trước khi chạy cả lô

Đáng bỏ 5 phút, vì nó chặn được kiểu lỗi chỉ lộ ra khi chạy thật.

```bash
set -a; . /root/worker.env; set +a
DUB_CONCURRENCY=1 /root/worker-venv/bin/python \
  /root/duoyin-videos/worker/worker.py --stage dub --once
```

Xong thì mở `output_link` in ra trong log, nghe thử: giọng phải là tiếng Việt,
câu cuối không bị cắt cụt.

## Bước 4 — chạy cả lô

```bash
bash /root/start_worker.sh dub
tail -f /tmp/worker.log
```

`Ctrl+C` chỉ thoát khỏi màn hình log, worker vẫn chạy nền.

## Theo dõi

```bash
tail -f /tmp/worker.log                    # log trực tiếp
grep -c 'DUBBED (' /tmp/worker.log         # đã xong bao nhiêu
grep '→ ERROR' /tmp/worker.log | tail -5   # có lỗi gì
```

Xem phần trăm, tự cập nhật (không dùng `watch` — container thiếu locale UTF-8
nên `watch` báo `unicode handling error`):

```bash
TOT=$(grep -m1 -oE '[0-9]+ job chờ' /tmp/worker.log | grep -oE '[0-9]+')
while true; do clear
  D=$(grep -c 'DUBBED (' /tmp/worker.log)
  echo "$D/$TOT = $((D*100/TOT))%"
  tail -3 /tmp/worker.log
  sleep 30
done
```

Hoặc thêm công thức này vào một ô trống trên Sheet để xem từ điện thoại:

```
=COUNTIF(H:H,"DUBBED") & "/" & COUNTA(A2:A)
```

Đo tốc độ thật sau ~20 phút: lấy `date` trừ dòng đầu log, chia cho số đã xong.

## Bước 5 — dừng và trả máy

```bash
pkill -f 'worker-venv/bin/python.*worker.py'
tail -20 /tmp/worker.log
```

Job đang dở kẹt ở `DUBBING` — không sao, lần chạy sau worker **tự đòi lại**
(`DUBBING→NEW`). Trả máy không mất gì: code trên GitHub, thành phẩm trên
Drive, trạng thái trên Sheet, secrets có bản sao mã hoá trên Drive.

## Thành phẩm

Mỗi video xong nằm ở Drive `output/<id>/`:

| File | Nội dung |
|---|---|
| `<id>_final.mp4` | **bản đăng được** — che sub Trung + sub Việt đã đốt vào |
| `<id>_dubbed.mp4` | bản đã lồng tiếng, còn sub Trung — giữ để làm lại hậu kỳ |
| `<id>_vi.srt` | phụ đề Việt rời — dùng nếu muốn tự chỉnh ở CapCut |

Cột `output_link` trên Sheet trỏ vào `_final.mp4`.

Giữ lại `_dubbed.mp4` vì đó là thứ **đắt nhất** (đã tốn GPU cho TTS). Đổi kiểu
che hay chỉnh sub thì làm lại từ nó, không phải dub lại.

### Cấu hình hậu kỳ

Sửa trong `/root/worker.env`:

| Biến | Nghĩa |
|---|---|
| `COVER_MODE` | `delogo` (nội suy, gọn với nền phẳng) · `blur` (mờ, luôn dùng được) · `box` (khối đen, che chắc) |
| `BURN_SUBS` | `1` = đốt sub Việt vào video; `0` = chỉ che sub cũ |
| `SUB_AREA` | vùng sub cũ, mặc định lấy theo `VSR_SUB_AREA` |
| `X264_CRF` | 18-23; thấp hơn = nét hơn, file to hơn |
| `POST_PROCESS` | `0` để tắt hẳn hậu kỳ |

**Chạy 1 video rồi xem trước khi thả cả lô** — `delogo` gọn với nền phẳng (cỏ,
tường) nhưng nhoè khi nền nhiều chi tiết; gặp vậy thì đổi `COVER_MODE=box`.

Đổi độ phân giải là **phải đo lại** `SUB_AREA`, sai vùng thì che nhầm chỗ:

```bash
ffmpeg -ss 40 -i <video> -frames:v 1 /tmp/f.jpg   # rồi xem chữ nằm ở dải y nào
```

Vùng đã đo cho video 1920×1080: `y 860→1010` (cao 150px, ~14% chiều cao, sát
đáy), `x 100→1820`.

### Chưa kiểm chứng trên máy thật

Phần hậu kỳ mới viết 18.08, đã kiểm ở local: ba filter che chạy thật với ffmpeg
8.1.2 và soi frame thấy đúng vùng, 44 unit test pass. **Nhưng chưa chạy trọn
một video trên container**, và có một điều kiện cần xác nhận ngay lần thuê sau:

```bash
ffmpeg -hide_banner -filters | grep subtitles
```

Không ra dòng nào nghĩa là ffmpeg thiếu `libass` → không đốt được sub. Worker
tự phát hiện và hạ xuống chỉ-che-sub kèm cảnh báo trong log, `.srt` vẫn lưu
rời nên không mất gì.

## Vì sao bỏ VSR (đo 18.08)

Code stage `vsr` vẫn còn và vẫn chạy đúng — xoá sub sạch, đã kiểm bằng cách
trích frame. Bỏ khỏi quy trình vì **chi phí**, không vì lỗi:

| | |
|---|---|
| Thời gian | ~262s cho video 122s, tức **~2× thời lượng** |
| Chi phí | **~475⚡/video**, gấp ~3 lần chặng dub |

Đã thử hai hướng tối ưu, cả hai **không ăn**:

1. Nghi thiếu CPU → sai. Máy 32 core, load 26, không hề nghẽn.
2. Cho chạy 3 luồng song song (trước đó bị ép cứng 1 luồng) → **262s/video so
   với 268s tuần tự**, gần như không đổi. Từng job chậm hẳn đi (328-455s so
   với 220-275s khi chạy một mình) nên tổng lại như cũ. Hai pha CPU (dò sub)
   và GPU (vá frame) không chồng lên nhau được như tôi suy luận.

Muốn chạy lại thì đặt `WORKER_STAGE=vsr` trong `worker.env` và **phải có**
`VSR_SUB_AREA` — thiếu nó thì PaddleOCR bản CPU không dò ra vùng nào, VSR chỉ
encode lại mà vẫn báo `DONE`. Dấu hiệu nhận biết: GPU nằm ở 2% suốt.

## Chạy lại từ đầu toàn bộ

```bash
# trên Mac
.venv-dev/bin/python worker/reset_sheet.py          # xem trước
.venv-dev/bin/python worker/reset_sheet.py --apply  # đưa hết về NEW
```

Nhớ xoá cả `output/` trên Drive, nếu không file cũ vẫn nằm đó.
