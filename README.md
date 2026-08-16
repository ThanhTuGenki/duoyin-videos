# duoyin-videos

Pipeline reup video: xóa hardsub (VSR) + lồng tiếng Việt (VoiceStudio) trên container GPU thuê theo giờ.

- **Thiết kế:** `docs/2026-08-16-reup-pipeline-design.md` · sơ đồ trực quan: `docs/flow-overview.html`
- **Hợp đồng ingest:** `contract/` — extension ghi, worker đọc, hai bên không biết nhau
- **`extension/`** — Chrome extension (TypeScript, Manifest V3): 1-click bắt video + metadata → Drive + Sheet
- **`worker/`** — Python 3.12 (uv): poll Sheet → VSR ∥ VoiceStudio → mux → up Drive
- **`setup.sh`** — bootstrap container GPU thuê mới

Secrets để trong `secrets/` (gitignored): `service-account.json`, `.env`, `rclone.conf`.
