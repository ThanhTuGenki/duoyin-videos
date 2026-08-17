#!/usr/bin/env bash
# Dựng môi trường xử lý video trên container GPU thuê (Ubuntu 22.04 + CUDA).
# Chạy lại được nhiều lần: bước nào xong rồi thì bỏ qua.
#
#   bash worker/setup.sh
#
# VSR và VoiceStudio dùng hai phiên bản torch KHÁC NHAU nên bắt buộc phải ở
# hai venv riêng (VSR: torch 2.2/2.3 + numpy 1.x; VoiceStudio: torch 2.8).
# Cùng dùng chung một GPU thì không sao — driver phục vụ cả hai.

set -euo pipefail

ROOT="${ROOT:-/root}"
VSR_DIR="$ROOT/video-subtitle-remover"
VS_DIR="$ROOT/VoiceStudio"
VS_DATA="$ROOT/omnivoice_data"

log()  { printf '\n\033[1;36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ── 0. Kiểm tra GPU trước khi làm gì ─────────────────────────────
log "Kiểm tra GPU"
command -v nvidia-smi >/dev/null || die "Không có nvidia-smi — container này không gắn GPU?"
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader
DRIVER=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1 | cut -d. -f1)
[ "${DRIVER:-0}" -ge 525 ] || warn "Driver $DRIVER khá cũ — torch 2.8 (CUDA 12.x) có thể không chạy, sẽ lùi về bản cu118"

# ── 1. Gói hệ thống ──────────────────────────────────────────────
log "Cài gói hệ thống"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# libxkbcommon0: VSR import qfluentwidgets → PySide6, thiếu là chết ngay (đã gặp 16.08)
# libsndfile1 + ffmpeg: VoiceStudio bắt buộc
apt-get install -y -qq --no-install-recommends \
  git curl ffmpeg libsndfile1 libxkbcommon0 python3-venv build-essential unzip
ok "apt xong"

# ── 2. rclone (đồng bộ Drive) ────────────────────────────────────
if command -v rclone >/dev/null; then
  ok "rclone đã có: $(rclone version | head -1)"
else
  # Cài từ apt (gói ký bởi Ubuntu) thay vì curl|bash script không ghim phiên
  # bản. Bản apt cũ hơn nhưng Drive + service_account đã hỗ trợ từ lâu.
  log "Cài rclone (apt)"
  apt-get install -y -qq rclone
  ok "rclone $(rclone version | head -1)"
fi

# ── 3. video-subtitle-remover ────────────────────────────────────
log "Dựng video-subtitle-remover"
[ -d "$VSR_DIR" ] || git clone --depth 1 https://github.com/YaoFANGUK/video-subtitle-remover.git "$VSR_DIR"
cd "$VSR_DIR"
[ -d venv_vsr ] || python3 -m venv venv_vsr
VSR_PY="$VSR_DIR/venv_vsr/bin/python"

if "$VSR_PY" -c "import torch" 2>/dev/null; then
  ok "torch đã có: $("$VSR_PY" -c 'import torch;print(torch.__version__)')"
else
  "$VSR_PY" -m pip install -q --upgrade pip
  # 2.3.1+cu118 là bản Dockerfile của VSR dùng cho CUDA 11.8
  "$VSR_PY" -m pip install -q torch==2.3.1 torchvision==0.18.1 --index-url https://download.pytorch.org/whl/cu118
  "$VSR_PY" -m pip install -q -r requirements.txt
fi

# paddlepaddle-gpu KHÔNG có trên PyPI — phải lấy từ index riêng của Paddle.
# Thiếu nó thì PaddleOCR (phần dò vùng phụ đề của VSR) không import được.
if "$VSR_PY" -c "import paddle" 2>/dev/null; then
  ok "paddle đã có: $("$VSR_PY" -c 'import paddle;print(paddle.__version__)')"
else
  log "Cài paddlepaddle-gpu từ index của Paddle (cu118)"
  "$VSR_PY" -m pip install -q paddlepaddle-gpu==3.0.0 \
      -i https://www.paddlepaddle.org.cn/packages/stable/cu118/ \
    || "$VSR_PY" -m pip install -q paddlepaddle==3.0.0 \
    || warn "paddle cài lỗi — VSR sẽ không dò được vùng sub tự động"
fi

# Lỗi đã gặp 16.08: scipy mới cần numpy>=2 trong khi torch cu118 kéo numpy 1.x
if ! "$VSR_PY" -c "from scipy import interpolate" 2>/dev/null; then
  warn "scipy lệch numpy — ghim scipy==1.13.1"
  "$VSR_PY" -m pip install -q "scipy==1.13.1"
fi
"$VSR_PY" -c "from scipy import interpolate; import torch; print('  VSR ok · torch', torch.__version__, '· cuda', torch.cuda.is_available())"

# ── 4. VoiceStudio (chỉ backend API, KHÔNG build frontend) ───────
log "Dựng VoiceStudio (API-only)"
[ -d "$VS_DIR" ] || git clone --depth 1 https://github.com/debpalash/VoiceStudio.git "$VS_DIR"
cd "$VS_DIR"

# VoiceStudio yêu cầu Python >= 3.11 nhưng container (pytorch/pytorch:latest,
# Ubuntu 22.04) chỉ có 3.10 và không có conda. Dùng uv để lấy bản Python
# standalone — nhanh, không cần PPA, và chính VoiceStudio cũng dùng uv.
export PATH="$HOME/.local/bin:$PATH"
if ! command -v uv >/dev/null; then
  # Cài từ PyPI với phiên bản ghim cứng, thay vì curl|sh script trôi nổi.
  # pip xác minh hash gói theo PyPI — chuỗi cung ứng chặt hơn hẳn.
  log "Cài uv (pip, ghim 0.12.5)"
  python3 -m pip install -q "uv==0.12.5"
  command -v uv >/dev/null || die "Cài uv thất bại"
fi
ok "uv $(uv --version)"

VS_PY="$VS_DIR/.venv/bin/python"
# venv cũ có thể đã lỡ tạo bằng 3.10, hoặc chứa torch từ index sai — bỏ đi
if [ -x "$VS_PY" ] && ! "$VS_PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3,11) else 1)' 2>/dev/null; then
  warn "venv cũ dùng Python <3.11 — tạo lại"
  rm -rf "$VS_DIR/.venv"
fi

if "$VS_PY" -c "import torch, fastapi" 2>/dev/null; then
  ok "VoiceStudio deps đã có: torch $("$VS_PY" -c 'import torch;print(torch.__version__)')"
else
  # KHÔNG cài torch bằng tay. pyproject.toml của VoiceStudio khai báo index
  # riêng [tool.uv.sources] pytorch-cuda = .../whl/cu128 và ghim torch==2.8.0.
  # Cài trước từ index khác (cu121/cu118) là uv không giải được phụ thuộc:
  #   "Because there is no version of torch==2.8.0 ... unsatisfiable"
  # uv sync theo uv.lock của chính họ là cách tái lập môi trường chuẩn nhất.
  uv python install 3.12
  uv sync --python 3.12 || die "uv sync thất bại — xem log phía trên"
  uv pip install -q --python "$VS_PY" requests
fi

# Engine dịch mặc định ("google") là gói TUỲ CHỌN, không nằm trong uv.lock.
# Thiếu nó thì /dub/translate trả 400 và cả dây chuyền đứng ở khâu dịch.
if ! "$VS_PY" -c "import deep_translator" 2>/dev/null; then
  log "Cài deep_translator (engine dịch google)"
  uv pip install -q --python "$VS_PY" deep_translator \
    || warn "deep_translator cài lỗi — phải đổi sang engine Argos/NLLB/OpenAI"
fi
"$VS_PY" -c "import torch; print('  VoiceStudio ok · torch', torch.__version__, '· cuda', torch.cuda.is_available())"

# WhisperX / faster-whisper chạy trên CTranslate2 và BẮT BUỘC cần cuDNN 8,
# trong khi torch cu128 chỉ mang theo cuDNN 9. Thiếu nó backend lặng lẽ lùi về
# pytorch-whisper — mất căn chỉnh thời gian và tách người nói, kết quả dub kém
# hơn hẳn. Cách cài lấy đúng từ thông báo lỗi của chính VoiceStudio.
CUDNN8_DIR="$VS_DIR/.venv/lib/python3.12/site-packages/cudnn8_compat"
if [ -d "$CUDNN8_DIR" ] && [ -n "$(ls -A "$CUDNN8_DIR" 2>/dev/null)" ]; then
  ok "cuDNN 8 compat đã có (WhisperX dùng được)"
else
  log "Cài cuDNN 8 compat cho WhisperX"
  uv pip install -q --target "$CUDNN8_DIR" "nvidia-cudnn-cu12==8.9.7.29" \
    || warn "cuDNN 8 compat cài lỗi — ASR sẽ lùi về pytorch-whisper"
fi

mkdir -p "$VS_DATA"

# ── 4c. CLIProxyAPI (dịch LLM qua Antigravity) ───────────────────
CPA_DIR="$ROOT/cliproxy"
CPA_VER="7.2.135"
# sha256 lấy từ checksums.txt của chính release v7.2.135 — binary này cầm token
# OAuth nên BẮT BUỘC kiểm trước khi giải nén; hash lệch = dừng ngay.
CPA_SHA256="f5e5ccf0f3fead3a2ee088cb37a69e996f05b33b47f116b4351dbfd1d4224241"
if [ -x "$CPA_DIR/cli-proxy-api" ]; then
  ok "CLIProxyAPI đã có"
else
  log "Cài CLIProxyAPI v$CPA_VER (kiểm sha256)"
  mkdir -p "$CPA_DIR"
  curl -fsSL -o "$CPA_DIR/cpa.tar.gz" \
    "https://github.com/router-for-me/CLIProxyAPI/releases/download/v${CPA_VER}/CLIProxyAPI_${CPA_VER}_linux_amd64.tar.gz"
  echo "$CPA_SHA256  $CPA_DIR/cpa.tar.gz" | sha256sum -c - \
    || die "CLIProxyAPI: sha256 KHÔNG khớp — tarball có thể bị can thiệp, dừng"
  tar xzf "$CPA_DIR/cpa.tar.gz" -C "$CPA_DIR"
fi
# Chỉ bind loopback — proxy không có xác thực
printf 'host: "127.0.0.1"\nport: 8317\nauth-dir: "/root/.cli-proxy-api"\n' > "$CPA_DIR/config.yaml"

# Khôi phục token Antigravity từ secrets (scp từ repo local: secrets/cli-proxy-api/)
mkdir -p "$ROOT/.cli-proxy-api"
if ls "$ROOT"/secrets/cli-proxy-api/*.json >/dev/null 2>&1; then
  cp "$ROOT"/secrets/cli-proxy-api/*.json "$ROOT/.cli-proxy-api/"
  ok "Đã khôi phục token Antigravity từ secrets — không cần login lại"
elif ls "$ROOT"/.cli-proxy-api/*.json >/dev/null 2>&1; then
  ok "Token Antigravity đã có sẵn"
else
  warn "CHƯA có token Antigravity — dịch cinematic sẽ không chạy."
  warn "Login 1 lần: (local) ssh -p <PORT> -L 51121:127.0.0.1:51121 root@<IP>"
  warn "             (đây)  $CPA_DIR/cli-proxy-api --config $CPA_DIR/config.yaml --antigravity-login --no-browser"
fi

cat > "$ROOT/start_cliproxy.sh" <<EOF
#!/usr/bin/env bash
# Bật CLIProxyAPI (cổng 8317, loopback). Token tự refresh mỗi 15 phút khi chạy.
for pid in \$(pgrep -f 'cli-proxy-api --config'); do kill "\$pid" 2>/dev/null || true; done
sleep 1
setsid nohup "$CPA_DIR/cli-proxy-api" --config "$CPA_DIR/config.yaml" \\
  > /tmp/cliproxy.log 2>&1 < /dev/null &
echo "CLIProxyAPI đang khởi động (pid \$!) — log: /tmp/cliproxy.log"
EOF
chmod +x "$ROOT/start_cliproxy.sh"

# ── 4d. Worker venv + remote ghi Drive ───────────────────────────
log "Dựng worker venv"
WK_VENV="$ROOT/worker-venv"
if [ -x "$WK_VENV/bin/python" ] && "$WK_VENV/bin/python" -c "import gspread, requests" 2>/dev/null; then
  ok "worker venv đã có"
else
  uv venv --python 3.12 "$WK_VENV" >/dev/null 2>&1 || python3 -m venv "$WK_VENV"
  uv pip install -q --python "$WK_VENV/bin/python" "gspread==6.1.4" "requests==2.32.3" \
    || "$WK_VENV/bin/pip" install -q "gspread==6.1.4" "requests==2.32.3"
  ok "worker venv xong"
fi

# Remote GHI Drive (gdrive-user, OAuth cá nhân): service account KHÔNG có quota
# lưu trữ nên không upload được (đã dính storageQuotaExceeded 17.08). Token
# OAuth user lấy 1 lần bằng lệnh dưới, dán vào secrets/rclone-user-token.json.
if rclone listremotes 2>/dev/null | grep -q '^gdrive-user:'; then
  ok "remote gdrive-user đã có"
elif [ -f "$ROOT/secrets/rclone-user-token.json" ]; then
  log "Tạo remote gdrive-user từ token trong secrets"
  rclone config create gdrive-user drive scope drive \
    root_folder_id "14sfsTkv-k8S2rqR5kFj6EoVr_RBqXsjh" \
    token "$(cat "$ROOT/secrets/rclone-user-token.json")" >/dev/null
  ok "remote gdrive-user xong"
else
  warn "CHƯA có remote ghi Drive (gdrive-user) — worker sẽ lỗi ở bước upload."
  warn "Trên MÁY LOCAL chạy:  rclone authorize \"drive\"  (mở browser, đăng nhập Google)"
  warn "→ dán JSON token nó in ra vào secrets/rclone-user-token.json, scp secrets/ lên /root/, chạy lại setup.sh"
fi

cat > "$ROOT/start_worker.sh" <<EOF
#!/usr/bin/env bash
# Bật worker (poll Sheet, xử lý job NEW). Log: /tmp/worker.log
for pid in \$(pgrep -f 'worker-venv/bin/python.*worker.py'); do kill "\$pid" 2>/dev/null || true; done
sleep 1
setsid nohup "$WK_VENV/bin/python" "$ROOT/duoyin-videos/worker/worker.py" \\
  > /tmp/worker.log 2>&1 < /dev/null &
echo "Worker đang chạy (pid \$!) — log: tail -f /tmp/worker.log"
EOF
chmod +x "$ROOT/start_worker.sh"

# ── 5. Script khởi động VoiceStudio ──────────────────────────────
cat > "$ROOT/start_voicestudio.sh" <<EOF
#!/usr/bin/env bash
# Bật VoiceStudio API ở cổng 3900 (chạy nền, log ra /tmp/voicestudio.log)
#
# BẢO MẬT: chỉ bind loopback. VoiceStudio KHÔNG có xác thực (tài liệu của họ
# nói rõ), mà container thuê có IP public — bind 0.0.0.0 là phơi GPU + toàn bộ
# file cho bất kỳ ai quét trúng cổng. docker-compose gốc của họ bind 0.0.0.0
# được là vì Docker map ra 127.0.0.1 ở phía host; ở đây không có lớp đó.
# Spike và worker đều chạy TRÊN container nên 127.0.0.1 là đủ.
# Muốn mở web UI từ máy local thì dùng SSH tunnel:
#     ssh -p <PORT> -L 3900:127.0.0.1:3900 root@<IP>
cd "$VS_DIR"
export OMNIVOICE_SERVER_MODE=1          # nới cổng chặn origin cho môi trường headless
export OMNIVOICE_BIND_HOST=127.0.0.1
export OMNIVOICE_DATA_DIR="$VS_DATA"
export HF_HOME="$VS_DATA/huggingface"
export PYTHONPATH="$VS_DIR/backend"
export PYTHONUNBUFFERED=1
for pid in \$(pgrep -f 'uvicorn backend.main:app'); do kill "\$pid" 2>/dev/null || true; done
sleep 1
setsid nohup "$VS_PY" -m uvicorn backend.main:app --host 127.0.0.1 --port 3900 \\
  > /tmp/voicestudio.log 2>&1 < /dev/null &
echo "VoiceStudio đang khởi động (pid \$!) — theo dõi: tail -f /tmp/voicestudio.log"
EOF
chmod +x "$ROOT/start_voicestudio.sh"

log "XONG"
cat <<EOF

  VSR          : $VSR_DIR  (venv_vsr)
  VoiceStudio  : $VS_DIR   (.venv)
  Dữ liệu VS   : $VS_DATA

  Bước tiếp theo:
    bash $ROOT/start_cliproxy.sh             # bật proxy dịch LLM cổng 8317
    bash $ROOT/start_voicestudio.sh          # bật API cổng 3900
    tail -f /tmp/voicestudio.log             # chờ dòng "Application startup complete"
    # trỏ VoiceStudio vào proxy (1 lần, lưu bền qua prefs):
    curl -X PUT http://127.0.0.1:3900/api/settings/llm-endpoint \\
      -H 'Content-Type: application/json' \\
      -d '{"base_url":"http://127.0.0.1:8317/v1","model":"gemini-3.5-flash-low","api_key":"dummy"}'
    python3 worker/spike_voicestudio.py --video <file.mp4> --quality cinematic

EOF
