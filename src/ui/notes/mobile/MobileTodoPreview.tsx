/**
 * MobileTodoPreview——手機的「變成車票」全螢幕面板（車次①契約 §5.3；D-筆-18／26；原型 app.js previewHtml 的 mob 分支）。
 *
 * 狀態全在 notesStore.preview（桌機 TodoPreviewDialog 同一份）：勾選、掛到哪、執行日、確定與取消都轉呼叫 store。
 * 版面：頂列「取消／變成車票／建立 N 張」→ 捲動區＝來源一行 → 欄位兩欄**直排**（掛到哪、執行日）
 *   → 「沒有日期也沒有路線＝留在收件匣」提示 → 清單（single 時不出）。
 *
 * 「掛到哪」標籤要名字，但 AttachTarget 只有 id：路線名查 nodeStore.routes；節點名在挑的當下由挑選器回傳、
 * 記在本元件（store 不必為了顯示多存一欄）。
 */
import { useState } from "react";
import { useNodeStore } from "../../../store/nodeStore";
import { useUiStore } from "../../../store/uiStore";
import { useNotesStore } from "../../../store/notesStore";
import { addDays, todayKey } from "../../../lib/date";
import { MobileAttachPicker, RouteDot } from "./MobileAttachPicker";

export function MobileTodoPreview() {
  const preview = useNotesStore((s) => s.preview);
  const setPreviewLine = useNotesStore((s) => s.setPreviewLine);
  const setPreviewAttach = useNotesStore((s) => s.setPreviewAttach);
  const setPreviewDate = useNotesStore((s) => s.setPreviewDate);
  const cancelPreview = useNotesStore((s) => s.cancelPreview);
  const confirmPreview = useNotesStore((s) => s.confirmPreview);
  const routes = useNodeStore((s) => s.routes);
  // 來源字三分（階段④ 0-16；同桌機 TodoPreviewDialog）：捕捉框／收件匣的筆記／筆記
  const fromInbox = useNotesStore((s) => !!s.preview?.noteId && s.inboxNotes.some((x) => x.id === s.preview?.noteId));
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const [picking, setPicking] = useState(false);
  const [nodeNames, setNodeNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  if (!preview) return null;

  const today = todayKey(dayStartHour);
  const tomorrow = addDays(today, 1);
  const n = preview.single ? 1 : preview.lines.filter((l) => l.checked).length;
  const { attach, scheduledOn } = preview;
  const route = attach.routeId ? (routes.find((r) => r.id === attach.routeId) ?? null) : null;
  const nodeName = attach.nodeId ? (nodeNames[attach.nodeId] ?? "已選的節點") : null;
  const custom = scheduledOn !== null && scheduledOn !== today && scheduledOn !== tomorrow;
  const staysInInbox = scheduledOn === null && !attach.routeId && !attach.nodeId;
  const single = preview.single;
  const firstText = preview.lines[0]?.text ?? preview.text;

  const confirm = async () => {
    if (busy || n === 0) return;
    setBusy(true);
    try {
      await confirmPreview();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ns-notes-mfull" role="dialog" aria-modal="true" aria-label="變成車票">
      <div className="ns-notes-mfullhead">
        <button type="button" className="ns-notes-mbtn" onClick={cancelPreview}>
          取消
        </button>
        <h3>變成車票</h3>
        <button
          type="button"
          className="ns-notes-mbtn primary"
          onClick={() => void confirm()}
          disabled={n === 0 || busy}
        >
          建立 {n} 張
        </button>
      </div>

      <div className="ns-notes-mfullscroll">
        <p className="ns-notes-mfullsrc">
          {single
            ? `「${firstText}」`
            : `${preview.source === "capture" ? "來自捕捉框" : fromInbox ? "來自收件匣的筆記" : "來自筆記"}・勾掉不要的`}
        </p>

        <dl className="ns-notes-mfields">
          <div className="ns-notes-mfield">
            <dt>掛到哪</dt>
            <dd>
              <button type="button" className="ns-notes-mfieldbtn" onClick={() => setPicking(true)}>
                {route ? (
                  <>
                    <RouteDot route={route} />
                    <span className="nm">
                      {route.name}
                      {nodeName && <span className="sub"> › {nodeName}</span>}
                    </span>
                  </>
                ) : (
                  <span className="nm">不掛（臨時車票）</span>
                )}
              </button>
              {route && (
                <button
                  type="button"
                  className="ns-notes-mfieldx"
                  aria-label="不掛"
                  onClick={() => setPreviewAttach({ routeId: null, nodeId: null, nodeKind: null })}
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
                    <path d="M4 4l8 8M12 4l-8 8" />
                  </svg>
                </button>
              )}
            </dd>
          </div>
          <div className="ns-notes-mfield">
            <dt>執行日</dt>
            <dd className="ns-notes-mchiprow">
              <button
                type="button"
                className={"ns-notes-mchip2" + (scheduledOn === today ? " on" : "")}
                aria-pressed={scheduledOn === today}
                onClick={() => setPreviewDate(today)}
              >
                今天
              </button>
              <button
                type="button"
                className={"ns-notes-mchip2" + (scheduledOn === tomorrow ? " on" : "")}
                aria-pressed={scheduledOn === tomorrow}
                onClick={() => setPreviewDate(tomorrow)}
              >
                明天
              </button>
              <input
                type="date"
                className={"ns-notes-mdate" + (custom ? " on" : "")}
                value={custom && scheduledOn ? scheduledOn : ""}
                min={today}
                aria-label="挑日期"
                onChange={(e) => {
                  const v = e.target.value;
                  if (v && v >= today) setPreviewDate(v);
                }}
              />
              <button
                type="button"
                className={"ns-notes-mchip2" + (scheduledOn === null ? " on" : "")}
                aria-pressed={scheduledOn === null}
                onClick={() => setPreviewDate(null)}
              >
                清除
              </button>
            </dd>
          </div>
        </dl>

        {staysInInbox && <p className="ns-notes-mfullhint">沒有日期也沒有路線＝留在收件匣</p>}

        {!single && (
          <ul className="ns-notes-mlines">
            {preview.lines.map((l, i) => (
              <li key={i} className={(l.isHeading ? "head" : "") + (l.checked ? "" : " off")}>
                <label>
                  <input
                    type="checkbox"
                    className="ns-notes-mcheck"
                    checked={l.checked}
                    onChange={(e) => setPreviewLine(i, e.target.checked)}
                  />
                  <span className="tx">{l.text}</span>
                  {l.isHeading && <span className="ns-notes-mheadtag">標題行</span>}
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>

      {picking && (
        <MobileAttachPicker
          title="掛到哪"
          depth="node"
          value={attach}
          onPick={(t, names) => {
            if (t.nodeId && names.node) {
              const id = t.nodeId;
              const nm = names.node;
              setNodeNames((m) => ({ ...m, [id]: nm }));
            }
            setPreviewAttach(t);
            setPicking(false);
          }}
          onClear={
            attach.routeId || attach.nodeId
              ? () => {
                  setPreviewAttach({ routeId: null, nodeId: null, nodeKind: null });
                  setPicking(false);
                }
              : undefined
          }
          clearLabel="不掛"
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}
