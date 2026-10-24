/**
 * MobileTodoPreview——手機的「變成車票」全螢幕面板（車次①契約 §5.3；D-筆-18／26；原型 app.js previewHtml 的 mob 分支）。
 *
 * 狀態全在 notesStore.preview（桌機 TodoPreviewDialog 同一份）：勾選、掛到哪、執行日、確定與取消都轉呼叫 store。
 * 版面：頂列「取消／變待辦／建立 N 張車票」→ 捲動區＝來源一行 → 欄位兩欄**直排**（掛到哪、執行日）
 *   → 「沒有日期也沒有路線＝留在收件匣」提示 → 清單（single 時不出）。
 * UI 丙-6 S2／P3：殼換共用 `MFullPage`（頂列書封色、左取消、右主鈕「建立 N 張車票」＝兩殼同字；返回層 backId "notes.preview"
 *   ＝殼自己登記 kind "full"，NotesMobileOverlay 那條刪掉）。挑日期面板（S9）給 backId ⇒ MSheet 殼、疊在本頁上＝"dialog"。
 *
 * 「掛到哪」標籤要名字，但 AttachTarget 只有 id：路線名查 nodeStore.routes；節點名在挑的當下由挑選器回傳、
 * 記在本元件（store 不必為了顯示多存一欄）。
 */
import { useState } from "react";
import { useNodeStore } from "../../../store/nodeStore";
import { useUiStore } from "../../../store/uiStore";
import { useNotesStore } from "../../../store/notesStore";
import { todayKey } from "../../../lib/date";
import { MobileAttachPicker, RouteDot } from "../../common/MobileAttachPicker";
import { MobileDatePicker } from "../../common/MobileDatePicker";
import { shortDayKey } from "../../common/DatePicker";
import { dateQuickSet } from "../../common/DateChip";
import { useBackLayer } from "../../mobile/backStack";
import { MFullPage } from "../../common/MFullPage";
import { IconClose } from "../../common/icons";

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
  // 「挑日期」底部面板（磨光⑤ S8：取代原生日期欄）。疊在本全螢幕面板（full）上 ⇒ 登記 "dialog"（同掛到哪挑選器）
  const [pickingDate, setPickingDate] = useState(false);
  useBackLayer("notes.preview.date", pickingDate && !!preview, () => setPickingDate(false), "dialog");

  if (!preview) return null;

  const today = todayKey(dayStartHour);
  const quick = dateQuickSet("forward", today);
  const n = preview.single ? 1 : preview.lines.filter((l) => l.checked).length;
  const { attach, scheduledOn } = preview;
  const route = attach.routeId ? (routes.find((r) => r.id === attach.routeId) ?? null) : null;
  const nodeName = attach.nodeId ? (nodeNames[attach.nodeId] ?? "已選的項目") : null;
  const custom = scheduledOn !== null && !quick.some((q) => q.day === scheduledOn);
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
    <MFullPage
      title="變待辦"
      backId="notes.preview"
      left={{ label: "取消", onClick: cancelPreview }}
      right={{ label: `建立 ${n} 張車票`, onClick: () => void confirm(), disabled: n === 0 || busy }}
    >
      <p className="ns-notes-mfullsrc">
        {single
          ? `「${firstText}」`
          : `${preview.source === "capture" ? "來自捕捉框" : fromInbox ? "來自收件匣的筆記" : "來自筆記"}・取消勾選不要的`}
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
                <IconClose size={12} />
              </button>
            )}
          </dd>
        </div>
        <div className="ns-notes-mfield">
          <dt>執行日</dt>
          <dd className="ns-notes-mchiprow">
            {/* 快選＝往後一套（今天／明天／後天／下週一；規範 §2.5，跟桌機變待辦的 DateChip quick="forward" 同一套；UI 丙-6 回修） */}
            {quick.map((q) => (
              <button
                key={q.label}
                type="button"
                className={"ns-notes-mchip2" + (scheduledOn === q.day ? " on" : "")}
                aria-pressed={scheduledOn === q.day}
                onClick={() => setPreviewDate(q.day)}
              >
                {q.label}
              </button>
            ))}
            <button
              type="button"
              className={"ns-notes-mchip2" + (custom ? " on" : "")}
              aria-pressed={custom}
              aria-haspopup="dialog"
              aria-label={custom && scheduledOn ? `執行日 ${shortDayKey(scheduledOn)}，換一天` : "挑日期"}
              onClick={() => setPickingDate(true)}
            >
              {custom && scheduledOn ? shortDayKey(scheduledOn) : "挑日期…"}
            </button>
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

      {staysInInbox && <p className="ns-notes-mfullhint">沒選日期和路線，就會留在收件匣</p>}

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
                {l.isHeading && <span className="ns-notes-mheadtag">標題</span>}
              </label>
            </li>
          ))}
        </ul>
      )}

      {pickingDate && (
        <MobileDatePicker
          title="執行日"
          value={scheduledOn}
          min={today}
          quick={[]}
          onPick={(d) => {
            if (d >= today) setPreviewDate(d);
            setPickingDate(false);
          }}
          onClose={() => setPickingDate(false)}
          // UI 丙-6 S9：給 backId ⇒ 殼換 MSheet、跟上面那條 "notes.preview.date" 合併成一層；疊在全螢幕頁上＝"dialog"
          backId="notes.preview.date"
          backKind="dialog"
        />
      )}

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
          // 磨光① 返回層：疊在本全螢幕面板（full）上的子面板一律登記 "dialog"（契約 §9.1，同售票口表單裡的幣別／日期 sheet）：
          // 權重比 full 高 ⇒ 返回先關挑選器、再關預覽；toast 跟著移到頂端，不壓在挑選器上
          backKind="dialog"
        />
      )}
    </MFullPage>
  );
}
