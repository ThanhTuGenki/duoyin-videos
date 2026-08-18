#!/usr/bin/env python3
"""Worker Phase 4 — dây chuyền khép kín: Sheet → Drive → VSR ∥ dub → mux → Drive.

Chạy trên container GPU:
    /root/worker-venv/bin/python /root/duoyin-videos/worker/worker.py          # vòng lặp poll
    /root/worker-venv/bin/python /root/duoyin-videos/worker/worker.py --once   # xử lý 1 lượt rồi thoát

Mọi hợp đồng API bên dưới đều đã kiểm chứng bằng spike 17.08 (không đoán):
upload field 'video' + chờ SSE ready; transcribe tự cài model khi 409;
translate qua khoá 'translated' + fallback cinematic→fast; generate chạy nền
phải chờ task; /dub/download trả VIDEO đã ghép (include_tracks=vi) nên worker
không tự ffmpeg mux; /dub/srt cho phụ đề tiếng Việt rời.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from wcontract import (  # noqa: E402
    COL_INDEX, STATUS_CLEANING, STATUS_DONE, STATUS_DUBBED, STATUS_DUBBING,
    STATUS_ERROR, Job, has_enough_speech, parse_translated, pick_jobs,
    pick_stale_jobs, reclaim_decision, vsr_command,
)

# ── Cấu hình (env override được) ─────────────────────────────────

SHEET_ID = os.environ.get("SHEET_ID", "1tLx0SQUqWQ1q7qGpkdcH0ATMYGdCSPA9AUMqLRHyFRY")
SA_JSON = os.environ.get("SA_JSON", "/root/secrets/sa.json")
READ_REMOTE = os.environ.get("RCLONE_READ_REMOTE", "gdrive")        # service account: chỉ đọc được
WRITE_REMOTE = os.environ.get("RCLONE_WRITE_REMOTE", "gdrive-user")  # OAuth user: ghi được
VS_API = os.environ.get("VS_API", "http://127.0.0.1:3900")
VSR_DIR = os.environ.get("VSR_DIR", "/root/video-subtitle-remover")
VSR_PY = os.environ.get("VSR_PY", f"{VSR_DIR}/venv_vsr/bin/python")
# Vùng phụ đề "ymin,ymax,xmin,xmax" (pixel). Rỗng = để VSR tự dò — nhưng
# PaddleOCR bản CPU dò không ra (xem vsr_remove_subs), nên khi chạy CPU
# paddle thì phải đặt tay, ví dụ VSR_SUB_AREA="880,1000,200,1720" cho 1080p.
VSR_SUB_AREA = os.environ.get("VSR_SUB_AREA", "").strip()
WORK_DIR = Path(os.environ.get("WORK_DIR", "/root/jobs"))
VOICE_DIR = Path(__file__).resolve().parent / "assets" / "voice"
POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "30"))
# Số video dub đồng thời. TTS vẫn xếp hàng trên GPU, nhưng tải/dịch/mux/upload
# (~75s trong 155s mỗi job, đo trên 3090) chồng lên nhau được → ~1.6-2x throughput.
DUB_CONCURRENCY = int(os.environ.get("DUB_CONCURRENCY", "3"))
# Số video VSR đồng thời. Trước 18.08 bị ép cứng bằng 1 với lý do "VSR ăn GPU
# liên tục nên song song chỉ tranh nhau" — đó là SUY ĐOÁN, và đo thật cho thấy
# sai: VSR luân phiên hai pha, dò sub bằng PaddleOCR (CPU, GPU rảnh) rồi vá
# frame bằng STTN (GPU, CPU rảnh). Đo trên 3090 lúc đang chạy: GPU 0%, load
# 26/32 core, VRAM 6.9/24GB — tức lúc nào cũng bỏ không một nửa máy.
# Chạy nhiều luồng để pha CPU của job này chồng lên pha GPU của job kia.
VSR_CONCURRENCY = int(os.environ.get("VSR_CONCURRENCY", "3"))
# Giãn cách (giây) giữa 2 dòng tiến độ VSR trong log. VSR in nhiều lần mỗi
# giây; in hết sẽ ngập log, lại còn nhiều job song song trộn vào nhau.
VSR_PROGRESS_EVERY_S = float(os.environ.get("VSR_PROGRESS_EVERY_S", "30"))
# Cách xử lý câu dịch dài hơn khung thời gian gốc.
#   concise (mặc định của VoiceStudio) — overflow thì CẮT CỨNG ở biên slot,
#     đúng triệu chứng "dừng ngang ở từ cuối cùng" user báo 17.08. Đo được
#     80-100% câu lố khung, rate_ratio tới 2.2 → gần như câu nào cũng bị cắt.
#   smart_fit — chia đôi gánh nặng: tăng tốc audio nhẹ (<=1.2x) + làm chậm
#     video nhẹ (<=2.0x), phần lố còn lại mới trim. Dùng được vì giờ ta lấy
#     VIDEO do VoiceStudio ghép (không tự mux vào video gốc nữa).
#   stretch_video — audio luôn 1.0x nhưng KHÔNG có bản ghi cue đã khớp nên
#     file .srt sẽ lệch khỏi video; tránh vì user cần .srt dùng ở CapCut.
TIMING_STRATEGY = os.environ.get("TIMING_STRATEGY", "smart_fit")
# Khoản dư (giây) được thấm vào khoảng lặng trước khi hard-trim ra tay.
OVERFLOW_BUDGET_S = float(os.environ.get("OVERFLOW_BUDGET_S", "1.5"))
TELEGRAM_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT = os.environ.get("TELEGRAM_CHAT_ID", "")

# voice trong Sheet → (tên profile VoiceStudio, file mẫu, file transcript)
VOICE_PROFILES = {
    "default": ("MinhQuan", VOICE_DIR / "MinhQuanVoice.mp3", VOICE_DIR / "MinhQuanVoice.txt"),
}


def log(msg: str) -> None:
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def notify(msg: str) -> None:
    log(f"TELEGRAM: {msg}")
    if not (TELEGRAM_TOKEN and TELEGRAM_CHAT):
        return
    try:
        requests.post(
            f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage",
            json={"chat_id": TELEGRAM_CHAT, "text": msg}, timeout=15,
        )
    except requests.RequestException as e:
        log(f"telegram lỗi (bỏ qua): {e}")


class JobError(Exception):
    """Lỗi thuộc về 1 job — ghi vào Sheet rồi đi tiếp job khác."""


# ── Sheet (gspread + service account) ────────────────────────────

def sheet_client():
    import gspread
    return gspread.service_account(filename=SA_JSON).open_by_key(SHEET_ID).sheet1


# gspread không thread-safe; nhiều job chạy song song nên serialize mọi ghi Sheet
_sheet_lock = threading.Lock()


def sheet_update(ws, row: int, updates: dict[str, str]) -> None:
    """Ghi 1 loạt ô trên cùng dòng theo tên cột hợp đồng."""
    cells = [
        {"range": f"{chr(ord('A') + COL_INDEX[col])}{row}", "values": [[value]]}
        for col, value in updates.items()
    ]
    with _sheet_lock:
        ws.batch_update(cells, value_input_option="RAW")


def set_status(ws, job: Job, status: str, **extra: str) -> None:
    updates = {"status": status, "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    updates.update(extra)
    sheet_update(ws, job.row_number, updates)
    log(f"[{job.id}] → {status}" + (f" ({extra})" if extra else ""))


# ── rclone / subprocess ──────────────────────────────────────────

def run(cmd: list[str], *, cwd: str | None = None, timeout: int = 7200) -> str:
    """Chạy lệnh, trả về stdout+stderr. Lỗi → JobError kèm phần cuối output."""
    proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip()[-400:]
        raise JobError(f"Lệnh thất bại ({cmd[0]} rc={proc.returncode}): {tail}")
    return (proc.stdout or "") + (proc.stderr or "")


def rclone_download(folder_id: str, dest: Path) -> Path:
    """Kéo cả folder inbox/<id>/ về theo folder ID (không phụ thuộc tên)."""
    dest.mkdir(parents=True, exist_ok=True)
    run(["rclone", "copy", f"{READ_REMOTE}:", str(dest),
         "--drive-root-folder-id", folder_id, "--transfers", "4"], timeout=3600)
    video = dest / "video.mp4"
    if not video.exists():
        raise JobError("Folder Drive không có video.mp4")
    return video


def rclone_upload(src: Path, job_id: str) -> str:
    """Đẩy thành phẩm lên output/<id>/ và trả về link Drive thật của file."""
    run(["rclone", "copy", str(src), f"{WRITE_REMOTE}:output/{job_id}/"], timeout=3600)
    out = subprocess.run(
        ["rclone", "lsjson", f"{WRITE_REMOTE}:output/{job_id}/"],
        capture_output=True, text=True, timeout=120)
    try:
        for item in json.loads(out.stdout or "[]"):
            if item.get("Name") == src.name and item.get("ID"):
                return f"https://drive.google.com/file/d/{item['ID']}/view"
    except ValueError:
        pass
    return f"(đã upload output/{job_id}/{src.name} — không lấy được link)"


def video_duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(path)], capture_output=True, text=True, timeout=60)
    try:
        return float(out.stdout.strip())
    except ValueError:
        return 0.0


# ── VoiceStudio client (hợp đồng đã kiểm chứng bằng spike) ───────

def vs_wait_task(task_id: str, label: str, timeout: int = 5400) -> None:
    t0 = time.time()
    with requests.get(f"{VS_API}/tasks/stream/{task_id}", stream=True, timeout=(10, timeout)) as r:
        for raw in r.iter_lines(decode_unicode=True):
            if not raw or not raw.startswith("data:"):
                continue
            try:
                ev = json.loads(raw[5:].strip())
            except ValueError:
                continue
            stage = str(ev.get("type") or ev.get("stage") or "").lower()
            if stage in ("ready", "done", "complete", "completed", "success"):
                log(f"  {label} xong {time.time() - t0:.0f}s")
                return
            if stage in ("error", "failed", "failure"):
                raise JobError(f"{label} thất bại: {json.dumps(ev, ensure_ascii=False)[:200]}")
    log(f"  {label}: stream kết thúc sau {time.time() - t0:.0f}s")


def vs_ensure_profile(voice: str) -> str:
    """Trả về profile_id cho giọng; tạo nếu chưa có (idempotent theo tên)."""
    name, audio, transcript = VOICE_PROFILES.get(voice, VOICE_PROFILES["default"])
    r = requests.get(f"{VS_API}/profiles", timeout=60)
    r.raise_for_status()
    profiles = r.json()
    rows = profiles if isinstance(profiles, list) else profiles.get("profiles", [])
    for p in rows:
        if isinstance(p, dict) and p.get("name") == name:
            return str(p.get("id"))
    log(f"  tạo voice profile '{name}'")
    with audio.open("rb") as fh:
        r = requests.post(
            f"{VS_API}/profiles",
            data={"name": name, "ref_text": transcript.read_text(encoding="utf-8").strip(),
                  "kind": "clone", "language": "vi"},
            files={"ref_audio": (audio.name, fh, "audio/mpeg")}, timeout=300)
    r.raise_for_status()
    return str(r.json().get("id"))


def vs_transcribe(vs_job: str, timeout: int = 5400) -> dict:
    """Transcribe; tự cài model khi máy chủ báo thiếu (409 asr_model_missing)."""
    t0, asked = time.time(), set()
    while time.time() - t0 < timeout:
        r = requests.post(f"{VS_API}/dub/transcribe/{vs_job}", json={}, timeout=5400)
        if r.ok:
            return r.json()
        detail = None
        try:
            detail = r.json().get("detail")
        except ValueError:
            pass
        missing = detail.get("missing_repo_id") if isinstance(detail, dict) else None
        if r.status_code == 409 and missing:
            if missing not in asked:
                log(f"  thiếu model {missing} — cài tự động")
                requests.post(f"{VS_API}/models/install", json={"repo_id": missing}, timeout=120)
                asked.add(missing)
            time.sleep(30)
            continue
        raise JobError(f"Transcribe thất bại HTTP {r.status_code}: {r.text[:200]}")
    raise JobError("Hết giờ chờ model ASR")


def vs_translate(vs_job: str, segments: list[dict], quality: str) -> list[dict]:
    """Dịch sang vi; cinematic lỗi thì fallback fast (dây chuyền không đứng).

    Trả segments đã thay text. Raise nếu cả 2 mức đều thất bại hoặc kết quả
    trông như CHƯA dịch (đa số câu y hệt bản gốc — bug đã dính 17.08).
    """
    payload_segments = [
        {"id": s.get("id") or str(i), "text": s.get("text", ""),
         "start": s.get("start"), "end": s.get("end"),
         "slot_seconds": round(float(s.get("end", 0)) - float(s.get("start", 0)), 2)}
        for i, s in enumerate(segments)
    ]
    tried = []
    for q in dict.fromkeys([quality, "fast"]):  # giữ thứ tự, khử trùng lặp
        r = requests.post(f"{VS_API}/dub/translate", timeout=3600, json={
            "segments": payload_segments, "target_lang": "vi", "job_id": vs_job, "quality": q})
        if not r.ok:
            tried.append(f"{q}: HTTP {r.status_code} {r.text[:120]}")
            continue
        data = r.json()
        # Đo mức lố khung: rate_ratio > 1 nghĩa câu Việt dài hơn slot gốc.
        # Đây là thước đo trực tiếp cho triệu chứng "cắt ngang từ cuối".
        rows_raw = data.get("translated") if isinstance(data, dict) else None
        if isinstance(rows_raw, list) and rows_raw:
            ratios = [float(x.get("rate_ratio") or 0) for x in rows_raw if isinstance(x, dict)]
            over = [x for x in ratios if x > 1.0]
            if ratios:
                log(f"  fit: {len(over)}/{len(ratios)} câu lố khung"
                    f" · rate_ratio tối đa {max(ratios):.2f} · quality={data.get('quality_used')}")
        translated, unchanged = parse_translated(data, segments)
        if unchanged >= max(1, len(segments) // 2):
            tried.append(f"{q}: {unchanged}/{len(segments)} câu không đổi (chưa dịch?)")
            continue
        if q != quality:
            log(f"  dịch fallback {quality} → {q}")
        return translated
    raise JobError("Dịch thất bại cả 2 mức: " + " | ".join(tried))


def vs_dub(video: Path, quality: str, profile_id: str) -> bytes:
    """Toàn bộ nhánh tiếng: upload → transcribe → dịch → TTS → tải audio."""
    with video.open("rb") as fh:
        r = requests.post(f"{VS_API}/dub/upload",
                          files={"video": (video.name, fh, "video/mp4")}, timeout=1800)
    if not r.ok:
        raise JobError(f"Upload VoiceStudio thất bại HTTP {r.status_code}")
    up = r.json()
    vs_job = up.get("job_id")
    if up.get("task_id"):
        vs_wait_task(up["task_id"], "prep")

    tr = vs_transcribe(vs_job)
    segments = tr.get("segments") or []
    duration = video_duration(video)
    if not has_enough_speech(segments, duration):
        raise JobError(
            f"Video không có lời thoại để lồng tiếng ({len(segments)} đoạn / {duration:.0f}s)")

    segments = vs_translate(vs_job, segments, quality)

    gen_segments = [
        {"start": s.get("start", 0.0), "end": s.get("end", 0.0),
         "text": s.get("text", ""), "profile_id": profile_id}
        for s in segments
    ]
    r = requests.post(f"{VS_API}/dub/generate/{vs_job}", timeout=7200, json={
        "segments": gen_segments, "language": "vi", "language_code": "vi",
        "timing_strategy": TIMING_STRATEGY,
        "overflow_budget_s": OVERFLOW_BUDGET_S,
    })
    if not r.ok:
        raise JobError(f"Generate thất bại HTTP {r.status_code}: {r.text[:200]}")
    task = r.json().get("task_id")
    if task:
        vs_wait_task(task, "TTS")

    return vs_job


def vs_fetch_video(vs_job: str) -> bytes:
    """Lấy VIDEO đã lồng tiếng do chính VoiceStudio ghép.

    Đo thật 17.08: include_tracks=vi cho đúng 1 track audio tiếng Việt
    (h264 + aac), preserve_bg giữ nhạc nền. Nhờ lấy video thay vì audio, ta
    KHÔNG phải tự ffmpeg mux nữa, và các chế độ timing đổi timeline video
    (smart_fit) dùng được — đó là cách chữa gốc lỗi cắt ngang câu.
    """
    r = requests.get(f"{VS_API}/dub/download/{vs_job}", timeout=3600,
                     params={"include_tracks": "vi", "default_track": "vi",
                             "preserve_bg": "true", "burn_subs": "false"})
    if not r.ok or len(r.content) < 100_000:
        raise JobError(f"Tải video dub thất bại HTTP {r.status_code}, {len(r.content)} bytes")
    return r.content


def vs_fetch_srt(vs_job: str) -> str:
    """Phụ đề tiếng Việt dạng file rời (dùng trong CapCut/chương trình khác).
    Không nướng vào hình — quyết định của user 17.08."""
    r = requests.get(f"{VS_API}/dub/srt/{vs_job}", timeout=600)
    return r.text if r.ok and r.text.strip() else ""


# ── Nhánh hình (VSR) ─────────────────────────────────────────────

# 'Subtitle Removing:  26%|██▌       | 800/3051 [00:45<02:07, 37.99frame/s]'
_TQDM_RE = re.compile(r"(\d+)%\|[^|]*\|\s*(\d+)/(\d+)")


def run_progress(cmd: list[str], *, cwd: str | None = None,
                 timeout: int = 7200, label: str = "") -> str:
    """Như run() nhưng VỪA thu output VỪA in tiến độ ra log theo nhịp.

    VSR in tiến độ bằng ký tự \r chứ không xuống dòng, nên đọc theo dòng sẽ
    treo — phải đọc từng khối rồi tách cả \r lẫn \n.

    Hạn chế đã biết: hạn giờ chỉ được kiểm giữa hai khối output. VSR in liên
    tục nên thực tế không sao, nhưng nếu nó treo hẳn mà không in gì thì hạn
    giờ sẽ không kích hoạt.
    """
    proc = subprocess.Popen(cmd, cwd=cwd, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True,
                            errors="replace")
    chunks: list[str] = []
    buf = ""
    last_log = 0.0
    deadline = time.time() + timeout
    try:
        while True:
            block = proc.stdout.read(256)
            if not block:
                break
            chunks.append(block)
            buf += block
            parts = re.split(r"[\r\n]", buf)
            buf = parts.pop()          # đuôi chưa trọn vẹn, để dành khối sau
            now = time.time()
            if now > deadline:
                proc.kill()
                raise JobError(f"{cmd[0]} chạy quá {timeout}s — đã dừng")
            if now - last_log < VSR_PROGRESS_EVERY_S:
                continue
            for line in reversed(parts):   # lấy mốc mới nhất, bỏ qua các mốc cũ
                m = _TQDM_RE.search(line)
                if m:
                    pct, done, total = m.groups()
                    log(f"  {label}xoá sub {pct}% · {done}/{total} frame")
                    last_log = now
                    break
    finally:
        proc.stdout.close()
        rc = proc.wait()
    out = "".join(chunks)
    if rc != 0:
        raise JobError(f"Lệnh thất bại ({cmd[0]} rc={rc}): {out.strip()[-400:]}")
    return out


def vsr_remove_subs(video_in: Path, video_out: Path, label: str = "") -> None:
    """Xóa hardsub. Ném JobError nếu VSR không dò được vùng sub nào.

    Ca thật 17.08 22:5x: VSR thoát mã 0, tạo file 100MB hợp lệ, worker báo DONE
    — nhưng frame vẫn còn nguyên chữ Trung. GPU chỉ 2% suốt 197s, tức STTN
    không hề inpaint: PaddleOCR (bản CPU) không dò ra vùng sub nên VSR chỉ
    encode lại. "Thoát mã 0" KHÔNG đủ để kết luận đã xóa sub.
    """
    out = run_progress(vsr_command(VSR_PY, str(video_in), str(video_out), sub_area=VSR_SUB_AREA),
                       cwd=VSR_DIR, timeout=4 * 3600, label=label)
    if not video_out.exists() or video_out.stat().st_size < 100_000:
        raise JobError("VSR không tạo ra file kết quả hợp lệ")

    tail = out.strip()[-600:]
    if VSR_SUB_AREA:
        log(f"  VSR vùng sub chỉ định: {VSR_SUB_AREA}")
    elif not re.search(r"(sub_area|字幕区域|subtitle area|检测到)", out, re.I):
        raise JobError(
            "VSR không dò được vùng phụ đề nào — video ra vẫn còn sub. "
            f"Đặt VSR_SUB_AREA='ymin,ymax,xmin,xmax' để chỉ định tay. Log: {tail}")


# ── Giai đoạn A: dub (NEW → DUBBING → DUBBED) ────────────────────

def process_dub(ws, job: Job) -> None:
    """Dịch + lồng tiếng, lấy VIDEO do VoiceStudio tự ghép.

    Đầu ra Drive output/<id>/:
      <id>_dubbed.mp4 — video (còn sub Trung) + tiếng Việt. Vừa là bản duyệt,
                        vừa là đầu vào cho giai đoạn VSR.
      <id>_vi.srt     — phụ đề tiếng Việt rời (dùng ở CapCut nếu muốn).
    Không tự ffmpeg mux nữa: VoiceStudio ghép tốt hơn và giữ được các chế độ
    timing đổi timeline video.
    """
    t0 = time.time()
    job_dir = WORK_DIR / job.id
    try:
        set_status(ws, job, STATUS_DUBBING)
        video = rclone_download(job.drive_folder_id, job_dir)
        duration = video_duration(video)
        sheet_update(ws, job.row_number, {"duration": str(int(duration))})

        profile_id = vs_ensure_profile(job.voice)
        vs_job = vs_dub(video, job.translation_mode, profile_id)

        dubbed = job_dir / f"{job.id}_dubbed.mp4"
        dubbed.write_bytes(vs_fetch_video(vs_job))
        srt = vs_fetch_srt(vs_job)
        if srt:
            (job_dir / f"{job.id}_vi.srt").write_text(srt, encoding="utf-8")
            rclone_upload(job_dir / f"{job.id}_vi.srt", job.id)
        else:
            log(f"  [{job.id}] không lấy được .srt (bỏ qua, không chặn)")

        link = rclone_upload(dubbed, job.id)
        elapsed = int(time.time() - t0)
        set_status(ws, job, STATUS_DUBBED, output_link=link, process_time=str(elapsed), error="")
        notify(f"🎙️ {job.id} dub xong ({elapsed}s): {job.title[:60]}")
        shutil.rmtree(job_dir, ignore_errors=True)
    except JobError as e:
        set_status(ws, job, STATUS_ERROR, error=str(e)[:300])
        notify(f"🚨 {job.id} lỗi dub: {e}")
    except Exception as e:  # lỗi không lường — không được làm sập vòng lặp
        traceback.print_exc()
        set_status(ws, job, STATUS_ERROR, error=f"Lỗi hệ thống: {e}"[:300])
        notify(f"🚨 {job.id} lỗi hệ thống: {e}")


# ── Giai đoạn B: vsr (DUBBED → CLEANING → DONE) ──────────────────

def rclone_download_dubbed(job_id: str, dest: Path) -> Path:
    """Kéo <id>_dubbed.mp4 mà giai đoạn dub đã đẩy lên output/<id>/."""
    name = f"{job_id}_dubbed.mp4"
    dest.mkdir(parents=True, exist_ok=True)
    run(["rclone", "copy", f"{READ_REMOTE}:output/{job_id}/", str(dest),
         "--include", name], timeout=1800)
    path = dest / name
    if not path.exists():
        raise JobError(f"output/{job_id}/ không có {name} — job chưa qua giai đoạn dub?")
    return path


def process_vsr(ws, job: Job) -> None:
    """Xóa hardsub trên video ĐÃ lồng tiếng → thành phẩm <id>_vi.mp4.

    Không cần ghép audio: VSR trích audio ra rồi merge lại bằng -acodec copy
    (đã kiểm source), nên tiếng Việt đi qua nguyên vẹn không nén lại.
    """
    t0 = time.time()
    job_dir = WORK_DIR / job.id
    try:
        set_status(ws, job, STATUS_CLEANING)
        dubbed = rclone_download_dubbed(job.id, job_dir)

        final = job_dir / f"{job.id}_vi.mp4"
        vsr_remove_subs(dubbed, final, label=f"[{job.id}] ")

        link = rclone_upload(final, job.id)
        elapsed = int(time.time() - t0)
        set_status(ws, job, STATUS_DONE, output_link=link, process_time=str(elapsed), error="")
        notify(f"✅ {job.id} HOÀN CHỈNH ({elapsed}s): {job.title[:60]}")
        shutil.rmtree(job_dir, ignore_errors=True)
    except JobError as e:
        set_status(ws, job, STATUS_ERROR, error=str(e)[:300])
        notify(f"🚨 {job.id} lỗi VSR: {e}")
    except Exception as e:
        traceback.print_exc()
        set_status(ws, job, STATUS_ERROR, error=f"Lỗi hệ thống: {e}"[:300])
        notify(f"🚨 {job.id} lỗi hệ thống: {e}")


def process(ws, job: Job) -> None:
    """Chọn giai đoạn theo status hiện tại của dòng."""
    current = job.raw[COL_INDEX["status"]].strip().upper()
    if current == STATUS_DUBBED:
        process_vsr(ws, job)
    else:
        process_dub(ws, job)


# ── Health check + vòng lặp chính ────────────────────────────────

def health_check(stage: str) -> None:
    """Chỉ kiểm những gì stage này thật sự cần — VSR hỏng không chặn stage dub."""
    problems = []
    if not Path(SA_JSON).exists():
        problems.append(f"Thiếu service account {SA_JSON} — scp secrets/ lên")
    if stage in ("dub", "all"):
        try:
            requests.get(f"{VS_API}/health", timeout=10).raise_for_status()
        except requests.RequestException:
            problems.append(f"VoiceStudio API ({VS_API}) không phản hồi — chạy /root/start_voicestudio.sh")
    if stage in ("vsr", "all") and not Path(VSR_PY).exists():
        problems.append(f"Không thấy VSR tại {VSR_PY} — chạy worker/setup.sh")
    if problems:
        sys.exit("Health check thất bại:\n  - " + "\n  - ".join(problems))
    if stage in ("dub", "all"):
        # Proxy dịch LLM: không bắt buộc (có fallback fast) nhưng cảnh báo sớm
        try:
            requests.get("http://127.0.0.1:8317/v1/models", timeout=10).raise_for_status()
        except requests.RequestException:
            log("! CLIProxyAPI không phản hồi — dịch sẽ fallback về fast. Bật: /root/start_cliproxy.sh")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true", help="xử lý 1 lượt rồi thoát")
    ap.add_argument("--stage", default=os.environ.get("WORKER_STAGE", "dub"),
                    choices=["dub", "vsr", "all"],
                    help="dub: NEW→DUBBED · vsr: DUBBED→DONE · all: cả hai")
    args = ap.parse_args()

    health_check(args.stage)
    ws = sheet_client()
    log(f"Worker stage={args.stage} — poll {POLL_SECONDS}s, sheet {SHEET_ID[:12]}…")

    # Đòi lại job kẹt ở trạng thái đang-xử-lý từ lần chạy trước (crash/mất
    # mạng/container chết giữa chừng). Kẹt DUBBING → NEW; kẹt CLEANING →
    # DUBBED (không dub lại). Quá 2 lần → ERROR để job 'độc' không đốt GPU.
    try:
        stale = pick_stale_jobs(ws.get_all_values())
        for job in stale:
            current = job.raw[COL_INDEX["status"]]
            status, err = reclaim_decision(job.raw[COL_INDEX["error"]], current)
            sheet_update(ws, job.row_number, {
                "status": status, "error": err,
                "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            })
            log(f"[{job.id}] dở dang ({current}) → {status} ({err[:50]})")
        if stale:
            notify(f"♻️ Đòi lại {len(stale)} job dở dang sau khởi động lại")
    except Exception as e:
        log(f"Đòi lại job dở dang lỗi (bỏ qua): {e}")

    idle_reported = False
    while True:
        try:
            jobs = pick_jobs(ws.get_all_values(), args.stage)
        except Exception as e:
            log(f"Đọc Sheet lỗi (thử lại sau): {e}")
            time.sleep(POLL_SECONDS)
            continue

        if jobs:
            idle_reported = False
            # Cả hai stage đều chạy song song được, nhưng vì lý do khác nhau:
            #   dub — TTS xếp hàng trên GPU, còn tải/dịch/upload chồng nhau được
            #   vsr — dò sub chạy CPU, vá frame chạy GPU, hai pha chồng nhau được
            # Số đo 18.08: chạy tuần tự mất 268s/video (21 job trong 1h34m),
            # trong khi từng job chỉ tốn ~275s CPU-time → gần như không có phần
            # nào chồng lên nhau, phí nửa máy.
            workers = DUB_CONCURRENCY if args.stage in ("dub", "all") else VSR_CONCURRENCY
            # Chỉ làm MỘT lứa rồi đọc lại Sheet. Trước đây worker chụp cả hàng
            # đợi vào bộ nhớ và chạy hết mới đọc lại → sửa translation_mode
            # giữa batch không có tác dụng (dính 17.08: đổi 3 dòng sang autofit
            # nhưng chúng vẫn dub bằng cinematic). Đọc lại từng lứa cũng nhặt
            # được job mới thêm và khiến --once đúng nghĩa "một lứa".
            batch = jobs[:workers]
            log(f"{len(jobs)} job chờ stage {args.stage} · làm {len(batch)} "
                f"(song song {workers}): {[j.id for j in batch]}")
            if workers <= 1:
                for job in batch:
                    process(ws, job)
            else:
                with ThreadPoolExecutor(max_workers=workers) as pool:
                    futures = {pool.submit(process, ws, job): job for job in batch}
                    for fut in as_completed(futures):
                        try:
                            fut.result()
                        except Exception as e:  # process() đã tự bắt; đây là chốt cuối
                            log(f"[{futures[fut].id}] thoát bất thường: {e}")
            if args.once:
                return
            continue  # đọc lại Sheet ngay, khỏi chờ POLL_SECONDS
        if not idle_reported:
            log("Queue rỗng — chờ job mới")
            idle_reported = True

        if args.once:
            return
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
