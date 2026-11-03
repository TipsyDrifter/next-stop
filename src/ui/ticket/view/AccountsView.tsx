/**
 * AccountsView——售票口桌機的「帳戶」分頁（售票口④ 第二輪 D-票-77、79；桌機席）。
 * 頁首第四格「帳戶」（鍵 4；ViewSwitch）；頁首由 TicketLedger 畫（大標「帳戶」、stats 行「N 個帳戶・資產・負債」、「＋ 帳戶」）。
 * 長相照原型 prototypes/design-structure-獨立頁.html 場景 acct-a（資訊照原型，排法改成清單型——見下）：
 *
 *   div.ns-tk-accts
 *   ├─ section.ns-tk-ac-sec × 群組（groupAccounts：群組序固定＝ACCOUNT_GROUPS，只列未封存）
 *   │   ├─ .ns-tk-ac-sech      群組名（負債群組右標「負債」）・虛線・兩個以上時「合計 X」（主幣別，同手機）
 *   │   └─ ul.ns-tk-ac-list    每個帳戶一張卡 li > div.ns-tk-ac-card（role=button；點／Enter＝打開右側帳戶側板，那張卡框起來）
 *   │         名稱（同名補群組；外幣補幣別碼）＋「本月 收 ＋X　支 Y　轉入 Z　轉出 W」｜近六個月月底餘額的小走勢｜餘額＋幣別｜⋯
 *   └─ .ns-tk-ac-arch          「封存 N ▸」摺起（封存的卡同一種長相、淡一點，不能拖）
 *   沒有帳戶 ⇒ EmptyState「新增帳戶」。
 *
 * 數字：餘額＝store.balances（帳戶幣別；負債帳戶照現行就是負數）；本月＝accountCards[id].month.own 照 accountFlowParts（收、支、
 *   轉入、轉出、調整；兩殼同一套）；群組合計＝accountTotals 的主幣別淨額（同頁首與手機）；走勢＝accountCards[id].trend（6 點、舊到新）。
 *   accountCards 還沒算好時數字列留白、餘額照畫。
 * 排序：同群組內拖曳（共用 dragReorder，每個群組一份；放開對最新清單換算 indexOfAnchor → moveAccountTo）；
 *   卡上 Alt+↑↓＝moveAccount（鍵盤入口；拖曳是加速）。群組之間不能拖（同帳戶順序對話框）。
 * ⋯／右鍵（照帳戶側板已有的動作，不另發明）：改名（卡上就地改，Enter／失焦存、Esc 放棄）・調整餘額…（打開側板並展開精算列）・
 *   只看這個帳戶的帳（側欄篩選＋切回清單）・封存（askConfirm）／取消封存。
 * 排法：原型是一張四欄格（小群組併排）；共用拖曳只認上下（gapAt 只看 y），格子拖不了，所以照丙的寬度規範改成清單型——
 *   一個帳戶一列卡、跟帳簿同寬（.ns-tk-ledger > * 的 820；src/styles 沒有 --read-w token）。
 * 樣式在 ticket-4b.css「帳戶頁」區。
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTicketStore } from "../../../store/ticketStore";
import { ACCOUNT_GROUPS, MAIN_CURRENCY, accountTotals, archivedAccounts, groupAccounts, moneyText, type AccountRow } from "../../../domain/ticket";
import { accountFlowParts, type AccountCard } from "../../../domain/ticketView";
import { indexOfAnchor, useDragReorder } from "../../common/dragReorder";
import { EmptyState } from "../../common/EmptyState";
import { PopMenu, type PopMenuItem } from "../../common/PopMenu";
import { rowContextMenu } from "../../common/contextMenu";
import { IconDots, IconPlus } from "../../common/icons";
import { Money } from "../parts/Money";
import { acctLabel } from "../TicketLedger";
import { switchView } from "./ViewSwitch";
import "../ticket-4b.css";

const isLiability = (groupKey: string): boolean => ACCOUNT_GROUPS.some((g) => g.key === groupKey && g.liability);

/** 打開帳戶側板並展開「調整餘額」那一列（側板的精算狀態在 TicketPanel 裡，從外面只能按它的鈕） */
function openAdjust(id: string): void {
  useTicketStore.getState().openAccount(id);
  setTimeout(() => document.querySelector<HTMLButtonElement>(".ns-tk-panel .ns-tk-acctcard .ns-tk-adj button")?.click(), 0);
}

export function AccountsView() {
  const accounts = useTicketStore((s) => s.accounts);
  const [archOpen, setArchOpen] = useState(false);
  const groups = groupAccounts(accounts);
  const archived = archivedAccounts(accounts);
  const store = useTicketStore.getState;

  if (!groups.length && !archived.length) {
    return (
      <div className="ns-tk-book is-empty">
        <EmptyState
          tone="first"
          title="還沒有帳戶"
          action={{ label: "新增帳戶", icon: <IconPlus />, onClick: () => store().openDialog({ kind: "newAccount" }) }}
        />
      </div>
    );
  }

  return (
    <div className="ns-tk-accts">
      {groups.map(({ group, accounts: list }) => (
        <section key={group.key} className="ns-tk-ac-sec" aria-label={group.label}>
          <GroupHead label={group.label} liability={group.liability} list={list} />
          <GroupList groupKey={group.key} list={list} />
        </section>
      ))}
      {archived.length > 0 && (
        <section className="ns-tk-ac-arch" aria-label="已封存的帳戶">
          <button type="button" className="tog" aria-expanded={archOpen} onClick={() => setArchOpen(!archOpen)}>
            封存 {archived.length} {archOpen ? "▾" : "▸"}
          </button>
          {archOpen && (
            <ul className="ns-tk-ac-list is-archived">
              {archived.map((a) => (
                <li key={a.id}>
                  <Card account={a} />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

/* ───────── 群組頭 ───────── */

function GroupHead({ label, liability, list }: { label: string; liability: boolean; list: AccountRow[] }) {
  const balances = useTicketStore((s) => s.balances);
  const curByCode = useTicketStore((s) => s.curByCode);
  // 兩個以上才印合計：主幣別、外幣照目前匯率換（accountTotals，同頁首與手機的口徑）
  const sum = list.length > 1 ? accountTotals(list, balances, curByCode).net : null;
  return (
    <div className="ns-tk-ac-sech">
      <h3>
        {label}
        {liability && <span className="lia">負債</span>}
      </h3>
      <span className="rule" aria-hidden />
      {sum !== null && (
        <span className="sum">
          合計 <Money minor={sum} currency={MAIN_CURRENCY} />
        </span>
      )}
    </div>
  );
}

/* ───────── 一個群組的清單（各自一份拖曳） ───────── */

function GroupList({ groupKey, list }: { groupKey: string; list: AccountRow[] }) {
  const moveAccountTo = useTicketStore((s) => s.moveAccountTo);
  const [root, setRoot] = useState<HTMLUListElement | null>(null);
  useDragReorder({
    root,
    items: list.map((a) => ({ id: a.id })),
    onDrop: (ids, place) => {
      if (place.kind !== "slot") return;
      const latest = groupAccounts(useTicketStore.getState().accounts).find((g) => g.group.key === groupKey)?.accounts.map((a) => a.id) ?? [];
      const at = indexOfAnchor(latest, ids[0], place);
      if (at === null) return;
      void moveAccountTo(ids[0], at);
    },
  });
  return (
    <ul ref={setRoot} className="ns-tk-ac-list">
      {list.map((a, i) => (
        <li key={a.id} data-drag-id={a.id}>
          <Card account={a} first={i === 0} last={i === list.length - 1} />
        </li>
      ))}
    </ul>
  );
}

/* ───────── 一張帳戶卡 ───────── */

function Card({ account: a, first, last }: { account: AccountRow; first?: boolean; last?: boolean }) {
  const accounts = useTicketStore((s) => s.accounts);
  const balances = useTicketStore((s) => s.balances);
  const card = useTicketStore((s) => s.accountCards?.[a.id] ?? null);
  const panel = useTicketStore((s) => s.panel);
  const dec = useTicketStore((s) => s.curByCode[a.currency]?.decimals ?? 2);
  const store = useTicketStore.getState;
  const [menuAt, setMenuAt] = useState<HTMLElement | null>(null);
  const [renaming, setRenaming] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  const archived = a.archived_at !== null;
  const label = acctLabel(a, accounts);
  const bal = balances[a.id] ?? card?.balance ?? 0; // balances 每次 refresh 都是新的；card 是上次算卡時的快照
  const on = panel.kind === "account" && panel.id === a.id;

  const items: PopMenuItem[] = [
    { key: "rename", label: "改名", onSelect: () => setRenaming(true) },
    { key: "adjust", label: "調整餘額…", onSelect: () => openAdjust(a.id) },
    {
      key: "filter",
      label: "只看這個帳戶的帳",
      onSelect: () => {
        void store().setFilter(a.id);
        switchView("list");
      },
    },
    archived
      ? { key: "unarchive", label: "取消封存", cut: true, onSelect: () => void store().unarchiveAccount(a.id) }
      : { key: "archive", label: "封存", cut: true, danger: true, onSelect: () => store().archiveAccount(a.id) },
  ];

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      // 同群組內上下移（封存的不排序；邊界不動）
      e.preventDefault();
      e.stopPropagation();
      const up = e.key === "ArrowUp";
      if (archived || (up && first) || (!up && last)) return;
      // React 換位時搬的是聚焦的那個 DOM，焦點可能掉：搬完把焦點放回這張卡
      void store()
        .moveAccount(a.id, up ? -1 : 1)
        .then(() => requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-drag-id="${a.id}"] .ns-tk-ac-card`)?.focus({ preventScroll: true })));
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      store().openAccount(a.id);
    }
  };

  // 改名收起後焦點回卡上（鍵盤連著操作）
  const wasRenaming = useRef(false);
  useEffect(() => {
    if (wasRenaming.current && !renaming) cardRef.current?.focus({ preventScroll: true });
    wasRenaming.current = renaming;
  }, [renaming]);

  return (
    <>
      <div
        ref={cardRef}
        className={"ns-tk-ac-card" + (on ? " is-on" : "") + (archived ? " is-archived" : "") + (bal === 0 ? " is-zero" : "")}
        role="button"
        tabIndex={0}
        aria-label={`${label}：餘額 ${moneyText(bal, dec)} ${a.currency}`}
        aria-current={on ? "true" : undefined}
        title={archived ? undefined : "點一下看帳戶詳情・拖曳或 Alt+↑↓ 排順序"}
        onClick={() => store().openAccount(a.id)}
        onKeyDown={onKeyDown}
        onContextMenu={rowContextMenu(() => ({ overline: { zh: a.name, latin: "Account" }, label: `${label} 的動作`, items }))}
      >
        <div className="who">
          {renaming ? (
            <RenameInput name={a.name} onDone={() => setRenaming(false)} onCommit={(name) => void store().updateAccount(a.id, { name })} />
          ) : (
            <span className="nm">
              {a.name}
              {label !== a.name && <span className="g">{label.slice(a.name.length)}</span>}
            </span>
          )}
          <Flow card={card} dec={dec} />
        </div>
        <Spark card={card} liability={isLiability(a.group_key)} dec={dec} />
        <div className="bal">
          {moneyText(bal, dec)}
          <small>{a.currency}</small>
        </div>
        <button
          type="button"
          className="ns-iconbtn is-dim"
          aria-label={`更多動作：${label}`}
          title={items.map((it) => it.label).join("、")}
          aria-haspopup="menu"
          aria-expanded={menuAt !== null}
          onClick={(e) => {
            e.stopPropagation();
            const btn = e.currentTarget;
            setMenuAt((cur) => (cur ? null : btn));
          }}
        >
          <IconDots />
        </button>
      </div>
      {/* 選單放在卡外：portal 裡的點擊照 React 樹往上冒，放在卡裡會順便觸發卡的「開側板」 */}
      {menuAt && (
        <PopMenu anchor={menuAt} overline={{ zh: a.name, latin: "Account" }} label={`${label} 的動作`} items={items} onClose={() => setMenuAt(null)} />
      )}
    </>
  );
}

/** 「本月 收 ＋5,350　支 3,120　轉入 5,000」（accountFlowParts，同手機）；全沒有＝「本月沒有進出」；還沒算好＝空 */
function Flow({ card, dec }: { card: AccountCard | null; dec: number }) {
  if (!card) return <span className="io" />;
  const parts = accountFlowParts(card.month.own);
  return (
    <span className="io">
      <span className="lbl">本月</span>
      {parts.length === 0 ? (
        <span className="none">沒有進出</span>
      ) : (
        parts.map((p) => {
          // 收入與調整是正的才加「＋」（收入退回多於收入時不寫成「＋−」）；金只給收入＋
          const plus = (p.key === "income" || p.key === "adjust") && p.minor > 0;
          return (
            <span key={p.key}>
              {p.label} <b className={plus && p.key === "income" ? "pos" : undefined}>{moneyText(p.minor, dec, plus ? { prefix: "＋" } : undefined)}</b>
            </span>
          );
        })
      )}
    </span>
  );
}

/** 近六個月月底餘額的小走勢（折線；六點都一樣＝一條虛線）；下面小字「6–11月」 */
function Spark({ card, liability, dec }: { card: AccountCard | null; liability: boolean; dec: number }) {
  if (!card || !card.trend.length) return <span className="spark" aria-hidden />;
  const pts = card.trend.map((t) => t.balance);
  const lo = Math.min(...pts);
  const hi = Math.max(...pts);
  const W = 100;
  const H = 28;
  const y = (v: number) => (hi === lo ? H / 2 : 2 + (1 - (v - lo) / (hi - lo)) * (H - 4));
  const x = (i: number) => (pts.length === 1 ? W : (i / (pts.length - 1)) * W);
  const d = pts.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const m0 = Number(card.trend[0].month.slice(5, 7));
  const m1 = Number(card.trend[card.trend.length - 1].month.slice(5, 7));
  // 負債帳戶說「欠款」就把正負翻過來（餘額是負數，不寫成「欠款 −3,120」；溢繳時才是負的）
  const title =
    (liability ? "近六個月月底欠款：" : "近六個月月底餘額：") +
    card.trend.map((t) => `${Number(t.month.slice(5, 7))}月 ${moneyText(liability ? -t.balance : t.balance, dec)}`).join("、");
  return (
    <span className="spark" title={title}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-label={title} role="img">
        {hi === lo ? <line className="base" x1={0} x2={W} y1={H / 2} y2={H / 2} /> : <path className="ln" d={d} />}
      </svg>
      <small>
        {m0}–{m1}月
      </small>
    </span>
  );
}

/** 卡上就地改名：Enter／失焦存（空白或沒變不送）、Esc 放棄 */
function RenameInput({ name, onCommit, onDone }: { name: string; onCommit(name: string): void; onDone(): void }) {
  const [text, setText] = useState(name);
  const done = useRef(false);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const v = text.trim();
    if (save && v && v !== name) onCommit(v);
    onDone();
  };
  return (
    <input
      className="techo-input nm-in"
      value={text}
      autoFocus
      aria-label="帳戶名稱"
      autoComplete="off"
      spellCheck={false}
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        e.stopPropagation(); // 卡的 Enter／Space（開側板）與頁面鍵盤表都不接
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === "Enter") {
          e.preventDefault();
          finish(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(false);
        }
      }}
    />
  );
}
