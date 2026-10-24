/**
 * TodoPreviewDialog——「變待辦」預覽框（桌機；車次①契約 §5.2；D-筆-18／26；原型 app.js:690-737）。
 *
 * UI 丙-6 P1～P5：殼換共用 `DialogShell size="L"`（眉標 `{變待辦, To tickets}`、標題「變待辦」、×、黏底按鈕列）；
 *   來源字（「來自捕捉框・取消勾選不要的」／單行的「「標題」」）殼沒有插槽，放本文第一行。
 *   foot 依序：鍵位提示（推到最左）、取消、主鈕「建立 N 張車票」（視覺規範 §4；手機 MobileTodoPreview 同字）。
 *
 * 單行＝只有欄位列；多行＝欄位列＋可勾的清單（標題行預設不勾、淡化並標「標題行」）。
 * 欄位只有兩欄（D-筆-26）：
 *   掛到哪＝AttachPicker depth="node"（第一層路線、往下支線／列車／車廂；只選到路線＝路線標籤）＋清除 ×
 *   執行日＝共用 `DateChip`（quick="forward"：今天／明天／後天／下週一；chip 開共用 DatePicker；min＝今天；可清除）——P5，跟側板日期 chip 同一種。
 *     **捕捉小窗例外**：DateChip 用 `useShell`（看視窗寬）分兩殼，小窗寬 640＜768 會被當成手機——開的是手機日期 sheet，
 *     而且 useShell 會把 <html data-shell> 改成 mobile、整個小窗換成手機尺寸。common 不歸本班改，小窗先留舊的
 *     「今天／明天／挑日期…／清除」（`CaptureWindowDateChips`，桌機 DatePicker）；DateChip 能指定殼之後刪掉這支（記〈待併入〉）。
 * 掛到哪浮層（AttachPicker float，absolute、不 portal）不能被殼本文的內捲裁掉：這一框的本文 `overflow: visible`（notes.css 變待辦段；
 *   P4——不改 common 的 AttachPicker，免得波及核心「移動到…」）。清單本身另有 max-height 自己捲。
 * 鍵：
 *   - Esc＝殼的（掛 window）→ `onClose`：掛到哪浮層開著先收浮層、否則 `cancelPreview`（P2：自己那支 window Esc 拿掉，不然兩支一起跑＝
 *     浮層開著按 Esc 連框一起關）。浮層／日期小卡裡按 Esc 由它們自己 stopPropagation 擋下，到不了殼。
 *   - 點暗幕：浮層（掛到哪、日期小卡）開著時那一下只收浮層（floatAtVeilDown；UI 丙-6 回修），再點一次才關框。
 *   - Ctrl+Enter＝建立（自己掛 window，先判 IME；殼沒有這條）。清單列上 Space 切勾（原生 checkbox）。
 * 開啟時焦點在「建立 N 張車票」（autoFocus；殼看到焦點已在卡內就不搶）。
 */
import { useEffect, useRef, useState } from "react";
import { useNotesStore } from "../../store/notesStore";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { addDays, todayKey } from "../../lib/date";
import { matches } from "../shell/hotkeys";
import { AttachPicker } from "../common/AttachPicker";
import { DateChip } from "../common/DateChip";
import { DatePicker, shortDayKey } from "../common/DatePicker";
import { DialogShell } from "../common/DialogShell";
import { IconX, Kbd, RouteDot, attachParts, restoreFocus, takeReturnFocus } from "./notesBits";
import { isCaptureWindow } from "./capture-window/shell";

/** 這個 JS context 是不是捕捉小窗（啟動後不會變；同 NotesDesktopOverlay） */
const IN_CAPTURE_WINDOW = isCaptureWindow();

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

  // Ctrl+Enter 掛在 window（同殼的 Esc）：焦點不論落在框裡哪裡（或挑選器收起後落空）都吃得到。Esc 歸殼（見檔頭）。
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (matches(e, "notes-capture.preview.confirm")) {
      e.preventDefault();
      void confirmRef.current();
    }
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);
  const confirmRef = useRef<() => Promise<void>>(async () => {});
  // 點暗幕時若有浮層（掛到哪、日期小卡）開著：那一下只收浮層，不連框一起關（P2 精神：一次收一層）。
  // 浮層自己在 mousedown 收起、殼的暗幕也在同一個 mousedown 叫 onClose；window 捕獲階段最先跑，這時浮層還在 DOM 裡。
  const floatAtVeilDown = useRef(false);
  useEffect(() => {
    const on = (e: MouseEvent) => {
      const t = e.target;
      floatAtVeilDown.current =
        t instanceof Element &&
        t.classList.contains("techo-veil") &&
        !!document.querySelector(".ns-datepick.float, .ns-notes-pop.float");
    };
    window.addEventListener("mousedown", on, true);
    return () => window.removeEventListener("mousedown", on, true);
  }, []);
  const fieldBtnRef = useRef<HTMLButtonElement>(null);
  const closeAttach = () => {
    setAttachOpen(false);
    fieldBtnRef.current?.focus({ preventScroll: true });
  };

  if (!pv) return null;
  const st = useNotesStore.getState;
  const today = todayKey(dayStartHour);
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

  /** 殼的 ×／Esc／點暗幕（P2）：掛到哪浮層開著先收浮層 */
  const onClose = () => {
    if (floatAtVeilDown.current) {
      floatAtVeilDown.current = false; // 浮層已在同一下 mousedown 自己收了
      return;
    }
    if (attachOpen) closeAttach();
    else st().cancelPreview();
  };

  const foot = (
    <>
      <span className="ns-notes-prevhint">
        {pv.scheduledOn === null && !hasAttach && "未指定日期或路線，將留在收件匣・"}
        <Kbd id="notes-capture.preview.confirm" />
        建立・
        <Kbd id="notes-capture.escape" />
        取消
      </span>
      <button type="button" className="ns-btn btn-ghost" onClick={() => st().cancelPreview()}>
        取消
      </button>
      <button type="button" className="ns-btn btn-seal" autoFocus disabled={n === 0} onClick={() => void confirm()}>
        建立 {n} 張車票
      </button>
    </>
  );

  return (
    <DialogShell size="L" overline={{ zh: "變待辦", latin: "To tickets" }} title="變待辦" onClose={onClose} foot={foot}>
      <div className="ns-notes-prev">
        <p className="ns-notes-prevsrc">{pv.single ? `「${title}」` : `${src}・取消勾選不要的`}</p>

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
                  {!hasAttach ? "不掛（臨時車票）" : `${route?.name ?? "（路線）"}${nodeName ? ` › ${nodeName}` : ""}`}
                </span>
              </button>
              {hasAttach && (
                <button
                  type="button"
                  className="ns-notes-fieldbtn clear"
                  aria-label="不掛"
                  title="不掛"
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
              {IN_CAPTURE_WINDOW ? (
                <CaptureWindowDateChips value={pv.scheduledOn} today={today} onPick={(d) => st().setPreviewDate(d)} />
              ) : (
                <DateChip
                  date={pv.scheduledOn}
                  onPick={(d) => {
                    if (d === null || d >= today) st().setPreviewDate(d);
                  }}
                  quick="forward"
                  label="執行日"
                  min={today}
                  today={today}
                  clearable
                />
              )}
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
      </div>
    </DialogShell>
  );
}

/**
 * 捕捉小窗專用的執行日（見檔頭「捕捉小窗例外」）：舊的「今天／明天／挑日期…／清除」＋桌機 DatePicker（anchor 模式，portal 到 body；
 * 小窗的 FLOATERS 有算它的高度）。日期小卡的 Esc 由 DatePicker 自己 stopPropagation，到不了殼。
 */
function CaptureWindowDateChips({ value, today, onPick }: { value: string | null; today: string; onPick: (d: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const tomorrow = addDays(today, 1);
  const custom = value !== null && value !== today && value !== tomorrow;
  return (
    <div className="ns-notes-chips">
      <button type="button" className={`ns-notes-chip${value === today ? " on" : ""}`} aria-pressed={value === today} onClick={() => onPick(today)}>
        今天
      </button>
      <button type="button" className={`ns-notes-chip${value === tomorrow ? " on" : ""}`} aria-pressed={value === tomorrow} onClick={() => onPick(tomorrow)}>
        明天
      </button>
      <button
        ref={btnRef}
        type="button"
        className={`ns-notes-chip${custom ? " on" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={custom && value ? `執行日 ${shortDayKey(value)}，換一天` : "挑日期"}
        onClick={() => setOpen((o) => !o)}
      >
        {custom && value ? shortDayKey(value) : "挑日期…"}
      </button>
      {open && (
        <DatePicker
          anchor={btnRef.current}
          label="執行日"
          value={value}
          min={today}
          onPick={(d) => {
            setOpen(false);
            if (d >= today) onPick(d);
          }}
          onClose={() => setOpen(false)}
        />
      )}
      <button type="button" className={`ns-notes-chip${value === null ? " on" : ""}`} aria-pressed={value === null} onClick={() => onPick(null)}>
        清除
      </button>
    </div>
  );
}
