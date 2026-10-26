/**
 * RouteDialog——UI Flow 2.3 幹線・路線 dialog（置中紙卡，讀 uiStore.routeDialog）。
 * UI 丙-3 C1（契約 §5 P3；規範 §3.2「一個資料欄只在一個地方編」）起只做三件事：
 *   - 新增幹線（lineId null、editId null）＝只有名稱；
 *   - 新增路線（lineId＝所屬幹線）＝名稱・路線色（共用 ColorPicker：四格＋自訂圓「＋」＋右邊色名，跟路線側板同一種排法；沒有色碼框；第 2 格叫「梅紫」）・代碼（選填 ≤4 字、大寫）；
 *   - 編輯幹線（editId＝幹線 id）＝改名＋危險區刪除——幹線沒有側板，所以留在這裡（P3＝RouteDialog 保留編輯幹線）。
 * **路線的編輯不在這裡**：名稱、代碼、色、所屬幹線全在詳情側板的 RoutePanel；書封路線 ✎ 開的是側板（Sidebar.tsx）。
 *   editId 若指到路線（舊呼叫端）＝不開（回 null），免得長出第二個路線編輯器。
 * 刪除幹線：askConfirm（danger，寫明連同底下幾條路線）→ nodeStore.deleteNode（repository soft delete 整個子樹）
 *   → 若刪到目前路線所屬的幹線就切到剩餘第一條路線或 null → toast「復原」走 undoDelete。
 * 手機殼班第四輪（D-主-84）：新增幹線／路線與刪除幹線的寫入、守門、文案搬到 panel/routeFlows（手機路線圖同一支），
 *   本檔只剩表單狀態與畫面；行為與字一個不變。
 * 取捨：預設色存成 "var(--route-preset-N)" 字串（跟著主題換夜間色，側欄／大綱以 background 直接吃）；代碼重複只淡提示不擋；
 *       新增路線成功後直接切到該路線（接著就能鋪軌）。Enter 送出（名稱、代碼框）、Esc 關閉（殼層處理）、名稱空白不送。
 * 視覺：DialogShell M（表單）＋眉標 {zh, latin}（粉彩只畫拉丁斜體）；欄位 .techo-label／底線輸入 .techo-input；
 *       黏底按鈕列＝取消（次鈕）左、建立／儲存（主鈕 .btn-seal）右；危險鈕＝次鈕形制＋赭（.ns-btn-danger，永遠不實心）。
 */
import { useEffect, useState, type KeyboardEvent } from "react";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore, type RouteDialogState } from "../../store/uiStore";
import { ColorPicker, routePresetColor } from "../common/ColorPicker";
import { createLine, createRoute, renameLine, requestDeleteLine } from "../panel/routeFlows";
import {
  childRouteCount as countChildRoutes,
  codeInput,
  codeTaken as isCodeTaken,
  codeTakenNote,
  codeValue,
  defaultRouteColorIndex,
  lineDeleteNote,
} from "../panel/routeFlowRules";
import { DialogShell } from "../common/DialogShell";
import "../common/overlay.css";

export function RouteDialog() {
  const dialog = useUiStore((s) => s.routeDialog);
  const lines = useNodeStore((s) => s.lines);
  if (!dialog) return null;
  // 編輯只收幹線；指到路線（或已刪掉的東西）就收掉狀態——不能只回 null：routeDialog 開著時全域快捷鍵整組停用
  if (dialog.editId && !lines.some((l) => l.id === dialog.editId)) return <CloseStale />;
  // key：換一個對象就重建內部狀態（避免 useEffect 同步表單）
  return <RouteDialogForm key={`${dialog.editId ?? "new"}:${dialog.lineId ?? "root"}`} {...dialog} />;
}

/** 對象不在了（或不是幹線）：畫完就把 routeDialog 清掉 */
function CloseStale() {
  const close = useUiStore((s) => s.closeRouteDialog);
  useEffect(() => close(), [close]);
  return null;
}

function RouteDialogForm({ lineId, editId }: RouteDialogState) {
  const lines = useNodeStore((s) => s.lines);
  const routes = useNodeStore((s) => s.routes);
  const close = useUiStore((s) => s.closeRouteDialog);

  /** 編輯中的幹線（只有幹線會走到編輯） */
  const editing = editId ? (lines.find((l) => l.id === editId) ?? null) : null;
  const kind: "line" | "route" = editing ? "line" : lineId ? "route" : "line";
  const kindLabel = kind === "line" ? "幹線" : "路線";
  const parentLineName = kind === "route" ? (lines.find((l) => l.id === lineId)?.name ?? null) : null;

  const [name, setName] = useState(editing?.name ?? "");
  // 新增路線的預設色：前三格輪流（routeFlowRules.defaultRouteColorIndex）
  const [color, setColor] = useState<string>(() => routePresetColor(defaultRouteColorIndex(routes.length)));
  const [code, setCode] = useState("");
  const [saving, setSaving] = useState(false);

  const trimmedName = name.trim();
  const codeTaken = kind === "route" && isCodeTaken(routes, code);
  const canSave = trimmedName.length > 0 && !saving;

  const title = editing ? "編輯幹線" : `新增${kindLabel}`;
  const overline = kind === "route" ? { zh: "路線", latin: "Route" } : { zh: "幹線", latin: "Line" };

  /** 幹線底下的路線數（刪除幹線的確認文案用） */
  const childRouteCount = editing ? countChildRoutes(routes, editing.id) : 0;

  async function submit() {
    if (!canSave) return;
    setSaving(true);
    try {
      if (editing) {
        await renameLine(editing.id, trimmedName);
      } else if (kind === "route" && lineId) {
        // 建好直接切到該路線（routeFlows.createRoute）
        await createRoute({ lineId, name: trimmedName, color, code: codeValue(code) });
      } else {
        await createLine(trimmedName);
      }
      close();
    } finally {
      setSaving(false);
    }
  }

  /** 刪除幹線（連同子樹；確認＋別線附加句＋切走目前路線＋復原都在 routeFlows.requestDeleteLine）；按下確認先收起本框 */
  function requestDelete() {
    if (!editing) return;
    void requestDeleteLine(editing, { onConfirmed: close });
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    }
  };

  const foot = (
    <>
      {trimmedName.length === 0 && <span className="ns-note mr-auto">請輸入名稱</span>}
      <button type="button" onClick={close} className="btn-ghost ns-btn">
        取消
      </button>
      <button type="button" onClick={() => void submit()} disabled={!canSave} className="btn-seal ns-btn">
        {editing ? "儲存" : "建立"}
      </button>
    </>
  );

  return (
    <DialogShell title={title} overline={overline} size="M" onClose={close} foot={foot}>
      <div className="space-y-5">
        {parentLineName && (
          <p className="techo-label">
            幹線・{parentLineName}
          </p>
        )}
        <div>
          <label className="techo-label block mb-1" htmlFor="route-dialog-name">
            名稱
          </label>
          <input
            id="route-dialog-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={kind === "line" ? "例：工作、學習、健康" : "例：日文檢定、年度旅遊"}
            className="techo-input w-full font-display text-[16px] tracking-[0.04em]"
          />
        </div>

        {kind === "route" && (
          <>
            <div>
              <span className="techo-label block mb-2">路線色</span>
              <ColorPicker palette="route" custom showName value={color} onChange={setColor} />
            </div>

            <div>
              <label className="techo-label block mb-1" htmlFor="route-dialog-code">
                代碼 <span className="tracking-normal">（選填・最多 4 個大寫字母）</span>
              </label>
              <input
                id="route-dialog-code"
                value={code}
                onChange={(e) => setCode(codeInput(e.target.value))}
                onKeyDown={onKeyDown}
                placeholder="E1"
                maxLength={4}
                spellCheck={false}
                className="techo-input w-24 font-latin uppercase text-[14px] tracking-[0.16em]"
              />
              {codeTaken && <p className="ns-note mt-1.5">{codeTakenNote(code)}</p>}
            </div>
          </>
        )}

        {editing && (
          <div className="flex items-center justify-between gap-4 pt-4 border-t border-dashed border-dash">
            <p className="ns-note">{lineDeleteNote(childRouteCount)}</p>
            <button type="button" onClick={requestDelete} className="btn-ghost ns-btn-danger ns-btn ns-btn--sm shrink-0">
              刪除幹線
            </button>
          </div>
        )}
      </div>
    </DialogShell>
  );
}
