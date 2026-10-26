/**
 * SettingsPanel——UI Flow 4.0 設定（讀 uiStore.settingsOpen）。
 * M3 ⑥（D-⑥-7）分頁化：籤列〔一般｜備份與還原｜快捷鍵｜同步〕；
 *   4.0a 一般     ＝主題三選（粉彩星空／銀河鐵道／跟隨系統）＋一天的開始時間（0–6 點）——原封搬入
 *                  ＋每週從星期幾開始（星期一／星期日；旅客筆記車次② D-筆-29）
 *   4.0b 備份與還原＝`BackupTab`（⑥ WP3 填）
 *   4.0c 快捷鍵   ＝⑦ 通車：`HotkeysTab`（D-⑦-2 甲：籤頂雙模式說明＋按場景七組，全部切 registry 不手抄）
 *   4.0d 同步     ＝`SyncTab`（v1.1.1 WP8）
 * UI 丙-3（契約 E1；視覺規範 §2.2／§2.4／§4）：
 *   - 籤列換共用 `Tabs`（底線滑塊、襯線籤；←→ 循環、Home／End、IME 組字不攔都由它做，本檔不再自做鍵盤）；
 *     開設定時焦點落到目前籤（Tabs 沒有 ref API，開場用 DOM 查選中的那一籤）；`aria-controls` 用 `getPanelId` 對齊 tabpanel id。
 *   - 主題三選與週首換共用 `Segmented`（相連方格、--sel-bg 選中），不再用分開的 `.ns-choice` 小方塊。
 *   - `DialogShell size="L"`（620）、眉標 `{設定, Settings}`；拿掉「關閉」鈕，只留標題列的 ×（即選即存，沒有底部按鈕列）。
 *   - 籤的唯一來源仍是 `uiStore.settingsTab`／`setSettingsTab`（HotkeyGuide、useGlobalHotkeys、同步橫幅會從外面指定籤）。
 * 主題過渡（M3 ② · 決策記錄〈M3 · 發車〉決策 12・r3）：商店主題（旅の手帖・夜行寝台・月白）暫時下架、tokens 存在 styles/theme-library.css，主題商店開張再回歸。
 * 取捨：即選即存（無儲存鈕，store 自己落 settings 表）；日界線的說明放在選單下方一句話；主題的副註只放 title。
 */
import { useEffect, useId, useRef } from "react";
import { useUiStore, type SettingsTab, type ThemePref } from "../../store/uiStore";
import { DialogShell } from "../common/DialogShell";
import { Tabs, type TabItem } from "../common/Tabs";
import { Segmented, type SegmentedOption } from "../common/Segmented";
import { BackupTab } from "./BackupTab";
import { HotkeysTab } from "./HotkeysTab";
import { SyncTab } from "./SyncTab";
import { ExternalAssistantTab } from "./ExternalAssistantTab";
import { AutostartRow } from "../notes/desktop";
import { lineSettingsLinks } from "../../lines/runtime";
import "../common/overlay.css";
import "./settings.css";

/** 主題三選（文案與順序 MobileMore.tsx 逐字沿用；改這裡要跟著改那邊）；副註放 title */
const THEMES: SegmentedOption<ThemePref>[] = [
  { value: "pastel", label: "粉彩星空", title: "朧月的月台・日間" },
  { value: "galaxy", label: "銀河鐵道", title: "深夜月台・夜間" },
  { value: "system", label: "跟隨系統", title: "依手機設定" },
];

const HOURS = [0, 1, 2, 3, 4, 5, 6];

/**
 * 週首（uiStore.weekStart＝JS getDay() 的值；settings 鍵 week_start；旅客筆記車次② D-筆-29）。
 * Segmented 的值是字串，這裡用 "1"／"0" 對應，進出 store 時轉數字。
 */
const WEEK_STARTS: SegmentedOption<"1" | "0">[] = [
  { value: "1", label: "星期一" },
  { value: "0", label: "星期日" },
];

/** 五籤（第五籤〈外部助理〉＝MCP 接口班）；日後還在施工的籤可以掛 `disabled`＋`why`（Tabs 會淡出並在 title 說為什麼） */
const TABS: TabItem<SettingsTab>[] = [
  { key: "general", label: "一般" },
  { key: "backup", label: "備份與還原" },
  { key: "hotkeys", label: "快捷鍵" },
  { key: "sync", label: "同步" },
  { key: "assistant", label: "外部助理" },
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
  const panelId = (k: SettingsTab) => `${tabsId}-panel-${k}`;
  const close = () => setSettingsOpen(false);
  const tabsRef = useRef<HTMLDivElement>(null);
  const current = TABS.find((t) => t.key === tab) ?? TABS[0];

  // 開設定時焦點落到目前籤（⑥ 遺留：原本焦點留在底下的頁面，Tab 要繞一圈才進得了卡）。
  // 共用 Tabs 沒有 ref／focus API：用 DOM 查選中的那一籤（Tabs 保證它 aria-selected=true、tabIndex 0）。
  // 等一個 frame 讓 DialogShell 的 @starting-style 進場先掛好；只在開場跑一次（之後換籤由 Tabs 自己帶焦點）。
  useEffect(() => {
    const id = requestAnimationFrame(() =>
      tabsRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus(),
    );
    return () => cancelAnimationFrame(id);
  }, []);

  // topClass 置頂 10vh（其他 dialog 18vh）：設定是全站最高的一張卡，上移才塞得進 1280×800 的預設視窗。
  return (
    <DialogShell
      title="設定"
      overline={{ zh: "設定", latin: "Settings" }}
      size="L"
      onClose={close}
      topClass="pt-[10vh]"
    >
      <div ref={tabsRef} className="ns-set-tabs">
        <Tabs items={TABS} value={tab} onChange={setTab} size="md" aria-label="設定分頁" getPanelId={panelId} />
      </div>

      {/* Tabs 不給籤鈕 id，分頁內容改用 aria-label（籤名）命名，不用 aria-labelledby */}
      <div role="tabpanel" id={panelId(tab)} aria-label={current.label} className="ns-tabpanel">
        {tab === "general" && <GeneralTab />}
        {tab === "backup" && <BackupTab />}
        {tab === "hotkeys" && <HotkeysTab />}
        {tab === "sync" && <SyncTab />}
        {tab === "assistant" && <ExternalAssistantTab />}
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
  const weekStart = useUiStore((s) => s.weekStart);
  const setWeekStart = useUiStore((s) => s.setWeekStart);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const links = lineSettingsLinks("desktop");
  const selectId = useId();

  return (
    <div className="space-y-6">
      <div>
        <span className="techo-label block mb-2.5">主題</span>
        <Segmented options={THEMES} value={theme} onChange={(v) => void setTheme(v)} aria-label="主題" />
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
        <p className="ns-note mt-2">熬夜到這個時間前都算前一天——今日視圖與誤點都依此計算。</p>
      </div>

      <div>
        <span className="techo-label block mb-2.5">每週從星期幾開始</span>
        <Segmented
          options={WEEK_STARTS}
          value={weekStart === 0 ? "0" : "1"}
          onChange={(v) => void setWeekStart(v === "0" ? 0 : 1)}
          aria-label="每週從星期幾開始"
        />
        <p className="ns-note mt-2">行程表與旅客筆記的月曆都照這個排。</p>
      </div>
      <AutostartRow />
      {/* 磨光③ 0-2：各線的設定住在自己頁面時在這裡指路；沒有任何線填＝什麼都不畫 */}
      {links.length > 0 &&
        links.map((l) => (
          <div key={l.id}>
            <span className="techo-label block mb-2.5">{l.label}</span>
            {/* 這是「去別處」的動作鈕，不是單選：用次鈕，不借選項的 .ns-choice（視覺規範 §2.3） */}
            <button
              type="button"
              className="btn-ghost ns-btn"
              onClick={() => {
                setSettingsOpen(false);
                l.open("desktop");
              }}
            >
              打開
            </button>
            {l.sub && <p className="ns-note mt-2">{l.sub}</p>}
          </div>
        ))}
    </div>
  );
}
