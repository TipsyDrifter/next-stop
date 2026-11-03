/**
 * TodayRepeat——今日頁統計列的「定期 N 筆 −X」（售票口④ D-票-72；插槽 `todayStats`，接縫 #66；雜項席）。
 * 長相照原型 questions.js 題七（截圖 7-desktop／7-mobile）；接法照時刻表的 `TodayFocus`。
 *
 * 內容＝今天由定期規則記出來、還在的帳（store `repeatEntriesOn(dateKey)`：`isRepeatMade`；「設成定期…」連上的來源那筆、
 * 改過日期的那筆不算）。今日頁的 dateKey（日界線日）就是帳的 occurred_on，不換算。今天沒有 ⇒ 回 null（整段不出）。
 * 數字＝`repeatDaySum`：筆數全算；金額＝收入 − 支出（主幣別；轉帳校正不入），負「−」、正「＋」（售票口收入前綴例外）；
 * 全是轉帳校正（沒有收支）⇒ 只寫「定期 N 筆」。重查依據＝`entriesVersion`（refresh、實體化各 +1）與 dateKey。
 *
 *   桌機：{lead && <span class="sep">・</span>}<span class="ns-tk-todayrep-wrap"><button class="ns-tk-todayrep">定期 <b>1</b> 筆 <b>−12,000</b></button>
 *         ＋滑過／聚焦時的浮層 .ns-tk-todaytip（列出是哪幾筆：分類、金額、規則・帳戶；尾行「點一下到售票口 11/5」）</span>
 *   手機：<span class="m-today-left">・</span><button class="ns-tk-todayrep">定期 1 筆 −12,000</button>（點擊區撐到 44px；
 *         手機沒有滑過，哪幾筆寫進 aria-label）；`wrap`（核心今天沒畫統計列）⇒ 外面自己包 `<p class="m-today-stats">`。
 * 點了：分殼切到售票口（桌機切頁、手機切 tab；同 quickJump）→ 等售票口 init（從沒開過也不會被 init 蓋回）→
 *   `jumpToRepeatDay(dateKey)`：選中並攤開那天第一筆定期帳（好幾筆＝浮層第一列那筆；代驗 O5，以前選中的是那天第一列）；
 *   那天已經沒有 ⇒ 退回 jumpToDay。
 *
 * 位置：桌機插槽本來就畫在「下一班」前面（TodayView 的 stats 陣列：完成 → 各線 todayStats → 下一班）；
 * 手機 MobileToday 把插槽畫在統計列尾端（「下一班」後面），本元件改不了順序——見施工回報。
 */
import { useEffect, useId, useState, type KeyboardEvent } from "react";
import { MAIN_CURRENCY, categoryLabel, moneyText, type EntryRow } from "../../../domain/ticket";
import { describeRule } from "../../../domain/repeat";
import { parseFixedRule, quickOfRule, quickRepeatLabel, repeatDaySum } from "../../../domain/ticketPlan";
import { shortDay } from "../../../domain/ticketView";
import { useTicketStore } from "../../../store/ticketStore";
import { useUiStore } from "../../../store/uiStore";
import "../ticket-4-extras.css";

/** 這一段的字（只在這一支用） */
const TEXT = {
  head: "今天自動記的定期帳",
  go: (day: string) => `點一下到售票口 ${day}`,
} as const;

/** 金額帶號：負「−」（moneyText 自己帶）、正「＋」 */
function signed(minor: number, dec: number): string {
  return moneyText(minor, dec, { prefix: minor > 0 ? "＋" : undefined });
}

/** 浮層一列的字：名稱（分類／轉帳兩端）、金額（原幣）、小字（規則・帳戶） */
function lineOf(e: EntryRow): { name: string; amount: string; sub: string } {
  const s = useTicketStore.getState();
  const cur = s.curByCode[e.currency];
  const dec = cur?.decimals ?? s.curByCode[MAIN_CURRENCY]?.decimals ?? 0;
  const code = e.currency !== MAIN_CURRENCY ? ` ${e.currency}` : "";
  const acc = (id: string | null) => (id ? s.accById[id]?.name : undefined) ?? "（帳戶已刪除）";
  const rep = e.repeat_id ? s.repeats.find((r) => r.id === e.repeat_id) : undefined;
  const rule = rep ? parseFixedRule(rep.rule) : null;
  const q = rule ? quickOfRule(rule) : null;
  const ruleText = rule ? (q ? quickRepeatLabel(q) : describeRule(rule)) : "";
  if (e.kind === "transfer") {
    return { name: `${acc(e.account_id)} → ${acc(e.to_account_id)}`, amount: moneyText(Math.abs(e.amount_minor), dec) + code, sub: ruleText };
  }
  if (e.kind === "adjust") {
    return { name: "精算", amount: signed(e.amount_minor, dec) + code, sub: [ruleText, acc(e.account_id)].filter(Boolean).join(" · ") };
  }
  // 支出 −（退款＝負的支出 ⇒ ＋）、收入 ＋
  const v = e.kind === "income" ? e.amount_minor : -e.amount_minor;
  const name = e.category_id === null ? "未分類" : categoryLabel(s.catById[e.category_id] ?? null, s.catById);
  return { name, amount: signed(v, dec) + code, sub: [ruleText, acc(e.account_id)].filter(Boolean).join(" · ") };
}

/** 點了：分殼切到售票口 → 等 init → 跳到那天第一筆定期帳 */
async function goDay(shell: "desktop" | "mobile", dayKey: string): Promise<void> {
  const ui = useUiStore.getState();
  if (shell === "mobile") ui.setMobileTab("ticket");
  else ui.setPage("ticket");
  try {
    // 從沒開過售票口：頁面的 init 會把月份設成本月、清掉選取——先等它跑完再跳（同 jumpToEntry）
    await useTicketStore.getState().init(shell);
  } catch {
    return; // 初始化失敗：頁面自己會顯示錯誤
  }
  await useTicketStore.getState().jumpToRepeatDay(dayKey);
}

export function TodayRepeat({
  shell,
  dateKey,
  lead,
  wrap,
}: {
  shell: "desktop" | "mobile";
  dateKey: string;
  lead: boolean;
  wrap: boolean;
}) {
  const version = useTicketStore((s) => s.entriesVersion);
  const mainDec = useTicketStore((s) => s.curByCode[MAIN_CURRENCY]?.decimals ?? 0);
  // 浮層的分類、帳戶、規則字要跟著改名重畫
  useTicketStore((s) => s.catById);
  useTicketStore((s) => s.accById);
  useTicketStore((s) => s.repeats);
  const [rows, setRows] = useState<{ day: string; list: EntryRow[] } | null>(null);
  const [tip, setTip] = useState(false);
  const tipId = useId();

  useEffect(() => {
    let alive = true;
    useTicketStore
      .getState()
      .repeatEntriesOn(dateKey)
      .then((list) => {
        if (alive) setRows({ day: dateKey, list });
      })
      .catch((e: unknown) => {
        console.warn("[ticket] 今日頁讀定期帳失敗", e); // 讀不到＝不出這一段，今日頁照常
        if (alive) setRows(null);
      });
    return () => {
      alive = false;
    };
  }, [dateKey, version]);

  const list = rows && rows.day === dateKey ? rows.list : [];
  if (!list.length) return null;

  const sum = repeatDaySum(list);
  const hasMoney = list.some((e) => e.deleted_at === null && (e.kind === "income" || e.kind === "expense"));
  const amount = hasMoney ? signed(sum.net, mainDec) : null;
  const lines = list.map((e) => ({ id: e.id, ...lineOf(e) }));
  const go = () => void goDay(shell, dateKey);

  if (shell === "mobile") {
    const aria = `定期 ${sum.count} 筆${amount ? ` ${amount}` : ""}：${lines.map((l) => `${l.name} ${l.amount}`).join("、")}。${TEXT.go(shortDay(dateKey))}`;
    const inner = (
      <>
        {lead && <span className="m-today-left">・</span>}
        <button type="button" className="ns-tk-todayrep" aria-label={aria} onClick={go}>
          定期 {sum.count} 筆{amount && ` ${amount}`}
        </button>
      </>
    );
    return wrap ? <p className="m-today-stats">{inner}</p> : inner;
  }

  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "Escape" && tip) {
      e.stopPropagation();
      setTip(false);
    }
  };

  return (
    <>
      {lead && <span className="sep">・</span>}
      <span className="ns-tk-todayrep-wrap" onMouseEnter={() => setTip(true)} onMouseLeave={() => setTip(false)}>
        <button
          type="button"
          className="ns-tk-todayrep"
          aria-describedby={tip ? tipId : undefined}
          onFocus={() => setTip(true)}
          onBlur={() => setTip(false)}
          onKeyDown={onKey}
          onClick={go}
        >
          定期 <b>{sum.count}</b> 筆{amount && <> <b>{amount}</b></>}
        </button>
        {tip && (
          <span id={tipId} role="tooltip" className="ns-tk-todaytip">
            <span className="hd">{TEXT.head}</span>
            {lines.map((l) => (
              <span key={l.id} className="li">
                <span className="nm">{l.name}</span>
                <b>{l.amount}</b>
                {l.sub && <small>{l.sub}</small>}
              </span>
            ))}
            <span className="go">{TEXT.go(shortDay(dateKey))}</span>
          </span>
        )}
      </span>
    </>
  );
}
