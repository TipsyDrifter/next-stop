/**
 * SettingsPanel——UI Flow 4.0 設定（讀 uiStore.settingsOpen）。
 * M3 ⑥（D-⑥-7）分頁化：籤列三枚〔一般｜備份與還原｜快捷鍵〕、卡寬 400→560；
 *   4.0a 一般     ＝主題三選（粉彩星空／銀河鐵道／跟隨系統）＋一天的開始時間（0–6 點）——原封搬入
 *   4.0b 備份與還原＝`BackupTab`（⑥ WP3 填）
 *   4.0c 快捷鍵   ＝⑦ 通車：`HotkeysTab`（D-⑦-2 甲：籤頂雙模式說明＋按場景七組，全部切 registry 不手抄）
 * 籤列鍵盤（M3 ⑦ 併收 ⑥ 遺留 D-⑦-5）：焦點在籤鈕上 ←→ 切相鄰籤（首尾相接）、Home／End 首尾；
 *   開設定時焦點落到當前籤鈕（開場 requestAnimationFrame 聚焦，DialogShell 不動、在 SettingsForm 內做）。
 * 主題過渡（M3 ② · 決策記錄〈M3 · 發車〉決策 12・r3）：商店主題（旅の手帖・夜行寝台・月白）暫時下架、tokens 存在 styles/theme-library.css，主題商店開張再回歸。
 * 視覺：DialogShell 票面紙卡＋燙金 overline；籤與主題同一顆 .ns-choice（原型 .status 式小字標籤，選中燙金邊與字）；
 *       時間＝手帳底線 select（.ns-select-wrap 去系統外觀＋細線 chevron）；關閉＝次鈕 .btn-ghost（籤外共用）。
 * 取捨：即選即存（無儲存鈕，store 自己落 settings 表）；日界線的說明放在選單下方一句話；主題的副註只放 title。
 */
import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { useUiStore, type SettingsTab, type ThemePref } from "../../store/uiStore";
import { DialogShell } from "../common/DialogShell";
import { BackupTab } from "./BackupTab";
import { HotkeysTab } from "./HotkeysTab";
import { SyncTab } from "./SyncTab";
import "../common/overlay.css";
import "./settings.css";

const THEMES: { value: ThemePref; label: string; note: string }[] = [
  { value: "pastel", label: "粉彩星空", note: "朧月的月台・日間" },
  { value: "galaxy", label: "銀河鐵道", note: "深夜月台・夜間" },
  { value: "system", label: "跟隨系統", note: "依作業系統" },
];

const HOURS = [0, 1, 2, 3, 4, 5, 6];

/** `note`／`disabled` 留給日後還在施工的籤（⑥ 的「快捷鍵 ⑦ 施工中」就是這樣掛的）；目前三籤全通車 */
const TABS: { value: SettingsTab; label: string; note?: string; disabled?: boolean }[] = [
  { value: "general", label: "一般" },
  { value: "backup", label: "備份與還原" },
  { value: "hotkeys", label: "快捷鍵" },
  // v1.1.1 第四籤（WP8 通車：拿掉 note／disabled——這是本檔在 v1.1.1 的唯一改動）
  { value: "sync", label: "同步" },
];

export function SettingsPanel() {
  const open = useUiStore((s) => s.settingsOpen);
  if (!open) return null;
  return <SettingsForm />;
}

function SettingsForm() {
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  // 籤的唯一來源在 uiStore（WP2 加）——失敗 toast／啟動橫幅要能「開設定並直接落在備份籤」
  const tab = useUiStore((s) => s.settingsTab);
  const setTab = useUiStore((s) => s.setSettingsTab);
  const tabsId = useId();
  const close = () => setSettingsOpen(false);
  const tabRefs = useRef<Partial<Record<SettingsTab, HTMLButtonElement | null>>>({});

  // 開設定時焦點落到當前籤鈕（⑥ 遺留：原本焦點留在底下的頁面，Tab 要繞一圈才進得了卡）。
  // 等一個 frame 讓 DialogShell 的 @starting-style 進場先掛好；籤從 store 現讀，不把 tab 綁進依賴（只在開場跑一次）。
  useEffect(() => {
    const id = requestAnimationFrame(() => tabRefs.current[useUiStore.getState().settingsTab]?.focus());
    return () => cancelAnimationFrame(id);
  }, []);

  // tablist 慣例：←→ 切相鄰籤（首尾相接）、Home／End 首尾；切到就聚焦那枚籤鈕。
  // IME 組字中不攔（沿全站鐵則）；停用的籤跳過。籤列在 DialogShell 內、不在三張視圖的容器裡，方向鍵不會漏到底下的列。
  const onTabsKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const enabled = TABS.filter((t) => !t.disabled).map((t) => t.value);
    const i = enabled.indexOf(tab);
    let next: SettingsTab | undefined;
    switch (e.key) {
      case "ArrowRight":
        next = enabled[(i + 1) % enabled.length];
        break;
      case "ArrowLeft":
        next = enabled[(i - 1 + enabled.length) % enabled.length];
        break;
      case "Home":
        next = enabled[0];
        break;
      case "End":
        next = enabled[enabled.length - 1];
        break;
      default:
        return;
    }
    if (!next) return;
    e.preventDefault();
    setTab(next);
    tabRefs.current[next]?.focus();
  };

  // topClass 置頂 10vh（其他 dialog 仍 18vh）：設定是全站最高的一張卡，上移才塞得進 1280×800 的預設視窗
  return (
    <DialogShell title="設定" overline="設定 — SETTINGS" onClose={close} width={560} topClass="pt-[10vh]">
      <div className="ns-tabs" role="tablist" aria-label="設定分頁" onKeyDown={onTabsKeyDown}>
        {TABS.map((t) => {
          const on = tab === t.value;
          return (
            <button
              key={t.value}
              ref={(el) => {
                tabRefs.current[t.value] = el;
              }}
              type="button"
              role="tab"
              id={`${tabsId}-tab-${t.value}`}
              aria-selected={on}
              aria-controls={`${tabsId}-panel-${t.value}`}
              // 選中的籤在 Tab 序裡、其餘靠 ←→ 走（tablist 慣例：一個 tab stop）
              tabIndex={on ? 0 : -1}
              disabled={t.disabled}
              title={t.note}
              onClick={() => setTab(t.value)}
              className={`ns-choice${on ? " is-on" : ""}`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`${tabsId}-panel-${tab}`}
        aria-labelledby={`${tabsId}-tab-${tab}`}
        className="ns-tabpanel"
      >
        {tab === "general" && <GeneralTab />}
        {tab === "backup" && <BackupTab />}
        {tab === "hotkeys" && <HotkeysTab />}
        {tab === "sync" && <SyncTab />}
      </div>

      <div className="flex justify-end pt-5">
        <button type="button" onClick={close} className="btn-ghost ns-btn">
          關閉
        </button>
      </div>
    </DialogShell>
  );
}

/** 4.0a 一般——⑥ 之前的設定頁內容原封搬入 */
function GeneralTab() {
  const theme = useUiStore((s) => s.theme);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const setTheme = useUiStore((s) => s.setTheme);
  const setDayStartHour = useUiStore((s) => s.setDayStartHour);
  const selectId = useId();

  return (
    <div className="space-y-6">
      <div>
        <span className="techo-label block mb-2.5">主題</span>
        <div role="radiogroup" aria-label="主題" className="flex flex-wrap items-center gap-2">
          {THEMES.map((t) => {
            const checked = theme === t.value;
            return (
              <button
                key={t.value}
                type="button"
                role="radio"
                aria-checked={checked}
                title={t.note}
                onClick={() => void setTheme(t.value)}
                className={`ns-choice${checked ? " is-on" : ""}`}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <label className="techo-label block mb-1" htmlFor={selectId}>
          一天的開始時間
        </label>
        <span className="ns-select-wrap">
          <select
            id={selectId}
            value={dayStartHour}
            onChange={(e) => void setDayStartHour(Number(e.target.value))}
            className="techo-input font-latin text-[14px]"
          >
            {HOURS.map((h) => (
              <option key={h} value={h}>
                {String(h).padStart(2, "0")}:00
              </option>
            ))}
          </select>
        </span>
        <p className="ns-note mt-2">熬夜到這個時間前都算同一天——今日視圖的聚合與誤點判定都依此計算。</p>
      </div>
    </div>
  );
}
