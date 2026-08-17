// Content script (isolated world) — gắn nút ＋Q lên mọi card video Douyin.
//
// pagehook.ts (MAIN world) đã đánh dấu từng card bằng data-dyq="<awemeId>" và
// giữ metadata (title, author, tags, stats, cover, URL mp4 nét nhất). Ở đây chỉ
// việc vẽ nút, hỏi metadata theo id rồi chuyển cho background.
//
// Nhờ có sẵn URL mp4 trong React props, KHÔNG cần phát video trước khi bấm.

import type { CapturedPage } from "./lib/contract";
import type { IngestRequest, ProgressEvent } from "./lib/messages";

const ATTR = "data-dyq";
const BTN = "duoyin-ingest-btn";

interface Meta {
  id: string;
  title: string;
  author: string;
  tags: string[];
  likes: number;
  comments: number;
  shares: number;
  durationSeconds: number;
  cover: string;
  videoUrl: string;
}

// ── Hỏi metadata từ MAIN world ───────────────────────────────────

function askMeta(id: string): Promise<Meta | null> {
  return new Promise((resolve) => {
    const done = (value: Meta | null) => {
      window.removeEventListener("message", onMessage);
      clearTimeout(timeout);
      resolve(value);
    };
    const onMessage = (e: MessageEvent) => {
      if (e.source === window && e.data?.type === "dyq-meta" && e.data.id === id) done(e.data.meta ?? null);
    };
    window.addEventListener("message", onMessage);
    const timeout = setTimeout(() => done(null), 4000);
    window.postMessage({ type: "dyq-get", id }, "*");
  });
}

function toPage(meta: Meta): CapturedPage {
  return {
    rawId: `dy-${meta.id}`,
    title: meta.title,
    author: meta.author,
    sourceUrl: `https://www.douyin.com/video/${meta.id}`,
    description: meta.title,
    tags: meta.tags,
    stats: { likes: meta.likes, comments: meta.comments, shares: meta.shares },
    durationSeconds: meta.durationSeconds,
    videoUrl: meta.videoUrl,
    thumbUrl: meta.cover,
  };
}

// ── Nút ＋Q ──────────────────────────────────────────────────────

type State = "idle" | "busy" | "ok" | "err";
const stateById = new Map<string, { state: State; tip: string }>();

function paint(btn: HTMLButtonElement, state: State, tip: string): void {
  btn.textContent = { idle: "＋Q", busy: "⏳", ok: "✓", err: "✗" }[state];
  btn.title = tip;
  btn.style.background = state === "err" ? "#c0392b" : state === "ok" ? "#0E7D6B" : "#D92B57";
  btn.disabled = state === "busy";
  btn.style.cursor = state === "busy" ? "default" : "pointer";
}

function refresh(btn: HTMLButtonElement, id: string): void {
  const s = stateById.get(id);
  paint(btn, s?.state ?? "idle", s?.tip ?? "Gửi video này vào queue");
}

async function ingest(id: string, btn: HTMLButtonElement): Promise<void> {
  if (stateById.get(id)?.state === "busy") return;
  stateById.set(id, { state: "busy", tip: "Đang gửi…" });
  refresh(btn, id);
  try {
    const meta = await askMeta(id);
    if (!meta) throw new Error("Không lấy được metadata của video này");
    if (!meta.videoUrl) throw new Error("Card này chưa có URL video — cuộn qua nó một lần rồi thử lại");
    const res = (await chrome.runtime.sendMessage({ kind: "ingest", page: toPage(meta) } as IngestRequest)) as {
      ok: boolean;
      error?: string;
    };
    if (!res?.ok) throw new Error(res?.error ?? "Ingest thất bại");
    stateById.set(id, { state: "ok", tip: "Đã vào queue" });
  } catch (e) {
    stateById.set(id, { state: "err", tip: e instanceof Error ? e.message : String(e) });
  }
  refresh(btn, id);
}

function decorate(): void {
  for (const card of Array.from(document.querySelectorAll<HTMLElement>(`[${ATTR}]`))) {
    const id = card.getAttribute(ATTR);
    if (!id) continue;

    let btn = card.querySelector<HTMLButtonElement>(`:scope > .${BTN}`);
    if (!btn) {
      btn = document.createElement("button");
      btn.className = BTN;
      Object.assign(btn.style, {
        position: "absolute", top: "8px", left: "8px", zIndex: "2147483647",
        width: "38px", height: "26px", padding: "0",
        border: "none", borderRadius: "13px", color: "#fff",
        fontSize: "12px", fontWeight: "700", lineHeight: "26px",
        fontFamily: "system-ui, sans-serif", boxShadow: "0 1px 6px rgba(0,0,0,.35)",
        opacity: "0.92",
      } satisfies Partial<CSSStyleDeclaration>);
      if (getComputedStyle(card).position === "static") card.style.position = "relative";
      card.appendChild(btn);
      const button = btn;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        const current = card.getAttribute(ATTR);
        if (current) void ingest(current, button);
      });
    }
    refresh(btn, id);
  }
}

document.documentElement.setAttribute("data-dyq-cs", "1"); // dấu hiệu để chẩn đoán
decorate();
let timer = 0;
new MutationObserver(() => {
  clearTimeout(timer);
  timer = window.setTimeout(decorate, 300);
}).observe(document.documentElement, { childList: true, subtree: true });

// Tiến độ từ background: cập nhật nút của đúng video đang xử lý
chrome.runtime.onMessage.addListener((msg: ProgressEvent & { awemeId?: string }) => {
  if (msg.kind !== "progress") return;
  const busyId = [...stateById.entries()].find(([, v]) => v.state === "busy")?.[0];
  if (!busyId) return;
  if (msg.error) stateById.set(busyId, { state: "err", tip: msg.error });
  else if (msg.done) stateById.set(busyId, { state: "ok", tip: msg.step });
  else stateById.set(busyId, { state: "busy", tip: msg.step });
  const card = document.querySelector<HTMLElement>(`[${ATTR}="${busyId}"]`);
  const btn = card?.querySelector<HTMLButtonElement>(`.${BTN}`);
  if (btn) refresh(btn, busyId);
});
