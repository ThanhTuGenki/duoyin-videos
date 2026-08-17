#!/usr/bin/env bash
# MỘT LỆNH trên container: dựng môi trường + bật toàn bộ service + bật worker.
# Được deploy.sh (chạy từ máy local) gọi; hoặc chạy tay:
#     bash /root/duoyin-videos/worker/bootstrap.sh
#
# Idempotent: chạy lại lần 2 chỉ mất vài giây (mọi bước tự bỏ qua khi đã xong).

set -euo pipefail
ROOT="${ROOT:-/root}"

log() { printf '\n\033[1;35m━━ %s ━━\033[0m\n' "$*"; }

log "1/5 Dựng môi trường (setup.sh)"
bash "$ROOT/duoyin-videos/worker/setup.sh"

log "2/5 Bật CLIProxyAPI (dịch LLM)"
bash "$ROOT/start_cliproxy.sh"

log "3/5 Bật VoiceStudio API"
bash "$ROOT/start_voicestudio.sh"
for i in $(seq 1 60); do
  curl -sf --max-time 5 http://127.0.0.1:3900/health >/dev/null && break
  sleep 5
done
curl -sf --max-time 5 http://127.0.0.1:3900/health >/dev/null \
  || { echo "VoiceStudio không lên sau 5 phút — xem /tmp/voicestudio.log"; exit 1; }
echo "VoiceStudio sẵn sàng"

log "4/5 Trỏ VoiceStudio vào proxy dịch + cài trước model"
curl -sf --max-time 30 -X PUT http://127.0.0.1:3900/api/settings/llm-endpoint \
  -H 'Content-Type: application/json' \
  -d '{"base_url":"http://127.0.0.1:8317/v1","model":"gemini-3.5-flash-low","api_key":"dummy"}' >/dev/null \
  && echo "LLM endpoint OK" || echo "! Trỏ LLM endpoint lỗi — dịch sẽ fallback fast"
# Cài trước 2 model (idempotent phía máy chủ); worker cũng tự cài được khi thiếu
curl -sf -X POST http://127.0.0.1:3900/models/install -H 'Content-Type: application/json' \
  -d '{"repo_id":"Systran/faster-whisper-large-v3"}' >/dev/null || true
curl -sf -X POST http://127.0.0.1:3900/models/install -H 'Content-Type: application/json' \
  -d '{"repo_id":"k2-fsa/OmniVoice"}' >/dev/null || true

log "5/5 Bật worker"
bash "$ROOT/start_worker.sh"

cat <<'EOF'

━━ XONG ━━ Dây chuyền đang chạy.
  Theo dõi   : tail -f /tmp/worker.log
  Dừng worker: pkill -f 'worker-venv/bin/python.*worker.py'
EOF
