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
 * 票根（車次② D-筆-36）：內建四枚（收件匣／待辦／筆記／日記）＋手機入口通車的線登記的捕捉目的地
 *   （store.captureStubList("mobile")）。內建的字取 STUB_LABEL／STUB_HINT；登記的取 spec.label／hint、落點取 spec.destLabel。
 *   375px 寬四枚一排；多於四枚（別線登記）時橫捲，不擠扁；≤360px 收掉小字（契約 §8-7）。
 *   不吃路線前綴的票根（日記、acceptsRoute=false 的登記票根）認到前綴時，路線票根改畫淡化版「●路線名・日記不掛路線」
 *   （沒有 ×；游標在開頭按退格仍可取消，主人可能想順手把前綴字刪掉）。存檔一律 store.saveCapture（它會分派）。
 *
 * IME：唯一攔的鍵是「游標在開頭時 Backspace＝取消路線票根」與實體鍵盤的 Esc，
 *   一律先判 isComposing／keyCode 229，再加 composition 旗標（Android 部分 IME 兩者都不帶；MobileToday 同法）。
 *
 * 車次③（契約 §5.5、7.2-7）：打字區游標處打 `#` ⇒ 打字區下方出荷札建議（MobileTagSuggest；組字中不出）；
 *   點一列＝把 `#q` 換成 `#名稱 `、游標放回去。存檔後的解析與掛上由 store 的 saveCapture 做（§2.1）。
 *
 * 車次④（契約 0-2 甲、§5.5-1、§5.7-5）：從路線圖「＋ 記一則」開的面板帶預掛節點（`store.capturePreset`）：
 *   票根預選「筆記」，落點一行＝「→ 筆記 · 路線 › 節點」；「收件匣」票根＋預掛＝同樣直接進筆記。
 *   路線前綴認到同一條路線＝照常吃掉（路線票根照畫、可取消）；認到別條路線＝前綴當一般文字（以預掛為準）。
 *   規則與 store.saveCapture 同一條；待辦／日記／別線票根不吃預掛、照舊。
 */
import { useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { MobileTagSuggest } from "./MobileTagToolbar";
import { replaceAtCaret, useCaretTag } from "./mobileTagBits";
import { useNodeStore } from "../../../store/nodeStore";
import { captureRouteOf, captureStubList, captureTargetOf, useNotesStore } from "../../../store/notesStore";
import {
  STUB_HINT,
  applyCapturePreset,
  STUB_LABEL,
  isBuiltinStub,
  needsPreview,
  resolveDestination,
  splitTodoLines,
  type CaptureStub,
} from "../../../domain/notes";
import { RouteDot } from "./MobileAttachPicker";

/** 打字區最高長到幾 px（超過就內捲；面板其餘部分仍看得見） */
const TA_MAX = 220;

/** 票根的大字／小字：內建查表、登記的查 spec（該線已不通車＝null，不畫） */
function stubText(k: CaptureStub): { label: string; hint: string } | null {
  if (isBuiltinStub(k)) return { label: STUB_LABEL[k], hint: STUB_HINT[k] };
  const spec = captureTargetOf(k);
  return spec ? { label: spec.label, hint: spec.hint } : null;
}

export function MobileCaptureSheet() {
  const capture = useNotesStore((s) => s.capture);
  const preset = useNotesStore((s) => s.capturePreset);
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

  /* 荷札建議：游標處的 #…；選了之後游標在下一次 render 放回 */
  const { at: tagAt, dismiss: dismissTag } = useCaretTag(taRef, capture !== null);
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const ta = taRef.current;
    const c = pendingCaret.current;
    if (!ta || c === null) return;
    pendingCaret.current = null;
    ta.setSelectionRange(c, c);
  }, [capture?.text]);

  if (!capture) return null;

  const rawP = captureRouteOf(capture, routes);
  // 階段④ 0-2：預掛節點——與 store.saveCapture 同一支純函式（domain applyCapturePreset）：
  //   筆記／收件匣票根＝掛在預掛節點（收件匣＋預掛＝直接進筆記），前綴認到別條路線＝前綴當一般文字；
  //   待辦票根＝不建進樹，只借預掛節點的路線當路線標籤（合成的前綴 matched＝""，沒有字可取消）
  const { prefix: p, nodeId: presetNodeId } = applyCapturePreset(capture.stub, rawP, capture.text, preset, routes);
  const usePreset = preset !== null && presetNodeId !== null;
  const route = p ? (routes.find((r) => r.id === p.routeId) ?? null) : null;
  const rawRoute = rawP ? (routes.find((r) => r.id === rawP.routeId) ?? null) : null;
  /** 合成的前綴（待辦＋預掛）：畫在落點一行就好，不畫可取消的路線票根 */
  const typedPrefix = !!p && p.matched !== "";
  const stubs = captureStubList("mobile");
  const spec = isBuiltinStub(capture.stub) ? null : captureTargetOf(capture.stub);

  let body: string;
  let destText: string;
  let showRoute: boolean;
  let noInboxNote = false;
  /** 認到前綴、但這枚票根不吃路線 ⇒ 路線票根淡化 */
  let routeMuted: string | null = null;
  if (usePreset) {
    // 「→ 筆記 · 路線 › 節點」（§5.7-5）；同路線的前綴照樣被吃掉（路線票根照畫、可取消），落點仍以預掛節點為準
    body = p ? p.body : capture.text;
    destText = "→ 筆記 · " + preset.label;
    showRoute = false;
    if (rawP && !p) routeMuted = "已掛在這裡";
  } else if (isBuiltinStub(capture.stub)) {
    const dest = resolveDestination(capture.stub, !!p);
    body = dest.consumePrefix && p ? p.body : capture.text;
    if (needsPreview(capture.stub, body)) {
      destText = `→ 預覽：拆成 ${splitTodoLines(body).filter((l) => l.checked).length} 張車票`;
    } else if (dest.target === "inbox") destText = "→ 收件匣";
    else if (dest.target === "today") destText = "→ 今日";
    else if (dest.target === "diary") destText = "→ 今天的日記";
    else destText = "→ 筆記";
    showRoute = dest.withRoute && !!route;
    noInboxNote = dest.target === "note" && capture.stub === "inbox" && dest.withRoute;
    if (dest.target === "diary") routeMuted = "日記不掛路線";
  } else {
    const useRoute = !!spec?.acceptsRoute && !!p;
    body = useRoute && p ? p.body : capture.text;
    destText = "→ " + (spec ? spec.destLabel(p ? { id: p.route.id, name: p.route.name } : null) : "（這裡目前不能選）");
    showRoute = false; // 路線怎麼寫由 spec.destLabel 決定
    if (spec && !spec.acceptsRoute) routeMuted = `${spec.label}不掛路線`;
  }
  const empty = !body.trim();

  const keepFocus = (e: { preventDefault(): void }) => e.preventDefault();

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229 || composing.current) return;
    if (e.key === "Escape") {
      e.preventDefault();
      escapeCapture();
      return;
    }
    if (e.key === "Backspace" && rawP) {
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
      // 只有真的沒字才聚焦；"failed"（寫入失敗）不聚焦，免得鍵盤彈回來蓋住失敗 toast（磨光① #65 後半）
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
        {tagAt && (
          <div className="ns-notes-mcapsug">
            <MobileTagSuggest
              q={tagAt.q}
              onPick={(name) => {
                const r = replaceAtCaret(capture.text, tagAt.start, tagAt.caret, name);
                pendingCaret.current = r.caret;
                setCaptureText(r.text);
              }}
              onDismiss={dismissTag}
            />
          </div>
        )}
        <div className="ns-notes-mtear" aria-hidden />

        <div className="ns-notes-mstubs" role="group" aria-label="票根">
          {stubs.map((k) => {
            const t = stubText(k);
            if (!t) return null;
            return (
              <button
                key={k}
                type="button"
                className={"ns-notes-mstub" + (capture.stub === k ? " on" : "")}
                aria-pressed={capture.stub === k}
                onMouseDown={keepFocus}
                onClick={() => setCaptureStub(k)}
              >
                <span className="l">{t.label}</span>
                <span className="h">{t.hint}</span>
              </button>
            );
          })}
        </div>

        {rawP && rawRoute && routeMuted && (
          <div className="ns-notes-mroute">
            <span className="ns-notes-mroutestub muted" title={`認出路線「${rawP.matched.trim()}」——${usePreset ? `已掛在「${preset?.label ?? ""}」` : "這一枚票根不掛路線"}，原文保留`}>
              <RouteDot route={rawRoute} />
              <span className="nm">{rawRoute.name}</span>
              <span className="why">・{routeMuted}</span>
            </span>
          </div>
        )}

        {typedPrefix && p && route && !routeMuted && (
          <div className="ns-notes-mroute">
            <span className="ns-notes-mroutestub" title={`認出路線代碼「${p.matched.trim()}」`}>
              <span className="arr" aria-hidden>
                →
              </span>
              <RouteDot route={route} />
              <span className="nm">{route.name}</span>
              <button
                type="button"
                className="x"
                aria-label="取消路線（在開頭按退格鍵也可以）"
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

        {capture.confirmEsc && <p className="ns-notes-mwarn">還有內容沒存——再按一次就放棄</p>}

        <div className="ns-notes-msave">
          <span className="dest">
            {destText}
            {showRoute && route && (
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
