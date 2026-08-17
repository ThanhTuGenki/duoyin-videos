#!/usr/bin/env python3
"""Đưa các video đã dub bằng timing cũ (`concise`) về NEW để dub lại.

Vì sao cần: các video dub trước 17.08 14:45 dùng timing_strategy=concise —
VoiceStudio cắt cứng audio ở biên slot nên câu dài bị cụt từ cuối (đúng lỗi
bạn nghe thấy). Bản sửa dùng smart_fit, phải chạy lại mới có.

Nhận biết bằng ĐẦU RA trên Drive, không đoán theo thời gian:
  bản cũ  → output/<id>/<id>_preview.mp4  (worker tự ghép audio bằng ffmpeg)
  bản mới → output/<id>/<id>_dubbed.mp4   (video do VoiceStudio xuất)

Chạy trên container:
  /root/worker-venv/bin/python /root/duoyin-videos/worker/redub_old.py          # chỉ xem
  /root/worker-venv/bin/python /root/duoyin-videos/worker/redub_old.py --apply  # ghi Sheet
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from wcontract import COL_INDEX, STATUS_DUBBED, STATUS_NEW  # noqa: E402
from worker import READ_REMOTE, sheet_client, sheet_update  # noqa: E402


def has_new_output(video_id: str) -> bool:
    """True nếu Drive đã có <id>_dubbed.mp4 (tức đã chạy pipeline mới)."""
    r = subprocess.run(
        ["rclone", "lsf", f"{READ_REMOTE}:output/{video_id}/"],
        capture_output=True, text=True, timeout=120,
    )
    return f"{video_id}_dubbed.mp4" in r.stdout


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="ghi Sheet thật (mặc định chỉ in ra)")
    args = ap.parse_args()

    ws = sheet_client()
    stale: list[tuple[int, str]] = []

    for i, row in enumerate(ws.get_all_values()[1:], start=2):
        parts = list(row) + [""] * (len(COL_INDEX) - len(row))
        video_id = parts[COL_INDEX["id"]].strip()
        if not video_id or parts[COL_INDEX["status"]].strip().upper() != STATUS_DUBBED:
            continue
        if has_new_output(video_id):
            continue
        stale.append((i, video_id))
        print(f"  dòng {i}: {video_id} — timing cũ, cần dub lại")

    if not stale:
        print("Không có video nào dùng timing cũ. Xong.")
        return 0

    print(f"\n{len(stale)} video dub bằng timing cũ (bị cụt từ cuối).")
    if not args.apply:
        print("Chạy lại kèm --apply để đưa về NEW.")
        return 0

    for row_number, video_id in stale:
        sheet_update(ws, row_number, {"status": STATUS_NEW, "error": "", "output_link": ""})
        print(f"  {video_id} → {STATUS_NEW}")
    print(f"\nĐã đưa {len(stale)} dòng về {STATUS_NEW}. Chạy start_worker.sh dub để làm lại.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
