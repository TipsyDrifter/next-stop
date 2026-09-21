/**
 * 詳情側板的顯示格式小工具（UI Flow 2.1）：UTC ISO → 本地 MM/DD HH:mm；日期 key（YYYY-MM-DD）→ MM/DD。
 * 已知取捨：只做顯示用，不做解析；無效字串原樣回傳不拋錯。
 */
const pad = (n: number) => String(n).padStart(2, "0");

/** UTC ISO（completed_at／logged_at）→ 本地 "MM/DD HH:mm" */
export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 日期 key "YYYY-MM-DD"（scheduled_on／arrived_on）→ "MM/DD" */
export function fmtDateKey(key: string): string {
  const [, m, d] = key.split("-");
  return m && d ? `${m}/${d}` : key;
}
