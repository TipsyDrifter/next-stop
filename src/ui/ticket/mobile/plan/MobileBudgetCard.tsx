/**
 * MobileBudgetCard——手機統計（月模式）的預算卡（③契約 §5.5、✎-1／✎-2／✎-10／✎-11；原型 `prototypes/售票口-③.html` 題一手機；丙席擁有）。
 *
 * 位置：「月｜年」那一列**下面**、趨勢卡上面（原型結論：放最上面時切「年」卡片消失、月｜年鈕會跳位 200 多 px）。
 * section.ns-tk-mst-card.ns-tk-mbud
 *   ├ .ns-tk-mbud-h   h2「預算」・small「10 月 · 已過 19/31 天」・右端「設定」（openDialog budgets；觸控 44 高）
 *   ├ 篩了帳戶 ⇒ 一行 .ns-tk-mbud-note「預算看全部帳戶」（✎-11）
 *   ├ 沒有預算 ⇒ .ns-tk-mbud-empty「還沒有預算」＋「設定預算…」
 *   └ ul.ns-tk-mbud-rows  一條兩行（grid "n v" / "b r"、列高 ≥ 56）：名稱｜已用／預算（compactMoney）；條｜剩 N／超支 N
 *        分類列是 button ⇒ drillToList（本月・該分類・支出）；總預算列、分類已不在的列是 div（不可點）
 * 條（原型 barHtml）：沒超支＝填色 share；超支＝條代表「已用」、填滿，斜紋段＝超出的比例（至少 6%），左緣實線＝預算到這裡；
 *   按日進度線落在 pace × 預算 ÷ 尺度（超支時尺度＝已用）；pace 0 或 1（未來／過去的月）不畫。
 * 資料全來自 store.budgetLines（純函式 budgetLines，與三數卡同一支口徑）；年模式整張不畫（宿主也只在月模式掛）。
 */
import { useTicketStore, TK_TEXT } from "../../../../store/ticketStore";
import { useUiStore } from "../../../../store/uiStore";
import { todayKey } from "../../../../lib/date";
import { MAIN_CURRENCY, monthOf } from "../../../../domain/ticket";
import { compactMoney } from "../../../../domain/ticketView";
import type { BudgetLine } from "../../../../domain/ticketPlan";

export function MobileBudgetCard() {
  const lines = useTicketStore((s) => s.budgetLines);
  const span = useTicketStore((s) => s.span);
  const period = useTicketStore((s) => s.period);
  const filtered = useTicketStore((s) => s.filterAccountId !== null);
  const dec = useTicketStore((s) => s.curByCode[MAIN_CURRENCY]?.decimals ?? 2);
  const openDialog = useTicketStore((s) => s.openDialog);
  const drillToList = useTicketStore((s) => s.drillToList);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  if (span !== "month") return null;

  const month = period.key;
  const today = todayKey(dayStartHour);
  const open = () => openDialog({ kind: "budgets" });

  const head = (
    <div className="ns-tk-mbud-h">
      <h2>預算</h2>
      {!filtered && lines && lines.length > 0 && <small>{subText(month, today)}</small>}
      <button type="button" className="ns-tk-mbud-set" onClick={open} aria-haspopup="dialog">
        設定
      </button>
    </div>
  );

  if (filtered) {
    return (
      <section className="ns-tk-mst-card ns-tk-mbud" aria-label="預算">
        {head}
        <p className="ns-tk-mbud-note">{TK_TEXT.budgetAllAccounts}</p>
      </section>
    );
  }
  if (!lines || lines.length === 0) {
    return (
      <section className="ns-tk-mst-card ns-tk-mbud" aria-label="預算">
        {head}
        <div className="ns-tk-mbud-empty">
          <p>還沒有預算</p>
          <button type="button" className="ns-tk-mbtn" onClick={open}>
            設定預算…
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="ns-tk-mst-card ns-tk-mbud" aria-label="預算">
      {head}
      <ul className="ns-tk-mbud-rows">
        {lines.map((l) => {
          const cls =
            "ns-tk-mbud-row" +
            (l.scope.kind === "total" ? " is-total" : "") +
            (l.over ? " is-over" : "") +
            (l.archived ? " is-archived" : "") +
            (l.gone ? " is-gone" : "");
          const inner = <RowInner l={l} dec={dec} />;
          const scope = l.scope;
          return (
            <li key={l.key} className={cls}>
              {scope.kind === "category" && !l.gone ? (
                <button
                  type="button"
                  aria-label={ariaOf(l, dec) + "；到清單看這個月的支出"}
                  onClick={() => void drillToList({ categoryIds: [scope.categoryId], kinds: ["expense"] })}
                >
                  {inner}
                </button>
              ) : (
                <div role="group" aria-label={ariaOf(l, dec)}>
                  {inner}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function daysIn(month: string): number {
  return new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
}

/** 「10 月 · 已過 19/31 天」／過去的月「10 月 · 已結束」／未來「還沒開始」 */
function subText(month: string, today: string): string {
  const m = `${Number(month.slice(5, 7))} 月`;
  const tm = monthOf(today);
  if (tm === month) return `${m} · 已過 ${Number(today.slice(8, 10))}/${daysIn(month)} 天`;
  return `${m} · ${tm > month ? "已結束" : "還沒開始"}`;
}

function ariaOf(l: BudgetLine, dec: number): string {
  const used = compactMoney(l.used, dec);
  const budget = compactMoney(l.budget, dec);
  const rest = l.over ? `超支 ${compactMoney(-l.remaining, dec)}` : `剩 ${compactMoney(l.remaining, dec)}`;
  return `${l.label}${l.override ? "（本月覆寫）" : ""}：已用 ${used}，預算 ${budget}，${rest}`;
}

function RowInner({ l, dec }: { l: BudgetLine; dec: number }) {
  // 子分類「🍜 食物 › 點心」：› 淡字（同清單列）
  const parts = l.label.split(" › ");
  return (
    <>
      <span className="n" aria-hidden>
        <span className="t">
          {parts.length === 2 ? (
            <>
              {parts[0]}
              <span className="gt">›</span>
              {parts[1]}
            </>
          ) : (
            l.label
          )}
        </span>
        {l.override && <small className="ovr">僅改本月</small>}
      </span>
      <span className="v" aria-hidden>
        {compactMoney(l.used, dec)}
        <span className="sl">／</span>
        {compactMoney(l.budget, dec)}
      </span>
      <Bar l={l} />
      <span className="r" aria-hidden>
        {l.over ? <b>超支 {compactMoney(-l.remaining, dec)}</b> : `剩 ${compactMoney(l.remaining, dec)}`}
      </span>
    </>
  );
}

function Bar({ l }: { l: BudgetLine }) {
  const scale = l.over ? l.used : l.budget; // 超支時條代表「已用」，預算在 budget/used 處
  const fill = l.over ? 100 : Math.max(0, Math.min(1, l.share)) * 100;
  const tail = l.over ? Math.max(6, (1 - l.budget / l.used) * 100) : 0;
  const pace = scale > 0 ? ((l.pace * l.budget) / scale) * 100 : 0;
  return (
    <span className="bar" aria-hidden>
      <i className="fill" style={{ width: fill.toFixed(1) + "%" }} />
      {l.over && <i className="tail" style={{ width: tail.toFixed(1) + "%" }} />}
      {l.pace > 0 && l.pace < 1 && <i className="pace" style={{ left: pace.toFixed(1) + "%" }} />}
    </span>
  );
}
