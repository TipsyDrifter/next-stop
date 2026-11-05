/**
 * RepeatManager——定期帳管理（③契約 §5.3、✎-9／✎-12；乙席擁有）。宿主＝DesktopDialogHost（寬 620、標題「定期帳」）。
 * props `{ onDone(): void }`。長相照原型席結論（app.js repeatManager／rmRow；樣式 ticket.css §N）——**一列兩行**（契約一行版在 620 寬會截掉帳戶）：
 *
 *   div.ns-tk-dialog.ns-tk-rm
 *   ├─ h3.ns-tk-rm-h「進行中 N」 ul.ns-tk-rm-list  li.ns-tk-rm-row[.is-blocked][.is-ended]
 *   │     .main  .l1 金額（外幣小字代碼）＋分類或「帳戶 → 帳戶」＋備註
 *   │            .l2 規則一句（含結束條件）· 帳戶（⚠ 列開頭「⚠ 帳戶已不在」、不再印帳戶）
 *   │            .l3 還沒到的提前跳過「已跳過 11/1 復原」（只有跳過過才出；D-票-82）
 *   │     .nx    「下一班 11/1」＋底下文字鈕「跳過下一班」（D-票-82；已暫停、已結束、記不了不給）／「已結束」／⚠「記不了」
 *   │     .acts  暫停・編輯・刪除（.ns-tk-dmini＋.ns-btn--sm 次鈕；刪除＝危險鈕）
 *   ├─ h3「已暫停 N」 ul …[.is-paused]（.nx「已暫停」；動作「開始」）
 *   ├─ 空狀態 .ns-tk-rm-empty
 *   └─ .ns-tk-rm-add       文字鈕「＋ 新增定期帳」（UI 丙-5 E2：「關閉」拿掉——管理清單即時存，只留 ×／暗幕／Esc，視覺規範 §4）
 *
 * ⚠ 的判定看資料本身（帳戶／轉入帳戶／分類已刪、規則看不懂），再補上次實體化被擋的原因（store.repeatBlocked）——
 * 不用等下一次實體化跑過才出現。排序＝repeatOrder（進行中依下一班、已暫停依建立時間）。
 */
import { useTicketStore } from "../../../store/ticketStore";
import { useUiStore } from "../../../store/uiStore";
import { todayKey } from "../../../lib/date";
import { UNCAT_EXPENSE_ID, UNCAT_INCOME_ID, categoryLabel, type AccountRow, type CategoryRow, type CurrencyRow } from "../../../domain/ticket";
import { shortDay } from "../../../domain/ticketView";
import { canSkipNext, nextOnText, parseFixedRule, pendingSkips, repeatOrder, repeatRuleText, type RepeatRow } from "../../../domain/ticketPlan";
import { acctLabel } from "../TicketLedger";
import { repeatAmount, repeatNoteShown, repeatWarn } from "./repeatText";
import { IconPlus } from "../../common/icons";

interface Ctx {
  accounts: AccountRow[];
  accById: Record<string, AccountRow>;
  catById: Record<string, CategoryRow>;
  curByCode: Record<string, CurrencyRow>;
}

const alive = <T extends { deleted_at: string | null }>(x: T | undefined): x is T => !!x && x.deleted_at === null;

function What({ r, ctx }: { r: RepeatRow; ctx: Ctx }) {
  if (r.kind === "transfer") {
    const a = ctx.accById[r.account_id];
    const b = r.to_account_id ? ctx.accById[r.to_account_id] : undefined;
    return (
      <>
        {alive(a) ? a.name : "（帳戶已刪除）"}
        <span className="arr">→</span>
        {alive(b) ? b.name : "（帳戶已刪除）"}
      </>
    );
  }
  const id = r.category_id;
  if (!id || id === UNCAT_EXPENSE_ID || id === UNCAT_INCOME_ID) return <span className="unc">未分類</span>;
  const c = ctx.catById[id];
  if (!alive(c)) return <span className="unc">（分類已刪除）</span>;
  const label = categoryLabel(c, ctx.catById);
  const i = label.indexOf(" › ");
  return i < 0 ? (
    <>{label}</>
  ) : (
    <>
      {label.slice(0, i)}
      <span className="gt">›</span>
      {label.slice(i + 3)}
    </>
  );
}

function RmRow({ r, ctx, warn, today }: { r: RepeatRow; ctx: Ctx; warn: string | null; today: string }) {
  const store = useTicketStore.getState;
  const rule = parseFixedRule(r.rule);
  const paused = r.paused_at !== null;
  const ended = !paused && r.next_on === null;
  const amt = repeatAmount(r, ctx.curByCode);
  const acc = ctx.accById[r.account_id];
  const cls = "ns-tk-rm-row" + (paused ? " is-paused" : "") + (warn ? " is-blocked" : "") + (ended ? " is-ended" : "");
  const note = repeatNoteShown(r, ctx.catById);
  const skipped = pendingSkips(r, today);
  const lastSkipped = skipped.length ? skipped[skipped.length - 1] : null;
  return (
    <li className={cls}>
      <span className="main">
        <span className="l1">
          <b className="amt">
            {amt.text}
            {amt.code && <span className="cur">{amt.code}</span>}
          </b>
          <span className="what">
            <What r={r} ctx={ctx} />
          </span>
          {note && <span className="note">{note}</span>}
        </span>
        <span className="l2">
          {warn && <span className="warn">⚠ {warn}</span>}
          {rule ? repeatRuleText(rule) : "重複規則有誤"}
          {!warn && r.kind !== "transfer" && alive(acc) && (
            <>
              <i>·</i>
              {acctLabel(acc, ctx.accounts)}
            </>
          )}
        </span>
        {lastSkipped && (
          <span className="l3">
            已跳過 {skipped.map(shortDay).join("、")}
            <button type="button" className="btn-text ns-tk-rm-textbtn" aria-label={`取消跳過 ${shortDay(lastSkipped)}`} onClick={() => void store().unskipRepeat(r.id, lastSkipped)}>
              復原
            </button>
          </span>
        )}
      </span>
      {paused ? (
        <span className="nx is-paused">已暫停</span>
      ) : warn ? (
        <span className="nx is-blocked">記不了</span>
      ) : (
        <span className={"nx" + (ended ? " is-paused" : "")}>
          {nextOnText(r)}
          {canSkipNext(r) && r.next_on && (
            <button type="button" className="btn-text ns-tk-rm-textbtn" aria-label={`跳過下一班 ${shortDay(r.next_on)}`} onClick={() => void store().skipNextRepeat(r.id)}>
              跳過下一班
            </button>
          )}
        </span>
      )}
      <span className="acts">
        {paused ? (
          <button type="button" className="ns-btn ns-btn--sm btn-ghost ns-tk-dmini" onClick={() => void store().resumeRepeat(r.id)}>
            開始
          </button>
        ) : (
          <button type="button" className="ns-btn ns-btn--sm btn-ghost ns-tk-dmini" disabled={ended} onClick={() => void store().pauseRepeat(r.id)}>
            暫停
          </button>
        )}
        <button type="button" className="ns-btn ns-btn--sm btn-ghost ns-tk-dmini" onClick={() => store().openRepeatEditor(r.id)}>
          編輯
        </button>
        <button type="button" className="ns-btn ns-btn--sm btn-ghost ns-btn-danger ns-tk-dmini" onClick={() => void store().deleteRepeat(r.id)}>
          刪除
        </button>
      </span>
    </li>
  );
}

export function RepeatManager(_props: { onDone(): void }) {
  const repeats = useTicketStore((s) => s.repeats);
  const blocked = useTicketStore((s) => s.repeatBlocked);
  const accounts = useTicketStore((s) => s.accounts);
  const accById = useTicketStore((s) => s.accById);
  const catById = useTicketStore((s) => s.catById);
  const curByCode = useTicketStore((s) => s.curByCode);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const today = todayKey(dayStartHour);
  const store = useTicketStore.getState;
  const ctx: Ctx = { accounts, accById, catById, curByCode };

  const list = repeats.filter((r) => r.deleted_at === null).slice().sort(repeatOrder);
  const active = list.filter((r) => r.paused_at === null);
  // 已暫停依建立順序（✎-12；repeatOrder 對暫停的也照 next_on 排，這裡另排）
  const paused = list
    .filter((r) => r.paused_at !== null)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // 新增＝清單尾一顆文字鈕（同時刻表分類管理「＋ 新增分類」；不是黏底按鈕列——即時存的面板沒有主鈕，§2.3）
  const foot = (
    <div className="ns-tk-rm-add">
      <button type="button" className="ns-btn btn-text ns-btn--sm ns-tk-btn" onClick={() => store().openRepeatEditor(null)}>
        <IconPlus />
        新增定期帳
      </button>
    </div>
  );

  if (!list.length) {
    return (
      <div className="ns-tk-dialog ns-tk-rm">
        <p className="ns-tk-rm-empty">還沒有定期帳——點開一筆帳按「設成定期…」，或在這裡新增</p>
        {foot}
      </div>
    );
  }

  const ul = (rows: RepeatRow[]) => (
    <ul className="ns-tk-rm-list">
      {rows.map((r) => (
        <RmRow key={r.id} r={r} ctx={ctx} warn={repeatWarn(r, ctx, blocked)} today={today} />
      ))}
    </ul>
  );

  return (
    <div className="ns-tk-dialog ns-tk-rm">
      <h3 className="ns-tk-rm-h">
        進行中<small>{active.length}</small>
      </h3>
      {active.length ? ul(active) : <p className="ns-tk-rm-none">沒有進行中的定期帳</p>}
      {paused.length > 0 && (
        <>
          <h3 className="ns-tk-rm-h">
            已暫停<small>{paused.length}</small>
          </h3>
          {ul(paused)}
        </>
      )}
      {foot}
    </div>
  );
}
