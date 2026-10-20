/**
 * ImportCard——匯入票四態（車次①契約 §5.2、§3.8.2、0-22～0-24；兩殼共用；乙席）。
 * props `{ onDone(): void }`（確認或取消後由 host 關）；自己讀 store 的 `imp`。標題「從財務管家匯入」由 host 給。
 * 讀檔與寫入只透過 store 的動作（startImport／importFromPath／setImportBalance／setImportChoice／runImport）。
 *
 *   reading  檢查中：淡字「正在讀備份…」
 *   unknown  schema 不符：一句「這個備份版本我不認得（缺 ○○ 表）」＋關閉
 *   preview  預覽卡：檔名＋摘要（帳戶・分類・交易・日期範圍）→ 三行（新增／財務管家端已修改（可展開逐筆二選一）／Next Stop 有、備份沒有）
 *            → 餘額對帳區（plan.checks；兩欄）＋判定行 → 取消・匯入
 *   writing  執行中：「正在寫入 ○/N」＋細進度條
 *   done     結果卡：「已匯入 N 筆 · 更新 M 筆 · 略過 K 筆」＋餘額對照表（Next Stop｜財務管家｜✓/✗）＋蓋一枚領収＋關閉
 *   error    訊息＋再試一次（plan 在就能重跑；確定性 id 讓重跑安全）＋關閉
 *
 * 手機的單欄排版由丙席在 ticket-mobile.css 調（本檔 class 兩殼共用）。
 */
import { useState } from "react";
import { useTicketStore, TK_TEXT, IMPORT_REPEATS_PAUSED } from "../../store/ticketStore";
import { partSummary, type PlanImportPart } from "../../domain/ticketPlan";
import { SealReceipt } from "../stamps/Stamps";
import { moneyText, type BalanceCheck, type EntryRow, type ImportChange, type ImportPlan } from "../../domain/ticket";
import { groupLabel } from "./TicketLedger";

const ymd = (d: string | null): string => (d ? d.replace(/-/g, "/") : "—");

/** 出現兩次以上的名字 */
function dupSet(names: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const n of names) (seen.has(n) ? dup : seen).add(n);
  return dup;
}

export function ImportCard(props: { onDone(): void }) {
  const imp = useTicketStore((s) => s.imp);
  const store = useTicketStore.getState;

  let body;
  switch (imp.phase) {
    case "idle":
    case "reading":
      body = <p className="ns-tk-im-wait">{TK_TEXT.importReading}</p>;
      break;
    case "unknown":
      body = (
        <>
          <p className="ns-tk-im-unknown">{TK_TEXT.importUnknown(imp.missing)}</p>
          <footer className="ns-tk-im-foot">
            <button type="button" className="ns-tk-btn" onClick={props.onDone}>
              關閉
            </button>
          </footer>
        </>
      );
      break;
    case "preview":
      body = imp.plan ? <Preview plan={imp.plan} fileName={imp.dump?.file_name ?? ""} onCancel={props.onDone} /> : null;
      break;
    case "writing": {
      const p = imp.progress ?? { done: 0, total: 0 };
      const ratio = p.total > 0 ? Math.min(1, p.done / p.total) : 0;
      body = (
        <div className="ns-tk-im-writing" aria-live="polite">
          <p>{TK_TEXT.importWriting(p.done, p.total)}</p>
          <div className="ns-tk-im-bar" role="progressbar" aria-valuemin={0} aria-valuemax={p.total} aria-valuenow={p.done}>
            <i style={{ width: `${(ratio * 100).toFixed(1)}%` }} />
          </div>
          <small>匯入中，請先別關閉畫面</small>
        </div>
      );
      break;
    }
    case "done":
      body = <Done onClose={props.onDone} />;
      break;
    case "error":
      body = (
        <>
          <p className="ns-tk-im-error" role="alert">
            {imp.message ?? "匯入失敗"}
          </p>
          <footer className="ns-tk-im-foot">
            {imp.plan && <span className="note">已匯入的不會重複——再試一次就能補齊</span>}
            <button type="button" className="ns-tk-btn quiet" onClick={props.onDone}>
              關閉
            </button>
            {imp.plan && (
              <button type="button" className="ns-tk-btn primary" onClick={() => void store().runImport()}>
                再試一次
              </button>
            )}
          </footer>
        </>
      );
      break;
  }
  return (
    <div className="ns-tk-dialog ns-tk-import" data-phase={imp.phase}>
      {body}
    </div>
  );
}

/* ───────── 預覽卡 ───────── */

/** 第③階段（③契約 §5.6）：預算與定期規則的計畫——摘要行之後一行；有略過、或備份少了欄位 ⇒ 各多一行小字 */
function PlanLines() {
  const part: PlanImportPart | null = useTicketStore((s) => s.imp.part);
  if (!part) return null;
  const b = part.budgets;
  const sum = partSummary(part);
  return (
    <>
      <p className="ns-tk-im-sum is-plan">
        預算 <b>{b.scopes}</b> 個{b.overrides > 0 && <>（{b.overrides} 個單月覆寫）</>} · 定期帳 <b>{part.repeats.inserts.length + part.repeats.updates.length}</b> 筆
      </p>
      {sum.skipLine && <p className="ns-tk-im-plannote">{sum.skipLine}</p>}
      {sum.tombLine && <p className="ns-tk-im-plannote">{sum.tombLine}</p>}
      {part.missing.length > 0 && <p className="ns-tk-im-plannote">這個備份的預算與定期帳少了 {part.missing.join("、")}，這次只匯入帳目</p>}
    </>
  );
}

function Preview({ plan, fileName, onCancel }: { plan: ImportPlan; fileName: string; onCancel(): void }) {
  const balanceText = useTicketStore((s) => s.imp.balanceText);
  const choices = useTicketStore((s) => s.imp.choices);
  const accById = useTicketStore((s) => s.accById);
  const store = useTicketStore.getState;
  const [modsOpen, setModsOpen] = useState(false);
  const sm = plan.summary;
  const changed = plan.entries.changed;
  const invalid = plan.entries.invalid.length;
  // 同名帳戶（兩張「悠遊卡」）才補群組小字
  const dupNames = dupSet(plan.checks.map((c) => c.name));
  const groupOf = (c: BalanceCheck): string => {
    if (!dupNames.has(c.name)) return "";
    const a = plan.accounts.find((x) => x.id === c.accountId) ?? accById[c.accountId];
    return a ? groupLabel(a.group_key) : "";
  };

  return (
    <>
      <header className="ns-tk-im-head">
        {fileName && <p className="file">{fileName}</p>}
        <p className="ns-tk-im-sum">
          帳戶 <b>{sm.accounts}</b> · 分類 <b>{sm.categories}</b> · 帳目 <b>{sm.transactions}</b> ·{ymd(sm.from)} – {ymd(sm.to)}
        </p>
        <PlanLines />
      </header>

      {plan.unsupported !== null && <p className="ns-tk-verdict bad">{plan.unsupported}</p>}

      <div className="ns-tk-im-rows">
        <div className="ns-tk-im-row">
          <span className="ic" aria-hidden>
            ＋
          </span>
          <span>新增</span>
          <span className="n">{plan.entries.inserts.length}</span>
        </div>
        <div className="ns-tk-im-row">
          <span className="ic" aria-hidden>
            ✎︎
          </span>
          <span>
            在財務管家有改過{changed.length > 0 && (
              <button type="button" className="tog" aria-expanded={modsOpen} onClick={() => setModsOpen((v) => !v)}>
                {modsOpen ? "收起" : "逐筆看"}
              </button>
            )}
          </span>
          <span className="n">{changed.length}</span>
          {modsOpen && changed.length > 0 && (
            <div className="ns-tk-im-mods">
              {changed.map((c) => (
                <ModRow key={c.id} c={c} choice={choices[c.id] ?? "theirs"} onChoice={(v) => store().setImportChoice(c.id, v)} />
              ))}
            </div>
          )}
        </div>
        <div className="ns-tk-im-row">
          <span className="ic" aria-hidden>
            ·
          </span>
          <span>Next Stop 有、備份沒有</span>
          <span className="n">{plan.extraLocal}</span>
          <span className="hint">預設保留——在財務管家刪掉的不會跟著刪</span>
        </div>
        {invalid > 0 && (
          <div className="ns-tk-im-row is-faint">
            <span className="ic" aria-hidden>
              −
            </span>
            <span>格式不支援，將略過</span>
            <span className="n">{invalid}</span>
            <span className="hint">{Array.from(new Set(plan.entries.invalid.map((x) => x.reason))).join("、")}</span>
          </div>
        )}
      </div>

      {plan.checks.length > 0 && (
        <>
          <div className="ns-tk-im-sec">
            <h3>餘額對帳</h3>
            <span className="rule" />
          </div>
          <p className="ns-tk-im-desc">
            填入財務管家「帳戶」頁目前的餘額，用來自動推算 {plan.adjust.total}筆差額是變多還是變少（可略過）。</p>
          <div className="ns-tk-recon">
            {plan.checks.map((c) => {
              const text = balanceText[c.mmUid] ?? "";
              const filled = text.trim() !== "";
              const g = groupOf(c);
              return (
                <label key={c.mmUid}>
                  <span className="nm">
                    {c.name}
                    {g && <small>{g}</small>}
                  </span>
                  <input
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="抄這裡"
                    aria-label={`${c.name}${g ? `（${g}）` : ""}的餘額`}
                    value={text}
                    onChange={(e) => store().setImportBalance(c.mmUid, e.target.value)}
                  />
                  <span className={`ck${filled && c.ok === false ? " bad" : ""}`} aria-label={filled ? (c.ok ? "對上" : "對不上") : undefined}>
                    {filled ? (c.ok === true ? "✓" : c.ok === false ? "✗" : "?") : ""}
                  </span>
                </label>
              );
            })}
          </div>
          <Verdict plan={plan} />
        </>
      )}

      <footer className="ns-tk-im-foot">
        <button type="button" className="ns-tk-btn quiet" onClick={onCancel}>
          取消
        </button>
        <button
          type="button"
          className="ns-tk-btn primary"
          disabled={plan.unsupported !== null}
          onClick={() => void store().runImport()}
        >
          匯入
        </button>
      </footer>
    </>
  );
}

function Verdict({ plan }: { plan: ImportPlan }) {
  const balanceText = useTicketStore((s) => s.imp.balanceText);
  const n = plan.checks.length;
  const filled = plan.checks.filter((c) => (balanceText[c.mmUid] ?? "").trim() !== "").length;
  const bad = plan.checks.filter((c) => (balanceText[c.mmUid] ?? "").trim() !== "" && c.ok === false);
  if (bad.length) {
    return (
      <p className="ns-tk-verdict bad">
        有 <b>{bad.length}</b> 個帳戶餘額對不上：{bad.map((c) => c.name).join("、")}
      </p>
    );
  }
  if (filled === n) {
    return (
      <p className="ns-tk-verdict ok">
        已調整 <b>{plan.adjust.total}</b> 筆（＋{plan.adjust.plus}／−{plan.adjust.minus}）✓ 全部對上
      </p>
    );
  }
  return (
    <p className="ns-tk-verdict">
      已填 <b>{filled}</b>／{n}——沒填的會先自動推算，匯入後再提醒你核對
    </p>
  );
}

const COL_LABEL: Record<string, string> = {
  kind: "類型",
  occurred_on: "日期",
  occurred_at: "時刻",
  account_id: "帳戶",
  to_account_id: "轉入帳戶",
  category_id: "分類",
  amount_minor: "金額",
  currency: "幣別",
  main_minor: "折算",
  account_minor: "帳戶額",
  to_amount_minor: "轉入金額",
  note: "備註",
};

function entryLine(e: EntryRow, dec: number): string {
  return `${moneyText(e.amount_minor, dec)}${e.note ? ` ${e.note}` : ""}`;
}

function ModRow({ c, choice, onChoice }: { c: ImportChange; choice: "theirs" | "ours"; onChoice(v: "theirs" | "ours"): void }) {
  const curByCode = useTicketStore((s) => s.curByCode);
  const dec = curByCode[c.incoming.currency]?.decimals ?? 2;
  const [, m, d] = c.incoming.occurred_on.split("-").map(Number);
  const noteOnly = c.cols.length === 1 && c.cols[0] === "note";
  return (
    <div className="ns-tk-im-mod">
      <span className="t">
        <small>
          {m}/{d}
        </small>
        {moneyText(c.incoming.amount_minor, dec)}
        <em>{c.cols.map((k) => COL_LABEL[k] ?? k).join("、")}</em>
      </span>
      <span className="diff">
        {noteOnly ? (
          <>
            <s>{c.local.note || "（空）"}</s> → {c.incoming.note || "（空）"}
          </>
        ) : (
          <>
            <s>{entryLine(c.local, dec)}</s> → {entryLine(c.incoming, dec)}
          </>
        )}
      </span>
      <span className="ns-tk-kind" role="group" aria-label="用哪一邊">
        <button type="button" aria-pressed={choice === "theirs"} onClick={() => onChoice("theirs")}>
          用財務管家的
        </button>
        <button type="button" aria-pressed={choice === "ours"} onClick={() => onChoice("ours")}>
          留 Next Stop 的
        </button>
      </span>
    </div>
  );
}

/* ───────── 結果卡 ───────── */

function Done({ onClose }: { onClose(): void }) {
  const outcome = useTicketStore((s) => s.imp.outcome);
  const part = useTicketStore((s) => s.imp.part);
  const after = useTicketStore((s) => s.imp.after);
  const plan = useTicketStore((s) => s.imp.plan);
  const curByCode = useTicketStore((s) => s.curByCode);
  const accById = useTicketStore((s) => s.accById);
  const rows: BalanceCheck[] = after ?? [];
  const anyInput = rows.some((r) => r.inputMinor !== null);
  const anyBad = rows.some((r) => r.ok === false);
  const dec = (code: string) => curByCode[code]?.decimals ?? 2;
  const dupNames = dupSet(rows.map((r) => r.name));
  const tombLine = part ? partSummary(part).tombLine : null;

  return (
    <div className="ns-tk-im-done">
      <div className="ns-tk-im-donehead">
        <p className="ns-tk-im-result">
          {outcome ? TK_TEXT.importResult(outcome.inserted, outcome.updated, outcome.skipped) : TK_TEXT.importResult(0, 0, 0)}
          {/* 第③階段（③契約 §5.6）：預算和預覽同一個口徑（有變動的對象數＋單月覆寫數，不是列數；收尾修正 nit n4） */}
          {outcome &&
            ` · 預算 ${part ? part.budgets.scopes : 0} 個${part && part.budgets.overrides > 0 ? `（${part.budgets.overrides} 個單月覆寫）` : ""} · 定期帳 ${outcome.repeats} 筆`}
        </p>
        <span className="ns-tk-im-seal">
          <SealReceipt size={46} fresh rotate={-5} title="領収" />
        </span>
      </div>
      {/* 沙盒代驗 D2：本機刪過的預算／定期照舊不復活，和預覽卡同一行小字說出來 */}
      {outcome && tombLine && <p className="ns-tk-im-plannote">{tombLine}</p>}
      {rows.length > 0 && (
        <table className="ns-tk-im-table">
          <thead>
            <tr>
              <th scope="col">帳戶</th>
              <th scope="col">Next Stop</th>
              <th scope="col">財務管家</th>
              <th scope="col" aria-label="對上了嗎" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const a = accById[r.accountId];
              return (
                <tr key={r.mmUid} className={r.ok === false ? "is-bad" : undefined}>
                  <th scope="row">
                    {r.name}
                    {a && dupNames.has(r.name) && <small>{groupLabel(a.group_key)}</small>}
                  </th>
                  <td>{moneyText(r.computedMinor, dec(r.currency))}</td>
                  <td>{r.inputMinor === null ? "" : moneyText(r.inputMinor, dec(r.currency))}</td>
                  <td className="ck">{r.ok === null ? "" : r.ok ? "✓" : "✗"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {(!anyInput || plan?.adjust.rule === "default") && (
        <p className="ns-tk-im-note">有幾筆差額是自動推算的——請對照財務管家「帳戶」頁的餘額確認一次。</p>
      )}
      {outcome && outcome.repeats > 0 && IMPORT_REPEATS_PAUSED && (
        <p className="ns-tk-im-note is-plan">
          {TK_TEXT.importPaused}
          <button type="button" className="ns-tk-btn quiet" onClick={() => useTicketStore.getState().openDialog({ kind: "repeats" })}>
            去定期帳 ›
          </button>
        </p>
      )}
      {anyBad && <p className="ns-tk-im-note is-bad">有帳戶餘額對不上：可以去帳戶點「調整餘額…」補一筆精算。</p>}
      <footer className="ns-tk-im-foot">
        <button type="button" className="ns-tk-btn primary" onClick={onClose}>
          關閉
        </button>
      </footer>
    </div>
  );
}
