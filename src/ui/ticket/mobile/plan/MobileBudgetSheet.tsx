/**
 * MobileBudgetSheet——手機的預算 sheet 本體（③契約 §5.5、✎-3、✎-14；原型題二手機；丙席擁有）。宿主＝MobileSheetHost（標題「預算」）。
 *
 * div.ns-tk-mbe
 *   ├ .ns-tk-mbe-head   ‹ 2026 年 10 月 ›（只換「覆寫」格看的月；預設不變）＋小字「預設套用沒有覆寫的每個月」
 *   ├ .ns-tk-mbe-blk × N 一個對象一塊（總預算固定第一塊、之後照 budgetScopes 順序；加了還沒存的分類接在最後）
 *   │    塊頭：名稱＋（分類）「移除」；塊身 **兩格並排**（原型結論：一塊 114px，上下疊要 145px）：「預設」｜「10 月覆寫」（×）
 *   └ 「＋ 加分類預算」⇒ 疊一層 sheet：支出格子一層一層點進去（MobileCatDrill；每一層「選這一層」；未分類不列；封存的另一區）
 * UI 丙-5 E2／H4：底部「完成」拿掉（即時存的 sheet 只留下滑／暗幕／返回鍵，規範 §4）；「加分類預算」換共用 MSheet
 *   （疊在預算 sheet 上 ⇒ backKind "dialog"、z 47；返回層跟本檔那行同 id 合併，返回鍵一次關）。
 * 輸入：失焦或 Enter ⇒ setBudget（parseAmount：主幣別、不允許負與 0）；清空預設 ⇒ askConfirm 後 removeBudget(scope, null)（連同覆寫）；
 *   清空覆寫或按 × ⇒ removeBudget(scope, month)。沒聚焦時顯示千分位，聚焦時換成可直接改的數字。
 * UI 只讀 store、只叫 store 的動作（①§2.5-2）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTicketStore } from "../../../../store/ticketStore";
import { useUiStore } from "../../../../store/uiStore";
import { todayKey } from "../../../../lib/date";
import {
  MAIN_CURRENCY,
  UNCAT_EXPENSE_ID,
  addMonths,
  bareName,
  categoryArchivedUp,
  categoryLabel,
  categoryPath,
  monthOf,
  monthTitle,
  moneyText,
  type CategoryRow,
} from "../../../../domain/ticket";
import { amountInputText, budgetScopes, scopeKey, scopeOf, type BudgetRow, type BudgetScope } from "../../../../domain/ticketPlan";
import { useBackLayer } from "../../../mobile/backStack";
import { MSheet } from "../../../common/MSheet";
import { IconLeft, IconPlus, IconRight, useImeGuard } from "../mobileBits";
import { MobileCatDrill } from "../MobileCatDrill";

// onDone：宿主的介面照留（兩殼本體同一種 props）；丙-5 拿掉「完成」後本體不再自己關
export function MobileBudgetSheet(_props: { onDone(): void }) {
  const budgets = useTicketStore((s) => s.budgets);
  const catById = useTicketStore((s) => s.catById);
  const dec = useTicketStore((s) => s.curByCode[MAIN_CURRENCY]?.decimals ?? 2);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const [month, setMonth] = useState(() => monthOf(todayKey(dayStartHour)));
  const [pending, setPending] = useState<string[]>([]); // 加了、還沒填預設的分類
  const [focusCat, setFocusCat] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  // 磨光①（主線手機殼契約 §1.5）：「加分類預算」疊在預算 sheet（ticket.dialog）上，返回鍵＝它的「取消」。
  // 丙-5：kind "dialog" 跟 CategoryPick 的 MSheet backKind 一樣（同 id 合併；預算 sheet 本身可能已是 dialog，要壓得過它）
  useBackLayer("ticket.budget.pick", picking, () => setPicking(false), "dialog");

  const saved = useMemo(() => budgetScopes(budgets), [budgets]);
  const savedCats = useMemo(() => new Set(saved.filter((x) => x.kind === "category").map((x) => (x as { categoryId: string }).categoryId)), [saved]);
  // 存進去之後就從「還沒存」名單拿掉（它已經在 saved 裡了）
  useEffect(() => {
    if (pending.some((id) => savedCats.has(id))) setPending((p) => p.filter((id) => !savedCats.has(id)));
  }, [savedCats, pending]);

  const scopes: BudgetScope[] = [{ kind: "total" }];
  for (const x of saved) if (x.kind === "category") scopes.push(x);
  for (const id of pending) if (!savedCats.has(id)) scopes.push({ kind: "category", categoryId: id });

  const ovrName = `${Number(month.slice(5, 7))} 月單獨設定`;

  return (
    <div className="ns-tk-mbe">
      <div className="ns-tk-mbe-head">
        <button type="button" className="ns-tk-mnav" aria-label="上一個月" onClick={() => setMonth(addMonths(month, -1))}>
          <IconLeft />
        </button>
        <b aria-live="polite">{monthTitle(month)}</b>
        <button type="button" className="ns-tk-mnav" aria-label="下一個月" onClick={() => setMonth(addMonths(month, 1))}>
          <IconRight />
        </button>
      </div>
      <p className="ns-tk-mbe-hint">沒單獨設定的月份都照預設</p>

      {scopes.map((scope) => (
        <Block
          key={scopeKey(scope)}
          scope={scope}
          month={month}
          ovrName={ovrName}
          budgets={budgets}
          dec={dec}
          name={scope.kind === "total" ? "總預算" : catName(scope.categoryId, catById)}
          autoFocus={scope.kind === "category" && scope.categoryId === focusCat}
          onDropPending={(id) => setPending((p) => p.filter((x) => x !== id))}
        />
      ))}

      <button type="button" className="ns-btn btn-text ns-tk-mbtn ns-tk-mbe-add" aria-haspopup="dialog" onClick={() => setPicking(true)}>
        <IconPlus />
        加分類預算
      </button>

      {picking && (
        <CategoryPick
          taken={new Set([...savedCats, ...pending])}
          onPick={(id) => {
            setPending((p) => (p.indexOf(id) < 0 ? p.concat(id) : p));
            setFocusCat(id);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}

function catName(id: string, catById: Readonly<Record<string, CategoryRow>>): string {
  const c = catById[id];
  if (!c || c.deleted_at !== null) return "（分類已刪除）";
  return categoryLabel(c, catById) + (categoryArchivedUp(c, catById) ? "（已封存）" : "");
}

/* ───────── 一個對象一塊 ───────── */

function Block({
  scope,
  month,
  ovrName,
  budgets,
  dec,
  name,
  autoFocus,
  onDropPending,
}: {
  scope: BudgetScope;
  month: string;
  ovrName: string;
  budgets: readonly BudgetRow[];
  dec: number;
  name: string;
  autoFocus: boolean;
  onDropPending(categoryId: string): void;
}) {
  const setBudget = useTicketStore((s) => s.setBudget);
  const removeBudget = useTicketStore((s) => s.removeBudget);
  const askConfirm = useUiStore((s) => s.askConfirm);
  const key = scopeKey(scope);
  let def: BudgetRow | null = null;
  let ovr: BudgetRow | null = null;
  let any = false;
  for (const b of budgets) {
    if (b.deleted_at !== null || scopeKey(scopeOf(b)) !== key) continue;
    any = true;
    if (b.month === null) def = b;
    else if (b.month === month) ovr = b;
  }

  const confirmRemove = () =>
    askConfirm({
      title: "移除這個預算？",
      body: `${name}——連同各月單獨設定的金額`,
      confirmLabel: "移除",
      danger: true,
      onConfirm: () => void removeBudget(scope, null),
    });

  const commitDefault = async (text: string): Promise<boolean> => {
    if (text === "") {
      if (def) confirmRemove();
      return false; // 先回原值；按了「移除」這一列會自己消失
    }
    return setBudget(scope, null, text);
  };
  const commitOverride = async (text: string): Promise<boolean> => {
    if (text === "") {
      if (ovr) await removeBudget(scope, month);
      return true;
    }
    return setBudget(scope, month, text);
  };

  const parts = name.split(" › ");
  return (
    <div className={"ns-tk-mbe-blk" + (scope.kind === "total" ? " is-total" : "")}>
      <div className="ns-tk-mbe-bh">
        <span className="nm">
          {parts.length === 2 ? (
            <>
              {parts[0]}
              <span className="gt">›</span>
              {parts[1]}
            </>
          ) : (
            name
          )}
        </span>
        {scope.kind === "category" && (
          <button
            type="button"
            className="ns-btn ns-btn--sm btn-ghost ns-btn-danger ns-tk-mbtn"
            onClick={() => {
              if (any) confirmRemove();
              else onDropPending(scope.categoryId);
            }}
          >
            移除
          </button>
        )}
      </div>
      <div className="ns-tk-mbe-fs">
        <AmountField
          label="預設"
          aria={`${name}的預設預算`}
          value={def ? def.amount_minor : null}
          dec={dec}
          placeholder="未設"
          autoFocus={autoFocus}
          onCommit={commitDefault}
        />
        <AmountField
          key={month /* 換月＝換一格（不讓上個月的字留一幀） */}
          label={ovrName}
          aria={`${name}的${ovrName}`}
          value={ovr ? ovr.amount_minor : null}
          dec={dec}
          placeholder={def ? "同預設" : "未設"}
          onCommit={commitOverride}
          onClear={ovr ? () => void removeBudget(scope, month) : undefined}
        />
      </div>
    </div>
  );
}

/** 金額格：沒聚焦顯示千分位、聚焦換成純數字；失焦或 Enter 交出去（回 false ⇒ 退回原值） */
function AmountField({
  label,
  aria,
  value,
  dec,
  placeholder,
  autoFocus,
  onCommit,
  onClear,
}: {
  label: string;
  aria: string;
  value: number | null;
  dec: number;
  placeholder: string;
  autoFocus?: boolean;
  onCommit(text: string): Promise<boolean>;
  onClear?(): void;
}) {
  const shown = value === null ? "" : moneyText(value, dec);
  const raw = value === null ? "" : amountInputText(value, dec);
  const [text, setText] = useState(shown);
  const focused = useRef(false);
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!focused.current) setText(shown);
  }, [shown]);
  useEffect(() => {
    if (!autoFocus) return;
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: "nearest" });
  }, [autoFocus]);

  const commit = async () => {
    focused.current = false;
    const t = text.replace(/,/g, "").trim();
    if (t === raw) {
      setText(shown);
      return;
    }
    const ok = await onCommit(t);
    if (!ok) setText(shown);
  };
  const ime = useImeGuard((e) => {
    e.preventDefault();
    (e.target as HTMLInputElement).blur(); // 交給 onBlur，只交一次
  });

  return (
    <label className="ns-tk-mbe-f">
      <span className="lbl">{label}</span>
      <span className="in">
        <input
          ref={ref}
          inputMode="decimal"
          autoComplete="off"
          enterKeyHint="done"
          value={text}
          placeholder={placeholder}
          aria-label={aria}
          className={onClear ? "has-clr" : undefined}
          onFocus={() => {
            focused.current = true;
            setText(raw);
          }}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => void commit()}
          {...ime}
        />
        {onClear && (
          <button
            type="button"
            className="clr"
            aria-label="改回預設金額"
            onPointerDown={(e) => e.preventDefault() /* 別讓輸入框先失焦送出一次 */}
            onClick={() => {
              setText("");
              onClear();
            }}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        )}
      </span>
    </label>
  );
}

/* ───────── 加分類預算：支出格子一層一層點進去（疊在預算 sheet 上） ───────── */

function CategoryPick({ taken, onPick, onClose }: { taken: ReadonlySet<string>; onPick(id: string): void; onClose(): void }) {
  const categories = useTicketStore((s) => s.categories);
  const catById = useTicketStore((s) => s.catById);
  const [level, setLevel] = useState<string | null>(null);
  // 封存的（✎-14：含封存，列在「封存」區）：自己封存的那一個（底下跟著封存的不另列——設在上層就含它們），平鋪；小字＝上層路徑
  const archived = useMemo(
    () =>
      categories.filter((c) => {
        if (c.kind !== "expense" || c.deleted_at !== null || c.archived_at === null || c.id === UNCAT_EXPENSE_ID) return false;
        const path = categoryPath(c, catById);
        return !path.slice(0, -1).some((x) => x.archived_at !== null);
      }),
    [categories, catById],
  );

  const cell = (c: CategoryRow) => {
    const done = taken.has(c.id);
    const path = categoryPath(c, catById);
    const sub = path.length > 1 ? path.slice(0, -1).map((x) => bareName(x.name) || x.name).join(" › ") : undefined;
    return (
      <button key={c.id} type="button" className={"ns-tk-mcell" + (done ? " is-taken" : "")} disabled={done} onClick={() => onPick(c.id)}>
        <span>
          {c.name}
          {done ? <small>已設</small> : sub ? <small>{sub}</small> : null}
        </span>
      </button>
    );
  };

  return (
    <MSheet
      title="加分類預算"
      backId="ticket.budget.pick"
      backKind="dialog"
      onClose={onClose}
      className="ns-tk-msh ns-tk-mbe-picksheet"
      // 點一格就收＝沒有主鈕；「取消」在殼的黏底列（同 MobileDatePicker 新殼）
      foot={
        <button type="button" className="ns-btn btn-ghost" onClick={onClose}>
          取消
        </button>
      }
    >
      <p className="ns-tk-mbe-pickhint">分類的預算會包含底下的分類</p>
      <div className="ns-tk-mf-cats ns-tk-mbe-pick">
        {/* 售票口④ 第二輪（D-票-78）：有下一層的點了走進去，每一層都能「選這一層」 */}
        <MobileCatDrill
          kind="expense"
          level={level}
          onLevel={setLevel}
          picked={[]}
          taken={taken}
          hideUncat
          onPick={(c) => onPick(c.id)}
          rootLabel="支出"
          backId="ticket.budget.pick.cat"
          backKind="dialog"
        />
      </div>
      {archived.length > 0 && (
        <>
          <p className="ns-tk-mf-lbl">封存</p>
          <div className="ns-tk-mf-cats ns-tk-mbe-pick">
            <div className="ns-tk-mgrid">{archived.map(cell)}</div>
          </div>
        </>
      )}
    </MSheet>
  );
}
