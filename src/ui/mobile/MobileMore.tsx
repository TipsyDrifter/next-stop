/**
 * MobileMore——「更多」頁（v1.1.0「手機殼可用」；WP2 席）。
 *
 * 拍板依據：決策記錄〈v1.1 Plan 草案拍板〉D-1.1-2「底部第五格『更多』收設定（主題）」
 *   ＋《2026-09-16-v1.1.0-手機殼契約.md》§2.9。
 *
 * v1.1.0 只有三件：
 *   ① 設定 → 主題三選（uiStore.theme／setTheme；文案與順序逐字沿 SettingsPanel.tsx 的 `THEMES`）
 *   ② 售票口（記帳）一列灰顯「次期開業予定」——與底部 tab 的 planned 格同一套語彙（tabs.ts 的
 *      COMING_SOON_TEXT），手機只有五格、售票口不佔格，所以它掛在這裡當「看得到的預告」
 *   ③ 關於：App 名／拉丁名／版本號（版本自 package.json，發版時不必改這支的字）
 *
 * **不出現**（契約 §2.9）：備份與還原（D-1.1-1 甲：Android 整組關閉）、快捷鍵、? 指引、
 *   一天的開始時間（日界線是 v1.1.1 唯一要同步的 setting，等同步一起做進手機）、搜尋、日曆。
 *
 * v1.1.1（WP8）補上②：設定區在主題之後多一列「同步・運行中／未啟用…」，點了切到子頁 `MobileSync`。
 *   子頁用**本地 state**（`view`）而不進 uiStore：這是同一個 tab 之內的往返，底部 tab 仍停在「更多」，
 *   離開再回來回到清單是對的（沿 MobileRouteMap 的 zoom 也是本地 state 的作法）。
 */
import { useEffect, useState } from "react";
import { COMING_SOON_TEXT } from "./tabs";
import { useUiStore, type ThemePref } from "../../store/uiStore";
import { useSyncStore, SYNC_PHASE_LABEL } from "../../store/syncStore";
import MobileSync from "./MobileSync";
// 版本號取 package.json 的 version（tsconfig resolveJsonModule 已開）——發版只改一處，這頁自動跟。
// ⚠ 發版時 package.json 的 version 要與 tauri.conf.json 一起改成 1.1.0（WP3／整合席）。
import { version as APP_VERSION } from "../../../package.json";

/** 主題三選——逐字沿 SettingsPanel.tsx 的 THEMES（同一份文案，桌機改了這裡也要跟） */
const THEMES: { value: ThemePref; label: string; note: string }[] = [
  { value: "pastel", label: "粉彩星空", note: "朧月的月台・日間" },
  { value: "galaxy", label: "銀河鐵道", note: "深夜月台・夜間" },
  { value: "system", label: "跟隨系統", note: "依作業系統" },
];

export default function MobileMore() {
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const syncPhase = useSyncStore((s) => s.status?.phase ?? "off");
  const refreshSyncStatus = useSyncStore((s) => s.refreshStatus);
  const [view, setView] = useState<"more" | "sync">("more");

  // 這一列右邊寫的是現在的同步狀態——進頁問一次（純讀、可重入；同桌機 SyncTab 的作法）。
  // App.tsx 的 `boot()` 也會問，重複一次只是多一趟 invoke，換來「整合席還沒接線時這列也不說謊」。
  useEffect(() => {
    void refreshSyncStatus();
  }, [refreshSyncStatus]);

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

        {/* v1.1.1（WP8）：同步一列——右側直接寫現在的狀態（觸控沒有 hover，狀態得攤在字面上）。
            形狀沿下面那列「售票口」的 `.m2-row-planned`，只是這一列可點：故另立 `.m2-row-link`
            （同樣的排版、不吃 .42 的灰度、撐到 48px 觸控目標）。 */}
        <button type="button" className="m2-row-link" onClick={() => setView("sync")}>
          <span className="m2-planned-name">同步</span>
          <span className="m2-planned-note">{SYNC_PHASE_LABEL[syncPhase]}</span>
        </button>

        {/* 未通車：售票口（記帳）。點不動，只是一行預告——與 tab 的 planned 格同一套語彙與灰度。 */}
        <div className="m2-row-planned" aria-disabled="true">
          <span className="m2-planned-name">售票口（記帳）</span>
          <span className="m2-planned-note">{COMING_SOON_TEXT}</span>
        </div>
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
    </div>
  );
}
