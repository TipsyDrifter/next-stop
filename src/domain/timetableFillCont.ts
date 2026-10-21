/**
 * 時刻表・補記的連續補——純函式（磨光⑥ 契約 §1-4；D-時-145）。
 *
 * 補記面板按「補上」後：那段未記錄扣掉剛補的 [s, e]，還剩 ≥ 1 分 ⇒ 面板不關、換到剩下那段。
 * - 剛補那塊之後的第一段優先（照時間往下補）；之後沒有 ⇒ 取它之前最近的一段；都沒有 ⇒ null（補滿、照舊關面板）。
 * - 前面剩下的段（往後補時跳過的那截）帶在 `rest` 裡，往後補完了再回頭補它——同原型 `nextPiece(gapsIn(G))`，
 *   但只靠幾何、不等寫入（契約：fill 是非同步，先算幾何）。
 * - 段尾可以在 now 之後（那段一路到現在，面板的到着再夾到 now）；量長度時用 min(end, now)。
 * 只 import `./timetable.ts`；不讀時鐘。
 */
import { MIN } from "./timetable.ts";

/** 一段時間 [start, end)（ms） */
export interface FillPiece {
  start: number;
  end: number;
}

export interface FillCont {
  /** 下一段（面板換過去的那段）；null＝補滿了 */
  next: FillPiece | null;
  /** 其餘還沒補的段（照時間排；不含 next） */
  rest: FillPiece[];
}

/** [a.start, a.end) 扣掉 [cut.start, cut.end)，留下 ≥ 1 分的部分（長度量到 now 為止） */
function subtract(a: FillPiece, cut: FillPiece, now: number): FillPiece[] {
  const out: FillPiece[] = [];
  const len = (s: FillPiece): number => Math.min(s.end, now) - s.start;
  const head = { start: a.start, end: Math.min(a.end, cut.start) };
  const tail = { start: Math.max(a.start, cut.end), end: a.end };
  if (cut.end <= a.start || cut.start >= a.end) return len(a) >= MIN ? [a] : [];
  if (len(head) >= MIN) out.push(head);
  if (len(tail) >= MIN) out.push(tail);
  return out;
}

/**
 * piece＝面板正在補的那段（sheet 的 start／end，end 可以晚於 now）；filled＝剛補的那塊；rest＝之前跳過、還沒補的段。
 */
export function fillContinuation(piece: FillPiece, filled: FillPiece, rest: readonly FillPiece[], now: number): FillCont {
  const pieces = [piece, ...rest]
    .flatMap((p) => subtract(p, filled, now))
    .sort((a, b) => a.start - b.start);
  const after = pieces.find((p) => p.start >= filled.end);
  const before = pieces.filter((p) => p.end <= filled.start);
  const next = after ?? before[before.length - 1] ?? pieces[0] ?? null;
  return { next, rest: next ? pieces.filter((p) => p !== next) : [] };
}
