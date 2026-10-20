/**
 * MobileRepeatSheet——手機的定期帳管理 sheet（③契約 §5.3／§5.5、✎-9／✎-12、0-1 (a)；原型題四手機；丙席擁有）。宿主＝MobileSheetHost（標題「定期帳」）。
 *
 * div.ns-tk-mrm
 *   ├（有還沒開始過的匯入規則）.ns-tk-mrm-banner 「從財務管家匯入的 N 條規則還在暫停——…」＋滿寬「全部開始」（askConfirm ⇒ resumeAllRepeats）
 *   ├ 「進行中 N」ul（依下一班；store 的 repeats 已照 repeatOrder 排）
 *   ├ 「已暫停 N」ul（灰字）
 *   ├ 空狀態「還沒有定期帳——…」
 *   └ 「＋ 新增」｜「完成」
 * 列（原型結論：兩行）：button.main 點＝開全螢幕表單編輯——上行 金額＋分類（或「帳戶 → 轉入」）……右端「下一班 11/1」；
 *   下行 規則一句 · 帳戶（匯入的暫停規則多「· 財務管家下一班 X」；被擋 ⇒ 開頭「⚠ 原因」、右端「記不了」）。
 *   列尾只留「暫停／開始」（三顆 44px 鈕放不下）；刪除在表單底部。
 */
import { type ReactNode } from "react";
import { useTicketStore } from "../../../../store/ticketStore";
import { useUiStore } from "../../../../store/uiStore";
import { todayKey } from "../../../../lib/date";
import { UNCAT_EXPENSE_ID, UNCAT_INCOME_ID, UNCAT_NAME, type AccountRow, type CategoryRow } from "../../../../domain/ticket";
import { shortDay } from "../../../../domain/ticketView";
import { nextOnText, parseFixedRule, repeatStatus, type RepeatRow } from "../../../../domain/ticketPlan";
import { describeRule } from "../../../../domain/repeat";
import { IconPlus } from "../mobileBits";
import { acctLabel } from "../../TicketLedger";
import { repeatAmount, repeatNoteShown, repeatUncat, repeatWarn } from "../../plan/repeatText";

export function MobileRepeatSheet({ onDone }: { onDone(): void }) {
  const repeats = useTicketStore((s) => s.repeats);
  const blocked = useTicketStore((s) => s.repeatBlocked);
  const unstarted = useTicketStore((s) => s.repeatUnstarted);
  const openRepeatEditor = useTicketStore((s) => s.openRepeatEditor);
  const resumeAllRepeats = useTicketStore((s) => s.resumeAllRepeats);
  const askConfirm = useUiStore((s) => s.askConfirm);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const today = todayKey(dayStartHour);

  // 從沒開始過的匯入規則（store.repeatUnstarted＝repo 判的、看帳含墓碑）：橫幅、確認窗、toast 的 N 都是這一份（收尾修正）
  const fresh = (r: RepeatRow) => r.paused_at !== null && unstarted.indexOf(r.id) >= 0;
  const active = repeats.filter((r) => r.paused_at === null);
  const paused = repeats.filter((r) => r.paused_at !== null);
  const imported = paused.filter(fresh);

  const startAll = () =>
    askConfirm({
      title: `啟動 ${imported.length} 筆定期帳？`, // 只開始匯入、從沒開始過的；手動暫停的不動
      body: "接著財務管家的下一班記；之後請不要再用財務管家記帳。",
      confirmLabel: "全部開始",
      tone: "gold", // 不是破壞性動作、也不蓋朱（接縫 #74、D-票-11）
      onConfirm: () => void resumeAllRepeats(),
    });

  return (
    <div className="ns-tk-mrm">
      {imported.length > 0 && (
        <div className="ns-tk-mrm-banner">
          <p>
            從財務管家匯入的 <b>{imported.length}</b> 筆定期帳還在暫停——停用財務管家那天再按「全部開始」
          </p>
          <button type="button" className="ns-tk-mbtn primary" onClick={startAll}>
            全部開始
          </button>
        </div>
      )}

      {repeats.length === 0 ? (
        <p className="ns-tk-mrm-empty">還沒有定期帳——可在記帳時打開「更多欄位」按「設成定期…」，或在這裡新增</p>
      ) : (
        <>
          <p className="ns-tk-mrm-h">
            進行中 <span className="n">{active.length}</span>
          </p>
          {active.length === 0 ? (
            <p className="ns-tk-mrm-none">沒有進行中的定期帳</p>
          ) : (
            <ul>
              {active.map((r) => (
                <Row key={r.id} r={r} status={repeatStatus(r, today, blocked)} blocked={blocked} fresh={false} onEdit={() => openRepeatEditor(r.id)} />
              ))}
            </ul>
          )}
          {paused.length > 0 && (
            <>
              <p className="ns-tk-mrm-h">
                已暫停 <span className="n">{paused.length}</span>
              </p>
              <ul>
                {paused.map((r) => (
                  <Row key={r.id} r={r} status="paused" blocked={blocked} fresh={fresh(r)} onEdit={() => openRepeatEditor(r.id)} />
                ))}
              </ul>
            </>
          )}
        </>
      )}

      <div className="ns-tk-mrm-foot">
        <button type="button" className="ns-tk-mbtn" onClick={() => openRepeatEditor(null)}>
          <IconPlus />
          新增
        </button>
        <button type="button" className="ns-tk-mbtn quiet" onClick={onDone}>
          完成
        </button>
      </div>
    </div>
  );
}

function Row({
  r,
  status,
  blocked,
  fresh,
  onEdit,
}: {
  r: RepeatRow;
  status: ReturnType<typeof repeatStatus>;
  blocked: Readonly<Record<string, string>>;
  fresh: boolean;
  onEdit(): void;
}) {
  const accounts = useTicketStore((s) => s.accounts);
  const accById = useTicketStore((s) => s.accById);
  const catById = useTicketStore((s) => s.catById);
  const curByCode = useTicketStore((s) => s.curByCode);
  const pauseRepeat = useTicketStore((s) => s.pauseRepeat);
  const resumeRepeat = useTicketStore((s) => s.resumeRepeat);
  const rule = parseFixedRule(r.rule);
  const paused = status === "paused";
  // ⚠ 原因與桌機同一支（repeatText.repeatWarn：短句、資料本身先判）；暫停的列也照樣標，但右端仍寫「已暫停」
  const why = repeatWarn(r, { accById, catById }, blocked);
  const isBlocked = !paused && why !== null;

  const { text: amt, code } = repeatAmount(r, curByCode);
  const foreign = code !== null;
  const nx = paused ? "已暫停" : isBlocked ? "記不了" : nextOnText(r);
  const desc = rule ? describeRule(rule) : "重複規則有誤";
  const note = repeatUncat(r) ? null : repeatNoteShown(r, catById); // 未分類的上行已經印備註了

  const cls = "ns-tk-mrm-row" + (paused ? " is-paused" : "") + (isBlocked ? " is-blocked" : "") + (status === "ended" ? " is-ended" : "");
  return (
    <li>
      <div className={cls}>
        <button type="button" className="main" onClick={onEdit} aria-label={`編輯：${desc}，${amt}${foreign ? " " + r.currency : ""}，${nx}`}>
          <span className="l1">
            <b className="amt">
              {amt}
              {foreign && <span className="cur">{r.currency}</span>}
            </b>
            <span className="what">{whatOf(r, accById, catById)}</span>
            <span className="nx">{nx}</span>
          </span>
          <span className="l2">
            {why && <span className="warn">⚠ {why}</span>}
            {desc}
            {r.kind !== "transfer" && !why && ` · ${acctLabel(accById[r.account_id], accounts)}`}
            {fresh && r.next_on && ` · 財務管家下一班 ${shortDay(r.next_on)}`}
            {note && ` · ${note}`}
          </span>
        </button>
        <button
          type="button"
          className="ns-tk-mbtn quiet tog"
          aria-label={paused ? "開始這筆定期帳" : "暫停這筆定期帳"}
          onClick={() => void (paused ? resumeRepeat(r.id) : pauseRepeat(r.id))}
        >
          {paused ? "開始" : "暫停"}
        </button>
      </div>
    </li>
  );
}

function accName(id: string | null, accById: Readonly<Record<string, AccountRow>>): string {
  const a = id ? accById[id] : undefined;
  return a && a.deleted_at === null ? a.name : "（帳戶已刪除）";
}

/** 上行的「記什麼」：收支＝分類（子分類「食物 › 晚餐」、› 淡字）；轉帳＝「帳戶 → 轉入」 */
function whatOf(r: RepeatRow, accById: Readonly<Record<string, AccountRow>>, catById: Readonly<Record<string, CategoryRow>>): ReactNode {
  if (r.kind === "transfer") {
    return (
      <>
        {accName(r.account_id, accById)}
        <span className="gt">→</span>
        {accName(r.to_account_id, accById)}
      </>
    );
  }
  const id = r.category_id ?? (r.kind === "income" ? UNCAT_INCOME_ID : UNCAT_EXPENSE_ID);
  if (id === UNCAT_INCOME_ID || id === UNCAT_EXPENSE_ID) return <span className="unc">{r.note.trim() || UNCAT_NAME}</span>;
  const c = catById[id];
  if (!c || c.deleted_at !== null) return <span className="unc">（分類已刪除）</span>;
  const p = c.parent_id ? catById[c.parent_id] : undefined;
  return p ? (
    <>
      {p.name}
      <span className="gt">›</span>
      {c.name}
    </>
  ) : (
    c.name
  );
}
