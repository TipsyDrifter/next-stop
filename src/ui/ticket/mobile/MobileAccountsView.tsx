/**
 * MobileAccountsView——售票口手機的「帳戶」分頁（售票口④ 第二輪 D-票-77、79；手機席；原型 prototypes/design-structure-獨立頁.html
 * 「帳戶 A・手機」）。MobileTicketOffice 在 `view === "accounts"` 時畫它（分頁籤列第四格，跟清單／月曆／統計同一層、不登記返回層）；
 * 上面照舊是合計帶（資產／負債／合計），帳戶卡橫捲列與月份列在這一頁不出（這一頁本身就是完整的帳戶目錄，帳戶頁沒有月份可翻）。
 *
 * 由上而下：
 *   一行「N 個帳戶」＋右端「＋ 帳戶」（開新增帳戶 sheet，同帳戶卡橫捲列最後那張「＋」）
 *   → 照群組分段（ACCOUNT_GROUPS 的順序；負債群組標「負債」；兩個以上的群組在段頭右端寫合計，主幣別）
 *     每張卡：名稱・餘額大字（外幣帶幣別小字；0 淡）・右邊近六個月月底餘額小走勢（store.accountCards，D-票-79）
 *            ・下一行「本月 收 ＋X　支 Y　轉入 Z　轉出 W　調整 V」（accountFlowParts，同桌機；帳戶幣別；沒有的那項不寫，
 *              全沒有＝「本月沒有進出」）・右端 ›
 *     點卡＝手機帳戶頁（MobileAccountPage：改名、群組、幣別、調整餘額、看這個帳戶的帳、在這個帳戶記一筆、封存）；
 *     長按 400ms 浮起拖曳排序（共用 dragReorder，每個群組各自一份 ⇒ 拖不出群組；放開對最新清單換算 indexOfAnchor → moveAccountTo）。
 *     拖曳的替代入口＝管帳「帳戶順序」（↑↓，觸控與讀屏都點得到）。
 *   →「封存 N」摺起來（預設收）；攤開是同樣的卡（淡、不能拖），點了進帳戶頁取消封存
 * 數字：餘額＝store.balances（card.balance 是上次算卡時的快照，只當備用）；群組合計＝accountTotals 的主幣別淨額（同桌機）；本月＝今天所在的月（日界線），不跟頁首月份、不跟側欄帳戶篩選（Stage 0 判斷 11、12）。
 * 樣式在 ticket-4b-mobile.css（`.ns-tk-mac*`）。
 */
import { useRef, useState } from "react";
import { useTicketStore } from "../../../store/ticketStore";
import { useDragReorder, indexOfAnchor } from "../../common/dragReorder";
import { EmptyState } from "../../common/EmptyState";
import {
  MAIN_CURRENCY,
  accountTotals,
  archivedAccounts,
  groupAccounts,
  moneyText,
  type AccountRow,
} from "../../../domain/ticket";
import { accountFlowParts, type AccountCard, type AccountFlow } from "../../../domain/ticketView";
import { IconPlus, IconRight } from "./mobileBits";
import { useViewSwipe } from "./MobileViewBar";

export function MobileAccountsView() {
  const accounts = useTicketStore((s) => s.accounts);
  const cards = useTicketStore((s) => s.accountCards);
  const balances = useTicketStore((s) => s.balances);
  const curByCode = useTicketStore((s) => s.curByCode);
  const openDialog = useTicketStore((s) => s.openDialog);
  const [archOpen, setArchOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useViewSwipe(rootRef);

  const groups = groupAccounts(accounts);
  const archived = archivedAccounts(accounts);
  const liveCount = groups.reduce((n, g) => n + g.accounts.length, 0);
  const main = curByCode[MAIN_CURRENCY];
  const mainDec = main?.decimals ?? 2;
  const add = () => openDialog({ kind: "newAccount" });

  /** 群組合計（主幣別；外幣照目前匯率換＝合計帶 accountTotals，同桌機） */
  const groupSum = (list: readonly AccountRow[]) => moneyText(accountTotals(list, balances, curByCode).net, mainDec);

  if (liveCount === 0 && archived.length === 0) {
    return (
      <div className="ns-tk-mac" ref={rootRef}>
        <EmptyState tone="first" className="ns-tk-mblank" title="還沒有帳戶" action={{ label: "新增帳戶", icon: <IconPlus />, onClick: add }} />
      </div>
    );
  }

  return (
    <div className="ns-tk-mac" ref={rootRef}>
      <div className="ns-tk-mac-sub">
        <span>{liveCount} 個帳戶</span>
        <button type="button" className="ns-btn btn-ghost ns-btn--sm" aria-haspopup="dialog" onClick={add}>
          <IconPlus />
          帳戶
        </button>
      </div>
      {cards === null && (
        <p className="ns-tk-mnone" aria-busy="true">
          正在算…
        </p>
      )}
      {groups.map(({ group, accounts: list }) => (
        <section key={group.key} className="ns-tk-mac-grp" aria-label={group.label}>
          <h3 className="hd">
            {group.label}
            {group.liability && <span className="lia">負債</span>}
            {list.length > 1 && <span className="s">{groupSum(list)}</span>}
          </h3>
          <GroupCards groupKey={group.key} list={list} cards={cards} />
        </section>
      ))}
      {archived.length > 0 && (
        <div className="ns-tk-mac-arch">
          <button type="button" className="tog" aria-expanded={archOpen} onClick={() => setArchOpen(!archOpen)}>
            封存 {archived.length}
            <IconRight size={11} />
          </button>
          {archOpen && (
            <ul className="ns-tk-mac-list">
              {archived.map((a) => (
                <li key={a.id}>
                  <Card account={a} card={cards?.[a.id] ?? null} archived />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/* ───────── 一個群組的卡（各自一份長按拖曳） ───────── */

function GroupCards({ groupKey, list, cards }: { groupKey: string; list: AccountRow[]; cards: Record<string, AccountCard> | null }) {
  const moveAccountTo = useTicketStore((s) => s.moveAccountTo);
  const [root, setRoot] = useState<HTMLUListElement | null>(null);
  useDragReorder({
    root,
    items: list.map((a) => ({ id: a.id })),
    onDrop: (ids, place) => {
      if (place.kind !== "slot") return;
      const latest = groupAccounts(useTicketStore.getState().accounts).find((g) => g.group.key === groupKey)?.accounts.map((a) => a.id) ?? [];
      const at = indexOfAnchor(latest, ids[0], place);
      if (at !== null) void moveAccountTo(ids[0], at);
    },
  });
  return (
    <ul ref={setRoot} className="ns-tk-mac-list">
      {list.map((a) => (
        <li key={a.id} data-drag-id={a.id}>
          <Card account={a} card={cards?.[a.id] ?? null} />
        </li>
      ))}
    </ul>
  );
}

/* ───────── 一張帳戶卡 ───────── */

function Card({ account: a, card, archived = false }: { account: AccountRow; card: AccountCard | null; archived?: boolean }) {
  const openAccount = useTicketStore((s) => s.openAccount);
  const balances = useTicketStore((s) => s.balances);
  const dec = useTicketStore((s) => s.curByCode[a.currency]?.decimals ?? 2);
  const bal = balances[a.id] ?? card?.balance ?? 0; // balances 每次 refresh 都是新的；card 是上次算卡時的快照
  const open = () => openAccount(a.id);
  return (
    // 不用 button：長按要能從卡上起拖（共用拖曳元件在按鈕上按下不起拖；同願望清單的列）
    <div
      className={"ns-tk-mac-card" + (archived ? " is-arch" : "")}
      role="button"
      tabIndex={0}
      aria-label={`${a.name}，餘額 ${moneyText(bal, dec)}${a.currency !== MAIN_CURRENCY ? " " + a.currency : ""}：帳戶頁`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
    >
      <span className="n">{a.name}</span>
      <span className={"b" + (bal === 0 ? " is-zero" : "")}>
        {moneyText(bal, dec)}
        {a.currency !== MAIN_CURRENCY && <small>{a.currency}</small>}
      </span>
      {card && <Spark trend={card.trend.map((t) => t.balance)} />}
      <span className="io">{card ? <FlowText flow={card.month.own} dec={dec} /> : null}</span>
      <span className="go" aria-hidden>
        <IconRight size={13} />
      </span>
    </div>
  );
}

/** 「本月 收 ＋X　支 Y　轉入 Z　轉出 W　調整 V」（accountFlowParts，同桌機）：沒有的那項不寫；收入＋金字（售票口收入的例外色） */
function FlowText({ flow, dec }: { flow: AccountFlow; dec: number }) {
  const parts = accountFlowParts(flow);
  if (parts.length === 0) return <>本月沒有進出</>;
  return (
    <>
      本月
      {parts.map((p) => {
        // 收入與調整是正的才加「＋」（收入退回多於收入時不寫成「＋−」）；金只給收入＋
        const plus = (p.key === "income" || p.key === "adjust") && p.minor > 0;
        return (
          <span key={p.key} className="it">
            {p.label} <b className={plus && p.key === "income" ? "pos" : undefined}>{moneyText(p.minor, dec, plus ? { prefix: "＋" } : undefined)}</b>
          </span>
        );
      })}
    </>
  );
}

/** 近六個月月底餘額的小折線（96×30；同原型 sparkPath：上下各留 3px、全平＝底部一條虛線） */
const SPARK_W = 96;
const SPARK_H = 30;
function Spark({ trend }: { trend: readonly number[] }) {
  if (trend.length < 2) return null;
  const mn = Math.min(...trend);
  const mx = Math.max(...trend);
  const flat = mx === mn;
  const span = mx - mn || 1;
  const pts = trend.map((v, i) => [(i * SPARK_W) / (trend.length - 1), flat ? SPARK_H - 2 : SPARK_H - 3 - ((v - mn) / span) * (SPARK_H - 6)]);
  const last = pts[pts.length - 1];
  return (
    <svg className="sp" viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" role="img" aria-label="近六個月月底餘額">
      {flat ? (
        <line className="base" x1={0} y1={last[1]} x2={SPARK_W} y2={last[1]} />
      ) : (
        <>
          <path className="ln" d={"M" + pts.map((p) => p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" L")} />
          <circle className="pt" cx={last[0]} cy={last[1]} r={2} />
        </>
      )}
    </svg>
  );
}
