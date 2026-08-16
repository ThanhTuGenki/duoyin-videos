/** Số kiểu Douyin: "1.2万" / "3.4w" / "5k" / "3456" → int */
export function parseCount(raw: string): number {
  const m = raw.trim().match(/^([\d.]+)\s*(万|w|W|k|K)?$/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = m[2];
  if (unit === "万" || unit === "w" || unit === "W") return Math.round(n * 10_000);
  if (unit === "k" || unit === "K") return Math.round(n * 1_000);
  return Math.round(n);
}
