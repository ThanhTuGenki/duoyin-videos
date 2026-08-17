#!/usr/bin/env python3
"""Worker Phase 4 — dây chuyền khép kín: Sheet → Drive → VSR ∥ dub → mux → Drive.

Chạy trên container GPU:
    /root/worker-venv/bin/python /root/duoyin-videos/worker/worker.py          # vòng lặp poll
    /root/worker-venv/bin/python /root/duoyin-videos/worker/worker.py --once   # xử lý 1 lượt rồi thoát

Mọi hợp đồng API bên dưới đều đã kiểm chứng bằng spike 17.08 (không đoán):
upload field 'video' + chờ SSE ready; transcribe tự cài model khi 409;
translate qua khoá 'translated' + fallback cinematic→fast; generate chạy nền
phải chờ task; download-audio trả WAV.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from wcontract import (  # noqa: E402
    COL_INDEX, STATUS_CLEANING, STATUS_DONE, STATUS_DUBBED, STATUS_DUBBING,
    STATUS_ERROR, Job, audio_ext, has_enough_speech, mux_command,
    parse_translated, pick_jobs, pick_stale_jobs, reclaim_decision, vsr_command,
)

# ── Cấu hình (env override được) ─────────────────────────────────

SHEET_ID = os.environ.get("SHEET_ID", "1tLx0SQUqWQ1q7qGpkdcH0ATMYGdCSPA9AUMqLRHyFRY")
SA_JSON = os.environ.get("SA_JSON", "/root/secrets/sa.json")
READ_REMOTE = os.environ.get("RCLONE_READ_REMOTE", "gdrive")        # service account: chỉ đọc được
WRITE_REMOTE = os.environ.get("RCLONE_WRITE_REMOTE", "gdrive-user")  # OAuth user: ghi được
VS_API = os.environ.get("VS_API", "http://127.0.0.1:3900")
VSR_DIR = os.environ.get("VSR_DIR", "/root/video-subtitle-remover")
VSR_PY = os.environ.get("VSR_PY", f"{VSR_DIR}/venv_vsr/bin/python")
WORK_DIR = Path(os.environ.get("WORK_DIR", "/root/jobs"))
VOICE_DIR = Path(__file__).resolve().parent / "assets" / "voice"
POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "30"))
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


def sheet_update(ws, row: int, updates: dict[str, str]) -> None:
    """Ghi 1 loạt ô trên cùng dòng theo tên cột hợp đồng."""
    cells = [
        {"range": f"{chr(ord('A') + COL_INDEX[col])}{row}", "values": [[value]]}
        for col, value in updates.items()
    ]
    ws.batch_update(cells, value_input_option="RAW")


def set_status(ws, job: Job, status: str, **extra: str) -> None:
    updates = {"status": status, "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    updates.update(extra)
    sheet_update(ws, job.row_number, updates)
    log(f"[{job.id}] → {status}" + (f" ({extra})" if extra else ""))


# ── rclone / subprocess ──────────────────────────────────────────

def run(cmd: list[str], *, cwd: str | None = None, timeout: int = 7200) -> None:
    proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip()[-400:]
        raise JobError(f"Lệnh thất bại ({cmd[0]} rc={proc.returncode}): {tail}")


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
        translated, unchanged = parse_translated(r.json(), segments)
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
    r = requests.post(f"{VS_API}/dub/generate/{vs_job}", timeout=7200,
                      json={"segments": gen_segments, "language": "vi", "language_code": "vi"})
    if not r.ok:
        raise JobError(f"Generate thất bại HTTP {r.status_code}: {r.text[:200]}")
    task = r.json().get("task_id")
    if task:
        vs_wait_task(task, "TTS")

    r = requests.get(f"{VS_API}/dub/download-audio/{vs_job}", timeout=1800)
    if not r.ok or len(r.content) < 10_000:
        raise JobError(f"Tải audio thất bại HTTP {r.status_code}, {len(r.content)} bytes")
    return r.content


# ── Nhánh hình (VSR) ─────────────────────────────────────────────

def vsr_remove_subs(video_in: Path, video_out: Path) -> None:
    run(vsr_command(VSR_PY, str(video_in), str(video_out)), cwd=VSR_DIR, timeout=4 * 3600)
    if not video_out.exists() or video_out.stat().st_size < 100_000:
        raise JobError("VSR không tạo ra file kết quả hợp lệ")


# ── Giai đoạn A: dub (NEW → DUBBING → DUBBED) ────────────────────

def process_dub(ws, job: Job) -> None:
    """Dịch + lồng tiếng. Đầu ra Drive: output/<id>/audio_vi.wav (nguyên liệu
    cho giai đoạn VSR) + <id>_preview.mp4 (video GỐC còn sub + tiếng Việt,
    để duyệt giọng/bản dịch TRƯỚC khi tốn tiền VSR)."""
    t0 = time.time()
    job_dir = WORK_DIR / job.id
    try:
        set_status(ws, job, STATUS_DUBBING)
        video = rclone_download(job.drive_folder_id, job_dir)
        duration = video_duration(video)
        sheet_update(ws, job.row_number, {"duration": str(int(duration))})

        profile_id = vs_ensure_profile(job.voice)
        audio_blob = vs_dub(video, job.translation_mode, profile_id)

        dubbed = job_dir / f"audio_vi.{audio_ext(audio_blob)}"
        dubbed.write_bytes(audio_blob)
        preview = job_dir / f"{job.id}_preview.mp4"
        run(mux_command(str(video), str(dubbed), str(preview)), timeout=1800)

        rclone_upload(dubbed, job.id)
        link = rclone_upload(preview, job.id)
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

def rclone_download_audio(job_id: str, dest: Path) -> Path:
    """Kéo audio_vi.* từ output/<id>/ (giai đoạn dub đã đẩy lên)."""
    run(["rclone", "copy", f"{READ_REMOTE}:output/{job_id}/", str(dest),
         "--include", "audio_vi.*"], timeout=1800)
    for f in dest.glob("audio_vi.*"):
        return f
    raise JobError(f"output/{job_id}/ không có audio_vi.* — job chưa qua giai đoạn dub?")


def process_vsr(ws, job: Job) -> None:
    """Xóa hardsub rồi ghép với audio đã dub → thành phẩm <id>_vi.mp4."""
    t0 = time.time()
    job_dir = WORK_DIR / job.id
    try:
        set_status(ws, job, STATUS_CLEANING)
        video = rclone_download(job.drive_folder_id, job_dir)
        dubbed = rclone_download_audio(job.id, job_dir)

        clean = job_dir / "clean.mp4"
        vsr_remove_subs(video, clean)

        final = job_dir / f"{job.id}_vi.mp4"
        run(mux_command(str(clean), str(dubbed), str(final)), timeout=1800)

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
            log(f"{len(jobs)} job chờ stage {args.stage}: {[j.id for j in jobs[:8]]}…")
            for job in jobs:
                process(ws, job)
        elif not idle_reported:
            log("Queue rỗng — chờ job mới")
            idle_reported = True

        if args.once:
            return
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
