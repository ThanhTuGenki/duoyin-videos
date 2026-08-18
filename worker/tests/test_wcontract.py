import pytest

from wcontract import (
    COLUMNS, Job, audio_ext, has_enough_speech, mux_command,
    parse_row, parse_translated, pick_new_jobs, vsr_command,
)

HEADER = COLUMNS


def make_row(**kw) -> list[str]:
    base = {
        "id": "dy-123", "title": "t", "author": "a", "source_url": "u",
        "drive_folder_link": "https://drive.google.com/drive/folders/FOLDER123",
        "voice": "default", "translation_mode": "cinematic", "status": "NEW",
        "output_link": "", "error": "", "duration": "", "process_time": "", "updated_at": "",
    }
    base.update(kw)
    return [base[c] for c in COLUMNS]


class TestPickNewJobs:
    def test_chon_dung_dong_new(self):
        rows = [HEADER, make_row(), make_row(id="dy-456", status="DONE")]
        jobs = pick_new_jobs(rows)
        assert [j.id for j in jobs] == ["dy-123"]
        assert jobs[0].row_number == 2  # 1-based, header là dòng 1

    def test_bo_qua_dong_thieu_id_hoac_link(self):
        rows = [HEADER, make_row(id=""), make_row(drive_folder_link=""), make_row(id="dy-ok")]
        assert [j.id for j in pick_new_jobs(rows)] == ["dy-ok"]

    def test_dong_ngan_hon_13_cot_khong_crash(self):
        rows = [HEADER, ["dy-1", "t", "a", "u", "https://drive.google.com/drive/folders/X", "", "", "NEW"]]
        jobs = pick_new_jobs(rows)
        assert jobs[0].id == "dy-1"
        assert jobs[0].translation_mode == "cinematic"  # default khi trống

    def test_status_thuong_hoa_van_nhan(self):
        rows = [HEADER, make_row(status="new ")]
        assert len(pick_new_jobs(rows)) == 1


class TestParseRow:
    def test_tach_folder_id_tu_link(self):
        job = parse_row(2, make_row())
        assert job.drive_folder_id == "FOLDER123"

    def test_folder_id_bo_query_string(self):
        job = parse_row(2, make_row(drive_folder_link="https://drive.google.com/drive/folders/ABC?usp=sharing"))
        assert job.drive_folder_id == "ABC"

    def test_translation_mode_la_khong_hop_le_ve_cinematic(self):
        job = parse_row(2, make_row(translation_mode="sieucap"))
        assert job.translation_mode == "cinematic"


class TestHasEnoughSpeech:
    def test_video_nhac_2_segment_bi_loai(self):
        # đúng ca thật 17.08: video 66s chỉ có 2 câu lời bài hát
        segs = [{"start": 14.2, "end": 24.2}, {"start": 29.7, "end": 66.0}]
        assert has_enough_speech(segs, 66.0) is False  # <3 segment

    def test_video_thuyet_minh_day_du_qua(self):
        segs = [{"start": i * 5, "end": i * 5 + 4} for i in range(25)]
        assert has_enough_speech(segs, 128.0) is True

    def test_nhieu_segment_nhung_noi_qua_it(self):
        segs = [{"start": i, "end": i + 0.1} for i in range(5)]
        assert has_enough_speech(segs, 120.0) is False  # 0.5s/120s < 10%


class TestCommands:
    def test_vsr_khong_truyen_toa_do(self):
        cmd = vsr_command("/venv/bin/python", "in.mp4", "out.mp4")
        assert "-c" not in cmd  # sttn-auto tự dò vùng sub
        assert cmd[:2] == ["/venv/bin/python", "backend/main.py"]

    def test_mux_stream_copy_video(self):
        cmd = mux_command("clean.mp4", "dub.wav", "final.mp4")
        i = cmd.index("-c:v")
        assert cmd[i + 1] == "copy"  # không re-encode hình
        assert "-shortest" in cmd


class TestAudioExt:
    @pytest.mark.parametrize("blob,ext", [
        (b"RIFF\x00\x00\x00\x00WAVEfmt ", "wav"),
        (b"ID3\x04\x00" + b"\x00" * 8, "mp3"),
        (b"\xff\xfb\x90\x00" + b"\x00" * 8, "mp3"),
        (b"OggS" + b"\x00" * 8, "ogg"),
        (b"junkdata" + b"\x00" * 8, "bin"),
    ])
    def test_nhan_dang(self, blob, ext):
        assert audio_ext(blob) == ext


class TestParseTranslated:
    ORIG = [
        {"id": "s1", "text": "你好", "start": 0, "end": 2},
        {"id": "s2", "text": "再见", "start": 2, "end": 4},
    ]

    def test_khoa_translated_dung_hop_dong_that(self):
        # cấu trúc thật đo 17.08: {"translated": [{id,text,rate_ratio,plan}], ...}
        data = {"translated": [
            {"id": "s1", "text": "Xin chào", "rate_ratio": 1.0},
            {"id": "s2", "text": "Tạm biệt", "rate_ratio": 1.1},
        ], "target_lang": "vi", "quality_used": "cinematic"}
        segs, unchanged = parse_translated(data, self.ORIG)
        assert [s["text"] for s in segs] == ["Xin chào", "Tạm biệt"]
        assert unchanged == 0
        assert segs[0]["start"] == 0  # giữ nguyên timing gốc

    def test_dem_cau_khong_doi_de_phat_hien_chua_dich(self):
        data = {"translated": [
            {"id": "s1", "text": "你好"},
            {"id": "s2", "text": "再见"},
        ]}
        _, unchanged = parse_translated(data, self.ORIG)
        assert unchanged == 2  # caller sẽ coi đây là chưa dịch

    def test_thieu_ban_dich_giu_ban_goc(self):
        data = {"translated": [{"id": "s1", "text": "Xin chào"}]}
        segs, _ = parse_translated(data, self.ORIG)
        assert segs[1]["text"] == "再见"

    def test_cau_truc_la_bao_loi(self):
        with pytest.raises(ValueError):
            parse_translated({"weird": 1}, self.ORIG)


class TestReclaim:
    """Đòi lại job dở dang sau crash — worker restart phải tự chạy lại."""

    def test_pick_stale_bat_dung_cac_trang_thai_dang_do(self):
        from wcontract import pick_stale_jobs
        rows = [HEADER,
                make_row(id="dy-a", status="PROCESSING"),
                make_row(id="dy-b", status="DONE"),
                make_row(id="dy-c", status="UPLOADING"),
                make_row(id="dy-d", status="NEW")]
        assert [j.id for j in pick_stale_jobs(rows)] == ["dy-a", "dy-c"]

    def test_lan_dau_crash_ve_new_voi_dem_1(self):
        from wcontract import reclaim_decision
        status, err = reclaim_decision("")
        assert status == "NEW"
        assert err.startswith("[auto-retry 1]")

    def test_dem_tang_dan_qua_cac_lan(self):
        from wcontract import reclaim_decision
        _, err1 = reclaim_decision("")
        status2, err2 = reclaim_decision(err1)
        assert status2 == "NEW" and err2.startswith("[auto-retry 2]")

    def test_qua_2_lan_thi_dung_han_o_error(self):
        from wcontract import reclaim_decision
        status, err = reclaim_decision("[auto-retry 2] tự chạy lại sau khi worker khởi động lại")
        assert status == "ERROR"
        assert "Quá 2 lần" in err

    def test_error_cu_khong_phai_retry_van_dem_tu_0(self):
        from wcontract import retry_count
        assert retry_count("Video không có lời thoại") == 0
        assert retry_count("") == 0
        assert retry_count("[auto-retry rác]") == 0


class TestTwoStage:
    """Thiết kế 2 giai đoạn 17.08: dub và VSR chạy container riêng."""

    def test_stage_dub_chi_nhan_new(self):
        from wcontract import pick_jobs
        rows = [HEADER, make_row(id="dy-a", status="NEW"), make_row(id="dy-b", status="DUBBED")]
        assert [j.id for j in pick_jobs(rows, "dub")] == ["dy-a"]

    def test_stage_vsr_chi_nhan_dubbed(self):
        from wcontract import pick_jobs
        rows = [HEADER, make_row(id="dy-a", status="NEW"), make_row(id="dy-b", status="DUBBED")]
        assert [j.id for j in pick_jobs(rows, "vsr")] == ["dy-b"]

    def test_stage_all_nhan_ca_hai(self):
        from wcontract import pick_jobs
        rows = [HEADER, make_row(id="dy-a", status="NEW"), make_row(id="dy-b", status="DUBBED")]
        assert [j.id for j in pick_jobs(rows, "all")] == ["dy-a", "dy-b"]

    def test_ket_dubbing_ve_new(self):
        from wcontract import reclaim_decision
        status, _ = reclaim_decision("", "DUBBING")
        assert status == "NEW"

    def test_ket_cleaning_ve_dubbed_khong_dub_lai(self):
        from wcontract import reclaim_decision
        status, _ = reclaim_decision("", "CLEANING")
        assert status == "DUBBED"  # chỉ làm lại phần VSR

    def test_status_cu_legacy_van_reclaim_ve_new(self):
        from wcontract import reclaim_decision
        for legacy in ("DOWNLOADING", "PROCESSING", "MUXING", "UPLOADING"):
            status, _ = reclaim_decision("", legacy)
            assert status == "NEW"

    def test_pick_stale_bat_ca_dubbing_va_cleaning(self):
        from wcontract import pick_stale_jobs
        rows = [HEADER, make_row(id="dy-a", status="DUBBING"), make_row(id="dy-b", status="CLEANING"),
                make_row(id="dy-c", status="DUBBED")]
        assert [j.id for j in pick_stale_jobs(rows)] == ["dy-a", "dy-b"]


class TestHauKy:
    """Che sub cũ + đốt sub Việt. Ba filter đã chạy thật với ffmpeg 8.1.2 và
    kiểm mắt thường trên frame (vùng mờ đúng y 860-1010, x 100-1820)."""

    def test_delogo_dung_toa_do_pixel(self):
        from wcontract import cover_filter
        # area là ymin,ymax,xmin,xmax nhưng delogo nhận x,y,w,h
        assert cover_filter("delogo", "860,1010,100,1820") == \
            "delogo=x=100:y=860:w=1720:h=150"

    def test_box_ve_khoi_dac(self):
        from wcontract import cover_filter
        f = cover_filter("box", "860,1010,100,1820")
        assert "drawbox=" in f and "t=fill" in f

    def test_blur_chi_lam_mo_trong_vung(self):
        from wcontract import cover_filter
        f = cover_filter("blur", "860,1010,100,1820")
        # split/overlay để phần ngoài vùng giữ nguyên, không mờ cả khung
        assert f.startswith("split[bg][fg]") and "overlay=100:860" in f

    def test_mode_khong_hop_le_thi_loi(self):
        from wcontract import cover_filter
        import pytest
        with pytest.raises(ValueError, match="cover mode"):
            cover_filter("khong-ton-tai", "860,1010,100,1820")

    def test_area_thieu_so_thi_loi_som(self):
        from wcontract import cover_filter
        import pytest
        with pytest.raises(ValueError, match="4 số"):
            cover_filter("delogo", "860,1010")

    def test_area_nguoc_thi_loi_thay_vi_ra_filter_am(self):
        from wcontract import cover_filter
        import pytest
        # ymin/ymax đảo ngược → cao âm; phải chặn chứ đừng đưa cho ffmpeg
        with pytest.raises(ValueError, match="không hợp lệ"):
            cover_filter("delogo", "1010,860,100,1820")

    def test_mot_luot_encode_audio_copy(self):
        from wcontract import finalize_command
        cmd = finalize_command("in.mp4", "s.srt", "out.mp4", area="860,1010,100,1820")
        vf = cmd[cmd.index("-vf") + 1]
        # che rồi đốt sub trong CÙNG một chuỗi filter → chỉ mất chất 1 lần
        assert vf == "delogo=x=100:y=860:w=1720:h=150,subtitles=s.srt"
        assert cmd[cmd.index("-c:a") + 1] == "copy"   # tiếng Việt không nén lại

    def test_khong_dot_sub_thi_chi_che(self):
        from wcontract import finalize_command
        cmd = finalize_command("in.mp4", "s.srt", "out.mp4",
                               area="860,1010,100,1820", burn_subs=False)
        assert "subtitles" not in cmd[cmd.index("-vf") + 1]

    def test_khong_co_srt_thi_van_che_duoc(self):
        from wcontract import finalize_command
        cmd = finalize_command("in.mp4", "", "out.mp4", area="860,1010,100,1820")
        assert "subtitles" not in cmd[cmd.index("-vf") + 1]

    def test_khong_co_gi_de_lam_thi_loi(self):
        from wcontract import finalize_command
        import pytest
        with pytest.raises(ValueError, match="Không có gì để làm"):
            finalize_command("in.mp4", "", "out.mp4", area="")

    def test_escape_dau_hai_cham_trong_duong_dan(self):
        from wcontract import escape_filter_path
        # ':' phân tách tham số trong filtergraph nên bắt buộc phải escape
        assert escape_filter_path("/a/b:c.srt") == "/a/b\\:c.srt"
