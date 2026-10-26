/**
 * 重複規則草稿的 React 那半——桌機側板 RepeatSection 與手機詳情頁 MobileRepeatSection 共用（手機殼班 D-主-82；純規則在 ./panelRules）。
 *
 * 資料流（M3 ④ WP3）：草稿 → buildRule → 去抖 400ms → `nodeStore.setRepeatRule`；被 repository 擋下（有子項／kind 不對）＝
 *   原句 toast、草稿還原成庫裡的樣子；清成不重複＝toast「已改回乘車券——過去的班次會保留」。規則不完整不送（panelRules 檔頭）。
 * `sent`＝最後一次我方送出的欄位值：props 進來的值跟它一樣＝自己寫回來的，不覆蓋草稿；別處改的（清了規則／引擎推了班次）才重置。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { serializeRule, type NodeRow, type RepeatRule } from "../../domain";
import { todayKey } from "../../lib/date";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { useDebouncedCommit } from "../common/fields";
import { buildRule, draftOf, type RepeatDraft } from "./panelRules";

export function useRepeatDraft(node: NodeRow): { draft: RepeatDraft; push(next: RepeatDraft): void } {
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const showToast = useUiStore((s) => s.showToast);
  const setRepeatRule = useNodeStore((s) => s.setRepeatRule);
  const [draft, setDraft] = useState<RepeatDraft>(() => draftOf(node, todayKey(dayStartHour)));
  const sent = useRef<string | null>(node.repeat_rule ?? null);
  const nodeRef = useRef(node);
  nodeRef.current = node;

  const commit = useCallback(
    (rule: RepeatRule | null) => {
      const payload = rule ? serializeRule(rule) : null;
      if (payload === sent.current) return;
      sent.current = payload;
      void setRepeatRule(nodeRef.current.id, rule).then((r) => {
        if (!r.ok) {
          const cur = nodeRef.current;
          sent.current = cur.repeat_rule ?? null;
          setDraft(draftOf(cur, todayKey(dayStartHour)));
          showToast({ message: r.reason ?? "無法設定重複" }, 4000);
          return;
        }
        if (rule === null) showToast({ message: "已改回乘車券——過去的班次會保留" });
      });
    },
    [setRepeatRule, showToast, dayStartHour],
  );
  const { schedule } = useDebouncedCommit<RepeatRule | null>(commit, 400);

  useEffect(() => {
    const incoming = node.repeat_rule ?? null;
    if (incoming === sent.current) return;
    sent.current = incoming;
    setDraft(draftOf(node, todayKey(dayStartHour)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.repeat_rule, node.id]);

  /** 改草稿＋（規則完整時才）排程寫回 */
  const push = (next: RepeatDraft) => {
    setDraft(next);
    if (next.mode === "none") {
      schedule(null);
      return;
    }
    const rule = buildRule(next);
    if (rule) schedule(rule);
  };

  return { draft, push };
}

/** 存活的直屬子項數（「有子項的列車不能設重複」的那把尺）：當前路線樹裡查得到就用樹，否則退回今日切片帶來的 child_total */
export function useLiveChildCount(id: string): number {
  const inTree = useNodeStore((s) => s.tree.byId[id] !== undefined);
  const treeKids = useNodeStore((s) => s.tree.childrenOf[id]?.length ?? 0);
  const todayKids = useNodeStore((s) => s.today.byId[id]?.child_total ?? 0);
  return inTree ? treeKids : todayKids;
}
