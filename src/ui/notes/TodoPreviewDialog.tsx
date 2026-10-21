/**
 * TodoPreviewDialog——「變成車票」預覽框（桌機；車次①契約 §5.2；D-筆-18／26；原型 app.js:690-737）。
 *
 * 單行＝只有欄位列；多行＝欄位列＋可勾的清單（標題行預設不勾、淡化並標「標題行」）。
 * 欄位只有兩欄（D-筆-26）：
 *   掛到哪＝AttachPicker depth="node"（第一層路線、往下支線／列車／車廂；只選到路線＝路線標籤）＋清除 ×
 *   執行日＝今天／明天 chip＋「挑日期…」chip（開共用 DatePicker，min＝今天；磨光⑤ S8 取代原生日期欄）＋清除
 * 鍵（掛在 window，先判 IME）：Ctrl+Enter 建立、Esc 取消（掛到哪浮層開著時先收浮層）、清單列上 Space 切勾（原生 checkbox）。
 * 開啟時焦點在「建立 N 張車票」。
 */
import { useEffect, useRef, useState } from "react";
import { useNotesStore } from "../../store/notesStore";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { addDays, todayKey } from "../../lib/date";
import { matches } from "../shell/hotkeys";
import { AttachPicker } from "./AttachPicker";
import { DatePicker, shortDayKey } from "../common/DatePicker";
import { IconX, Kbd, RouteDot, attachParts, restoreFocus, takeReturnFocus } from "./notesBits";

export function TodoPreviewDialog() {
  const pv = useNotesStore((s) => s.preview);
  const inboxNotes = useNotesStore((s) => s.inboxNotes);
  const routes = useNodeStore((s) => s.routes);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const [attachOpen, setAttachOpen] = useState(false);
  const busy = useRef(false);

  // 關掉後焦點還給開框前的元素（捕捉框直接換過來的，用捕捉框交接過來的那一個；notesBits）。
  // 開框前的焦點在 render 時就記下：autoFocus 在 commit 階段就會把焦點搬到「建立」鈕。
  const [prev] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  // （dev 的 StrictMode 會假卸載一次：真的卸載才還——微任務裡看 alive 判斷，同 CaptureOverlay。）
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      queueMicrotask(() => {
        if (!alive.current) restoreFocus(takeReturnFocus() ?? prev);
      });
    };
  }, [prev]);

  // 鍵掛在 window（同 DialogShell）：焦點不論落在框裡哪裡（或挑選器收起後落空）都吃得到 Ctrl+Enter／Esc。
  // 挑選器自己的 Esc 會在 React 根節點 stopPropagation，到不了這裡（先收挑選器、再按一次才取消）。
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (matches(e, "notes-capture.preview.confirm")) {
      e.preventDefault();
      void confirmRef.current();
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (attachOpen) closeAttach();
      else useNotesStore.getState().cancelPreview();
    }
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);
  const confirmRef = useRef<() => Promise<void>>(async () => {});
  const fieldBtnRef = useRef<HTMLButtonElement>(null);
  // 「挑日期」浮層（磨光⑤ S8：取代原生 date 欄）；Esc 由 DatePicker 自己擋下，到不了上面的 window 鍵
  const [dateOpen, setDateOpen] = useState(false);
  const dateBtnRef = useRef<HTMLButtonElement>(null);
  const closeAttach = () => {
    setAttachOpen(false);
    fieldBtnRef.current?.focus({ preventScroll: true });
  };

  if (!pv) return null;
  const st = useNotesStore.getState;
  const today = todayKey(dayStartHour);
  const tomorrow = addDays(today, 1);
  const custom = pv.scheduledOn !== null && pv.scheduledOn !== today && pv.scheduledOn !== tomorrow;
  const n = pv.single ? 1 : pv.lines.filter((l) => l.checked).length;
  const { route, nodeName } = attachParts(pv.attach, routes);
  const hasAttach = !!(pv.attach.routeId || pv.attach.nodeId);

  const title = pv.single ? (pv.lines[0]?.text ?? pv.text.trim()) : "";
  const src =
    pv.source === "capture"
      ? "來自捕捉框"
      : pv.noteId && inboxNotes.some((x) => x.id === pv.noteId)
        ? "來自收件匣的筆記"
        : "來自筆記";

  const confirm = async () => {
    if (busy.current || n === 0) return;
    busy.current = true;
    try {
      await st().confirmPreview();
    } finally {
      busy.current = false;
    }
  };
  confirmRef.current = confirm;

  return (
    <>
      <div
        className="techo-veil ns-notes-veil"
        onMouseDown={(e) => {
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          st().cancelPreview();
        }}
      />
      <div className="ns-notes-prev" role="dialog" aria-modal="true" aria-label="變待辦">
        <div className="ns-notes-prevcard">
          <div className="ns-notes-prevhead">
            <h3>變待辦</h3>
            <span className="src">{pv.single ? `「${title}」` : `${src}・取消勾選不要的`}</span>
          </div>

          <dl className="ns-notes-fields">
            <div className="ns-notes-field">
              <dt>掛到哪</dt>
              <dd>
                <button
                  ref={fieldBtnRef}
                  type="button"
                  className="ns-notes-fieldbtn"
                  data-pop-toggle=""
                  aria-expanded={attachOpen}
                  onClick={() => setAttachOpen((o) => !o)}
                >
                  {hasAttach && <RouteDot route={route} />}
                  <span className="nm">
                    {!hasAttach
                      ? "不掛（臨時車票）"
                      : `${route?.name ?? "（路線）"}${nodeName ? ` › ${nodeName}` : ""}`}
                  </span>
                </button>
                {hasAttach && (
                  <button
                    type="button"
                    className="ns-notes-fieldbtn clear"
                    aria-label="不掛"
                    onClick={() => st().setPreviewAttach({ routeId: null, nodeId: null, nodeKind: null })}
                  >
                    <IconX size={11} />
                  </button>
                )}
                {attachOpen && (
                  <AttachPicker
                    float
                    depth="node"
                    label="掛到哪"
                    value={pv.attach}
                    onPick={(t) => {
                      st().setPreviewAttach(t);
                      closeAttach();
                    }}
                    onClose={closeAttach}
                  />
                )}
              </dd>
            </div>
            <div className="ns-notes-field">
              <dt>執行日</dt>
              <dd>
                <div className="ns-notes-chips">
                  <button
                    type="button"
                    className={`ns-notes-chip${pv.scheduledOn === today ? " on" : ""}`}
                    onClick={() => st().setPreviewDate(today)}
                  >
                    今天
                  </button>
                  <button
                    type="button"
                    className={`ns-notes-chip${pv.scheduledOn === tomorrow ? " on" : ""}`}
                    onClick={() => st().setPreviewDate(tomorrow)}
                  >
                    明天
                  </button>
                  <button
                    ref={dateBtnRef}
                    type="button"
                    className={`ns-notes-chip${custom ? " on" : ""}`}
                    aria-haspopup="dialog"
                    aria-expanded={dateOpen}
                    aria-label={custom && pv.scheduledOn ? `執行日 ${shortDayKey(pv.scheduledOn)}，換一天` : "挑日期"}
                    onClick={() => setDateOpen((o) => !o)}
                  >
                    {custom && pv.scheduledOn ? shortDayKey(pv.scheduledOn) : "挑日期…"}
                  </button>
                  {dateOpen && (
                    <DatePicker
                      anchor={dateBtnRef.current}
                      label="執行日"
                      value={pv.scheduledOn}
                      min={today}
                      onPick={(d) => {
                        setDateOpen(false);
                        if (d >= today) st().setPreviewDate(d);
                      }}
                      onClose={() => setDateOpen(false)}
                    />
                  )}
                  <button
                    type="button"
                    className={`ns-notes-chip${pv.scheduledOn === null ? " on" : ""}`}
                    onClick={() => st().setPreviewDate(null)}
                  >
                    清除
                  </button>
                </div>
              </dd>
            </div>
          </dl>

          {!pv.single && (
            <ul className="ns-notes-lines">
              {pv.lines.map((l, i) => (
                <li key={i} className={`${l.isHeading ? "head" : ""}${l.checked ? "" : " off"}`}>
                  <label>
                    <input
                      type="checkbox"
                      className="ns-notes-check"
                      checked={l.checked}
                      onChange={(e) => st().setPreviewLine(i, e.target.checked)}
                    />
                    <span className="tx">{l.text}</span>
                    {l.isHeading && <span className="ns-notes-headtag">標題</span>}
                  </label>
                </li>
              ))}
            </ul>
          )}

          <div className="ns-notes-prevfoot">
            <span className="hint">
              {pv.scheduledOn === null && !hasAttach && "未指定日期或路線，將留在收件匣・"}
              <Kbd id="notes-capture.preview.confirm" />
              建立・
              <Kbd id="notes-capture.escape" />
              取消
            </span>
            <button type="button" className="ns-notes-btn" onClick={() => st().cancelPreview()}>
              取消
            </button>
            <button type="button" className="ns-notes-btn primary" autoFocus disabled={n === 0} onClick={() => void confirm()}>
              變成 {n} 張車票</button>
          </div>
        </div>
      </div>
    </>
  );
}
