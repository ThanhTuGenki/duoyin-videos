#!/usr/bin/env python3
"""Spike VoiceStudio — trả lời 2 câu hỏi rủi ro nhất trước khi xây worker:

  1. API headless /dub/* có chạy đúng trên Linux server không?
  2. Giọng Việt clone từ MinhQuanVoice.mp3 nghe có dùng được không?

Đây là script THĂM DÒ: mỗi bước in ra thứ máy chủ thực sự trả về và lưu JSON
đầy đủ ra đĩa, thay vì giả định hợp đồng API. Bước nào lệch tài liệu thì thấy
ngay tại chỗ chứ không đoán.

    bash /root/start_voicestudio.sh
    /root/VoiceStudio/.venv/bin/python worker/spike_voicestudio.py --video test.mp4
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import requests

API = os.environ.get("VS_API", "http://127.0.0.1:3900")
OUT = Path(os.environ.get("SPIKE_OUT", "/root/spike_out"))
ASSETS = Path(__file__).resolve().parent / "assets" / "voice"


# ── tiện ích ─────────────────────────────────────────────────────

def log(msg: str) -> None:
    print(f"\033[1;36m▸ {msg}\033[0m", flush=True)


def ok(msg: str) -> None:
    print(f"\033[1;32m  ✓ {msg}\033[0m", flush=True)


def warn(msg: str) -> None:
    print(f"\033[1;33m  ! {msg}\033[0m", flush=True)


def vram() -> str:
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used,utilization.gpu", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=10,
        )
        return out.stdout.strip().replace("\n", " | ")
    except Exception:
        return "n/a"


def dump(name: str, data) -> Path:
    OUT.mkdir(parents=True, exist_ok=True)
    p = OUT / f"{name}.json"
    p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return p


def show(name: str, resp: requests.Response):
    """In gọn phản hồi + lưu đầy đủ ra đĩa (spike: cần thấy hợp đồng thật)."""
    print(f"    HTTP {resp.status_code} · {len(resp.content)} bytes")
    try:
        data = resp.json()
    except ValueError:
        print(f"    (không phải JSON) {resp.text[:200]}")
        return None
    p = dump(name, data)
    if isinstance(data, dict):
        print(f"    keys: {list(data.keys())[:14]}")
    elif isinstance(data, list):
        print(f"    list[{len(data)}]" + (f" · phần tử đầu keys: {list(data[0].keys())[:12]}"
                                          if data and isinstance(data[0], dict) else ""))
    print(f"    → {p}")
    return data


# ── các bước ─────────────────────────────────────────────────────

def wait_health(timeout: int = 600) -> None:
    log(f"Chờ API sẵn sàng tại {API} (tối đa {timeout}s)")
    start = time.time()
    while time.time() - start < timeout:
        try:
            r = requests.get(f"{API}/health", timeout=5)
            if r.ok:
                ok(f"API sẵn sàng sau {time.time() - start:.0f}s · VRAM {vram()}")
                return
        except requests.RequestException:
            pass
        time.sleep(3)
    sys.exit(f"API không lên sau {timeout}s — xem tail -f /tmp/voicestudio.log")


def create_voice(name: str) -> str | None:
    """Tạo voice profile clone từ MinhQuanVoice.mp3 + transcript kèm theo."""
    audio = ASSETS / "MinhQuanVoice.mp3"
    text = (ASSETS / "MinhQuanVoice.txt").read_text(encoding="utf-8").strip()
    if not audio.exists():
        sys.exit(f"Thiếu {audio}")

    log(f"Tạo giọng clone '{name}' từ {audio.name} ({audio.stat().st_size / 1024:.0f} KB)")
    print(f"    ref_text ({len(text)} ký tự): {text[:70]}…")
    with audio.open("rb") as fh:
        r = requests.post(
            f"{API}/profiles",
            data={"name": name, "ref_text": text, "kind": "clone", "language": "vi"},
            files={"ref_audio": (audio.name, fh, "audio/mpeg")},
            timeout=300,
        )
    data = show("profile_create", r)
    if not r.ok:
        warn("Tạo giọng thất bại — xem JSON ở trên")
        return None
    pid = (data or {}).get("id") or (data or {}).get("profile_id")
    ok(f"profile_id = {pid}")
    return pid


def audio_ext(blob: bytes) -> str:
    """Đuôi file theo magic bytes, không tin vào tên endpoint."""
    if blob[:4] == b"RIFF" and blob[8:12] == b"WAVE":
        return "wav"
    if blob[:3] == b"ID3" or blob[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"):
        return "mp3"
    if blob[:4] == b"OggS":
        return "ogg"
    if blob[:4] == b"fLaC":
        return "flac"
    return "bin"


def install_model(repo_id: str) -> None:
    """Cài model qua Model Catalogue (tải chạy nền phía máy chủ)."""
    log(f"Cài model {repo_id}")
    r = requests.post(f"{API}/models/install", json={"repo_id": repo_id}, timeout=120)
    print(f"    HTTP {r.status_code} · {r.text[:130]}")


def transcribe_with_autoinstall(job: str, timeout: int = 5400):
    """Transcribe; nếu máy chủ báo thiếu model ASR thì tự cài, chờ, rồi thử lại.

    Máy mới dựng chưa có model nào: /dub/transcribe trả 409 kèm
    {"error": "asr_model_missing", "missing_repo_id": ...}. Tự xử ở đây để
    dựng máy mới không phải thao tác tay qua Model Catalogue.
    """
    t0 = time.time()
    asked = set()
    while time.time() - t0 < timeout:
        r = requests.post(f"{API}/dub/transcribe/{job}", json={}, timeout=5400)
        if r.ok:
            return show("dub_transcribe", r)

        detail = None
        try:
            detail = r.json().get("detail")
        except ValueError:
            pass
        missing = detail.get("missing_repo_id") if isinstance(detail, dict) else None

        if r.status_code == 409 and missing:
            if missing not in asked:
                warn(f"Máy chủ báo thiếu model: {missing}")
                install_model(missing)
                asked.add(missing)
            print(f"    [{time.time() - t0:5.0f}s] model đang tải… chờ 30s rồi thử lại")
            time.sleep(30)
            continue

        show("dub_transcribe", r)
        sys.exit(f"Transcribe thất bại HTTP {r.status_code}")
    sys.exit(f"Hết {timeout}s chờ model ASR")


def wait_ready(task_id: str | None, timeout: int = 5400, label: str = "prep") -> None:
    """Chờ một task chạy nền của VoiceStudio xong, qua SSE /tasks/stream/{task_id}.

    Dùng cho cả hai chỗ chạy nền:
      - /dub/upload   → tách audio → Demucs → scene detect → sự kiện 'ready'
      - /dub/generate → dịch + TTS từng đoạn (trả {task_id} ngay, TTS làm sau)
    Gọi bước sau khi task chưa xong sẽ nhận 409/400.
    """
    if not task_id:
        warn(f"Không có task_id cho bước '{label}' — bỏ qua chờ, bước sau có thể lỗi")
        return
    log(f"Chờ {label} xong · SSE /tasks/stream/{task_id}")
    t0 = time.time()
    try:
        with requests.get(f"{API}/tasks/stream/{task_id}", stream=True, timeout=(10, timeout)) as r:
            for raw in r.iter_lines(decode_unicode=True):
                if not raw or not raw.startswith("data:"):
                    continue
                body = raw[5:].strip()
                try:
                    ev = json.loads(body)
                except ValueError:
                    print(f"    {body[:130]}")
                    continue
                stage = str(ev.get("stage") or ev.get("event") or ev.get("status") or "")
                print(f"    [{time.time() - t0:5.0f}s] {stage or '?'} · {json.dumps(ev, ensure_ascii=False)[:120]}")
                if stage.lower() in ("ready", "done", "complete", "completed", "success"):
                    ok(f"{label} xong sau {time.time() - t0:.0f}s · VRAM {vram()}")
                    return
                if stage.lower() in ("error", "failed", "failure"):
                    dump("prep_error", ev)
                    sys.exit(f"Prep thất bại: {ev}")
    except requests.RequestException as e:
        warn(f"SSE đứt ({e}) — thử đi tiếp")
    ok(f"stream kết thúc sau {time.time() - t0:.0f}s")


def dub(video: Path, profile_id: str | None, target_lang: str) -> None:
    log(f"Upload video: {video.name} ({video.stat().st_size / 1e6:.1f} MB)")
    t0 = time.time()
    # Trường form tên "video" (không phải "file") — theo chữ ký dub_upload()
    with video.open("rb") as fh:
        r = requests.post(f"{API}/dub/upload", files={"video": (video.name, fh, "video/mp4")}, timeout=1800)
    up = show("dub_upload", r)
    if not r.ok:
        sys.exit("Upload thất bại")
    job = (up or {}).get("job_id") or (up or {}).get("id")
    ok(f"job_id = {job} · {time.time() - t0:.0f}s")

    # Upload trả 202 rồi chạy nền: tách audio, Demucs, scene detect.
    # Phải chờ sự kiện 'ready' mới được transcribe (theo docstring của endpoint).
    wait_ready((up or {}).get("task_id"))

    log("Transcribe (WhisperX + tách giọng/nhạc nền + diarization)")
    t0 = time.time()
    tr = transcribe_with_autoinstall(job)
    ok(f"transcribe xong {time.time() - t0:.0f}s · VRAM {vram()}")

    segments = None
    if isinstance(tr, dict):
        for key in ("segments", "result", "data"):
            if isinstance(tr.get(key), list):
                segments = tr[key]
                break
    if not segments:
        warn("Không thấy danh sách segment trong phản hồi — mở dub_transcribe.json xem cấu trúc thật")
        return
    ok(f"{len(segments)} segment · câu đầu: {str(segments[0].get('text'))[:60]}")

    log(f"Dịch + tổng hợp giọng sang '{target_lang}'"
        + (f" (dùng profile {profile_id} cho MỌI segment)" if profile_id else " (giọng mặc định)"))
    payload_segments = []
    for s in segments:
        seg = {
            "start": s.get("start", 0.0),
            "end": s.get("end", 0.0),
            "text": s.get("text", ""),
        }
        if profile_id:
            seg["profile_id"] = profile_id   # DubSegment.profile_id — giọng cho từng đoạn
        payload_segments.append(seg)

    t0 = time.time()
    r = requests.post(
        f"{API}/dub/generate/{job}",
        json={"segments": payload_segments, "language": target_lang, "language_code": target_lang},
        timeout=7200,
    )
    gen = show("dub_generate", r)
    if not r.ok:
        sys.exit("Gọi generate thất bại")
    # generate cũng chạy nền như upload: trả {task_id} ngay, TTS làm sau.
    # Tải audio trước khi task xong sẽ nhận HTTP 400.
    wait_ready((gen or {}).get("task_id"), label="tổng hợp giọng")
    gen_s = time.time() - t0
    ok(f"generate xong {gen_s:.0f}s · VRAM {vram()}")

    log("Tải audio đã lồng tiếng")
    r = requests.get(f"{API}/dub/download-audio/{job}", timeout=1800)
    if r.ok and len(r.content) > 1000:
        OUT.mkdir(parents=True, exist_ok=True)
        # Endpoint tên là download-audio nhưng thực tế trả WAV. Đặt đuôi theo
        # nội dung thật, vì đuôi sai làm nhiều trình phát từ chối mở file.
        dest = OUT / f"dubbed_{target_lang}.{audio_ext(r.content)}"
        dest.write_bytes(r.content)
        ok(f"ĐÃ LƯU {dest} ({len(r.content) / 1e6:.1f} MB) ← nghe file này để chấm chất lượng giọng")
    else:
        warn(f"Tải audio thất bại: HTTP {r.status_code}, {len(r.content)} bytes")

    dump("summary", {
        "job_id": job,
        "profile_id": profile_id,
        "segments": len(segments),
        "generate_seconds": round(gen_s, 1),
        "vram_after": vram(),
    })


def main() -> None:
    ap = argparse.ArgumentParser(description="Spike VoiceStudio headless + clone giọng Việt")
    ap.add_argument("--video", required=True, help="video test (nên dùng clip 1-2 phút cho vòng lặp nhanh)")
    ap.add_argument("--lang", default="vi", help="ngôn ngữ đích (mặc định vi)")
    ap.add_argument("--voice-name", default="MinhQuan", help="tên voice profile")
    ap.add_argument("--skip-voice", action="store_true", help="bỏ qua tạo giọng, dùng giọng mặc định")
    args = ap.parse_args()

    video = Path(args.video)
    if not video.exists():
        sys.exit(f"Không thấy video: {video}")

    print(f"\nAPI={API} · OUT={OUT} · VRAM lúc bắt đầu: {vram()}\n")
    wait_health()
    pid = None if args.skip_voice else create_voice(args.voice_name)
    dub(video, pid, args.lang)

    log("KẾT LUẬN CẦN CHẤM")
    print(f"""
  1. API headless chạy được?      → xem các bước ở trên có bước nào đỏ không
  2. Giọng Việt nghe thế nào?     → nghe {OUT}/dubbed_{args.lang}.mp3
  3. Thời gian / VRAM             → {OUT}/summary.json
  4. Hợp đồng API thật            → các file *.json trong {OUT}

  Tải file về máy để nghe:
    scp -P <PORT> root@<IP>:{OUT}/dubbed_{args.lang}.mp3 ~/Desktop/
""")


if __name__ == "__main__":
    main()
