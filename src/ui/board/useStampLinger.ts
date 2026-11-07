/**
 * 篩選清單蓋済之後在原地停一下（⑫；兩殼共用，原型 stampTicket）：結果會把蓋好的那列濾掉，先照原位多畫一列給人看到章才離開。
 * `stamp` 就是検印那一下（boardActions.stampCard）；看板版面的卡是換欄，不用停。
 */
import { useMemo, useState } from "react";
import { stampCard } from "./boardActions";
import type { FilterRow, TaskRow } from "./useTaskFilter";

/** 蓋済後在原地停多久才離開清單（章的動畫 .4s） */
const LINGER_MS = 700;
const FRESH_MS = 800;

export function useStampLinger(rows: readonly FilterRow[], listLayout: boolean) {
  const [linger, setLinger] = useState<{ row: FilterRow; at: number } | null>(null);
  const [freshId, setFreshId] = useState<string | null>(null);

  const flash = (id: string) => {
    setFreshId(id);
    window.setTimeout(() => setFreshId((cur) => (cur === id ? null : cur)), FRESH_MS);
  };

  const shown = useMemo<readonly FilterRow[]>(() => {
    if (!linger || rows.some((r) => r.node.id === linger.row.node.id)) return rows;
    return [...rows.slice(0, linger.at), linger.row, ...rows.slice(linger.at)];
  }, [rows, linger]);

  const stamp = (n: TaskRow) => {
    const at = rows.findIndex((r) => r.node.id === n.id);
    const row = rows[at];
    void stampCard(n).then((stamped) => {
      if (!stamped) return;
      flash(n.id);
      if (row && listLayout) {
        // 列是蓋章前的快照：停著的這一下要畫成済
        setLinger({ row: { ...row, node: { ...row.node, status: "done" } }, at });
        window.setTimeout(() => setLinger((cur) => (cur?.row.node.id === n.id ? null : cur)), LINGER_MS);
      }
    });
  };

  return { shown, stamp, flash, freshId };
}
