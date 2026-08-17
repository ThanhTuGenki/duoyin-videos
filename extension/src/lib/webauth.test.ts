import { describe, expect, it } from "vitest";
import { buildAuthUrl, isExpired, parseCallback, redirectUri, toStoredToken } from "./webauth";

const EXT = "bbhcmfeedghfopbijnbjnhdfenfdinli";

describe("buildAuthUrl", () => {
  it("đủ tham số cho code flow + refresh token", () => {
    const u = new URL(buildAuthUrl("CID.apps.googleusercontent.com", EXT, "st4te"));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(u.searchParams.get("redirect_uri")).toBe(`https://${EXT}.chromiumapp.org/`);
    expect(u.searchParams.get("scope")).toContain("spreadsheets");
    expect(u.searchParams.get("state")).toBe("st4te");
  });
});

describe("parseCallback", () => {
  it("lấy code khi state khớp", () => {
    expect(parseCallback(`${redirectUri(EXT)}?state=abc&code=4%2FXYZ`, "abc")).toBe("4/XYZ");
  });
  it("state lệch → null (chống CSRF)", () => {
    expect(parseCallback(`${redirectUri(EXT)}?state=EVIL&code=x`, "abc")).toBeNull();
  });
  it("URL rác → null", () => {
    expect(parseCallback("not a url", "abc")).toBeNull();
  });
});

describe("isExpired", () => {
  const token = { access_token: "a", expires_at: 1_000_000 };
  it("chưa tới hạn - 60s → còn dùng được", () => {
    expect(isExpired(token, 1_000_000 - 61_000)).toBe(false);
  });
  it("trong vùng đệm 60s → coi như hết hạn", () => {
    expect(isExpired(token, 1_000_000 - 30_000)).toBe(true);
  });
});

describe("toStoredToken", () => {
  it("tính expires_at từ expires_in", () => {
    const t = toStoredToken({ access_token: "A", refresh_token: "R", expires_in: 3600 }, 1000);
    expect(t.expires_at).toBe(1000 + 3_600_000);
    expect(t.refresh_token).toBe("R");
  });
  it("refresh KHÔNG trả refresh_token mới → giữ cái cũ", () => {
    const t = toStoredToken({ access_token: "A2", expires_in: 3600 }, 1000, "R_CU");
    expect(t.refresh_token).toBe("R_CU");
  });
});
