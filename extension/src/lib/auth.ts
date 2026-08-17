// Lấy OAuth token cho Drive/Sheets — hai đường tuỳ trình duyệt:
//
//   1. Chrome thật : chrome.identity.getAuthToken (nhanh, không cần secret)
//   2. Fork Chromium (Cốc Cốc, Brave, Edge…): getAuthToken bị chặn
//      ("This API is not supported on Coc Coc browser" — ca thật 17.08)
//      → launchWebAuthFlow + authorization code flow, cần OAuth client loại
//      "Web application" (điền client id/secret trong Options).
//
// Token web flow lưu chrome.storage.local, tự refresh khi hết hạn.

import { loadConfig } from "./config";
import { StoredToken, buildAuthUrl, isExpired, parseCallback, toStoredToken } from "./webauth";

const TOKEN_KEY = "webauth_token";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

// ── Đường 1: Chrome thật ─────────────────────────────────────────

function tryGetAuthToken(interactive: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      chrome.identity.getAuthToken({ interactive }, (token) => {
        // lastError trên fork: "not supported" → null để rơi sang web flow
        resolve(chrome.runtime.lastError || !token ? null : (token as string));
      });
    } catch {
      resolve(null); // fork không có luôn hàm này
    }
  });
}

// ── Đường 2: web flow cho fork Chromium ──────────────────────────

async function storedToken(): Promise<StoredToken | null> {
  const data = await chrome.storage.local.get(TOKEN_KEY);
  return (data[TOKEN_KEY] as StoredToken) ?? null;
}

async function exchangeToken(body: Record<string, string>, previousRefresh?: string): Promise<StoredToken> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  if (!res.ok) throw new Error(`Đổi token thất bại ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const token = toStoredToken(await res.json(), Date.now(), previousRefresh);
  await chrome.storage.local.set({ [TOKEN_KEY]: token });
  return token;
}

async function webFlowLogin(clientId: string, clientSecret: string): Promise<StoredToken> {
  const state = crypto.randomUUID();
  const callback = await new Promise<string>((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: buildAuthUrl(clientId, chrome.runtime.id, state), interactive: true },
      (url) => {
        if (chrome.runtime.lastError || !url) {
          reject(new Error(chrome.runtime.lastError?.message ?? "Đăng nhập bị huỷ"));
        } else {
          resolve(url);
        }
      },
    );
  });
  const code = parseCallback(callback, state);
  if (!code) throw new Error("Callback OAuth không hợp lệ (state lệch hoặc thiếu code)");
  return exchangeToken({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: `https://${chrome.runtime.id}.chromiumapp.org/`,
    grant_type: "authorization_code",
  });
}

async function webFlowToken(): Promise<string> {
  const cfg = await loadConfig();
  if (!cfg.webClientId || !cfg.webClientSecret) {
    throw new Error(
      "Trình duyệt này không hỗ trợ đăng nhập Chrome — cần OAuth client Web: " +
        "điền Web client ID + secret trong Options của extension.",
    );
  }
  let token = await storedToken();
  if (token && !isExpired(token, Date.now())) return token.access_token;
  if (token?.refresh_token) {
    try {
      token = await exchangeToken(
        {
          refresh_token: token.refresh_token,
          client_id: cfg.webClientId,
          client_secret: cfg.webClientSecret,
          grant_type: "refresh_token",
        },
        token.refresh_token,
      );
      return token.access_token;
    } catch {
      // refresh token chết (revoke/đổi mật khẩu) → login lại
    }
  }
  token = await webFlowLogin(cfg.webClientId, cfg.webClientSecret);
  return token.access_token;
}

// ── API chung ────────────────────────────────────────────────────

export async function getToken(_interactive: boolean): Promise<string> {
  const native = await tryGetAuthToken(true);
  if (native) return native;
  return webFlowToken();
}

/** Token hết hạn/bị thu hồi giữa chừng → làm mới rồi thử lại đúng 1 lần. */
export async function withFreshToken<T>(fn: (token: string) => Promise<T>): Promise<T> {
  const token = await getToken(true);
  try {
    return await fn(token);
  } catch (e) {
    if (!(e instanceof Error) || !/401|invalid.credential/i.test(e.message)) throw e;
    await new Promise<void>((r) => {
      try {
        chrome.identity.removeCachedAuthToken({ token }, () => r());
      } catch {
        r();
      }
    });
    await chrome.storage.local.remove(TOKEN_KEY);
    const fresh = await getToken(true);
    return fn(fresh);
  }
}
