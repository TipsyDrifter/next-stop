/**
 * taskState——任務側元件共用的小判斷（車次② 契約 §5.1、§5.6、§5.8；丙）。
 *
 * - `isTaskSettled`：這張票「已經交代了沒」（〈原型拍板〉2：已蓋済／運休的不出発車）。今日頁的判法
 *   （`useTodayController.ts` 的 `isSettledRow`：`occurrence !== null || status === "done"`）的同義副本——
 *   契約 0-10：時刻表自己寫一份，不 import today 的檔。今日切片沒有這張 ⇒ 看路線樹／日曆切片的節點：
 *   定期券＝`currentOccurrences[id]` 有結局（済或運休）、其餘＝`status === "done"`。三處都找不到 ⇒ 當作沒交代
 *   （讓它照常顯示「発車」，真的不能發由 store 的 `departFromTask` 擋）。
 * - `TODAY_DEPART_HOTKEY`：今日鍵 n 的 id（段二由整合席登記進 manifest；之前 `hotkeyById` 查不到 ⇒ 不畫鍵帽）。
 * - `fmtTaskDur`：時間列的時長字（0＝「—」，其餘＝`fmtDur`）。
 */
import { parseRule } from "../../../domain";
import { fmtDur } from "../../../domain/timetable";
import type { useNodeStore } from "../../../store/nodeStore";

type NodeState = ReturnType<typeof useNodeStore.getState>;

export const TODAY_DEPART_HOTKEY = "timetable.today.depart";

export function isTaskSettled(ns: NodeState, nodeId: string): boolean {
  const row = ns.today.byId[nodeId];
  if (row) return row.occurrence !== null || row.status === "done";
  const node = ns.tree.byId[nodeId] ?? ns.calendar.nodes[nodeId];
  if (!node) return false;
  if (parseRule(node.repeat_rule)) return ns.currentOccurrences[nodeId] !== undefined;
  return node.status === "done";
}

/** 時間列的時長：取整後是 0 分 ⇒「—」；其餘 `45m`／`2h`／`1h20m`（＝fmtDur，分鐘四捨五入） */
export function fmtTaskDur(ms: number): string {
  const s = fmtDur(ms);
  return s === "0m" ? "—" : s;
}
