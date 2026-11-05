/**
 * HotkeysTab——設定頁「快捷鍵」分頁（M3 ⑦ WP3；D-⑦-2 甲；⑧ 起可改）。
 *
 * 拍板依據：決策記錄〈⑦ 快捷鍵指引頁・拍板〉D-⑦-2 甲「按場景分七組、每組開頭一句情境註，籤頂一段
 *           導航／編輯雙模式說明」＋草案 §3「WP3 設定籤」；⑧ 原型 `prototypes/⑧-自訂快捷鍵.html`（A 就地錄鍵＋甲 先存、兩列標赭字）。
 *
 * 版面（由上而下）：
 *   ⓪ 籤頂 ＝ 小標「導航模式・編輯模式」＋三句人話（`dualModeNote()`）＋「點鍵帽就能換」＋全部還原；一道撕線隔開下面的表。
 *   ①–⑦   ＝ `SCENES` 七組，每組：小標（組名）＋一句「什麼時候有效」的情境註＋列表；
 *           每列＝動作名（左）＋鍵帽（右）＋必要時一句小註（如「句點」）；組與組之間一道撕線。
 *
 * 資料流：**一個鍵位都不手抄**——列表全由 `hotkeyRows.rowsFor(scope)` 切 registry（`hotkeys.ts`，已含覆寫），
 *   鍵帽字由 `formatChord()` 產（Mac 顯 ⌘／⌥／⇧、Windows 顯 Ctrl／Alt／Shift；方向鍵 ↑↓←→；Space／Esc／Del）。
 *   不接線的三組（當日清單／側板與覆蓋層通用／編輯模式）照樣列——對主人來說它們就是「可以按的鍵」，
 *   接不接線是工程內部的事，不外露。能不能改看 `isRebindable`：不能改的鍵帽就是 `<kbd>`，能改的包一顆按鈕。
 *
 * 改鍵（⑧）：點鍵帽 → 那一格變「按下新的組合鍵…」（`useChordRecorder`）→ 按下去就存（`rebindHotkey`）；Esc 取消。
 *   不能用的組合（`chordProblem`）留在錄鍵狀態、赭字說為什麼；撞鍵照存、兩列都標赭字＋籤頂總數（`conflictsOf`），
 *   想對調兩顆鍵時不必先繞一組暫時的鍵。列尾「還原」回預設；全部還原附「復原」toast。
 *
 * 視覺紀律（c13：無原型，一個新形狀都不發明；⑧ 的錄鍵態見原型）：
 *   小標＝`.techo-label`、說明小字＝`.ns-note`、鍵帽＝`.ns-kbd`／`.ns-kbd-seq`（overlay.css，沿側板 `.log-hint kbd`
 *   放大一級）、分隔＝原型票根的 1px dashed（同 BackupTab 危險區那道）。settings.css 的 `.ns-hk-*` 只放排版，
 *   顏色一律 token。高度不由本籤管：撐不下時整張紙卡的本文一起捲（DialogShell `.ns-dialog-body`）。
 */
import { Fragment, useRef, useState } from "react";
import { useUiStore } from "../../store/uiStore";
import { SCENES, dualModeNote, rowSlots, rowsFor, sceneNote, sceneOf, type HotkeyRow, type RowSlot } from "../shell/hotkeyRows";
import { formatChord, hotkeyById, hotkeyOverrides, type Hotkey } from "../shell/hotkeys";
import { OS_HOTKEY_ID, allConflictIds, chordProblem, conflictsOf, isRebindable } from "../shell/hotkeyRebind";
import { rebindHotkey, resetAllHotkeys, resetHotkeys, restoreHotkeys } from "../shell/hotkeyOverrides";
import { useHotkeyRevision } from "../shell/useHotkeyRevision";
import { useChordRecorder } from "./useChordRecorder";
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

/** 撞到的那一筆怎麼稱呼：不同組的帶組名（「全域・快速跳轉」），同組的只寫動作 */
function conflictName(hk: Hotkey, from: string): string {
  return hk.scope === hotkeyById(from)?.scope ? hk.label : `${sceneOf(hk.scope).title}・${hk.label}`;
}

/** 這一列撞到誰（去重；一句只點名第一個，多的寫「等 N 項」） */
function conflictLine(row: HotkeyRow): string | null {
  const seen = new Map<string, Hotkey>();
  let from = "";
  for (const slot of rowSlots(row)) {
    for (const hk of conflictsOf(slot.id, slot.index)) {
      if (row.ids.includes(hk.id)) continue;
      seen.set(hk.id, hk);
      from = slot.id;
    }
  }
  const list = [...seen.values()];
  if (list.length === 0) return null;
  const more = list.length > 1 ? `等 ${list.length} 項` : "";
  return `和〈${conflictName(list[0], from)}〉${more}撞鍵，換一組或還原`;
}

function RecordingCap({
  slot,
  row,
  onDone,
  problem,
  setProblem,
}: {
  slot: RowSlot;
  row: HotkeyRow;
  onDone: () => void;
  problem: string | null;
  setProblem: (msg: string | null) => void;
}) {
  const { held, capRef } = useChordRecorder(true, {
    onCancel: onDone,
    onChord: (chord, code) => {
      const hk = hotkeyById(slot.id);
      // 數字鍵盤的 1 跟上排的 1 字一樣、實體鍵不同：背景鍵認實體鍵，錄下去會註冊成上排那顆
      const bad = slot.id === OS_HOTKEY_ID && code.startsWith("Numpad") ? "這組鍵要用上排的數字，不能用數字鍵盤。" : hk && chordProblem(hk, slot.index, chord);
      if (bad) {
        setProblem(bad);
        return;
      }
      void rebindHotkey(slot.id, slot.index, chord).then((failed) => {
        if (failed) setProblem(failed);
        else onDone();
      });
    },
  });
  return (
    <span
      ref={capRef}
      className="ns-hk-rec"
      role="status"
      aria-label={`正在換〈${row.label}〉的鍵，按下新的組合鍵，按 Esc 取消`}
    >
      {held.length ? `${held.join("+")}+…` : problem ? "再按一組…" : "按下新的組合鍵…"}
    </span>
  );
}

function Row({ row }: { row: HotkeyRow }) {
  const [recording, setRecording] = useState<RowSlot | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const overrides = hotkeyOverrides();
  const changed = row.ids.some((id) => overrides.has(id));
  const conflict = recording ? null : conflictLine(row);
  const liRef = useRef<HTMLLIElement>(null);
  const stop = () => {
    const slot = recording;
    setRecording(null);
    setProblem(null);
    // 鍵盤流不中斷：焦點回到剛才那一格（錄鍵時那顆按鈕換成提示字，焦點會掉到頁面上）
    if (slot) requestAnimationFrame(() => liRef.current?.querySelector<HTMLElement>(`[data-slot="${slot.id}:${slot.index}"]`)?.focus());
  };

  return (
    <li ref={liRef} className="ns-hk-row">
      <span className="ns-hk-label">
        {row.label}
        {row.note && <span className="ns-note ns-hk-note">{row.note}</span>}
      </span>
      <span className="ns-hk-keys">
        {/* 成對（↑／↓）與替代路（Enter／Space）都攤成一串，條與條之間一個「／」；每一格各自能改 */}
        {rowSlots(row).map((slot, i) => {
          const hk = hotkeyById(slot.id);
          const editable = !!hk && isRebindable(hk);
          const caps = formatChord(slot.chord);
          const isRec = recording?.id === slot.id && recording.index === slot.index;
          return (
            <Fragment key={`${slot.id}:${slot.index}`}>
              {i > 0 && <span className="ns-hk-or">／</span>}
              {isRec ? (
                <RecordingCap slot={slot} row={row} onDone={stop} problem={problem} setProblem={setProblem} />
              ) : editable ? (
                <button
                  type="button"
                  className={`ns-hk-cap${conflictsOf(slot.id, slot.index).length ? " is-conflict" : ""}`}
                  data-slot={`${slot.id}:${slot.index}`}
                  title="點一下換一組鍵"
                  aria-label={`更換〈${row.label}〉的鍵，目前是 ${caps.join("+")}`}
                  onClick={() => {
                    setProblem(null);
                    setRecording(slot);
                  }}
                >
                  <KeyCaps caps={caps} />
                </button>
              ) : (
                <span title={slot.chord.key === "Escape" ? "Esc 固定是退一步，不能改" : "輸入時的慣例，不能改"}>
                  <KeyCaps caps={caps} />
                </span>
              )}
            </Fragment>
          );
        })}
        {changed && !recording && (
          <button type="button" className="ns-hk-reset" onClick={() => void resetHotkeys(row.ids)}>
            還原
          </button>
        )}
      </span>
      {recording && <p className={`ns-hk-msg${problem ? " is-bad" : ""}`}>{problem ?? "按 Esc 取消"}</p>}
      {conflict && <p className="ns-hk-msg is-bad">{conflict}</p>}
    </li>
  );
}

export function HotkeysTab() {
  useHotkeyRevision();
  const showToast = useUiStore((s) => s.showToast);
  const clashes = allConflictIds().length;
  const anyChanged = hotkeyOverrides().size > 0;

  const resetAll = () => {
    void resetAllHotkeys().then(({ before, warning }) =>
      showToast({
        message: "快捷鍵已還原成預設",
        sub: warning ?? undefined,
        actionLabel: "復原",
        onAction: () => void restoreHotkeys(before),
      }),
    );
  };

  return (
    <div className="ns-hk">
      {/* ⓪ 籤頂：導航／編輯雙模式——規格書鐵則翻成人話（文案在 hotkeyRows，跟 registry 同一份備援鍵字） */}
      <section className="ns-hk-intro">
        <div className="ns-hk-intro-head">
          <div>
            <span className="techo-label block mb-1">選取時・打字時</span>
            <ul className="ns-hk-intro-list">
              {dualModeNote().map((line) => (
                <li key={line} className="ns-note">
                  {line}
                </li>
              ))}
              <li className="ns-note">
                點鍵帽就能換一組鍵。
                {clashes > 0 && <span className="ns-hk-clash">有 {clashes} 列撞鍵</span>}
              </li>
            </ul>
          </div>
          <button type="button" className="btn-ghost ns-btn ns-btn--sm shrink-0" disabled={!anyChanged} onClick={resetAll}>
            全部還原預設
          </button>
        </div>
      </section>

      {/* ①–⑦ 七組：順序＝SCENES 的順序（全域→今日→路線圖→日曆→當日清單→通用→編輯模式） */}
      {SCENES.map((scene) => {
        const rows = rowsFor(scene.scope);
        const fixed = rows.every((r) => r.ids.every((id) => !isRebindable(hotkeyById(id)!)));
        return (
          <section key={scene.scope} className="ns-hk-scene" aria-labelledby={`ns-hk-${scene.scope}`}>
            <span id={`ns-hk-${scene.scope}`} className="techo-label block">
              {scene.title}
            </span>
            <p className="ns-note ns-hk-when">
              {sceneNote(scene)}
              {fixed && "這組是輸入時的慣例，不能改。"}
            </p>
            <ul className="ns-hk-list">
              {rows.map((row) => (
                <Row key={row.id} row={row} />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
