/**
 * 磨光⑦ 評審 #1（接縫 #102 的副作用）：今日清單會收「今天済過、同一天又被上層一起完成退役」的定期券（D-主-68）。
 * 那一列顯示的是今天那班的済，但 nodes.status 已是 done（退役）——點済章走一般的「取消完成」會把它整張解除退役、
 * 明天起又排班，而畫面上那一列還是済。這種列點済章只給一句說明、不寫資料；真的要讓它繼續排班，到側板取消完成。
 */
export const RETIRED_RUN_MSG = "這張定期券已經跟著上層一起完成了；要讓它繼續排班，請到側板取消完成";

/** 退役的定期券（有規則、status done）而且這一列帶著今天那班的結局 */
export function isRetiredRunRow(row: { repeat_rule: string | null; status: string; occurrence: unknown | null }): boolean {
  return row.repeat_rule !== null && row.status === "done" && row.occurrence !== null;
}
