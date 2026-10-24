/**
 * BudgetEditor——預算對話框的本體（③契約 §5.2、✎-3；乙席擁有）。宿主＝DesktopDialogHost（寬 460、標題「預算」）。
 * props `{ onDone(): void }`（同①的對話框本體）。長相照原型席結論（app.js budgetEditor；樣式 ticket.css §M）：
 *
 *   div.ns-tk-dialog.ns-tk-be
 *   ├─ .ns-tk-be-head      ‹ 2026 年 10 月 ›（只換「覆寫」欄看的月；預設不變）・小字「預設套用沒有覆寫的每個月」
 *   ├─ table.ns-tk-be-table   對象｜預設｜10 月覆寫｜（移除）
 *   │    tr.is-total 總預算（固定第一列，沒設也在）；之後每個分類預算一列（budgetScopes 的順序）
 *   │    tr.is-add「＋ 加分類預算」⇒ 分類挑選（支出兩層樹、未分類不列、封存分區、已設的灰掉）
 *   └─ .ns-tk-dhint        金額是主幣別…清空「預設」＝移除
 *   （UI 丙-5 E2：「關閉」鈕拿掉——即時存、不改東西的對話框只留 ×／暗幕／Esc，視覺規範 §4；onDone 留作宿主介面）
 *
 * 輸入欄失焦或 Enter ⇒ setBudget；清空預設 ⇒ askConfirm 後 removeBudget(scope, null)（連同覆寫）；清空覆寫或按 × ⇒ removeBudget(scope, month)。
 * 挑選分類的浮層**不浮**：開在表格下方、照文流撐高對話框（.ns-dialog-body 是內捲容器，絕對定位的浮層開在底部會被裁、撐出捲軸——原型席留的題）。
 * 剛加、還沒填金額的分類只活在本元件（pending），關掉對話框就不見——不寫空的預算列。
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTicketStore } from "../../../store/ticketStore";
import { useUiStore } from "../../../store/uiStore";
import {
  MAIN_CURRENCY,
  UNCAT_EXPENSE_ID,
  UNCAT_INCOME_ID,
  addMonths,
  categoryLabel,
  categoryTree,
  moneyText,
  type CategoryRow,
} from "../../../domain/ticket";
import { budgetScopes, scopeKey, type BudgetRow, type BudgetScope } from "../../../domain/ticketPlan";
import { useImeGuard } from "../dialogs/dialogBits";
import { TkIcon } from "../TicketLedger";
import { useOutside } from "../TicketPanel";

const TOTAL: BudgetScope = { kind: "total" };
const isUncat = (id: string): boolean => id === UNCAT_EXPENSE_ID || id === UNCAT_INCOME_ID;
const monthTitle = (m: string): string => `${m.slice(0, 4)} 年 ${parseInt(m.slice(5, 7), 10)} 月`;

function rowOf(budgets: readonly BudgetRow[], scope: BudgetScope, month: string | null): BudgetRow | null {
  const k = scopeKey(scope);
  for (const b of budgets) {
    if (b.deleted_at !== null || b.month !== month) continue;
    if ((b.kind === "category" && b.category_id ? `cat:${b.category_id}` : "total") === k) return b;
  }
  return null;
}

export function BudgetEditor(_props: { onDone(): void }) {
  const budgets = useTicketStore((s) => s.budgets);
  const categories = useTicketStore((s) => s.categories);
  const catById = useTicketStore((s) => s.catById);
  const [month, setMonth] = useState(() => {
    const s = useTicketStore.getState();
    return s.span === "month" && s.period.key.length === 7 ? s.period.key : s.month;
  });
  const [pending, setPending] = useState<string[]>([]); // 剛加、還沒填的分類 id
  const [picking, setPicking] = useState(false);
  const [focusKey, setFocusKey] = useState<string | null>(null);

  const saved = budgetScopes(budgets).filter((s) => s.kind === "category");
  const savedKeys = new Set(saved.map(scopeKey));
  const scopes: BudgetScope[] = [TOTAL, ...saved];
  for (const id of pending) if (!savedKeys.has(`cat:${id}`)) scopes.push({ kind: "category", categoryId: id });
  const used = new Set(scopes.filter((s) => s.kind === "category").map((s) => (s.kind === "category" ? s.categoryId : "")));

  const add = (id: string) => {
    setPicking(false);
    if (!used.has(id)) setPending((p) => p.concat(id));
    setFocusKey(`cat:${id}`);
  };

  return (
    <div className="ns-tk-dialog ns-tk-be">
      <div className="ns-tk-be-head">
        <button type="button" className="ns-tk-mnav" aria-label="上個月" onClick={() => setMonth(addMonths(month, -1))}>
          <TkIcon name="left" size={13} />
        </button>
        <b className="m" aria-live="polite">
          {monthTitle(month)}
        </b>
        <button type="button" className="ns-tk-mnav" aria-label="下個月" onClick={() => setMonth(addMonths(month, 1))}>
          <TkIcon name="right" size={13} />
        </button>
        <small>沒單獨設定的月份都照預設</small>
      </div>
      <table className="ns-tk-be-table">
        <colgroup>
          <col />
          <col className="c-def" />
          <col className="c-ovr" />
          <col className="c-act" />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">對象</th>
            <th scope="col">預設</th>
            <th scope="col">{parseInt(month.slice(5, 7), 10)}月單獨設定</th>
            <th scope="col" aria-label="動作" />
          </tr>
        </thead>
        <tbody>
          {scopes.map((scope) => {
            const k = scopeKey(scope);
            const isPending = scope.kind === "category" && !savedKeys.has(k);
            return (
              <BudgetLineRow
                key={k}
                scope={scope}
                month={month}
                def={rowOf(budgets, scope, null)}
                ovr={rowOf(budgets, scope, month)}
                label={scope.kind === "total" ? "總預算" : categoryLabel(catById[scope.categoryId] ?? null, catById)}
                autoFocus={focusKey === k}
                onDropPending={isPending ? () => setPending((p) => p.filter((id) => scope.kind === "category" && id !== scope.categoryId)) : null}
              />
            );
          })}
          <tr className="is-add">
            <td colSpan={4}>
              <button type="button" className="ns-btn ns-btn--sm btn-text ns-tk-btn" aria-expanded={picking} data-pop-toggle onClick={() => setPicking(!picking)}>
                <TkIcon name="plus" size={11} />
                加分類預算
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      {picking && <CatPicker categories={categories} used={used} onPick={add} onClose={() => setPicking(false)} />}
      <p className="ns-tk-dhint">以主幣別（{MAIN_CURRENCY}）計。清空「預設」會移除整個預算；單月留空則照預設金額。</p>
    </div>
  );
}

/* ── 一列：名稱・預設・覆寫（×）・移除 ── */
function BudgetLineRow(props: {
  scope: BudgetScope;
  month: string;
  def: BudgetRow | null;
  ovr: BudgetRow | null;
  label: string;
  autoFocus: boolean;
  onDropPending: (() => void) | null;
}) {
  const { scope, month, def, ovr, label } = props;
  const dec = useTicketStore((s) => s.curByCode[MAIN_CURRENCY]?.decimals ?? 2);
  const store = useTicketStore.getState;
  const isTotal = scope.kind === "total";
  const confirmRemove = () =>
    useUiStore.getState().askConfirm({
      title: "移除這個預算？",
      body: `「${label}」的預設和各月單獨設定的金額會一起移除。`,
      confirmLabel: "移除",
      danger: true,
      onConfirm: () => void store().removeBudget(scope, null),
    });

  const commitDef = async (text: string): Promise<boolean> => {
    if (text.trim() === "") {
      if (def) confirmRemove();
      return false; // 還原成目前的值（確認後那列會整個消失）
    }
    const ok = await store().setBudget(scope, null, text);
    // 剛加的分類存成功 ⇒ 從 pending 拿掉（之後由 store 的預算列帶；移除時整列才會消失）
    if (ok && props.onDropPending) props.onDropPending();
    return ok;
  };
  const commitOvr = async (text: string): Promise<boolean> => {
    if (text.trim() === "") {
      if (ovr) await store().removeBudget(scope, month);
      return true;
    }
    const ok = await store().setBudget(scope, month, text);
    if (ok && props.onDropPending) props.onDropPending();
    return ok;
  };

  return (
    <tr className={isTotal ? "is-total" : props.onDropPending ? "is-pending" : undefined}>
      <th scope="row">
        <span className="nm" title={label}>
          {label}
        </span>
      </th>
      <td>
        <AmountInput
          value={def ? def.amount_minor : null}
          dec={dec}
          placeholder="—"
          label={`${label} 的預設預算`}
          autoFocus={props.autoFocus}
          onCommit={commitDef}
        />
      </td>
      <td>
        <span className="ovrcell">
          <AmountInput
            key={month /* 換月＝換一格 */}
            value={ovr ? ovr.amount_minor : null}
            dec={dec}
            placeholder={def ? "同預設" : "—"}
            label={`${label} 在 ${parseInt(month.slice(5, 7), 10)} 月單獨設定的預算`}
            autoFocus={false}
            onCommit={commitOvr}
          />
          {ovr && (
            <button type="button" className="clr" aria-label="改回預設金額" title="改回預設金額" onClick={() => void store().removeBudget(scope, month)}>
              <TkIcon name="x" size={10} />
            </button>
          )}
        </span>
      </td>
      <td>
        {!isTotal && (
          <button
            type="button"
            className="ns-btn ns-btn--sm btn-ghost ns-btn-danger ns-tk-dmini"
            onClick={() => {
              if (props.onDropPending && !def && !ovr) props.onDropPending();
              else confirmRemove();
            }}
          >
            移除
          </button>
        )}
      </td>
    </tr>
  );
}

/* ── 金額格：本地文字、失焦／Enter 送；失敗（或被改回）⇒ 回到目前的值 ── */
function AmountInput(props: {
  value: number | null;
  dec: number;
  placeholder: string;
  label: string;
  autoFocus: boolean;
  onCommit(text: string): Promise<boolean>;
}) {
  const shown = props.value === null ? "" : moneyText(props.value, props.dec);
  const [text, setText] = useState(shown);
  const [seen, setSeen] = useState(shown);
  if (seen !== shown) {
    setSeen(shown);
    setText(shown);
  }
  const busy = useRef(false);
  const commit = async () => {
    const norm = (t: string) => t.replace(/[,，\s]/g, "");
    if (busy.current || norm(text) === norm(shown)) {
      setText(shown); // 「15000」→ 顯示回「15,000」
      return;
    }
    busy.current = true;
    try {
      const ok = await props.onCommit(text);
      if (!ok) setText(shown);
    } finally {
      busy.current = false;
    }
  };
  const ime = useImeGuard((e) => {
    e.preventDefault();
    (e.currentTarget as HTMLInputElement).blur();
  });
  return (
    <input
      className="techo-input ns-tk-din is-num"
      inputMode="decimal"
      autoComplete="off"
      enterKeyHint="done"
      aria-label={props.label}
      placeholder={props.placeholder}
      autoFocus={props.autoFocus}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => void commit()}
      {...ime}
    />
  );
}

/* ── 分類挑選（照文流開在表格下；↑↓ 移動、Esc 收起、點外面收起） ── */
function CatPicker({ categories, used, onPick, onClose }: { categories: CategoryRow[]; used: Set<string>; onPick(id: string): void; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useOutside(ref, onClose);
  useEffect(() => {
    const el = ref.current;
    el?.querySelector<HTMLElement>(".opt:not([disabled])")?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: "nearest" });
  }, []);
  const tree = categoryTree(categories, "expense", { includeArchived: false }).filter((t) => !isUncat(t.parent.id));
  const archived = categories.filter((c) => c.kind === "expense" && c.deleted_at === null && c.archived_at !== null && !isUncat(c.id));
  const opt = (c: CategoryRow, sub: boolean) => {
    const on = used.has(c.id);
    return (
      <button key={c.id} type="button" role="option" aria-selected={false} className={`opt${sub ? " is-sub" : ""}`} disabled={on} onClick={() => onPick(c.id)}>
        {c.name}
        {on && <span className="r">已設</span>}
      </button>
    );
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const opts = Array.from(ref.current?.querySelectorAll<HTMLElement>(".opt:not([disabled])") ?? []);
    const i = opts.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      if (!opts.length) return;
      const n = opts.length;
      opts[i < 0 ? 0 : (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n].focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };
  return (
    <div ref={ref} className="ns-tk-pop ns-tk-be-pop" role="listbox" aria-label="選一個支出分類" onKeyDown={onKeyDown}>
      <div className="hd">支出</div>
      {tree.map((t) => [opt(t.parent, false), ...t.children.map((c) => opt(c, true))])}
      {tree.length === 0 && <p className="ns-tk-pop-note">還沒有支出分類</p>}
      {archived.length > 0 && (
        <>
          <div className="hd">封存</div>
          {archived.map((c) => opt(c, !!c.parent_id))}
        </>
      )}
    </div>
  );
}
