import { describe, it, expect } from "vitest";
import { buildMeta, sanitizeId, sheetRow, type CapturedPage } from "./contract";
import { parseCount } from "./parse";

const page: CapturedPage = {
  rawId: "dy-7301234567890123456",
  title: "Tiêu đề gốc #tag1",
  author: "Kênh A",
  sourceUrl: "https://www.douyin.com/video/7301234567890123456",
  description: "mô tả",
  tags: ["tag1"],
  stats: { likes: 12000, comments: 340, shares: 56 },
  durationSeconds: 95,
  videoUrl: "",
  thumbUrl: "https://p3.douyinpic.com/x.jpg",
};

describe("sanitizeId", () => {
  it("giữ nguyên id hợp lệ", () => {
    expect(sanitizeId("dy-123_abc")).toBe("dy-123_abc");
  });
  it("thay ký tự lạ và gộp dấu gạch", () => {
    expect(sanitizeId("dy 123/../x")).toBe("dy-123-x");
  });
  it("không bao giờ trả rỗng", () => {
    expect(sanitizeId("///")).toMatch(/^v-\d+$/);
  });
});

describe("buildMeta", () => {
  const at = new Date("2026-08-16T12:00:00Z");
  it("đúng schema v1.0, có thumbnail", () => {
    const meta = buildMeta(page, at, true);
    expect(meta.schema_version).toBe("1.0");
    expect(meta.id).toBe("dy-7301234567890123456");
    expect(meta.captured_at).toBe("2026-08-16T12:00:00.000Z");
    expect(meta.files).toEqual({ video: "video.mp4", thumbnail: "thumb.jpg" });
  });
  it("không thumbnail thì files chỉ có video", () => {
    expect(buildMeta(page, at, false).files).toEqual({ video: "video.mp4" });
  });
});

describe("sheetRow", () => {
  it("đúng 13 cột A→M theo hợp đồng", () => {
    const meta = buildMeta(page, new Date(), true);
    const row = sheetRow(meta, "https://drive.google.com/drive/folders/xyz");
    expect(row).toHaveLength(13);
    expect(row[0]).toBe(meta.id); // A id
    expect(row[4]).toBe("https://drive.google.com/drive/folders/xyz"); // E drive_folder_link
    expect(row[6]).toBe("cinematic"); // G translation_mode
    expect(row[7]).toBe("NEW"); // H status
    expect(row.slice(8)).toEqual(["", "", "", "", ""]); // I→M worker ghi
  });
});

describe("parseCount", () => {
  it.each([
    ["1.2万", 12000],
    ["3456", 3456],
    ["5k", 5000],
    ["", 0],
    ["abc", 0],
  ])("%s → %d", (input, expected) => {
    expect(parseCount(input)).toBe(expected);
  });
});
