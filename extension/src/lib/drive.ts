const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";

async function driveFetch(token: string, url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Drive API ${res.status}: ${body.slice(0, 300)}`);
  }
  return res;
}

export async function createFolder(token: string, name: string, parentId: string): Promise<string> {
  const res = await driveFetch(token, `${DRIVE}/files`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] }),
  });
  const json = (await res.json()) as { id: string };
  return json.id;
}

/** Upload nhỏ (thumb, meta.json) — multipart 1 request. */
export async function uploadSmall(
  token: string,
  parentId: string,
  name: string,
  mimeType: string,
  content: Blob,
): Promise<void> {
  const boundary = "duoyin-ingest-boundary";
  const metadata = JSON.stringify({ name, parents: [parentId] });
  const body = new Blob(
    [
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
      `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
      content,
      `\r\n--${boundary}--`,
    ],
    { type: `multipart/related; boundary=${boundary}` },
  );
  await driveFetch(token, `${UPLOAD}/files?uploadType=multipart&fields=id`, { method: "POST", body });
}

/** Upload lớn (video) — resumable: initiate rồi PUT toàn bộ. */
export async function uploadVideo(
  token: string,
  parentId: string,
  name: string,
  content: Blob,
): Promise<void> {
  const initRes = await driveFetch(token, `${UPLOAD}/files?uploadType=resumable&fields=id`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Upload-Content-Type": "video/mp4",
      "X-Upload-Content-Length": String(content.size),
    },
    body: JSON.stringify({ name, parents: [parentId] }),
  });
  const sessionUri = initRes.headers.get("Location");
  if (!sessionUri) throw new Error("Drive không trả về resumable session URI");
  const putRes = await fetch(sessionUri, {
    method: "PUT",
    headers: { "Content-Type": "video/mp4" },
    body: content,
  });
  if (!putRes.ok) throw new Error(`Upload video thất bại: ${putRes.status}`);
}

export function folderLink(folderId: string): string {
  return `https://drive.google.com/drive/folders/${folderId}`;
}
