#!/usr/bin/env bash
# MỘT LỆNH từ máy local: đưa toàn bộ dây chuyền lên container GPU vừa thuê.
#
#     ./deploy.sh <IP> <SSH_PORT> <PASSWORD>
#     ./deploy.sh 159.48.242.3 21411 'rri_xxxx'
#
# Làm gì: đóng gói worker/ + secrets/ → scp lên → chạy bootstrap.sh
# (dựng môi trường, bật CLIProxyAPI + VoiceStudio + worker) → theo dõi log.
# Yêu cầu trên Mac: expect (có sẵn), tar, ssh.

set -euo pipefail
cd "$(dirname "$0")"

IP="${1:?Thiếu IP. Dùng: ./deploy.sh <IP> <PORT> <PASSWORD>}"
PORT="${2:?Thiếu SSH port}"
PASS="${3:?Thiếu password}"

[ -f secrets/sa.json ] || [ -f "$HOME/Desktop/Voice/shareup-dev-451ba9cdf667.json" ] \
  || { echo "Không thấy service account key"; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# expect helper: chạy lệnh ssh/scp với password
_expect() {
  expect -c "
    set timeout ${EXP_TIMEOUT:-900}
    spawn $1
    expect {
        -re \"(P|p)assword:\" { send \"$PASS\r\"; exp_continue }
        eof
    }
    catch wait result
    exit [lindex \$result 3]
  "
}
SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR"
rsh() { _expect "ssh -p $PORT $SSH_OPTS root@$IP $*"; }
rcp() { _expect "scp -r -P $PORT $SSH_OPTS $1 root@$IP:$2"; }

echo "━━ 1/4 Đóng gói code + secrets"
tar czf "$TMP/worker.tgz" --exclude='.venv-dev' --exclude='__pycache__' --exclude='.pytest_cache' worker
mkdir -p "$TMP/secrets"
cp -r secrets/* "$TMP/secrets/" 2>/dev/null || true
[ -f "$TMP/secrets/sa.json" ] || cp "$HOME/Desktop/Voice/shareup-dev-451ba9cdf667.json" "$TMP/secrets/sa.json"

echo "━━ 2/4 Đẩy lên container"
rsh "mkdir -p /root/duoyin-videos /root/secrets /root/.config/rclone" >/dev/null
rcp "$TMP/worker.tgz" /root/worker.tgz >/dev/null
rcp "$TMP/secrets" /root/ >/dev/null
rsh "cd /root/duoyin-videos && tar xzf /root/worker.tgz 2>/dev/null; echo CODE_OK" | tail -1

# rclone config: remote đọc (service account). Remote ghi do setup.sh tự tạo từ token.
rsh "printf '[gdrive]\ntype = drive\nscope = drive\nservice_account_file = /root/secrets/sa.json\nroot_folder_id = 14sfsTkv-k8S2rqR5kFj6EoVr_RBqXsjh\n' > /root/.config/rclone/rclone.conf; echo RCLONE_CONF_OK" | tail -1

echo "━━ 3/4 Chạy bootstrap trên container (lần đầu ~20-30 phút: tải model)"
# Truyền tiếp cấu hình sang container. Mặc định START_WORKER=0: dựng xong
# nhưng CHƯA chạy — chạy cả hàng đợi là ~10 giờ tiền GPU, phải do người quyết
# chứ không nên là tác dụng phụ của lệnh deploy.
EXP_TIMEOUT=3600 rsh "PADDLE_MODE='${PADDLE_MODE:-auto}' START_WORKER='${START_WORKER:-0}' bash /root/duoyin-videos/worker/bootstrap.sh"

if [ "${START_WORKER:-0}" = "0" ]; then
  cat <<'HINT'

━━ 4/4 Môi trường sẵn sàng — worker CHƯA chạy.

  Thử 1 video trước (khuyên dùng, ~10 phút):
    ssh vào máy rồi:
      set -a; . /root/worker.env; set +a
      DUB_CONCURRENCY=1 /root/worker-venv/bin/python \
        /root/duoyin-videos/worker/worker.py --stage all --once

  Chạy cả hàng đợi:
      bash /root/start_worker.sh dub    # chỉ lồng tiếng, rẻ hơn ~3 lần
      bash /root/start_worker.sh        # cả lồng tiếng + xoá sub

  Chi tiết: RUNBOOK.md
HINT
else
  echo "━━ 4/4 Theo dõi worker (Ctrl+C để rời — worker vẫn chạy tiếp trên container)"
  EXP_TIMEOUT=86400 rsh "tail -f /tmp/worker.log"
fi
