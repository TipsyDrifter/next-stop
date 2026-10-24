/**
 * pickDay——手機 ⋯ sheet「改執行日」的分流（UI 丙-3 F5；E20 手機補記；契約 §1 F5、地圖 §3.2）。純函式，node test 直接載入
 * （scripts/tests/mobile-pick-day.test.ts）；不 import React、store、repository。
 *
 * 規則（兩殼同一條：磨光⑦ D-主-67「執行日改到今天以前＝補記」）：
 *   1. 已蓋済／運休 ⇒ 擋（SETTLED_DEFER_MSG）——守門沿用推遲那兩道，順序也一樣（先済、後定期券）
 *   2. 定期券      ⇒ 擋（REPEAT_RESCHEDULE_MSG；班次由規則排定，D-④-3）
 *   3. 跟現值同一天 ⇒ 不動（同桌機 DateChip「挑了跟目前值一樣的日子不叫 onPick」；誤點票挑回它自己那天不算補記）
 *   4. null        ⇒ 清除執行日（進收件匣；收據＋復原在呼叫端）
 *   5. 今天以前    ⇒ 補記：`updateNode(id, { scheduled_on }, { backfill: true })`（「已補記到 M/D」＋復原由 nodeStore 出）
 *   6. 今天以後    ⇒ 照舊推遲：`reschedule`＋收據；排回今天不出收據（票留在眼前，看得見＝不出收據）
 * 推遲小卡（DeferPopover）與 T／Shift+T 刻意不走這支：推遲≠補記（契約 §2）。
 */

export type PickDayPlan =
  | { kind: "blocked"; why: "settled" | "repeat" }
  | { kind: "noop" }
  | { kind: "clear" }
  | { kind: "backfill"; day: string }
  | { kind: "reschedule"; day: string; receipt: boolean };

export interface PickDayInput {
  /** 挑的日子（YYYY-MM-DD）；null＝清除執行日 */
  target: string | null;
  /** 日界線今天 */
  today: string;
  /** 票現在的執行日 */
  current: string | null;
  /** 已蓋済或運休 */
  settled: boolean;
  /** 定期券 */
  repeat: boolean;
}

export function planPickDay({ target, today, current, settled, repeat }: PickDayInput): PickDayPlan {
  if (settled) return { kind: "blocked", why: "settled" };
  if (repeat) return { kind: "blocked", why: "repeat" };
  if (target === current) return { kind: "noop" };
  if (target === null) return { kind: "clear" };
  if (target < today) return { kind: "backfill", day: target };
  return { kind: "reschedule", day: target, receipt: target !== today };
}
