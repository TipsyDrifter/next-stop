/**
 * HotkeysTab——設定頁「快捷鍵」分頁（M3 ⑦ WP3；D-⑦-2 甲）。
 *
 * 拍板依據：決策記錄〈⑦ 快捷鍵指引頁・拍板〉D-⑦-2 甲「按場景分七組、每組開頭一句情境註，籤頂一段
 *           導航／編輯雙模式說明」＋草案 §3「WP3 設定籤」。
 *
 * 版面（由上而下）：
 *   ⓪ 籤頂 ＝ 小標「導航模式・編輯模式」＋三句人話（`DUAL_MODE_NOTE`）；一道撕線隔開下面的表。
 *   ①–⑦   ＝ `SCENES` 七組，每組：小標（組名）＋一句「什麼時候有效」的情境註＋列表；
 *           每列＝動作名（左）＋鍵帽（右）＋必要時一句小註（如「句點」）；組與組之間一道撕線。
 *
 * 資料流：**一個鍵位都不手抄**——列表全由 `hotkeyRows.rowsFor(scope)` 切 registry（`hotkeys.ts`），
 *   鍵帽字由 `formatChord()` 產（Mac 顯 ⌘／⌥／⇧、Windows 顯 Ctrl／Alt／Shift；方向鍵 ↑↓←→；Space／Esc／Del）。
 *   不接線的三組（當日清單／側板與覆蓋層通用／編輯模式）照樣列——對主人來說它們就是「可以按的鍵」，
 *   接不接線是工程內部的事，不外露。
 *
 * 視覺紀律（c13：無原型，一個新形狀都不發明）：
 *   小標＝`.techo-label`、說明小字＝`.ns-note`、鍵帽＝`.ns-kbd`／`.ns-kbd-seq`（overlay.css，沿側板 `.log-hint kbd`
 *   放大一級）、分隔＝原型票根的 1px dashed（同 BackupTab 危險區那道）。settings.css 的 `.ns-hk-*` 只放排版，
 *   顏色一律 token。高度不由本籤管：撐不下時整張紙卡的本文一起捲（DialogShell `.ns-dialog-body`）。
 */
import { Fragment } from "react";
import { DUAL_MODE_NOTE, SCENES, rowPaths, rowsFor } from "../shell/hotkeyRows";
import { formatChord } from "../shell/hotkeys";
import "./settings.css";

/** 一條鍵位路徑（如 Ctrl＋Enter）：一顆鍵帽一枚 `<kbd>`，鍵帽之間一個小「+」 */
function KeyCaps({ caps }: { caps: string[] }) {
  return (
    <span className="ns-kbd-seq">
      {caps.map((cap, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="ns-kbd-plus">+</span>}
          <kbd className="ns-kbd">{cap}</kbd>
        </Fragment>
      ))}
    </span>
  );
}

export function HotkeysTab() {
  return (
    <div className="ns-hk">
      {/* ⓪ 籤頂：導航／編輯雙模式——規格書鐵則翻成人話（文案在 hotkeyRows，跟 registry 同一份備援鍵字） */}
      <section className="ns-hk-intro">
        <span className="techo-label block mb-1">導航模式・編輯模式</span>
        <ul className="ns-hk-intro-list">
          {DUAL_MODE_NOTE.map((line) => (
            <li key={line} className="ns-note">
              {line}
            </li>
          ))}
        </ul>
      </section>

      {/* ①–⑦ 七組：順序＝SCENES 的順序（全域→今日→路線圖→日曆→當日清單→通用→編輯模式） */}
      {SCENES.map((scene) => (
        <section key={scene.scope} className="ns-hk-scene" aria-labelledby={`ns-hk-${scene.scope}`}>
          <span id={`ns-hk-${scene.scope}`} className="techo-label block">
            {scene.title}
          </span>
          <p className="ns-note ns-hk-when">{scene.note}</p>
          <ul className="ns-hk-list">
            {rowsFor(scene.scope).map((row) => (
              <li key={row.id} className="ns-hk-row">
                <span className="ns-hk-label">
                  {row.label}
                  {row.note && <span className="ns-note ns-hk-note">{row.note}</span>}
                </span>
                <span className="ns-hk-keys">
                  {/* 成對（↑／↓）與替代路（Enter／Space）都攤成一串，條與條之間一個「／」——顯示端不必分辨 */}
                  {rowPaths(row).map((chord, i) => (
                    <Fragment key={i}>
                      {i > 0 && <span className="ns-hk-or">／</span>}
                      <KeyCaps caps={formatChord(chord)} />
                    </Fragment>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
