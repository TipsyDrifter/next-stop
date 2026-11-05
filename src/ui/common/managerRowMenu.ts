/**
 * ManagerRow 的 ⋯ 項目怎麼排（己-2 A3，D-主-411）——拆出來是為了純函式測（ManagerRow.tsx 帶 CSS，node --test 載不了）。
 */
import type { PopMenuItem } from "./PopMenu";

/**
 * ⋯ 的項目（己-2 A3，D-主-411）：［更多設定…］＋呼叫端的一般動作＋［上移 Alt+↑］［下移 Alt+↓］＋呼叫端的收尾動作（封存、刪除…）。
 * 「收尾動作」＝呼叫端清單裡第一個帶 `cut` 或 `danger` 的項目起算（規範 §2.4：破壞性的放最後）；排序兩項插在它前面、自己帶一道撕線。
 * onUp／onDown 都不給＝這一列不排序（封存的、固定在最後的、清單只有一列）⇒ 不出排序兩項；只給一邊＝另一邊停用並說原因。
 */
export function rowMenu({
  menu,
  detail,
  onUp,
  onDown,
}: {
  menu: readonly PopMenuItem[];
  detail: PopMenuItem | null;
  onUp?: () => void;
  onDown?: () => void;
}): PopMenuItem[] {
  const cutAt = menu.findIndex((it) => it.cut || it.danger);
  const head = cutAt < 0 ? menu : menu.slice(0, cutAt);
  const tail = cutAt < 0 ? [] : menu.slice(cutAt);
  const before = [...(detail ? [detail] : []), ...head];
  const moves: PopMenuItem[] =
    onUp || onDown
      ? [
          { key: "ns-mgr-up", label: "上移", caps: "Alt+↑", cut: before.length > 0, disabled: !onUp, why: "已經在最上面", onSelect: () => onUp?.() },
          { key: "ns-mgr-down", label: "下移", caps: "Alt+↓", disabled: !onDown, why: "已經在最下面", onSelect: () => onDown?.() },
        ]
      : [];
  // 排序兩項後面接收尾動作：只帶 danger、沒帶撕線的那一項補一道，跟排序分開
  const rest = moves.length && tail.length && !tail[0].cut ? [{ ...tail[0], cut: true }, ...tail.slice(1)] : tail;
  return [...before, ...moves, ...rest];
}
