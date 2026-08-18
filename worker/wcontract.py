"""Hợp đồng ingest phía worker — PHẢI khớp contract/sheet-columns.md.

Chỉ chứa pure functions (không I/O) để test được ở local không cần Sheet thật.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# Cột A..M — thứ tự là hợp đồng, đổi = đổi contract/sheet-columns.md + extension
COLUMNS = [
    "id", "title", "author", "source_url", "drive_folder_link",
    "voice", "translation_mode", "status", "output_link", "error",
    "duration", "process_time", "updated_at",
]
COL_INDEX = {name: i for i, name in enumerate(COLUMNS)}

# Vòng đời 2 giai đoạn (thiết kế 17.08, tách dub và VSR chạy container riêng):
#   Giai đoạn A (dub): NEW → DUBBING → DUBBED   (<id>_dubbed.mp4 + <id>_vi.srt lên Drive)
#   Giai đoạn B (vsr): DUBBED → CLEANING → DONE (video sạch sub + tiếng Việt)
STATUS_NEW = "NEW"
STATUS_DUBBING = "DUBBING"
STATUS_DUBBED = "DUBBED"
STATUS_CLEANING = "CLEANING"
STATUS_DONE = "DONE"
STATUS_ERROR = "ERROR"

# Trạng thái của thiết kế cũ (1 giai đoạn) — chỉ còn dùng để reclaim dòng cũ
LEGACY_IN_PROGRESS = {"DOWNLOADING", "PROCESSING", "MUXING", "UPLOADING"}

VALID_TRANSLATION_MODES = {"fast", "cinematic", "autofit"}


@dataclass
class Job:
    row_number: int  # 1-based, đúng số dòng trên Sheet
    id: str
    title: str = ""
    voice: str = "default"
    translation_mode: str = "cinematic"
    drive_folder_link: str = ""
    raw: list[str] = field(default_factory=list)

    @property
    def drive_folder_id(self) -> str:
        """Tách folder id từ link https://drive.google.com/drive/folders/<id>."""
        link = self.drive_folder_link.rstrip("/")
        return link.rsplit("/", 1)[-1].split("?")[0] if link else ""


def parse_row(row_number: int, row: list[str]) -> Job:
    padded = list(row) + [""] * (len(COLUMNS) - len(row))
    mode = padded[COL_INDEX["translation_mode"]].strip().lower() or "cinematic"
    if mode not in VALID_TRANSLATION_MODES:
        mode = "cinematic"
    return Job(
        row_number=row_number,
        id=padded[COL_INDEX["id"]].strip(),
        title=padded[COL_INDEX["title"]].strip(),
        voice=padded[COL_INDEX["voice"]].strip() or "default",
        translation_mode=mode,
        drive_folder_link=padded[COL_INDEX["drive_folder_link"]].strip(),
        raw=padded,
    )


# stage → status đầu vào mà worker của stage đó nhận
STAGE_INPUT = {
    "dub": {STATUS_NEW},
    "vsr": {STATUS_DUBBED},
    "all": {STATUS_NEW, STATUS_DUBBED},
}


def pick_jobs(rows: list[list[str]], stage: str = "dub") -> list[Job]:
    """Chọn các dòng hợp lệ cho stage (đủ id + drive_folder_link). Dòng 1 là header."""
    wanted = STAGE_INPUT[stage]
    jobs = []
    for i, row in enumerate(rows[1:], start=2):
        padded = list(row) + [""] * (len(COLUMNS) - len(row))
        if padded[COL_INDEX["status"]].strip().upper() not in wanted:
            continue
        job = parse_row(i, row)
        if job.id and job.drive_folder_id:
            jobs.append(job)
    return jobs


def pick_new_jobs(rows: list[list[str]]) -> list[Job]:
    """Giữ tương thích: các dòng NEW (stage dub)."""
    return pick_jobs(rows, "dub")


def has_enough_speech(segments: list[dict], video_seconds: float,
                      min_segments: int = 3, min_ratio: float = 0.10) -> bool:
    """Video kiểu nhạc nền/chỉ chữ trên hình thì không có gì để lồng tiếng.

    Phát hiện từ spike 17.08: video 山顶小屋 66s chỉ ra 2 segment tiếng Anh
    (lời bài hát) — dub bản đó là vô nghĩa. Ngưỡng: >=3 segment VÀ tổng thời
    lượng nói >=10% video.
    """
    if len(segments) < min_segments:
        return False
    spoken = sum(max(0.0, float(s.get("end", 0)) - float(s.get("start", 0))) for s in segments)
    return video_seconds <= 0 or (spoken / video_seconds) >= min_ratio


def vsr_command(vsr_python: str, video_in: str, video_out: str,
                inpaint_mode: str = "sttn-auto", sub_area: str = "") -> list[str]:
    """Lệnh VSR. Không truyền -c thì sttn-auto tự dò vùng sub bằng PaddleOCR.

    Bản paddle CPU dò KHÔNG ra (đo 17.08: GPU 2% suốt 197s, sub còn nguyên),
    nên khi chạy CPU paddle phải truyền sub_area="ymin,ymax,xmin,xmax".

    -c của VSR khai báo nargs=4 (backend/tools/args_handler.py) nên phải đưa
    BỐN số rời, không phải một chuỗi có dấu phẩy — đã kiểm chứng bằng cách
    chạy thật: -c 860 1010 100 1820 cho video 1920x1080 thì GPU lên 95% và
    sub biến mất, còn không có -c thì GPU 2% và sub còn nguyên.
    """
    cmd = [vsr_python, "backend/main.py", "-i", video_in, "-o", video_out,
           "--inpaint-mode", inpaint_mode]
    if sub_area:
        coords = [p.strip() for p in sub_area.replace(",", " ").split() if p.strip()]
        if len(coords) != 4:
            raise ValueError(
                f"sub_area cần đúng 4 số 'ymin,ymax,xmin,xmax', nhận: {sub_area!r}")
        cmd += ["-c", *coords]
    return cmd


def escape_filter_path(path: str) -> str:
    """Escape đường dẫn để nhét vào filtergraph của ffmpeg.

    Trong filtergraph, ':' phân tách tham số và '\\' là ký tự escape, nên
    đường dẫn phải được escape trước — không thì filter bị parse sai.
    """
    return path.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


COVER_MODES = ("delogo", "blur", "box")


def cover_filter(mode: str, area: str) -> str:
    """Filter che vùng phụ đề cũ. area = 'ymin,ymax,xmin,xmax' (pixel).

    Ba cách, chọn theo nội dung video:
      delogo — nội suy từ viền xung quanh; gọn nhất với nền phẳng (cỏ, tường),
               nhưng nhoè khi nền nhiều chi tiết
      blur   — làm mờ mạnh vùng đó; luôn dùng được, còn thấy vệt mờ
      box    — vẽ khối đen đặc; chắc chắn che sạch, trông như thanh phụ đề
    """
    if mode not in COVER_MODES:
        raise ValueError(f"cover mode phải thuộc {COVER_MODES}, nhận {mode!r}")
    parts = [p.strip() for p in area.replace(",", " ").split() if p.strip()]
    if len(parts) != 4:
        raise ValueError(f"area cần 4 số 'ymin,ymax,xmin,xmax', nhận: {area!r}")
    ymin, ymax, xmin, xmax = (int(p) for p in parts)
    w, h = xmax - xmin, ymax - ymin
    if w <= 0 or h <= 0:
        raise ValueError(f"area không hợp lệ (rộng {w}, cao {h}): {area!r}")
    if mode == "delogo":
        return f"delogo=x={xmin}:y={ymin}:w={w}:h={h}"
    if mode == "box":
        return f"drawbox=x={xmin}:y={ymin}:w={w}:h={h}:color=black:t=fill"
    # blur: chỉ làm mờ trong vùng, phần còn lại giữ nguyên
    return (f"split[bg][fg];[fg]crop={w}:{h}:{xmin}:{ymin},boxblur=20:2[blr];"
            f"[bg][blr]overlay={xmin}:{ymin}")


def finalize_command(video_in: str, srt: str, out_path: str, *,
                     cover_mode: str = "delogo", area: str = "",
                     burn_subs: bool = True, crf: int = 20,
                     preset: str = "veryfast") -> list[str]:
    """Che sub cũ + (tuỳ chọn) đốt sub tiếng Việt, trong MỘT lượt encode.

    Một lượt để chỉ mất chất một lần. Audio stream-copy nên tiếng Việt đi qua
    nguyên vẹn, không nén lại.
    """
    chain = []
    if area:
        chain.append(cover_filter(cover_mode, area))
    if burn_subs and srt:
        chain.append(f"subtitles={escape_filter_path(srt)}")
    if not chain:
        raise ValueError("Không có gì để làm: thiếu cả area lẫn srt")
    return ["ffmpeg", "-y", "-loglevel", "error", "-i", video_in,
            "-vf", ",".join(chain),
            "-c:v", "libx264", "-preset", preset, "-crf", str(crf),
            "-c:a", "copy", "-movflags", "+faststart", out_path]


def mux_command(clean_video: str, dubbed_audio: str, out_path: str) -> list[str]:
    """Ghép hình sạch + tiếng Việt. Video stream-copy (không re-encode),
    audio WAV → AAC 192k. -shortest phòng audio dài hơn hình vài trăm ms."""
    return [
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", clean_video, "-i", dubbed_audio,
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
        "-shortest", out_path,
    ]


def audio_ext(blob: bytes) -> str:
    """Đuôi file theo magic bytes (VoiceStudio download-audio trả WAV dù tên là audio)."""
    if blob[:4] == b"RIFF" and blob[8:12] == b"WAVE":
        return "wav"
    if blob[:3] == b"ID3" or blob[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"):
        return "mp3"
    if blob[:4] == b"OggS":
        return "ogg"
    if blob[:4] == b"fLaC":
        return "flac"
    return "bin"


def parse_translated(data, originals: list[dict]) -> tuple[list[dict], int]:
    """Ghép kết quả /dub/translate (khoá 'translated', mỗi phần tử {id,text,...})
    vào segments gốc. Trả (segments đã thay text, số câu không đổi).

    Số câu không đổi cao = dấu hiệu CHƯA dịch (bug đã dính 17.08: TTS đọc
    nguyên văn tiếng Trung) — caller phải kiểm.
    """
    rows = data if isinstance(data, list) else None
    if rows is None and isinstance(data, dict):
        for key in ("translated", "segments", "results", "data", "translations"):
            if isinstance(data.get(key), list):
                rows = data[key]
                break
    if not rows:
        raise ValueError("Không đọc được kết quả dịch")
    by_id = {str(r.get("id")): r.get("text", "") for r in rows if isinstance(r, dict)}
    out, unchanged = [], 0
    for i, seg in enumerate(originals):
        sid = str(seg.get("id") or i)
        text = by_id.get(sid) or seg.get("text", "")
        if text.strip() == seg.get("text", "").strip():
            unchanged += 1
        out.append({**seg, "text": text})
    return out, unchanged


# ── Đòi lại job dở dang khi worker khởi động lại ─────────────────

# Kẹt ở đâu → quay về status nào. Điểm ăn tiền của thiết kế 2 giai đoạn:
# kẹt lúc đang CLEANING thì chỉ làm lại phần VSR (về DUBBED), KHÔNG dub lại.
RECLAIM_TARGET = {
    STATUS_DUBBING: STATUS_NEW,
    STATUS_CLEANING: STATUS_DUBBED,
    **{s: STATUS_NEW for s in LEGACY_IN_PROGRESS},
}
IN_PROGRESS_STATUSES = set(RECLAIM_TARGET)
MAX_AUTO_RETRIES = 2
_RETRY_PREFIX = "[auto-retry "


def retry_count(error_text: str) -> int:
    """Đọc số lần đã tự chạy lại từ cột error (dạng '[auto-retry N] ...')."""
    text = (error_text or "").strip()
    if not text.startswith(_RETRY_PREFIX):
        return 0
    try:
        return int(text[len(_RETRY_PREFIX):].split("]", 1)[0])
    except ValueError:
        return 0


def reclaim_decision(error_text: str, current_status: str = STATUS_DUBBING) -> tuple[str, str]:
    """Quyết định cho 1 dòng đang dở khi worker khởi động lại.

    Chỉ gọi lúc KHỞI ĐỘNG: mỗi stage chỉ có 1 worker nên dòng in-progress lúc
    đó chắc chắn là xác chết của lần chạy trước (crash/mất mạng/container chết).
    Chạy lại là an toàn: rclone idempotent, VoiceStudio cache prep theo file,
    VSR/mux ghi đè. Nhưng phải đếm số lần — job 'độc' (video hỏng làm sập
    worker) mà retry vô hạn thì đốt tiền GPU không hồi kết.

    Trả (status_mới, error_mới).
    """
    n = retry_count(error_text)
    target = RECLAIM_TARGET.get(current_status.strip().upper(), STATUS_NEW)
    if n >= MAX_AUTO_RETRIES:
        return STATUS_ERROR, (
            f"{_RETRY_PREFIX}{n}] Quá {MAX_AUTO_RETRIES} lần tự chạy lại sau crash — "
            f"cần xem tay. Muốn thử tiếp: xoá cột error rồi sửa status về {target}.")
    return target, f"{_RETRY_PREFIX}{n + 1}] tự chạy lại sau khi worker khởi động lại"


def pick_stale_jobs(rows: list[list[str]]) -> list[Job]:
    """Các dòng kẹt ở trạng thái đang-xử-lý (để đòi lại lúc khởi động)."""
    stale = []
    for i, row in enumerate(rows[1:], start=2):
        padded = list(row) + [""] * (len(COLUMNS) - len(row))
        if padded[COL_INDEX["status"]].strip().upper() in IN_PROGRESS_STATUSES:
            stale.append(parse_row(i, row))
    return stale
