/**
 * DeferPopover——推遲小卡（M3 ③ WP3；決策 D-③-6 乙、種子動線 M3-6）。
 *
 * 入口：今日列的執行日 chip（`.chip.chip-btn`）→ useTodayController.openDefer(id, anchor) → TodayView 渲染本元件。
 * 四項（拍板逐字）：**明天／下週一／選日期…／清除執行日**。
 *
 * **資料來源＝props 注入的 `row`（M3 ⑤ WP1 解耦，草案 §4-3）**：本元件不查 `today.byId`——
 * 日曆當日清單浮層的列不在今日切片裡。行為零改動；形狀見 `DeferRow`。
 *
 * **定期券版（M3 ④ D-④-3）**：同一枚 chip、同一張卡，內容整個換掉——定期券的班次由規則排定，
 * 四項改期一項都不給（給了也會被 repository throw），改成兩項：
 *   〔本班運休／取消運休（依 `row.occurrence.status` 二擇一）〕＋〔編輯重複規則…（＝開側板，與 `.` 同一個去處）〕。
 * 運休直接呼 `nodeStore.skipOccurrence`（與 `U`、側板検印區同一個入口，不經 controller）——
 * 運休的是哪一班由 `row.railDate` 決定（呼叫端明講；沒講才回到 store 的「今天那一班」口徑），
 * 三個入口才會**同語義**（拍板 D-⑤-2 修訂：`U`／浮層鈕／小卡同一句話）。
 * 是不是定期券只認 `parseRule(row.repeat_rule)`——欄位裡是 legacy 自由文字的票走一般版。
 *   改期一律走 `nodeStore.reschedule`（唯一入口：寫 carried_from 繰越章、清 today_position）——
 *   本元件不碰 repository、不自己算繰越。
 *   「清除執行日」＝票離開今日流入收件匣資料態（M4 開張），toast 與 Shift+Enter 那條種子動線同一句，
 *   並帶「復原」把原執行日放回去（拍板：清除後 toast 同上、可 undo）。
 *
 * 視覺（**沒有原型**——① 比稿與 C1／C2 都沒畫過 popover）：
 *   照移植規格 §0 鐵律，只拼 techo.css 既有語彙、不自創新視覺元素——
 *   .techo-card 紙卡 ＋ .techo-overline 眉標 ＋ .techo-foot 腳註 ＋ --color-dash 虛線撕線 ＋
 *   「清除執行日」用赭（--color-late，與誤點／締切同色階）。位置與間距在 ./defer.css。
 *
 * 鍵盤（本卡開著時整張今日鍵盤表停用，見 useTodayKeyboard 的 disabled 分支）：
 *   ↑↓ 在項目間移動・Enter／Space 由按鈕自己啟動・Tab 在卡內循環・Esc 關閉（自己攔並 stopPropagation，
 *   免得冒泡上去被 useTodayKeyboard 的 Esc 護欄再關一次）。點卡外＝關閉；點回原本那枚 chip 讓 chip 自己 toggle。
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { describeRule, parseRule, type NodeRow } from "../../domain";
import type { CurrentOccurrence } from "../../data";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { addDays, todayKey } from "../../lib/date";
import { isEditableTarget } from "../shell/hotkeys";
import { INBOX_TOAST, showRescheduleToast } from "./useTodayController";
import "./defer.css";

/**
 * 小卡要的那一列（M3 ⑤ WP1 解耦）——節點欄位＋「這一列在講的那一班」。
 * 今日頁傳 `today.byId[id]`（`TodayRow` 本來就是這個形狀）；
 * 日曆浮層傳 `calendar.nodes[id]` ＋ 由該天的 `ScheduleEntry` 組出來的 occurrence
 * （`{ id, status: occurrence_status, due_on: entry.date }`，沒有結局就 null）。
 */
export type DeferRow = NodeRow & {
  occurrence: CurrentOccurrence | null;
  /**
   * 這一列在講的那一班的**班次日**（M3 ⑤ 修正席 must 2）。給了就原封送進 `skipOccurrence` 當 `dueOn`——
   * 日曆浮層一列講的是「那一天那一班」，跟 store 認定的「今天那一班」不一定同一班
   * （今天蓋済後 `scheduled_on` 已指向明天，明天那列的 `occurrence` 又還沒有結局＝null），
   * 沒有這個欄位小卡會運休到別班、或吐「本班已済」。
   * **今日頁不傳**（undefined）＝沿用 store 的班次日口徑（`pickTodayOccurrence`），行為零改動。
   */
  railDate?: string | null;
};

export interface DeferPopoverProps {
  /**
   * 目標列。**由呼叫端注入**，本元件不再自己查 `today.byId`——日曆的列不在今日切片裡（草案 §4-3）。
   */
  row: DeferRow;
  /** 被點的日期 chip（定位錨；鍵盤觸發時為 null） */
  anchor: HTMLElement | null;
  onClose(): void;
}

/** YYYY-MM-DD → 本地 Date（不經 Date.parse，避免 date-only 被當 UTC 而跨日；與 TodayView 同一份做法） */
function dateOf(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

const WEEK_ZH = ["日", "一", "二", "三", "四", "五", "六"];

/**
 * 原生 date input 在鍵盤逐字輸入時會邊打邊發 change（年份只打了「0002」也算一個合法值），
 * 這裡擋掉明顯打到一半的值——與 fields.tsx DateField 的 400ms 去抖同一個問題、不同解法
 * （小卡送出即關窗，沒有去抖的餘地）。
 */
function isSaneDateKey(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const y = Number(v.slice(0, 4));
  return y >= 1900 && y <= 2999;
}

/** 「M/D（週X）」——小卡右側的淡字：告訴主人那一項到底是哪一天 */
function whenLabel(key: string): string {
  const d = dateOf(key);
  return `${d.getMonth() + 1}/${d.getDate()} 週${WEEK_ZH[d.getDay()]}`;
}

/** 下一個「下週一」＝嚴格晚於 dateKey 的最近星期一（今天就是週一 → 跳到七天後那個週一） */
function nextMonday(key: string): string {
  const day = dateOf(key).getDay(); // 0=日
  const delta = (8 - day) % 7 || 7;
  return addDays(key, delta);
}

export function DeferPopover({ row, anchor, onClose }: DeferPopoverProps) {
  const nodeId = row.id;
  const storedKey = useNodeStore((s) => s.today.dateKey);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const dateKey = storedKey ?? todayKey(dayStartHour);

  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [picking, setPicking] = useState(false);

  /* ── 定位：量完 anchor 與自身尺寸再落座，clamp 進視窗（沒有 anchor＝鍵盤觸發 → 靠上置中） ── */
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    // 視窗尺寸取 documentElement.clientWidth／Height（扣掉捲軸的可視區，比 innerWidth 準）
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    const M = 12;
    if (!anchor) {
      setPos({ top: Math.round(vh * 0.24), left: Math.round((vw - w) / 2) });
      return;
    }
    const r = anchor.getBoundingClientRect();
    let top = r.bottom + 8;
    if (top + h > vh - M) top = Math.max(M, r.top - h - 8);
    // 先右邊界後左邊界：視窗比小卡還窄時（極小視窗／面板收起時量到 innerWidth 0）也不會被推到負座標
    const left = Math.max(M, Math.min(r.left, vw - w - M));
    setPos({ top: Math.round(top), left: Math.round(left) });
  }, [anchor, picking]);

  /**
   * 開卡就把焦點放在第一項（鍵盤流不中斷）。
   * ⚠ 一定要等 pos 落位之後才 focus——落位前小卡是 `visibility:hidden`（避免量測時閃一下左上角），
   *   而 `.focus()` 對 visibility:hidden 的元素是 no-op（實測 Chrome 139：焦點會留在今日頁容器上）。
   *   guard 用 ref 而不是 deps，才不會在「選日期…」重新量測（pos 變）時把焦點從日期框搶回來；
   *   StrictMode 雙掛載時元件是真的重建，ref 也是新的，可重入。
   */
  const focusedOnce = useRef(false);
  useEffect(() => {
    if (!pos || focusedOnce.current) return;
    focusedOnce.current = true;
    ref.current?.querySelector<HTMLButtonElement>("button[data-defer-item]")?.focus();
  }, [pos]);

  /* ── 點卡外＝關閉；點回原本那枚 chip 不處理，交給 chip 自己 toggle（openDefer 同 id 再叫＝收起） ── */
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (ref.current?.contains(t)) return;
      if (anchor?.contains(t)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [anchor, onClose]);

  const ns = () => useNodeStore.getState();
  const ui = () => useUiStore.getState();

  /**
   * 改期：唯一入口 reschedule（繰越章與今日序清空的規則都在那一層），改完就收卡。
   * 票離開今日的那一刻畫面上沒有別的回饋（繰越章要到目標日才看得到）→ 補一張可反悔的收據，
   * 與「清除執行日」／`Delete` 同款，三項改期不再靜默（should 3）。
   */
  const applyDate = (next: string) => {
    const prev = { scheduled_on: row.scheduled_on, carried_from: row.carried_from };
    void ns().reschedule(nodeId, next);
    onClose();
    if (next !== dateKey) showRescheduleToast(nodeId, prev, next);
  };

  /** 清除執行日＝流入收件匣資料態；toast 與 Shift+Enter 同一句，「復原」把原執行日放回去 */
  const clearDate = () => {
    const prev = row.scheduled_on;
    void ns().reschedule(nodeId, null);
    onClose();
    ui().showToast({
      message: INBOX_TOAST,
      actionLabel: "復原",
      onAction: () => void ns().reschedule(nodeId, prev),
    });
  };

  /** ↑↓ 在項目之間移動；Esc 自己收（不冒泡）；Tab 在卡內循環 */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    // M3 ⑦：小卡開著時 `?`／Ctrl+/ 都不叫快捷鍵指引（開關是本地 state，全域表看不到；不擋會再疊一張卡、Esc 互搶）。
    // 日期欄裡打 `?` 仍是打字，只擋導航模式那一下；Ctrl+/ 連日期欄裡都擋（備援鍵的「輸入框」指視圖裡的行內
    // 輸入框，不是小卡裡的）。React 的 stopPropagation 會一路擋到 window（mock 頁實測）。
    if ((e.key === "?" && !isEditableTarget(e.target)) || (e.key === "/" && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>("button[data-defer-item]") ?? []).filter(
      (b) => !(b as HTMLButtonElement).disabled,
    );
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      const d = e.key === "ArrowDown" ? 1 : -1;
      const j = i < 0 ? (d > 0 ? 0 : items.length - 1) : (i + d + items.length) % items.length;
      items[j]?.focus();
    } else if (e.key === "Tab") {
      // 卡內循環（別把焦點丟回底下那張已停用的清單）
      const focusables = Array.from(
        ref.current?.querySelectorAll<HTMLElement>("button, input") ?? [],
      ).filter((el) => !(el as HTMLButtonElement).disabled);
      if (focusables.length < 2) return;
      const k = focusables.indexOf(document.activeElement as HTMLElement);
      const j = e.shiftKey ? (k <= 0 ? focusables.length - 1 : k - 1) : k >= focusables.length - 1 ? 0 : k + 1;
      e.preventDefault();
      e.stopPropagation();
      focusables[j]?.focus();
    }
  };

  const tomorrow = addDays(dateKey, 1);
  const monday = nextMonday(dateKey);

  /* ── 定期券版（見檔頭）：規則 parse 得出來就換一套內容 ── */
  const rule = parseRule(row.repeat_rule);
  const suspended = row.occurrence?.status === "skipped";
  /**
   * 這一班的日子＝班次日（定期券交代完後 scheduled_on 已指向下一班，不能拿來當「本班」）。
   * 呼叫端明講的 `railDate` 最優先（日曆浮層＝那一列那一天）；今日頁沒給就照舊推。
   */
  const railDate = row.railDate ?? row.occurrence?.due_on ?? row.scheduled_on;

  /**
   * 本班運休／取消運休；失敗（例：退役的定期券、歷史班次）照 store 的原句吐 toast。
   * 班次日只在呼叫端明講時才送——今日頁不送＝維持 store 的口徑（行為不變，見 `DeferRow.railDate`）。
   */
  const toggleSuspend = () => {
    onClose();
    void ns()
      .skipOccurrence(nodeId, !suspended, row.railDate ?? undefined)
      .then((r) => {
        if (!r.ok && r.reason) ui().showToast({ message: r.reason }, 3600);
      });
  };

  /** 編輯重複規則＝開詳情側板（與今日列的 `.`／票種小字同一個去處；編輯器本體是 WP3） */
  const editRule = () => {
    onClose();
    ui().select(nodeId);
    ui().setPanelOpen(true);
  };

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={rule ? `定期券『${row.name}』` : `推遲『${row.name}』`}
      onKeyDown={onKeyDown}
      onMouseDown={(e) => e.stopPropagation()}
      className="ns-defer techo-card"
      style={{
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        visibility: pos ? "visible" : "hidden",
      }}
    >
      <p className="techo-overline ns-defer-head">{rule ? "定期券 — TEIKI" : "推遲 — DEFER"}</p>

      {rule ? (
        <ul className="ns-defer-list">
          <li>
            <button type="button" data-defer-item className="ns-defer-item" onClick={toggleSuspend}>
              <span>{suspended ? "取消運休" : "本班運休"}</span>
              <span className="when">{railDate ? whenLabel(railDate) : "—"}</span>
            </button>
          </li>
          <li className="cut">
            <button type="button" data-defer-item className="ns-defer-item" onClick={editRule}>
              <span>編輯重複規則…</span>
              <span className="when">{describeRule(rule)}</span>
            </button>
          </li>
        </ul>
      ) : (
      <ul className="ns-defer-list">
        <li>
          <button type="button" data-defer-item className="ns-defer-item" onClick={() => applyDate(tomorrow)}>
            <span>明天</span>
            <span className="when">{whenLabel(tomorrow)}</span>
          </button>
        </li>
        <li>
          <button type="button" data-defer-item className="ns-defer-item" onClick={() => applyDate(monday)}>
            <span>下週一</span>
            <span className="when">{whenLabel(monday)}</span>
          </button>
        </li>
        <li>
          <button
            type="button"
            data-defer-item
            aria-expanded={picking}
            className="ns-defer-item"
            onClick={() => setPicking(true)}
          >
            <span>選日期…</span>
            <span className="when">{row.scheduled_on ? whenLabel(row.scheduled_on) : "—"}</span>
          </button>
        </li>
        <li className="cut">
          <button
            type="button"
            data-defer-item
            disabled={!row.scheduled_on}
            title={row.scheduled_on ? "票會離開今日，流入收件匣（M4 開張）" : "這張票本來就沒有執行日"}
            className="ns-defer-item warn"
            onClick={clearDate}
          >
            <span>清除執行日</span>
          </button>
        </li>
      </ul>
      )}

      {!rule && picking && (
        <div className="ns-defer-pick">
          <input
            type="date"
            autoFocus
            aria-label="選擇執行日"
            defaultValue={row.scheduled_on ?? dateKey}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Enter") {
                e.preventDefault();
                e.stopPropagation();
                const v = (e.target as HTMLInputElement).value;
                if (isSaneDateKey(v)) applyDate(v);
              }
            }}
            onChange={(e) => {
              const v = e.target.value;
              if (isSaneDateKey(v)) applyDate(v);
            }}
          />
        </div>
      )}

      <div className="techo-foot ns-defer-foot">↑↓ 移動・Enter 選・Esc 關閉</div>
    </div>
  );
}
