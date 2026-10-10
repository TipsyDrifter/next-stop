/**
 * MobileCaptureSheet——手機的捕捉面板（「記一句」；車次①契約 §5.3；原型 app.js captureHtml 的 mob 分支）。
 *
 * 狀態機全部在 notesStore（契約 0-6：共用狀態機＋純函式、元件各寫）：文字、票根、路線前綴取消、
 * 「有內容先問一次」、存檔分流都由 store 決定；本元件只畫與轉發事件。
 *
 * 與桌機刻意不同的三處（原型施工決定 11／契約 §5.3）：
 *   1. **Enter 是換行**——手機軟鍵盤的 Enter 就是換行鍵，存檔按「存」。所以這裡不攔 Enter。
 *   2. 「取消」＝桌機的 Esc：有內容時第一次只亮提示「再按一次取消就放棄」（store.escapeCapture 的二段確認），
 *      點暗幕同效（暗幕是隱性知識，「取消」才是明講的那一格）。
 *   3. 沒有鍵位提示列（手機沒有鍵盤）；落點一行與「存」並排在底部。
 *
 * 焦點：票根／取消路線鈕的 mousedown 先 preventDefault，按了不會把焦點從打字區搶走
 *   ——否則 Android 軟鍵盤會收下去又彈上來，打字被打斷。
 *
 * IME：唯一攔的鍵是「游標在開頭時 Backspace＝取消路線票根」與實體鍵盤的 Esc，
 *   一律先判 isComposing／keyCode 229，再加 composition 旗標（Android 部分 IME 兩者都不帶；MobileToday 同法）。
 */
import { useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { useNodeStore } from "../../../store/nodeStore";
import { captureRouteOf, useNotesStore } from "../../../store/notesStore";
import {
  CAPTURE_STUBS,
  STUB_HINT,
  STUB_LABEL,
  needsPreview,
  resolveDestination,
  splitTodoLines,
} from "../../../domain/notes";
import { RouteDot } from "./MobileAttachPicker";

/** 打字區最高長到幾 px（超過就內捲；面板其餘部分仍看得見） */
const TA_MAX = 220;

export function MobileCaptureSheet() {
  const capture = useNotesStore((s) => s.capture);
  const routes = useNodeStore((s) => s.routes);
  const setCaptureText = useNotesStore((s) => s.setCaptureText);
  const setCaptureStub = useNotesStore((s) => s.setCaptureStub);
  const dismissRoute = useNotesStore((s) => s.dismissRoute);
  const escapeCapture = useNotesStore((s) => s.escapeCapture);
  const saveCapture = useNotesStore((s) => s.saveCapture);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const saving = useRef(false);

  // 打字區自動長高（rows=2 起跳、TA_MAX 封頂）
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, TA_MAX) + "px";
  }, [capture?.text]);

  if (!capture) return null;

  const p = captureRouteOf(capture, routes);
  const route = p ? (routes.find((r) => r.id === p.routeId) ?? null) : null;
  const dest = resolveDestination(capture.stub, !!p);
  const body = dest.consumePrefix && p ? p.body : capture.text;
  const empty = !body.trim();

  let destText: string;
  if (needsPreview(capture.stub, body)) {
    destText = `→ 先預覽：拆成 ${splitTodoLines(body).filter((l) => l.checked).length} 張車票`;
  } else if (dest.target === "inbox") destText = "→ 收件匣";
  else if (dest.target === "today") destText = "→ 今日";
  else if (dest.target === "diary") destText = "→ 今天的日記";
  else destText = "→ 筆記";
  const showRoute = dest.withRoute && route;
  const noInboxNote = dest.target === "note" && capture.stub === "inbox" && dest.withRoute;

  const keepFocus = (e: { preventDefault(): void }) => e.preventDefault();

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229 || composing.current) return;
    if (e.key === "Escape") {
      e.preventDefault();
      escapeCapture();
      return;
    }
    if (e.key === "Backspace" && p) {
      const ta = e.currentTarget;
      if (ta.selectionStart === 0 && ta.selectionEnd === 0) {
        e.preventDefault();
        dismissRoute();
      }
    }
  };

  const save = async () => {
    if (saving.current) return;
    saving.current = true;
    try {
      const r = await saveCapture();
      if (r === "empty") taRef.current?.focus();
    } finally {
      saving.current = false;
    }
  };

  return (
    <div
      className="ns-notes-mveil"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) escapeCapture();
      }}
    >
      <div className="ns-notes-msheet" role="dialog" aria-modal="true" aria-label="記一句">
        <div className="ns-notes-grip" aria-hidden />
        <textarea
          ref={taRef}
          className="ns-notes-mcapta"
          rows={2}
          value={capture.text}
          onChange={(e) => setCaptureText(e.target.value)}
          onKeyDown={onKeyDown}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          placeholder="記一句…"
          aria-label="記一句"
          autoFocus
          spellCheck={false}
          autoComplete="off"
        />
        <div className="ns-notes-mtear" aria-hidden />

        <div className="ns-notes-mstubs" role="group" aria-label="票根">
          {CAPTURE_STUBS.map((k) => (
            <button
              key={k}
              type="button"
              className={"ns-notes-mstub" + (capture.stub === k ? " on" : "")}
              aria-pressed={capture.stub === k}
              onMouseDown={keepFocus}
              onClick={() => setCaptureStub(k)}
            >
              <span className="l">{STUB_LABEL[k]}</span>
              <span className="h">{STUB_HINT[k]}</span>
            </button>
          ))}
        </div>

        {p && route && (
          <div className="ns-notes-mroute">
            <span className="ns-notes-mroutestub" title={`認到路線前綴「${p.matched.trim()}」`}>
              <span className="arr" aria-hidden>
                →
              </span>
              <RouteDot route={route} />
              <span className="nm">{route.name}</span>
              <button
                type="button"
                className="x"
                aria-label="取消路線（游標在開頭按退格也可以）"
                onMouseDown={keepFocus}
                onClick={dismissRoute}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
              </button>
            </span>
          </div>
        )}

        {capture.confirmEsc && <p className="ns-notes-mwarn">還有內容沒存——再按一次取消就放棄</p>}

        <div className="ns-notes-msave">
          <span className="dest">
            {destText}
            {showRoute && (
              <>
                {" · "}
                <RouteDot route={route} />
                {route.name}
              </>
            )}
            {noInboxNote && "（有路線，不進收件匣）"}
          </span>
          <button type="button" className="ns-notes-mbtn" onMouseDown={keepFocus} onClick={escapeCapture}>
            取消
          </button>
          <button
            type="button"
            className="ns-notes-mbtn primary"
            onMouseDown={keepFocus}
            onClick={() => void save()}
            disabled={empty}
          >
            存
          </button>
        </div>
      </div>
    </div>
  );
}
