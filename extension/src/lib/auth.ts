/** Lấy OAuth token của tài khoản Google đang đăng nhập Chrome (chrome.identity). */
export function getToken(interactive: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message ?? "Không lấy được token"));
      } else {
        resolve(token as string);
      }
    });
  });
}

/** Token hết hạn/bị thu hồi → xóa cache rồi xin lại tương tác. */
export async function withFreshToken<T>(fn: (token: string) => Promise<T>): Promise<T> {
  const token = await getToken(true);
  try {
    return await fn(token);
  } catch (e) {
    if (e instanceof Response || !(e instanceof Error) || !/401|invalid.credential/i.test(e.message)) throw e;
    await new Promise<void>((r) => chrome.identity.removeCachedAuthToken({ token }, () => r()));
    const fresh = await getToken(true);
    return fn(fresh);
  }
}
