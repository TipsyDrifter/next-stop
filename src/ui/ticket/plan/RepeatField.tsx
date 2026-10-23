/**
 * RepeatField——大票的「定期」列（連著一條還在的規則的帳）＋「設成定期…」鈕（③契約 §5.4、✎-4；乙席擁有）。
 * 掛點在 TicketPanel（乙席）：
 *   - `<FieldRow label="定期"><RepeatField entry={row} /></FieldRow>`（只在 useLinkedRepeat(row) 非 null 時掛）：
 *     span.t「每月 5 日 · 下一班 11/5」（原型席結論：分類已在上面的「分類」列，不用 repeatLabel 重複印）＋「管理定期 ›」。
 *     完整一句話（repeatLabel）放 title。
 *   - `<RepeatMakeButton entry={row} />`：大票底部「刪除」左邊的淡字鈕「設成定期…」（連著還在的規則、精算票、新票不出）。
 * 規則被刪掉（或 repeat_id 指到不存在的規則）的帳＝當成沒連：不出「定期」列、可以再按「設成定期…」（收尾修正；主 session 10-19 定）。
 */
import { useTicketStore } from "../../../store/ticketStore";
import type { EntryRow } from "../../../domain/ticket";
import { describeRule } from "../../../domain/repeat";
import { nextOnText, parseFixedRule, repeatLabel, type RepeatRow } from "../../../domain/ticketPlan";

/**
 * 這筆帳連著的規則：store.repeats（未刪的規則）裡找 repeat_id；沒有 repeat_id、或規則已刪／不存在 ⇒ null。
 * 桌機大票與手機表單共用（「定期」列 vs「設成定期…」都看它）。
 */
export function useLinkedRepeat(entry: Pick<EntryRow, "repeat_id"> | null | undefined): RepeatRow | null {
  const id = entry?.repeat_id ?? null;
  return useTicketStore((s) => (id ? (s.repeats.find((r) => r.id === id) ?? null) : null));
}

export function RepeatField({ entry }: { entry: EntryRow }) {
  const rule = useLinkedRepeat(entry);
  const accById = useTicketStore((s) => s.accById);
  const catById = useTicketStore((s) => s.catById);
  const curByCode = useTicketStore((s) => s.curByCode);
  const openDialog = useTicketStore((s) => s.openDialog);
  if (!rule) return null; // 規則已刪 ⇒ 不出這列（大票底部改出「設成定期…」）
  const fixed = parseFixedRule(rule.rule);
  const text = `${fixed ? describeRule(fixed) : "規則看不懂"} · ${nextOnText(rule)}`;
  return (
    <span className="ns-tk-repfield">
      <span className="t" title={repeatLabel(rule, { accById, catById, curByCode })}>
        {text}
      </span>
      <button type="button" className="ns-btn ns-btn--sm btn-text ns-tk-btn" onClick={() => openDialog({ kind: "repeats" })}>
        管理定期 ›
      </button>
    </span>
  );
}

/** 大票底部「設成定期…」（✎-4）：帶著這筆預填規則編輯器（store.makeRepeatFromEntry）。連著還在的規則才不出；規則已刪的可以再設一次 */
export function RepeatMakeButton({ entry }: { entry: EntryRow }) {
  const makeRepeatFromEntry = useTicketStore((s) => s.makeRepeatFromEntry);
  const rule = useLinkedRepeat(entry);
  if (rule || entry.kind === "adjust") return null;
  return (
    <button type="button" className="ns-btn btn-text ns-tk-btn ns-tk-mkrep" title="照這筆每個月記一次（可改頻率）" onClick={() => makeRepeatFromEntry(entry.id)}>
      設成定期…
    </button>
  );
}
