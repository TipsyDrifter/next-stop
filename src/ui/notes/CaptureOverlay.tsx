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
 * 車次③：打字區游標處打 # 出荷札建議（useInlineTagSuggest；清單開著時 ↑↓／Enter／Tab／Esc 歸它，關著才是上面那套）；
 *   存檔後的 syncNoteTags 由 store 做（契約 0-13、§5.3）。
 *
 * 車次②：票根列＝內建四枚（收件匣／待辦／筆記／日記）＋別線登記的捕捉目的地（`captureStubList("desktop")`，D-筆-36）。
 *   內建的顯示 STUB_LABEL／STUB_HINT；登記的顯示 spec.label／spec.hint、落點列＝spec.destLabel(route)；存檔一律 saveCapture()。
 *   日記票根：落點「→ 今天的日記」；認到路線前綴時路線票根淡化成「●路線名・日記不掛路線」（沒有 ×；前綴照原文存進內文）。
 *
 * 車次④（契約 §5.1-3、0-2 甲）：側板「＋ 在這裡記一則」帶預掛節點（`capturePreset`）開框——票根預選「筆記」，
 *   筆記／收件匣票根的落點固定「→ 筆記 · 路線 › 節點」（收件匣＋預掛＝直接進筆記，同路線前綴的規則）；
 *   打了路線前綴也以預掛為準：路線票根淡化成「●路線名・已掛在這裡」（同一條路線＝前綴不進內文；別條＝前綴照原文留著）。
 *   待辦票根＋預掛＝不建進樹、只借預掛節點的路線當標籤：路線票根「→ ●路線名」（沒有 ×——不是打出來的前綴，取消不了），落點「→ 今日 · 路線名」。
 *   日記／別線票根不認預掛。判斷一律走 domain 的 `applyCapturePreset`（與 store 的 saveCapture 同一份）。
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { captureRouteOf, captureStubList, captureTargetOf, useNotesStore } from "../../store/notesStore";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { todayKey } from "../../lib/date";
import {
  STUB_HINT,
  STUB_LABEL,
  isBuiltinStub,
  needsPreview,
  resolveDestination,
  splitTodoLines,
  applyCapturePreset,
  type CaptureStub,
} from "../../domain/notes";
import { matches } from "../shell/hotkeys";
import { useInlineTagSuggest } from "./tags/useInlineTagSuggest";
import { IconX, Kbd, RouteDot, capsOf, fmtTime, handOffReturnFocus, restoreFocus } from "./notesBits";

export function CaptureOverlay() {
  const capture = useNotesStore((s) => s.capture);
  const preset = useNotesStore((s) => s.capturePreset);
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

  const tagSug = useInlineTagSuggest(taRef, (next) => useNotesStore.getState().setCaptureText(next));

  if (!capture) return null;

  const st = useNotesStore.getState;
  const rawP = captureRouteOf(capture, routes);
  // 預掛節點（車次④）：與 store saveCapture 同一支 applyCapturePreset——筆記／收件匣票根掛在預掛節點（別條路線的前綴當文字）；
  // 待辦票根只借預掛節點的路線（合成的前綴 matched＝""）
  const { prefix: p, nodeId: presetNodeId } = applyCapturePreset(capture.stub, rawP, capture.text, preset, routes);
  const usePreset = presetNodeId !== null && preset !== null;
  /** 待辦＋預掛：路線是借預掛節點的（合成的前綴，不是打出來的）⇒ 路線票根沒有 ×；打了別條路線的前綴就淡化那枚 */
  const presetOnlyRoute = !!p && p.matched === "";
  const route = p ? (routes.find((r) => r.id === p.routeId) ?? null) : rawP ? (routes.find((r) => r.id === rawP.routeId) ?? null) : null;
  const presetRoute = usePreset && preset.routeId ? (routes.find((r) => r.id === preset.routeId) ?? null) : null;
  const stubs = captureStubList("desktop");
  // 別線登記的票根（D-筆-36）：不走本線的去處表，落點與存檔都看它的 spec
  const spec = isBuiltinStub(capture.stub) ? null : captureTargetOf(capture.stub);
  const dest = usePreset
    ? { target: "note" as const, withRoute: !!p, consumePrefix: !!p }
    : resolveDestination(isBuiltinStub(capture.stub) ? capture.stub : "inbox", !!p);
  const body = dest.consumePrefix && p ? p.body : capture.text;
  /** 路線前綴認到了、但這枚票根不掛路線（日記；登記的票根 acceptsRoute=false）⇒ 路線票根淡化 */
  const routeIgnored = usePreset || (isBuiltinStub(capture.stub) ? capture.stub === "diary" : !spec?.acceptsRoute);
  const ignoredBy = isBuiltinStub(capture.stub) ? STUB_LABEL[capture.stub] : (spec?.label ?? "");
  const ignoredWhy = usePreset ? "已掛在這裡" : presetOnlyRoute ? "以預掛的路線為準" : `${ignoredBy}不掛路線`;
  const ignoredRoute = rawP ? (routes.find((r) => r.id === rawP.routeId) ?? null) : null;
  let ignoredTitle = "";
  if (rawP) {
    const head = `認到路線前綴「${rawP.matched.trim()}」——`;
    if (presetOnlyRoute) ignoredTitle = head + "以預掛節點的路線為準，前綴照原文留著";
    else if (usePreset)
      ignoredTitle = head + (p ? "與預掛的路線相同，前綴不進內文" : `這一則已掛在「${preset.label}」，前綴照原文留著`);
    else ignoredTitle = head + `${ignoredBy}不掛路線，前綴照原文留著`;
  }

  const stubText = (k: CaptureStub): { label: string; hint: string } => {
    if (isBuiltinStub(k)) return { label: STUB_LABEL[k], hint: STUB_HINT[k] };
    const s = captureTargetOf(k);
    return { label: s?.label ?? k, hint: s?.hint ?? "" };
  };

  let destLine;
  if (usePreset) {
    destLine = (
      <>
        → 筆記 · <RouteDot route={presetRoute} /> {preset.label}
      </>
    );
  } else if (!isBuiltinStub(capture.stub)) {
    const label = spec ? spec.destLabel(spec.acceptsRoute && p ? { id: p.route.id, name: p.route.name } : null) : "";
    destLine = label ? <>{label.startsWith("→") ? label : `→ ${label}`}</> : null;
  } else if (dest.target === "diary") {
    destLine = <>→ 今天的日記</>;
  } else if (needsPreview(capture.stub, body)) {
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
    if (tagSug.onKeyDown(e)) return;
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
    } else if (e.key === "Backspace" && rawP && e.currentTarget.selectionStart === 0 && e.currentTarget.selectionEnd === 0) {
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
                {...tagSug.bind}
                onBlur={tagSug.close}
                onKeyDown={onKeyDown}
              />
              {tagSug.popup}
            </div>
            <div className="ns-notes-tear" />
            <div className="ns-notes-capstubs">
              {stubs.map((k) => {
                const t = stubText(k);
                return (
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
                    <span className="l">{t.label}</span>
                    <span className="h">{t.hint}</span>
                  </button>
                );
              })}
              {rawP && (routeIgnored || presetOnlyRoute) && (
                <span key={`${rawP.routeId}-muted`} className="ns-notes-routestub muted" title={ignoredTitle}>
                  <RouteDot route={ignoredRoute} />
                  <span className="nm">{rawP.route.name}</span>
                  <span className="why">{ignoredWhy}</span>
                </span>
              )}
              {p && !routeIgnored && (
                <span
                  key={p.routeId}
                  className="ns-notes-routestub"
                  title={presetOnlyRoute ? "預掛節點的路線" : `認到路線前綴「${p.matched.trim()}」`}
                >
                  <span className="arr">→</span>
                  <RouteDot route={route} />
                  <span className="nm">{p.route.name}</span>
                  {!presetOnlyRoute && (
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
                  )}
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
