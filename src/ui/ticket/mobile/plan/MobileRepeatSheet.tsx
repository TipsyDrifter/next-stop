/**
 * MobileRepeatSheet——手機的定期帳管理 sheet（③契約 §5.3／§5.5、✎-9／✎-12；原型題四手機；丙席擁有）。宿主＝MobileSheetHost（標題「定期帳」）。
 *
 * div.ns-tk-mrm
 *   ├ 「進行中 N」ul（依下一班；store 的 repeats 已照 repeatOrder 排）
 *   ├ 「已暫停 N」ul（灰字）
 *   ├ 空狀態「還沒有定期帳——…」
 *   └ 「＋ 新增」（UI 丙-5 E2：「完成」拿掉——清單即時生效，關 sheet 走下滑／暗幕／返回鍵，規範 §4）
 * 列（原型結論：兩行）：button.main 點＝開全螢幕表單編輯——上行 金額＋分類（或「帳戶 → 轉入」）……右端「下一班 11/1」；
 *   下行 規則一句（含結束條件）· 帳戶（被擋 ⇒ 開頭「⚠ 原因」、右端「記不了」）。
 *   列尾只留「暫停／開始」（再多一顆 44px 鈕，上行的分類會被擠到剩一兩個字）；刪除在表單底部。
 *   列底一行 .sub（D-票-82）：左「已跳過 11/1 復原」（還沒到的提前跳過才出）、右文字鈕「跳過下一班」（已暫停、已結束、記不了不給）；兩個都沒有就不出。
 */
import { type ReactNode } from "react";
import { useTicketStore } from "../../../../store/ticketStore";
import { useUiStore } from "../../../../store/uiStore";
import { todayKey } from "../../../../lib/date";
import { UNCAT_EXPENSE_ID, UNCAT_INCOME_ID, UNCAT_NAME, categoryPath, type AccountRow, type CategoryRow } from "../../../../domain/ticket";
import { canSkipNext, nextOnText, parseFixedRule, pendingSkips, repeatRuleText, repeatStatus, type RepeatRow } from "../../../../domain/ticketPlan";
import { shortDay } from "../../../../domain/ticketView";
import { IconPlus } from "../mobileBits";
import { acctLabel } from "../../TicketLedger";
import { repeatAmount, repeatNoteShown, repeatUncat, repeatWarn } from "../../plan/repeatText";

// onDone：宿主的介面照留；丙-5 拿掉「完成」後本體不再自己關
export function MobileRepeatSheet(_props: { onDone(): void }) {
  const repeats = useTicketStore((s) => s.repeats);
  const blocked = useTicketStore((s) => s.repeatBlocked);
  const openRepeatEditor = useTicketStore((s) => s.openRepeatEditor);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const today = todayKey(dayStartHour);

  const active = repeats.filter((r) => r.paused_at === null);
  const paused = repeats.filter((r) => r.paused_at !== null);

  return (
    <div className="ns-tk-mrm">
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
                <Row key={r.id} r={r} status={repeatStatus(r, today, blocked)} blocked={blocked} today={today} onEdit={() => openRepeatEditor(r.id)} />
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
                  <Row key={r.id} r={r} status="paused" blocked={blocked} today={today} onEdit={() => openRepeatEditor(r.id)} />
                ))}
              </ul>
            </>
          )}
        </>
      )}

      <div className="ns-tk-mrm-foot">
        <button type="button" className="ns-btn btn-ghost ns-tk-mbtn" onClick={() => openRepeatEditor(null)}>
          <IconPlus />
          新增
        </button>
      </div>
    </div>
  );
}

function Row({
  r,
  status,
  blocked,
  today,
  onEdit,
}: {
  r: RepeatRow;
  status: ReturnType<typeof repeatStatus>;
  blocked: Readonly<Record<string, string>>;
  today: string;
  onEdit(): void;
}) {
  const accounts = useTicketStore((s) => s.accounts);
  const accById = useTicketStore((s) => s.accById);
  const catById = useTicketStore((s) => s.catById);
  const curByCode = useTicketStore((s) => s.curByCode);
  const pauseRepeat = useTicketStore((s) => s.pauseRepeat);
  const resumeRepeat = useTicketStore((s) => s.resumeRepeat);
  const skipNextRepeat = useTicketStore((s) => s.skipNextRepeat);
  const unskipRepeat = useTicketStore((s) => s.unskipRepeat);
  const rule = parseFixedRule(r.rule);
  const paused = status === "paused";
  // ⚠ 原因與桌機同一支（repeatText.repeatWarn：短句、資料本身先判）；暫停的列也照樣標，但右端仍寫「已暫停」
  const why = repeatWarn(r, { accById, catById }, blocked);
  const isBlocked = !paused && why !== null;

  const { text: amt, code } = repeatAmount(r, curByCode);
  const foreign = code !== null;
  const nx = paused ? "已暫停" : isBlocked ? "記不了" : nextOnText(r);
  const desc = rule ? repeatRuleText(rule) : "重複規則有誤";
  const skipped = pendingSkips(r, today);
  const lastSkipped = skipped.length ? skipped[skipped.length - 1] : null;
  const skippable = !isBlocked && canSkipNext(r) && r.next_on !== null;
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
            {note && ` · ${note}`}
          </span>
        </button>
        <button
          type="button"
          className="ns-btn btn-ghost ns-tk-mbtn tog"
          aria-label={paused ? "開始這筆定期帳" : "暫停這筆定期帳"}
          onClick={() => void (paused ? resumeRepeat(r.id) : pauseRepeat(r.id))}
        >
          {paused ? "開始" : "暫停"}
        </button>
        {(lastSkipped || skippable) && (
          <div className="sub">
            {lastSkipped && (
              <span className="skipped">
                已跳過 {skipped.map(shortDay).join("、")}
                <button type="button" className="ns-btn ns-btn--sm btn-text ns-tk-mbtn" aria-label={`取消跳過 ${shortDay(lastSkipped)}`} onClick={() => void unskipRepeat(r.id, lastSkipped)}>
                  復原
                </button>
              </span>
            )}
            {skippable && r.next_on && (
              <button type="button" className="ns-btn ns-btn--sm btn-text ns-tk-mbtn skip" aria-label={`跳過下一班 ${shortDay(r.next_on)}`} onClick={() => void skipNextRepeat(r.id)}>
                跳過下一班
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

function accName(id: string | null, accById: Readonly<Record<string, AccountRow>>): string {
  const a = id ? accById[id] : undefined;
  return a && a.deleted_at === null ? a.name : "（帳戶已刪除）";
}

/** 上行的「記什麼」：收支＝分類（子分類「食物 › 晚餐」、多層寫最後兩段、› 淡字）；轉帳＝「帳戶 → 轉入」 */
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
  // 售票口④ 第二輪（D-票-78）：多層時只寫最後兩段（同帳簿列）
  const path = categoryPath(c, catById);
  const p = path.length > 1 ? path[path.length - 2] : undefined;
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
