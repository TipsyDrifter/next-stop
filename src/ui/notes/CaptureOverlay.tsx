/**
 * CaptureOverlay——桌機捕捉框「記一句」（車次①契約 §5.2；原型 app.js:657-673、styles.css:744-815）。
 *
 * 畫面中央偏上浮出的一張票：票面打字區 → 撕線 → 票根列（收件匣／待辦／筆記＋認到的路線票根）→ 落點一行 → 鍵位提示。
 * 狀態機全在 notesStore（capture）；本元件只渲染與轉發事件（契約 0-6）。
 *
 * 鍵（textarea 自理；先判 IME，契約 §1-7；比對走 registry 的 notes-capture 組，鍵帽字同樣查 registry）：
 *   Enter 存檔・Shift+Enter 換行・Tab／Shift+Tab 切票根・Esc 關（有內容先問一次）
 *   游標在最前面且有路線票根時 Backspace ＝ 取消路線（不刪字）
 * 暗幕上按下滑鼠＝Esc（escapeCapture）。關掉後焦點還給開框前的元素。
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { captureRouteOf, useNotesStore } from "../../store/notesStore";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { todayKey } from "../../lib/date";
import {
  CAPTURE_STUBS,
  STUB_HINT,
  STUB_LABEL,
  needsPreview,
  resolveDestination,
  splitTodoLines,
} from "../../domain/notes";
import { matches } from "../shell/hotkeys";
import { IconX, Kbd, RouteDot, capsOf, fmtTime, handOffReturnFocus, restoreFocus } from "./notesBits";

export function CaptureOverlay() {
  const capture = useNotesStore((s) => s.capture);
  const routes = useNodeStore((s) => s.routes);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const inRef = useRef<HTMLDivElement>(null);
  const busy = useRef(false);
  const [no] = useState(() => {
    const t = todayKey(dayStartHour);
    return `No.${t.slice(5).replace("-", "")} · ${fmtTime(new Date().toISOString())}`;
  });

  // 焦點：開框即在打字區；關掉還給開框前的元素。開框前的焦點在 render 時就記下（StrictMode 重跑 effect 時
  // activeElement 已經是打字區了）。直接換成預覽框（多行待辦）時不還，交給預覽框關掉時還（notesBits 的交接）。
  // （dev 的 StrictMode 會「掛上→假卸載→再掛上」：真的卸載才還焦點——微任務裡看 alive 判斷。）
  const [prev] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    taRef.current?.focus({ preventScroll: true });
    return () => {
      alive.current = false;
      const toPreview = !!useNotesStore.getState().preview;
      queueMicrotask(() => {
        if (alive.current) return;
        if (toPreview) handOffReturnFocus(prev);
        else restoreFocus(prev);
      });
    };
  }, [prev]);

  // 自動長高＋撕線打孔的高度（--ns-tear＝票面打字區的高度）
  const text = capture?.text ?? "";
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = `${ta.scrollHeight}px`;
    }
    if (topRef.current && inRef.current) inRef.current.style.setProperty("--ns-tear", `${topRef.current.offsetHeight}px`);
  }, [text]);

  if (!capture) return null;

  const st = useNotesStore.getState;
  const p = captureRouteOf(capture, routes);
  const route = p ? (routes.find((r) => r.id === p.routeId) ?? null) : null;
  const dest = resolveDestination(capture.stub, !!p);
  const body = dest.consumePrefix && p ? p.body : capture.text;

  let destLine;
  if (needsPreview(capture.stub, body)) {
    destLine = <>→ 先預覽：拆成 {splitTodoLines(body).filter((l) => l.checked).length} 張車票</>;
  } else if (dest.target === "inbox") {
    destLine = <>→ 收件匣</>;
  } else if (dest.target === "today") {
    destLine = dest.withRoute ? (
      <>
        → 今日 · <RouteDot route={route} /> {p?.route.name}
      </>
    ) : (
      <>→ 今日</>
    );
  } else {
    destLine = dest.withRoute ? (
      <>
        → 筆記 · <RouteDot route={route} /> {p?.route.name}
        {capture.stub === "inbox" ? "（有路線，不進收件匣）" : ""}
      </>
    ) : (
      <>→ 筆記</>
    );
  }

  const refocus = () => taRef.current?.focus({ preventScroll: true });

  const save = async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      await st().saveCapture();
    } finally {
      busy.current = false;
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (matches(e, "notes-capture.save")) {
      e.preventDefault();
      void save();
    } else if (matches(e, "notes-capture.stub.next") || matches(e, "notes-capture.stub.prev")) {
      e.preventDefault();
      st().cycleStub(e.shiftKey ? -1 : 1);
    } else if (matches(e, "notes-capture.escape")) {
      e.preventDefault();
      e.stopPropagation();
      st().escapeCapture();
    } else if (e.key === "Backspace" && p && e.currentTarget.selectionStart === 0 && e.currentTarget.selectionEnd === 0) {
      e.preventDefault();
      st().dismissRoute();
    }
    // Shift+Enter（notes-capture.newline）＝textarea 的預設換行，不攔
  };

  return (
    <>
      <div
        className="techo-veil ns-notes-veil"
        onMouseDown={(e) => {
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          st().escapeCapture();
          refocus();
        }}
      />
      <div className="ns-notes-capwrap" role="dialog" aria-modal="true" aria-label="記一句">
        <div className="ns-notes-capticket">
          <div ref={inRef} className="ns-notes-capin">
            <div ref={topRef} className="ns-notes-captop">
              <div className="ns-notes-capfare">
                <span className="k">記一句</span>
                <span className="no">{no}</span>
              </div>
              <textarea
                ref={taRef}
                className="ns-notes-capta"
                rows={1}
                placeholder="記一句…"
                aria-label="記一句"
                value={capture.text}
                onChange={(e) => st().setCaptureText(e.target.value)}
                onKeyDown={onKeyDown}
              />
            </div>
            <div className="ns-notes-tear" />
            <div className="ns-notes-capstubs">
              {CAPTURE_STUBS.map((k) => (
                <button
                  key={k}
                  type="button"
                  className={`ns-notes-stub${capture.stub === k ? " on" : ""}`}
                  aria-pressed={capture.stub === k}
                  onClick={() => {
                    st().setCaptureStub(k);
                    refocus();
                  }}
                >
                  <span className="l">{STUB_LABEL[k]}</span>
                  <span className="h">{STUB_HINT[k]}</span>
                </button>
              ))}
              {p && (
                <span
                  key={p.routeId}
                  className="ns-notes-routestub"
                  title={`認到路線前綴「${p.matched.trim()}」`}
                >
                  <span className="arr">→</span>
                  <RouteDot route={route} />
                  <span className="nm">{p.route.name}</span>
                  <button
                    type="button"
                    className="x"
                    aria-label="取消路線（游標在開頭按 Backspace 也可以）"
                    title="取消路線（游標在開頭按 Backspace）"
                    onClick={() => {
                      st().dismissRoute();
                      refocus();
                    }}
                  >
                    <IconX size={12} />
                  </button>
                </span>
              )}
            </div>
            <div className="ns-notes-capdest">{destLine}</div>
            <div className="ns-notes-caphint">
              {capture.confirmEsc ? (
                <span className="warn">還有內容沒存——再按一次 {capsOf("notes-capture.escape")} 放棄，或繼續打字</span>
              ) : (
                <>
                  <span>
                    <Kbd id="notes-capture.save" />
                    存檔
                  </span>
                  <span>
                    <Kbd id="notes-capture.newline" />
                    換行
                  </span>
                  <span>
                    <Kbd id="notes-capture.stub.next" />
                    切換票根
                  </span>
                  <span>
                    <Kbd id="notes-capture.escape" />
                    關閉
                  </span>
                  <span className="r">開頭打「路線代碼：」直接掛路線</span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
