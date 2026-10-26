/**
 * MobileMore——「更多」頁（v1.1.0「手機殼可用」；WP2 席）。
 *
 * 拍板依據：決策記錄〈v1.1 Plan 草案拍板〉D-1.1-2「底部第五格『更多』收設定（主題）」
 *   ＋《2026-09-16-v1.1.0-手機殼契約.md》§2.9。
 *
 * v1.1.0 只有三件：
 *   ① 設定 → 主題三選（uiStore.theme／setTheme；文案與順序逐字沿 SettingsPanel.tsx 的 `THEMES`）
 *   ② 售票口（記帳）一列灰顯「次期開業予定」——手機只有五格、售票口不佔格，所以它掛在這裡當「看得到的預告」
 *      （售票口線車次①起拿掉，見檔尾）
 *   ③ 關於：App 名／拉丁名／版本號（版本自 package.json，發版時不必改這支的字）
 *
 * **不出現**（契約 §2.9）：備份與還原（D-1.1-1 甲：Android 整組關閉）、快捷鍵、? 指引、
 *   一天的開始時間（日界線是 v1.1.1 唯一要同步的 setting，等同步一起做進手機）、搜尋、行程表。
 *
 * v1.1.1（WP8）補上②：設定區在主題之後多一列「同步・運行中／未啟用…」，點了切到子頁 `MobileSync`。
 *   子頁用**本地 state**（`view`）而不進 uiStore：這是同一個 tab 之內的往返，底部 tab 仍停在「更多」，
 *   離開再回來回到清單是對的（沿 MobileRouteMap 的 zoom 也是本地 state 的作法）。
 *
 * v1.1.5（WP-C；契約 §2.5）：同步告警橫幅的「前往同步」要從**任何一格 tab** 直接落到同步子頁。
 *   子頁仍是本地 state（上面那條理由不變），外面只能「請求」：`uiStore.openSyncPage("mobile")` 把 tab 切到「更多」
 *   並留一張 `mobileMoreRequest="sync"`，本頁看到就切子頁、當場消費掉（一次性，不會卡在同步頁回不來）。
 *   初值也吃這張請求：從別的 tab 跳過來時直接畫同步頁，不先閃一下「更多」清單。
 *
 * v1.1.6（WP-B；拍板〈回饋兩題拍板〉重新開始＋《2026-09-28-v1.1.6-重新開始契約.md》§6.2／§9-1）：「關於」之後一段「危險區」。
 *   為什麼在這裡：拍板把入口定在〈備份與還原〉、且**不放同步頁**——手機沒有〈備份與還原〉這一頁，
 *   「更多」頁尾是最接近的位置（契約席自決 §9-1；手機是「整台換新、要清乾淨」最常見的那一台）。
 *   形狀零發明：`.m2-sec`＋`.m2-sec-title`＋`.m2-note`＋`.ns-btn.btn-ghost.ns-btn-danger.m2-sy-go`（44px），
 *   外框沿 `.m2-sy-danger`（說明在上、鈕在下）另立 `.m2-danger`。觸控沒有 hover，桌機掛在 title 的鈕說明這裡攤成鈕下一行。
 *   確認窗（打字「清空」）與留底全在 `syncStore.startOver`，畫窗的是 App 層共用的 ConfirmDialog。
 *
 * 旅客筆記車次②（D-筆-29）：設定區主題之後加「每週從星期幾開始」（星期一／星期日；uiStore.setWeekStart）。
 *
 * 售票口線車次①（D-票-20；《2026-10-11-售票口-車次①帳本-契約.md》§2.6 #9、0-28）：底部第五格改成售票口，
 *   本頁不再是 tab——入口是頂帶右上的 ⋯（MobileTopBand.tsx），點任一格 tab 離開。
 *   並行地基（M-3／M-4）時期掛在這裡的售票口那一列（planned＝灰顯預告、open＝進本地子頁 `view="ticket"`）連同子頁一起拿掉，
 *   `view` 回到 "more" | "sync"。深連結 `openSyncPage("mobile")` 不受影響（"more" 仍是合法的頁 key）。
 *
 * 磨光①（契約 `docs/research/2026-10-20-主線-磨光①手機殼-契約.md` §1.5、§9.5 N10）：同步子頁登記返回層（page）；
 *   週起點下面補「一天的開始時間」（上面 v1.1.0「不出現」那條的日界線，同步早已做進手機，這裡補上入口）。
 */
import { useEffect, useState } from "react";
import { useUiStore, type ThemePref } from "../../store/uiStore";
import { useSyncStore, SYNC_PHASE_LABEL, START_OVER_TEXT, startOverThisNote } from "../../store/syncStore";
import MobileSync from "./MobileSync";
import { useBackLayer } from "./backStack";
import { lineSettingsLinks } from "../../lines/runtime";
// 〈外部助理〉那一段的兩條排版規則跟桌機籤放在同一支 css（MCP 接口班的新檔，不動共用的 mobile.css）
import "../settings/externalAssistant.css";
// 版本號取 package.json 的 version（tsconfig resolveJsonModule 已開）——發版只改一處，這頁自動跟。
// ⚠ 發版時 package.json 的 version 要與 tauri.conf.json 一起改成 1.1.0（WP3／整合席）。
import { version as APP_VERSION } from "../../../package.json";

/** 主題三選——逐字沿 SettingsPanel.tsx 的 THEMES（同一份文案，桌機改了這裡也要跟） */
const THEMES: { value: ThemePref; label: string; note: string }[] = [
  { value: "pastel", label: "粉彩星空", note: "朧月的月台・日間" },
  { value: "galaxy", label: "銀河鐵道", note: "深夜月台・夜間" },
  { value: "system", label: "跟隨系統", note: "依手機設定" },
];

/** 週首（uiStore.weekStart＝JS getDay() 的值；settings 鍵 week_start）——字同 SettingsPanel.tsx 的 WEEK_STARTS */
const WEEK_STARTS: { value: 0 | 1; label: string; note: string }[] = [
  { value: 1, label: "星期一", note: "月曆一…六・日" },
  { value: 0, label: "星期日", note: "月曆日・一…六" },
];

/** 一天的開始時間（uiStore.dayStartHour；同 SettingsPanel.tsx 的 HOURS） */
const DAY_START_HOURS = [0, 1, 2, 3, 4, 5, 6];

export default function MobileMore() {
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const weekStart = useUiStore((s) => s.weekStart);
  const setWeekStart = useUiStore((s) => s.setWeekStart);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const setDayStartHour = useUiStore((s) => s.setDayStartHour);
  const syncPhase = useSyncStore((s) => s.status?.phase ?? "off");
  const refreshSyncStatus = useSyncStore((s) => s.refreshStatus);
  // v1.1.6 危險區：未加入時「所有裝置一起」disabled；同步有動作在飛時兩顆一起鎖
  const syncJoined = useSyncStore((s) => !!s.status?.configured);
  const syncWorking = useSyncStore((s) => s.working);
  const startOver = useSyncStore((s) => s.startOver);
  const moreRequest = useUiStore((s) => s.mobileMoreRequest);
  const consumeMoreRequest = useUiStore((s) => s.consumeMobileMoreRequest);
  const [view, setView] = useState<"more" | "sync">(() => (moreRequest === "sync" ? "sync" : "more"));
  const settingsLinks = lineSettingsLinks("mobile");

  // v1.1.5：橫幅「前往同步」的深連結——看到就切子頁並消費（本頁已經開著時也走這裡）
  useEffect(() => {
    if (moreRequest !== "sync") return;
    setView("sync");
    consumeMoreRequest();
  }, [moreRequest, consumeMoreRequest]);

  // 這一列右邊寫的是現在的同步狀態——進頁問一次（純讀、可重入；同桌機 SyncTab 的作法）。
  // App.tsx 的 `boot()` 也會問，重複一次只是多一趟 invoke，換來「整合席還沒接線時這列也不說謊」。
  useEffect(() => {
    void refreshSyncStatus();
  }, [refreshSyncStatus]);

  // 磨光① A3（契約 §1.5）：同步子頁是一層 page——返回＝回「更多」清單（同「← 更多」）
  useBackLayer("core.more-sync", view === "sync", () => setView("more"), "page");

  if (view === "sync") return <MobileSync onBack={() => setView("more")} />;

  return (
    <div className="m-page m2-page" aria-label="更多">
      <section className="m2-sec" aria-labelledby="m2-sec-settings">
        <h2 id="m2-sec-settings" className="m2-sec-title">
          設定
        </h2>

        <div className="m2-block">
          <span className="m2-block-label">主題</span>
          <div role="radiogroup" aria-label="主題" className="m2-choices">
            {THEMES.map((t) => {
              const checked = theme === t.value;
              return (
                <button
                  key={t.value}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  onClick={() => void setTheme(t.value)}
                  className={"m2-choice" + (checked ? " is-on" : "")}
                >
                  <span className="m2-choice-label">{t.label}</span>
                  <span className="m2-choice-note">{t.note}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 旅客筆記車次②（D-筆-29）：週首——與桌機設定頁同一列同一份字；形狀沿主題那組 `.m2-choice` */}
        <div className="m2-block">
          <span className="m2-block-label">每週從星期幾開始</span>
          <div role="radiogroup" aria-label="每週從星期幾開始" className="m2-choices">
            {WEEK_STARTS.map((w) => {
              const checked = weekStart === w.value;
              return (
                <button
                  key={w.value}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  onClick={() => void setWeekStart(w.value)}
                  className={"m2-choice" + (checked ? " is-on" : "")}
                >
                  <span className="m2-choice-label">{w.label}</span>
                  <span className="m2-choice-note">{w.note}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 磨光① N10（D-主-53）：一天的開始時間——放週起點下面（兩個都是「日子怎麼算」）。
            跟桌機設定同一支 setDayStartHour、同一個設定鍵（本來就同步）；說明照桌機的意思、精簡一句。
            原生 select（手機會跳系統選單）＋底線輸入 `.m2-input`＋桌機那枚 chevron `.ns-select-wrap`。 */}
        <div className="m2-block">
          <label className="m2-block-label" htmlFor="m2-day-start">
            一天的開始時間
          </label>
          <span className="ns-select-wrap m2-select-wrap">
            <select
              id="m2-day-start"
              className="m2-input m2-select"
              value={dayStartHour}
              onChange={(e) => void setDayStartHour(Number(e.target.value))}
            >
              {DAY_START_HOURS.map((h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, "0")}:00
                </option>
              ))}
            </select>
          </span>
          <p className="m2-note m2-day-start-note">熬夜到這個時間前都算前一天。</p>
        </div>

        {/* v1.1.1（WP8）：同步一列——右側直接寫現在的狀態（觸控沒有 hover，狀態得攤在字面上）。
            形狀沿當年下面那列「售票口」的 `.m2-row-planned`（車次①已拿掉），只是這一列可點：故另立 `.m2-row-link`
            （同樣的排版、不吃 .42 的灰度、撐到 48px 觸控目標）。 */}
        <button type="button" className="m2-row-link" onClick={() => setView("sync")}>
          <span className="m2-planned-name">同步</span>
          <span className="m2-planned-note">{SYNC_PHASE_LABEL[syncPhase]}</span>
        </button>

        {/* MCP 接口班（D-主-96）：手機不開外部助理——一段標籤＋一句話，不可點、沒有開關（原型方案 C 的手機段） */}
        <div className="m2-block m2-ai">
          <span className="m2-block-label">外部助理</span>
          <p className="m2-note">外部助理只能在桌機上連。手機的資料會同步過去。</p>
        </div>

        {/* 磨光③ 0-2：各線的設定住在自己頁面時在這裡指路；沒有任何線填＝什麼都不畫 */}
        {settingsLinks.length > 0 &&
          settingsLinks.map((l) => (
            <button key={l.id} type="button" className="m2-row-link" onClick={() => l.open("mobile")}>
              <span className="m2-planned-name">{l.label}</span>
              {l.sub && <span className="m2-planned-note">{l.sub}</span>}
            </button>
          ))}
      </section>

      <section className="m2-sec" aria-labelledby="m2-sec-about">
        <h2 id="m2-sec-about" className="m2-sec-title">
          關於
        </h2>
        <div className="m2-about">
          <p className="m2-about-name">私鐵手帳</p>
          <p className="m2-about-latin">Next Stop</p>
          <p className="m2-about-version">v{APP_VERSION}</p>
        </div>
      </section>

      {/* v1.1.6 危險區（契約 §6.2）：頁尾、關於之後——要滑到底才看得到，不跟日常設定擠在一起 */}
      <section className="m2-sec m2-danger" aria-labelledby="m2-sec-danger">
        <h2 id="m2-sec-danger" className="m2-sec-title">
          {START_OVER_TEXT.sectionTitle}
        </h2>
        <div className="m2-block">
          <p className="m2-note">{START_OVER_TEXT.lead}</p>
          <div className="m2-danger-item">
            <button
              type="button"
              className="ns-btn btn-ghost ns-btn-danger m2-sy-go"
              disabled={syncWorking}
              onClick={() => startOver("this_device")}
            >
              {START_OVER_TEXT.thisDevice.label}
            </button>
            <p className="m2-note">{startOverThisNote(syncJoined)}</p>
          </div>
          <div className="m2-danger-item">
            <button
              type="button"
              className="ns-btn btn-ghost ns-btn-danger m2-sy-go"
              disabled={syncWorking || !syncJoined}
              onClick={() => startOver("all_devices")}
            >
              {START_OVER_TEXT.allDevices.label}
            </button>
            <p className="m2-note">{syncJoined ? START_OVER_TEXT.allDevices.note : START_OVER_TEXT.allDevices.disabledTitle}</p>
          </div>
        </div>
      </section>
    </div>
  );
}
