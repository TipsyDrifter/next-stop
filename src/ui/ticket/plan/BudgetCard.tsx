/**
 * BudgetCard——統計頁（月模式）的預算卡（③契約 §5.1、✎-1／✎-2／✎-11；乙席擁有）。
 * 長相照原型席結論（`prototypes/售票口-③-src/app.js` budgetCard／barHtml；樣式 ticket.css §L）：
 *
 *   section.ns-tk-st-card.ns-tk-bud
 *   ├─ .ns-tk-st-h        h2「預算」・small「10 月 · 已過 19/31 天」（過去的月「已結束」、未來「還沒開始」）・右端「設定…」
 *   └─ ul.ns-tk-bud-rows  li.ns-tk-bud-row[.is-total][.is-over][.is-archived][.is-gone]
 *        分類列＝button（點＝drillToList 本月該分類的支出）；總預算列＝div
 *        .n 名稱（＋「本月覆寫」小字）・.bar（.fill／超支 .tail 斜紋／.pace 按日進度線）・.v「已用 X／預算 Y」・.r「剩 Z」或 b「超支 W」
 *   篩了帳戶 ⇒ 一行 .ns-tk-bud-note「預算看全部帳戶」（✎-11）；沒有預算 ⇒ .ns-tk-bud-empty＋「設定預算…」
 *
 * 條的算法（原型席 taste #1）：沒超支＝fill 寬 share；超支＝條代表「已用」，fill 100%、斜紋段 .tail 寬＝超出比例（至少 6%），
 * 左緣實線＝預算到這裡；進度線位置＝pace × 預算 ÷ 尺度（超支時尺度＝已用），pace 為 0 或 1 時不畫。
 * 只讀 store、只叫 store 的動作（§1-4）。
 */
import { useTicketStore, TK_TEXT } from "../../../store/ticketStore";
import { useUiStore } from "../../../store/uiStore";
import { todayKey } from "../../../lib/date";
import { MAIN_CURRENCY, monthOf } from "../../../domain/ticket";
import { budgetText, type BudgetLine } from "../../../domain/ticketPlan";

function daysIn(month: string): number {
  return new Date(parseInt(month.slice(0, 4), 10), parseInt(month.slice(5, 7), 10), 0).getDate();
}

/** 「10 月 · 已過 19/31 天」 */
function monthSub(month: string, today: string): string {
  const name = `${parseInt(month.slice(5, 7), 10)} 月`;
  const tm = monthOf(today);
  if (tm > month) return `${name} · 已結束`;
  if (tm < month) return `${name} · 還沒開始`;
  return `${name} · 已過 ${parseInt(today.slice(8, 10), 10)}/${daysIn(month)} 天`;
}

/** 「食物 › 點心」⇒ 主分類淡色箭頭 */
function LabelText({ label }: { label: string }) {
  const i = label.indexOf(" › ");
  if (i < 0) return <>{label}</>;
  return (
    <>
      {label.slice(0, i)}
      <span className="gt">›</span>
      {label.slice(i + 3)}
    </>
  );
}

export function BudgetBar({ line }: { line: BudgetLine }) {
  const l = line;
  const scale = l.over ? l.used : l.budget;
  const fill = l.over ? 100 : Math.max(0, Math.min(1, l.share)) * 100;
  const tail = l.over && l.used > 0 ? Math.max(6, (1 - l.budget / l.used) * 100) : 0;
  const pace = scale > 0 ? ((l.pace * l.budget) / scale) * 100 : 0;
  return (
    <span className="bar" aria-hidden>
      <i className="fill" style={{ width: `${fill.toFixed(1)}%` }} />
      {l.over && <i className="tail" style={{ width: `${tail.toFixed(1)}%` }} />}
      {l.pace > 0 && l.pace < 1 && <i className="pace" style={{ left: `${pace.toFixed(1)}%` }} />}
    </span>
  );
}

export function BudgetCard() {
  const lines = useTicketStore((s) => s.budgetLines);
  const span = useTicketStore((s) => s.span);
  const month = useTicketStore((s) => s.period.key);
  const filtered = useTicketStore((s) => s.filterAccountId !== null);
  const dec = useTicketStore((s) => s.curByCode[MAIN_CURRENCY]?.decimals ?? 2);
  const openDialog = useTicketStore((s) => s.openDialog);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  if (span !== "month") return null;
  const today = todayKey(dayStartHour);
  const open = () => openDialog({ kind: "budgets" });
  const has = !filtered && !!lines && lines.length > 0;
  return (
    <section className="ns-tk-st-card ns-tk-bud" aria-label="預算">
      <div className="ns-tk-st-h">
        <h2>預算</h2>
        {has && <small>{monthSub(month, today)}</small>}
        <button type="button" className="ns-tk-bud-set" onClick={open}>
          設定…
        </button>
      </div>
      {filtered ? (
        <p className="ns-tk-bud-note">{TK_TEXT.budgetAllAccounts}</p>
      ) : !has ? (
        <div className="ns-tk-bud-empty">
          <p>還沒有預算</p>
          <button type="button" className="ns-tk-btn" onClick={open}>
            設定預算…
          </button>
        </div>
      ) : (
        <ul className="ns-tk-bud-rows">
          {(lines ?? []).map((l) => {
            const t = budgetText(l, dec);
            const cls =
              "ns-tk-bud-row" +
              (l.scope.kind === "total" ? " is-total" : "") +
              (l.over ? " is-over" : "") +
              (l.archived ? " is-archived" : "") +
              (l.gone ? " is-gone" : "");
            const inner = (
              <>
                <span className="n">
                  <span className="t">
                    <LabelText label={l.label} />
                  </span>
                  {l.archived && <small className="ovr">已封存</small>}
                  {l.override && <small className="ovr">本月覆寫</small>}
                </span>
                <BudgetBar line={l} />
                <span className="v">
                  <small>已用</small>
                  {t.used}
                  <span className="sl">／</span>
                  <small>預算</small>
                  {t.budget}
                </span>
                <span className="r">{l.over ? <b>{t.rest}</b> : t.rest}</span>
              </>
            );
            const scope = l.scope;
            return (
              <li key={l.key} className={cls}>
                {scope.kind === "category" && !l.gone ? (
                  <button
                    type="button"
                    title={`到清單看${l.label}這個月的支出`}
                    onClick={() => void useTicketStore.getState().drillToList({ categoryIds: [scope.categoryId], kinds: ["expense"] })}
                  >
                    {inner}
                  </button>
                ) : (
                  <div>{inner}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
