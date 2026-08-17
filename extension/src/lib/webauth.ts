// OAuth thủ công cho trình duyệt KHÔNG phải Chrome thật (Cốc Cốc, Brave, Edge…).
// getAuthToken là đặc sản Chrome (Cốc Cốc báo thẳng "This API is not supported");
// đường vòng chuẩn: chrome.identity.launchWebAuthFlow + authorization code flow
// với OAuth client loại "Web application".
//
// File này chỉ chứa phần THUẦN (dựng URL, parse callback, xét hạn token) để
// test được bằng vitest; phần gọi chrome.* nằm ở auth.ts.

export const SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets",
];

export interface StoredToken {
  access_token: string;
  refresh_token?: string;
  /** epoch ms — thời điểm access_token hết hạn */
  expires_at: number;
}

export function redirectUri(extensionId: string): string {
  return `https://${extensionId}.chromiumapp.org/`;
}

export function buildAuthUrl(clientId: string, extensionId: string, state: string): string {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(extensionId),
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline", // để được cấp refresh_token
    prompt: "consent",      // ép cấp refresh_token cả khi đã consent trước đó
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

/** Lấy code từ URL callback; đối chiếu state chống CSRF. Trả null nếu hỏng. */
export function parseCallback(callbackUrl: string, expectedState: string): string | null {
  let u: URL;
  try {
    u = new URL(callbackUrl);
  } catch {
    return null;
  }
  if (u.searchParams.get("state") !== expectedState) return null;
  return u.searchParams.get("code");
}

/** Coi là hết hạn sớm 60s để không dùng token sát nút. */
export function isExpired(token: StoredToken, nowMs: number): boolean {
  return nowMs >= token.expires_at - 60_000;
}

export function toStoredToken(
  resp: { access_token: string; refresh_token?: string; expires_in: number },
  nowMs: number,
  previousRefresh?: string,
): StoredToken {
  return {
    access_token: resp.access_token,
    // Google chỉ trả refresh_token ở lần consent đầu — các lần refresh sau
    // phải giữ lại cái cũ, không được ghi đè bằng undefined.
    refresh_token: resp.refresh_token ?? previousRefresh,
    expires_at: nowMs + resp.expires_in * 1000,
  };
}
