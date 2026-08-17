#!/usr/bin/env python3
"""Đưa Sheet queue về trạng thái "mới ingest": status=NEW, xoá số liệu worker ghi.

Giữ nguyên phần extension ghi (id, title, author, source_url, drive_folder_link)
— đó là dữ liệu ingest, mất là phải bấm ＋Q lại toàn bộ.

Đặt lại phần người dùng/worker về mặc định như lúc vừa ingest:
  voice=default, translation_mode=cinematic, status=NEW,
  output_link/error/duration/process_time/updated_at = rỗng

Chạy được từ máy local (không cần container):
  .venv-dev/bin/python worker/reset_sheet.py           # chỉ xem
  .venv-dev/bin/python worker/reset_sheet.py --apply   # ghi thật
"""
from __future__ import annotations

import argparse
from pathlib import Path

import gspread

REPO = Path(__file__).resolve().parent.parent
SA_JSON = REPO / "secrets" / "sa.json"
SHEET_ID = "1tLx0SQUqWQ1q7qGpkdcH0ATMYGdCSPA9AUMqLRHyFRY"

# F..M — 8 cột, đúng thứ tự trong contract/sheet-columns.md
RESET_ROW = ["default", "cinematic", "NEW", "", "", "", "", ""]
FIRST_COL, LAST_COL = "F", "M"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="ghi Sheet thật (mặc định chỉ in ra)")
    args = ap.parse_args()

    ws = gspread.service_account(filename=str(SA_JSON)).open_by_key(SHEET_ID).sheet1
    rows = ws.get_all_values()

    # chỉ chạm dòng có id — tránh ghi NEW vào hàng nghìn dòng trống
    with_id = [i for i, r in enumerate(rows[1:], start=2) if r and r[0].strip()]
    if not with_id:
        print("Sheet không có dòng nào có id. Không làm gì.")
        return 0

    first, last = with_id[0], with_id[-1]
    gaps = sorted(set(range(first, last + 1)) - set(with_id))

    before: dict[str, int] = {}
    for i in with_id:
        parts = list(rows[i - 1]) + [""] * 13
        before[parts[7].strip() or "(rỗng)"] = before.get(parts[7].strip() or "(rỗng)", 0) + 1

    print(f"{len(with_id)} dòng có id (dòng {first}–{last})")
    print("status hiện tại:", ", ".join(f"{k}={v}" for k, v in sorted(before.items())))
    if gaps:
        print(f"CẢNH BÁO: {len(gaps)} dòng trống nằm giữa ({gaps[:10]}) — sẽ bị ghi luôn")
    print(f"sẽ đặt {FIRST_COL}{first}:{LAST_COL}{last} = {RESET_ROW}")
    print("giữ nguyên A–E (id, title, author, source_url, drive_folder_link)")

    if not args.apply:
        print("\nChạy lại kèm --apply để ghi.")
        return 0

    ws.update(
        range_name=f"{FIRST_COL}{first}:{LAST_COL}{last}",
        values=[list(RESET_ROW) for _ in range(last - first + 1)],
        value_input_option="RAW",
    )
    print(f"\nXong — {last - first + 1} dòng về NEW.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
