/**
 * MobileToday——今日視圖手機版（v1.1.0；WP1）＝副平台的落地頁。
 *
 * 拍板依據：D-1.1-2「副平台最小操作＝看今日、蓋済、推遲到明天、開臨時車票」＋契約 §2.7 的呼叫表。
 * 狀態機在 `useMobileToday.ts`（載入／蓋済／推遲／建票），本檔只負責畫與三個覆蓋層以外的本地互動：
 *   ⋯ 開的底部 action sheet（本地 useState；不進 uiStore——它只活在這一頁，關頁就該消失）。
 *
 * 版面（由上而下，單欄滿版）：
 *   .m-page  統計一行 → 誤點區（**置頂**＝r1 拍板）→「今天的列車」清單／空狀態
 *   .m-newticket  固定在 tab bar 之上的建票輸入列（不在 .m-page 內＝不跟著捲走）
 *
 * 與桌機今日視圖刻意不同的四處（都在契約的「不做」清單裡，記在這裡免得日後被當成遺漏）：
 *   1. 沒有頁首日期與日付印——日付印在頂帶（MobileTopBand），同一個畫面不蓋兩枚。
 *   2. 沒有紀念章（StationStamp 122px）、沒有頁尾 Day N/365：單欄 375px 放不下又不是每日操作。
 *   3. 誤點區**可摺疊、但不共用 `uiStore.lateCollapsed`**（2026-09-16 評審 S2 改）：
 *      共用會讓手機收起來的狀態跟著回桌機（那是桌機鍵盤流的記憶），所以用本頁的 useState，
 *      與 WP2 路線圖 zoom／收合的作法同一套。原本「不摺」的理由（誤點本來就該被看見）只對了一半——
 *      誤點 5 件時「今天的列車」第一張票要到 615dp 才出現，394×853 的首屏只剩一張半，
 *      主任務被推出畫面。折衷＝預設展開（一開啟仍看得見）、計數常駐、可收起。
 *   4. 不做拖曳排序、不開詳情側板、不開完成卡（契約 §2.7 的「不呼叫」清單）。
 *
 * 空狀態文案沿桌機（TodayView 的 1.0c／1.0d 兩塊逐字）；只有操作提示那一句改寫成觸控說法
 *   （桌機原句是「按 Enter 開一張臨時車票；或到路線圖（Ctrl+2）…按 T 排上今天」——手機沒有這些鍵）。
 */
import { useRef, useState, type KeyboardEvent } from "react";
import { useNodeStore } from "../../store/nodeStore";
import { MobileTicket } from "./MobileTicket";
import { useMobileToday } from "./useMobileToday";
import { isSettledRow } from "../today/useTodayController";

export default function MobileToday() {
  const c = useMobileToday();
  /** ⋯ 開的 action sheet 指向哪一列（null＝關著） */
  const [sheetId, setSheetId] = useState<string | null>(null);
  /** 誤點區展開與否（本地 state，預設展開；不進 uiStore＝不污染桌機的 lateCollapsed，見檔頭 3） */
  const [lateOpen, setLateOpen] = useState(true);
  const sheetRow = useNodeStore((s) => (sheetId ? (s.today.byId[sheetId] ?? null) : null));

  const { total, done, left } = c.stats;
  const allSettled = !c.empty && left === 0 && c.lateRows.every((r) => r.occurrence !== null || r.status === "done");

  return (
    <>
      <div className="m-page m-today">
        {total > 0 && (
          <p className="m-today-stats">
            完成 <b>{done}</b>/<b>{total}</b>
            {left > 0 && <span className="m-today-left">・還有 {left} 張</span>}
          </p>
        )}

        {/* ═══ 誤點區（置頂＝r1 拍板；含 D-③-7 浮上來的締切段）═══ */}
        {c.lateRows.length > 0 && (
          <>
            <div className="sec late">
              <h3>誤點</h3>
              <span className="rule" />
              {/* 摺疊鈕＝計數本身（語彙逐字同桌機 TodayView：「N 件」＋▾，收起時箭頭轉 -90°）。
                  觸控目標 44px 由 mobile.css 的負 margin 撐出來，段距視覺不變。 */}
              <button
                type="button"
                aria-expanded={lateOpen}
                aria-label={`誤點 ${c.lateRows.length} 件，${lateOpen ? "收起" : "展開"}`}
                onClick={() => setLateOpen((v) => !v)}
                className="note fold"
              >
                {c.lateRows.length} 件
                <span className="caret" aria-hidden>
                  ▾
                </span>
              </button>
            </div>
            {lateOpen && (
              <ul className="m-tk-list" aria-label="誤點">
                {c.lateRows.map((r) => (
                  <MobileTicket
                    key={r.id}
                    row={r}
                    route={c.routeOf(r)}
                    dateKey={c.dateKey}
                    fresh={c.freshId === r.id}
                    onComplete={c.complete}
                    onMore={setSheetId}
                  />
                ))}
              </ul>
            )}
          </>
        )}

        {/* ═══ 今天的列車 ═══ */}
        {c.empty ? (
          <div className="m-empty">
            <div className="sec">
              <h3>今天還沒有班次</h3>
              <span className="rule" />
            </div>
            <p className="m-empty-body">在下面的輸入列打一件事，按「発券」就開一張臨時車票。</p>
          </div>
        ) : (
          <>
            {c.todayRows.length > 0 && (
              <>
                <div className="sec">
                  <h3>今天的列車</h3>
                  <span className="rule" />
                  <span className="note">{total} 張</span>
                </div>
                <ul className="m-tk-list" aria-label="今天的列車">
                  {c.todayRows.map((r) => (
                    <MobileTicket
                      key={r.id}
                      row={r}
                      route={c.routeOf(r)}
                      dateKey={c.dateKey}
                      fresh={c.freshId === r.id}
                      onComplete={c.complete}
                      onMore={setSheetId}
                    />
                  ))}
                </ul>
              </>
            )}

            {/* 1.0d 全完成慶祝（語氣與 1.0c 分開：這裡是收工，不是招募）——文案逐字同桌機 */}
            {allSettled && (
              <div className="m-empty is-cheer">
                <div className="sec">
                  <h3>今天的班次都到站了</h3>
                  <span className="rule" />
                </div>
                <p className="m-empty-body">剩下的時間是你的。明天要跑的，可以到路線圖先排好。</p>
              </div>
            )}
          </>
        )}
      </div>

      <MobileNewTicket onCreate={c.createTicket} />

      {sheetRow && (
        <MobileActionSheet
          name={sheetRow.name}
          settled={isSettledRow(sheetRow)}
          onDefer={() => {
            c.deferTomorrow(sheetRow.id);
            setSheetId(null);
          }}
          onClose={() => setSheetId(null)}
        />
      )}
    </>
  );
}

/* ═══════════════════════════════════════════════════════
 * 建票輸入列——固定在 tab bar 之上（不在 .m-page 內，捲動時不會跑掉）
 * ═══════════════════════════════════════════════════════ */

/**
 * 兩種票共用一條輸入列，靠「無日期」切換選目的地（沿桌機 Enter／Shift+Enter 的兩條種子動線）：
 *   關＝臨時車票排今天（票留在眼前，看得見＝不出收據）
 *   開＝無日期票進收件匣（票立刻離開今日，toast 是唯一收據、帶「取消建立」）
 * 切換是 `role="switch"` 的常駐鈕而不是「長按送出」：長按在觸控上沒有可見的前置提示，
 *   主人按下去之前不知道會發生什麼；一顆亮著的「無日期」把狀態攤在檯面上。
 *
 * IME 守門（鐵則 5）：`isComposing‖keyCode===229` 之外再加一支 composition 旗標——
 *   Android 部分 IME 送出的 keydown 既不帶 isComposing 也不是 229（Plan 草案 §5 的已知雷）。
 *   `enterKeyHint="done"` 讓 Android 軟鍵盤右下角顯示「完成」而不是換行。
 */
function MobileNewTicket({ onCreate }: { onCreate(name: string, inbox: boolean): Promise<boolean> }) {
  const [text, setText] = useState("");
  const [inbox, setInbox] = useState(false);
  const composing = useRef(false);

  const submit = async () => {
    if (!text.trim()) return;
    const ok = await onCreate(text, inbox);
    // 成功才清空＝失敗時主人打的字還在（createNode 回 null 已經吐過 toast）。
    // 不主動 blur：連打是預期用法（桌機 Enter 之後草稿列會續開一張），鍵盤收掉反而礙事。
    if (ok) setText("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    if (e.nativeEvent.isComposing || e.keyCode === 229 || composing.current) return;
    e.preventDefault();
    void submit();
  };

  return (
    <div className="m-newticket">
      <button
        type="button"
        role="switch"
        aria-checked={inbox}
        aria-label="無日期——建好直接放進收件匣"
        onClick={() => setInbox((v) => !v)}
        className={"m-nt-toggle" + (inbox ? " is-on" : "")}
      >
        無日期
      </button>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        placeholder={inbox ? "放進收件匣的一件事…" : "臨時想到的一件事…"}
        aria-label={inbox ? "輸入收件匣車票的名稱" : "輸入臨時車票的名稱"}
        enterKeyHint="done"
        spellCheck={false}
        autoComplete="off"
        className="m-nt-input"
      />
      <button
        type="button"
        onClick={() => void submit()}
        disabled={!text.trim()}
        className="m-nt-go ns-btn btn-seal"
      >
        発券
      </button>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════
 * 底部 action sheet——⋯ 的唯一用途（v1.1.0 只有「推遲到明天」）
 * ═══════════════════════════════════════════════════════ */

/**
 * 為什麼是底部 sheet 而不是桌機那張 DeferPopover：小卡是 anchor 定位＋日期選擇＋定期券分支的完整浮層，
 *   手機版 v1.1.0 只做「推遲到明天」一項（契約 §2.7），一張錨在票旁的小卡反而遮住列。
 *   底部 sheet 的好處是拇指按得到、暗幕點哪都關得掉。
 * 「取消」是清清楚楚的一格，不只依賴點暗幕——觸控裝置上暗幕關閉是隱性知識。
 */
function MobileActionSheet({
  name,
  settled,
  onDefer,
  onClose,
}: {
  name: string;
  /** 已蓋済／運休：推遲項改成一行說明、不可點（與桌機「settled 列不出＋執行日」同款） */
  settled: boolean;
  onDefer(): void;
  onClose(): void;
}) {
  return (
    <div className="m-sheet-veil techo-veil" role="presentation" onClick={onClose}>
      <div
        className="m-sheet ns-card"
        role="dialog"
        aria-modal="true"
        aria-label={`車票動作——${name}`}
        onClick={(e) => e.stopPropagation()}
      >
        <p className="m-sheet-title">{name}</p>
        {settled ? (
          <p className="m-sheet-item is-disabled">已蓋済——先取消済章才能推遲</p>
        ) : (
          <button type="button" onClick={onDefer} className="m-sheet-item">
            推遲到明天
          </button>
        )}
        <button type="button" onClick={onClose} className="m-sheet-item is-cancel">
          取消
        </button>
      </div>
    </div>
  );
}
