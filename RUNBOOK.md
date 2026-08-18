# Runbook — chạy dây chuyền trên máy thuê

Dành cho lúc vận hành thật. Chi tiết kỹ thuật xem `worker/README.md`.

## Trước khi thuê: hiểu chi phí

Số đo thật trên RTX 3090 (6.800⚡/h), video ~120s:

| Chặng | Thời gian/video | Song song được? |
|---|---|---|
| dub (dịch + lồng tiếng) | ~86s với 3 luồng | có, nhanh ~1.8× |
| vsr (xoá sub) | ~240s | **không** — STTN chiếm trọn GPU |

→ 104 video chạy `all` một mạch: **~9-10 giờ ≈ 65.000⚡**.

**Cách tiết kiệm:** chạy `dub` trước cho cả 104 video (~2.5 giờ ≈ 17.000⚡),
nghe duyệt trên Drive, rồi chỉ chạy `vsr` cho những video thật sự định đăng.
VSR là phần đắt gấp 3 lần — xoá sub cho video mà bản dịch dở là ném tiền.

## Bước 1 — trên Terminal của Mac (1 lệnh)

Phải chạy từ Mac vì `secrets/` nằm ở đây, không có trong git.

```bash
cd ~/Desktop/Project/duoyin-videos
./deploy.sh <IP> <PORT> '<PASSWORD>'
```

Nó tự: đóng gói code + secrets → đẩy lên → dựng môi trường → bật CLIProxyAPI
+ VoiceStudio → **bật worker luôn**. Lần đầu ~5-10 phút (tải model).

Cuối cùng nó bám vào log. **Ctrl+C là an toàn** — chỉ rời màn hình log, worker
vẫn chạy trên container.

## Bước 2 — trên Termius: kiểm trước khi để nó chạy dài

Kết nối `root@<IP>` cổng `<PORT>`, rồi:

```bash
cat /root/worker.env          # cấu hình đang dùng
nvidia-smi                    # GPU có nhận không
tail -f /tmp/worker.log       # log worker (Ctrl+C để thoát)
```

`worker.env` quan trọng nhất là dòng này:

```
VSR_SUB_AREA="860,1010,100,1820"
```

Toạ độ `ymin,ymax,xmin,xmax` tính bằng **pixel**, đo cho video dọc 1920×1080.
Sai vùng thì VSR xoá nhầm chỗ hoặc không xoá gì. Cách đo cho bộ video khác:

```bash
ffmpeg -ss 10 -i <video.mp4> -frames:v 1 /tmp/f.jpg
# tải /tmp/f.jpg về xem chữ nằm ở dải y nào
```

## Bước 3 — thử 1 video trước khi chạy cả lô

Đây là bước đáng giá nhất. Dừng worker rồi chạy đúng 1 lứa:

```bash
pkill -f 'worker-venv/bin/python.*worker.py'
set -a; . /root/worker.env; set +a
DUB_CONCURRENCY=1 /root/worker-venv/bin/python \
  /root/duoyin-videos/worker/worker.py --stage all --once
```

**Phải chạy lệnh này HAI lần.** `--once` = đúng một lứa, mà một lứa chỉ đưa
job qua *một* chặng: lần đầu `NEW→DUBBED` (~5 phút), lần hai `DUBBED→DONE`
(~4 phút). Chạy một lần rồi thấy dừng ở `DUBBED` là đúng, chưa phải lỗi.

Trong lúc đó mở tab Termius thứ hai gõ:

```bash
watch -n5 nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv
```

**Dấu hiệu VSR chạy thật: GPU phải lên 90-100%.** Nếu VSR chạy mà GPU chỉ 2%
thì nó KHÔNG xoá gì cả, chỉ encode lại — xem mục Sự cố bên dưới.

Xong thì kiểm thành phẩm:

```bash
ID=<id video vừa chạy>
rclone copy gdrive:output/$ID/${ID}_vi.mp4 /tmp/
ffmpeg -ss 40 -i /tmp/${ID}_vi.mp4 -frames:v 1 /tmp/check.jpg
```

Tải `/tmp/check.jpg` về (Termius có SFTP) — **phải không còn chữ Trung**.

## Bước 4 — cho chạy cả lô

```bash
bash /root/start_worker.sh          # đọc WORKER_STAGE trong worker.env
bash /root/start_worker.sh dub      # hoặc ép chỉ chạy chặng dub
tail -f /tmp/worker.log
```

Theo dõi tiến độ ở cột `status` trên Sheet:
https://docs.google.com/spreadsheets/d/1tLx0SQUqWQ1q7qGpkdcH0ATMYGdCSPA9AUMqLRHyFRY/edit

`NEW → DUBBING → DUBBED → CLEANING → DONE`. Lỗi thì dòng đỏ, message ở cột `error`.

## Bước 5 — dừng và trả máy

```bash
pkill -f 'worker-venv/bin/python.*worker.py'
tail -20 /tmp/worker.log            # xem job cuối xong chưa
```

Job đang dở sẽ kẹt ở `DUBBING`/`CLEANING`. Không sao — lần chạy sau worker
**tự đòi lại**: `DUBBING→NEW`, `CLEANING→DUBBED` (không dub lại từ đầu).

Trả máy xong không mất gì: code trên GitHub, thành phẩm trên Drive, trạng
thái trên Sheet, secrets có bản sao mã hoá trên Drive.

## Sự cố thường gặp

| Hiện tượng | Nguyên nhân | Xử lý |
|---|---|---|
| `start_worker.sh` báo `VSR_SUB_AREA rỗng` | chưa cấu hình vùng sub | sửa `/root/worker.env` |
| VSR chạy mà **GPU chỉ 2%**, sub còn nguyên | PaddleOCR không dò ra vùng sub | phải có `VSR_SUB_AREA`; xem lại toạ độ có đúng độ phân giải video không |
| Video ra vẫn tiếng Trung | bước dịch hỏng | xem log có `quality=fast` không — token Antigravity hết hạn thì tự hạ về Google MT |
| Cột `error`: `Không đủ lời thoại` | video nhạc nền/chỉ có chữ | đúng như thiết kế, bỏ qua video đó |
| `storageQuotaExceeded` | ghi Drive bằng service account | remote `gdrive-user` chưa tạo — kiểm `rclone listremotes` |
| Job kẹt `DUBBING` sau khi worker chết | bình thường | khởi động lại worker, nó tự đòi |
| Quá 2 lần tự chạy lại | lỗi thật, không phải mạng | đọc cột `error`, sửa rồi đưa status về `NEW` bằng tay |

## Chạy lại từ đầu toàn bộ

```bash
# trên Mac
.venv-dev/bin/python worker/reset_sheet.py          # xem trước
.venv-dev/bin/python worker/reset_sheet.py --apply  # đưa hết về NEW
```
Nhớ xoá cả `output/` trên Drive, nếu không file cũ vẫn nằm đó.
