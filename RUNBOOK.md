# Runbook — chạy dây chuyền trên máy thuê

Dành cho lúc vận hành thật. Chi tiết kỹ thuật xem `worker/README.md`.

Dây chuyền **kết thúc ở lồng tiếng**. Xoá sub (VSR) đã bị bỏ khỏi quy trình —
lý do và số đo ở mục cuối. Việc che sub làm ngoài, không tốn tiền GPU.

## Trước khi thuê: hiểu chi phí

Số đo thật trên RTX 3090 (6.800⚡/h):

| Chặng | Thời gian/video | Song song |
|---|---|---|
| dub (dịch + lồng tiếng) | ~90-170s với 3 luồng | có, nhanh ~1.8× |

→ 100 video ≈ **2.5-5 giờ ≈ 17.000-34.000⚡**.

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

## Thành phẩm và bước cuối làm ngoài

Mỗi video xong nằm ở Drive `output/<id>/`:

| File | Nội dung |
|---|---|
| `<id>_dubbed.mp4` | video đã lồng tiếng Việt, **còn nguyên sub Trung** |
| `<id>_vi.srt` | phụ đề tiếng Việt rời |

Che sub bằng CapCut hoặc `ffmpeg` trên máy mình — miễn phí, không cần GPU.
Vùng sub đo được trên video 1920×1080:

```
y: 860 → 1010    (cao 150px, ~14% chiều cao, sát đáy)
x: 100 → 1820
```

```bash
ffmpeg -i <id>_dubbed.mp4 -vf "delogo=x=100:y=860:w=1720:h=150" \
  -c:a copy <id>_clean.mp4
```

`delogo` nội suy từ viền xung quanh — với nền phẳng (cỏ, tường) khá gọn.
Đổi độ phân giải là phải đo lại toạ độ: trích 1 frame ra xem chữ nằm đâu.

```bash
ffmpeg -ss 40 -i <video> -frames:v 1 /tmp/f.jpg
```

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
