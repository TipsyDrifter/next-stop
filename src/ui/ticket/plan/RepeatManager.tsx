/**
 * RepeatManager——定期帳管理（③契約 §5.3、✎-9／✎-12；乙席擁有）。宿主＝DesktopDialogHost（寬 620、標題「定期帳」）。
 * props `{ onDone(): void }`。長相照原型席結論（app.js repeatManager／rmRow；樣式 ticket.css §N）——**一列兩行**（契約一行版在 620 寬會截掉帳戶）：
 *
 *   div.ns-tk-dialog.ns-tk-rm
 *   ├─（有暫停、從沒開始過的匯入規則）.ns-tk-rm-banner「從財務管家匯入的 N 條規則還在暫停——…」・btn-gold「全部開始」（askConfirm）
 *   ├─ h3.ns-tk-rm-h「進行中 N」 ul.ns-tk-rm-list  li.ns-tk-rm-row[.is-blocked][.is-ended]
 *   │     .main  .l1 金額（外幣小字代碼）＋分類或「帳戶 → 帳戶」＋備註
 *   │            .l2 規則一句 · 帳戶（匯入的加「· 從財務管家匯入」；⚠ 列開頭「⚠ 帳戶已不在」、不再印帳戶）
 *   │     .nx    「下一班 11/1」／「已結束」／⚠「記不了」
 *   │     .acts  暫停・編輯・刪除（.ns-tk-dmini）
 *   ├─ h3「已暫停 N」 ul …[.is-paused]（.nx「已暫停」＋匯入的小字「財務管家下一班 11/16」；動作「開始」）
 *   ├─ 空狀態 .ns-tk-rm-empty
 *   └─ .ns-tk-dfoot.is-split  「＋ 新增」｜「關閉」
 *
 * ⚠ 的判定看資料本身（帳戶／轉入帳戶／分類已刪、規則看不懂），再補上次實體化被擋的原因（store.repeatBlocked）——
 * 不用等下一次實體化跑過才出現。排序＝repeatOrder（進行中依下一班、已暫停依建立時間）。
 */
import { useTicketStore } from "../../../store/ticketStore";
import { useUiStore } from "../../../store/uiStore";
import { UNCAT_EXPENSE_ID, UNCAT_INCOME_ID, categoryLabel, type AccountRow, type CategoryRow, type CurrencyRow } from "../../../domain/ticket";
import { describeRule } from "../../../domain/repeat";
import { shortDay } from "../../../domain/ticketView";
import { nextOnText, parseFixedRule, repeatOrder, type RepeatRow } from "../../../domain/ticketPlan";
import { acctLabel } from "../TicketLedger";
import { repeatAmount, repeatNoteShown, repeatWarn } from "./repeatText";

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
        {alive(a) ? a.name : "（帳戶已不在）"}
        <span className="arr">→</span>
        {alive(b) ? b.name : "（帳戶已不在）"}
      </>
    );
  }
  const id = r.category_id;
  if (!id || id === UNCAT_EXPENSE_ID || id === UNCAT_INCOME_ID) return <span className="unc">未分類</span>;
  const c = ctx.catById[id];
  if (!alive(c)) return <span className="unc">（分類已不在）</span>;
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

function RmRow({ r, ctx, warn, imported }: { r: RepeatRow; ctx: Ctx; warn: string | null; imported: boolean }) {
  const store = useTicketStore.getState;
  const rule = parseFixedRule(r.rule);
  const paused = r.paused_at !== null;
  const ended = !paused && r.next_on === null;
  const amt = repeatAmount(r, ctx.curByCode);
  const acc = ctx.accById[r.account_id];
  const cls = "ns-tk-rm-row" + (paused ? " is-paused" : "") + (warn ? " is-blocked" : "") + (ended ? " is-ended" : "");
  const fromMm = r.import_source !== null;
  const note = repeatNoteShown(r, ctx.catById);
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
          {rule ? describeRule(rule) : "規則看不懂"}
          {!warn && r.kind !== "transfer" && alive(acc) && (
            <>
              <i>·</i>
              {acctLabel(acc, ctx.accounts)}
            </>
          )}
          {fromMm && (
            <>
              <i>·</i>從財務管家匯入
            </>
          )}
        </span>
      </span>
      {paused ? (
        <span className="nx is-paused">
          已暫停
          {imported && r.next_on && <small>財務管家下一班 {shortDay(r.next_on)}</small>}
        </span>
      ) : warn ? (
        <span className="nx is-blocked">記不了</span>
      ) : (
        <span className={"nx" + (ended ? " is-paused" : "")}>{nextOnText(r)}</span>
      )}
      <span className="acts">
        {paused ? (
          <button type="button" className="ns-tk-dmini" onClick={() => void store().resumeRepeat(r.id)}>
            開始
          </button>
        ) : (
          <button type="button" className="ns-tk-dmini" disabled={ended} onClick={() => void store().pauseRepeat(r.id)}>
            暫停
          </button>
        )}
        <button type="button" className="ns-tk-dmini" onClick={() => store().openRepeatEditor(r.id)}>
          編輯
        </button>
        <button type="button" className="ns-tk-dmini danger" onClick={() => void store().deleteRepeat(r.id)}>
          刪除
        </button>
      </span>
    </li>
  );
}

export function RepeatManager({ onDone }: { onDone(): void }) {
  const repeats = useTicketStore((s) => s.repeats);
  const blocked = useTicketStore((s) => s.repeatBlocked);
  const accounts = useTicketStore((s) => s.accounts);
  const accById = useTicketStore((s) => s.accById);
  const catById = useTicketStore((s) => s.catById);
  const curByCode = useTicketStore((s) => s.curByCode);
  const unstarted = useTicketStore((s) => s.repeatUnstarted);
  const store = useTicketStore.getState;
  const ctx: Ctx = { accounts, accById, catById, curByCode };

  const list = repeats.filter((r) => r.deleted_at === null).slice().sort(repeatOrder);
  const active = list.filter((r) => r.paused_at === null);
  // 已暫停依建立順序（✎-12；repeatOrder 對暫停的也照 next_on 排，這裡另排）
  const paused = list
    .filter((r) => r.paused_at !== null)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // 從沒開始過的匯入規則（store.repeatUnstarted＝repo 判的、看帳含墓碑）：橫幅、確認窗、toast 的 N 都是這一份（收尾修正）
  const importedIds = new Set(paused.filter((r) => unstarted.indexOf(r.id) >= 0).map((r) => r.id));

  const resumeAll = () => {
    const n = importedIds.size; // 只開始匯入、從沒開始過的；手動暫停的不動
    useUiStore.getState().askConfirm({
      title: `開始 ${n} 條規則？`,
      body: "接著財務管家的下一班記；之後請不要再用財務管家記帳。",
      confirmLabel: "全部開始",
      tone: "gold", // 不是破壞性動作、也不蓋朱（接縫 #74、D-票-11）
      onConfirm: () => void store().resumeAllRepeats(),
    });
  };

  const foot = (
    <div className="ns-tk-dfoot is-split">
      <button type="button" className="ns-btn btn-ghost ns-tk-dbtn" onClick={() => store().openRepeatEditor(null)}>
        ＋ 新增
      </button>
      <button type="button" className="ns-btn btn-ghost ns-tk-dbtn" onClick={onDone}>
        關閉
      </button>
    </div>
  );

  if (!list.length) {
    return (
      <div className="ns-tk-dialog ns-tk-rm">
        <p className="ns-tk-rm-empty">還沒有定期帳——從一筆帳的大票按「設成定期…」，或在這裡新增</p>
        {foot}
      </div>
    );
  }

  const ul = (rows: RepeatRow[]) => (
    <ul className="ns-tk-rm-list">
      {rows.map((r) => (
        <RmRow key={r.id} r={r} ctx={ctx} warn={repeatWarn(r, ctx, blocked)} imported={importedIds.has(r.id)} />
      ))}
    </ul>
  );

  return (
    <div className="ns-tk-dialog ns-tk-rm">
      {importedIds.size > 0 && (
        <div className="ns-tk-rm-banner">
          <p>
            從財務管家匯入的 <b>{importedIds.size}</b> 條規則還在暫停——停用財務管家那天按「全部開始」
          </p>
          <button type="button" className="ns-btn btn-gold ns-tk-dbtn" onClick={resumeAll}>
            全部開始
          </button>
        </div>
      )}
      <h3 className="ns-tk-rm-h">
        進行中<small>{active.length}</small>
      </h3>
      {active.length ? ul(active) : <p className="ns-tk-rm-none">沒有進行中的規則</p>}
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
