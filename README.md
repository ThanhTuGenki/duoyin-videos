# duoyin-videos

Pipeline reup video: lồng tiếng Việt (VoiceStudio) trên container GPU thuê theo giờ.
Che hardsub làm ngoài bằng CapCut/ffmpeg — xoá sub bằng VSR đã bỏ khỏi quy
trình 18.08 vì tốn ~475⚡/video (xem `RUNBOOK.md`).

- **Thiết kế:** `docs/2026-08-16-reup-pipeline-design.md` · sơ đồ trực quan: `docs/flow-overview.html`
- **Hợp đồng ingest:** `contract/` — extension ghi, worker đọc, hai bên không biết nhau
- **`extension/`** — Chrome extension (TypeScript, Manifest V3): 1-click bắt video + metadata → Drive + Sheet
- **`worker/`** — Python 3.12 (uv): poll Sheet → VoiceStudio dub → up Drive
- **`setup.sh`** — bootstrap container GPU thuê mới

Secrets để trong `secrets/` (gitignored): `service-account.json`, `.env`, `rclone.conf`.
