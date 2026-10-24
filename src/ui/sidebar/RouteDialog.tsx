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
 * 取捨：預設色存成 "var(--route-preset-N)" 字串（跟著主題換夜間色，側欄／大綱以 background 直接吃）；代碼重複只淡提示不擋；
 *       新增路線成功後直接切到該路線（接著就能鋪軌）。Enter 送出（名稱、代碼框）、Esc 關閉（殼層處理）、名稱空白不送。
 * 視覺：DialogShell M（表單）＋眉標 {zh, latin}（粉彩只畫拉丁斜體）；欄位 .techo-label／底線輸入 .techo-input；
 *       黏底按鈕列＝取消（次鈕）左、建立／儲存（主鈕 .btn-seal）右；危險鈕＝次鈕形制＋赭（.ns-btn-danger，永遠不實心）。
 */
import { useEffect, useState, type KeyboardEvent } from "react";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore, type RouteDialogState } from "../../store/uiStore";
import { collectDeleteHints, withDeleteHints } from "../../lines/deleteHints";
import { ColorPicker, routePresetColor } from "../common/ColorPicker";
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
  const currentRouteId = useNodeStore((s) => s.routeId);
  const createNode = useNodeStore((s) => s.createNode);
  const updateNode = useNodeStore((s) => s.updateNode);
  const deleteNode = useNodeStore((s) => s.deleteNode);
  const undoDelete = useNodeStore((s) => s.undoDelete);
  const openRoute = useNodeStore((s) => s.openRoute);
  const close = useUiStore((s) => s.closeRouteDialog);
  const setZoom = useUiStore((s) => s.setZoom);
  const select = useUiStore((s) => s.select);
  const askConfirm = useUiStore((s) => s.askConfirm);
  const showToast = useUiStore((s) => s.showToast);

  /** 編輯中的幹線（只有幹線會走到編輯） */
  const editing = editId ? (lines.find((l) => l.id === editId) ?? null) : null;
  const kind: "line" | "route" = editing ? "line" : lineId ? "route" : "line";
  const kindLabel = kind === "line" ? "幹線" : "路線";
  const parentLineName = kind === "route" ? (lines.find((l) => l.id === lineId)?.name ?? null) : null;

  const [name, setName] = useState(editing?.name ?? "");
  // 新增路線的預設色：前三格輪流（第 4 格利休鼠＝灰，不當預設）
  const [color, setColor] = useState<string>(() => routePresetColor((routes.length % 3) + 1));
  const [code, setCode] = useState("");
  const [saving, setSaving] = useState(false);

  const trimmedName = name.trim();
  const codeVal = code.trim().toUpperCase();
  const codeTaken = kind === "route" && codeVal.length > 0 && routes.some((r) => r.code?.toUpperCase() === codeVal);
  const canSave = trimmedName.length > 0 && !saving;

  const title = editing ? "編輯幹線" : `新增${kindLabel}`;
  const overline = kind === "route" ? { zh: "路線", latin: "Route" } : { zh: "幹線", latin: "Line" };

  /** 幹線底下的路線數（刪除幹線的確認文案用） */
  const childRouteCount = editing ? routes.filter((r) => r.line_id === editing.id).length : 0;

  async function submit() {
    if (!canSave) return;
    setSaving(true);
    try {
      if (editing) {
        await updateNode(editing.id, { name: trimmedName });
      } else {
        const row = await createNode({
          kind,
          name: trimmedName,
          parentId: kind === "route" ? lineId : null,
          color: kind === "route" ? color : null,
          code: kind === "route" ? codeVal || null : null,
        });
        if (row && kind === "route") {
          void openRoute(row.id);
          setZoom(null);
          select(null);
        }
      }
      close();
    } finally {
      setSaving(false);
    }
  }

  /** 刪除幹線（連同子樹；repository soft delete，6 秒內可由 toast 復原） */
  async function requestDelete() {
    if (!editing) return;
    const target = editing;
    // 刪到目前路線所屬的幹線 → 確認後要換路線
    const affectsCurrent = routes.some((r) => r.line_id === target.id && r.id === currentRouteId);
    const body =
      childRouteCount > 0
        ? `底下的 ${childRouteCount} 條路線與所有支線、列車、車廂、車票會一起刪除；6 秒內可復原。`
        : "底下的所有內容會一起刪除；6 秒內可復原。";
    // 別線的附加句（接縫 #62）：這裡沒載底下的樹 ⇒ descendantIds 傳 []，由該線自己補查；沒有線填＝空字串、框的字不變
    const hints = await collectDeleteHints(target, []);
    askConfirm({
      title: `刪除幹線「${target.name}」？`,
      body: withDeleteHints(body, hints),
      confirmLabel: "刪除",
      danger: true,
      onConfirm: () => void performDelete(target.id, target.name, affectsCurrent),
    });
  }

  async function performDelete(id: string, nodeName: string, affectsCurrent: boolean) {
    close();
    const ids = await deleteNode(id);
    if (ids.length === 0) return; // 失敗：store 已記 error（App 殼顯示），不出復原 toast
    if (affectsCurrent) {
      const remaining = useNodeStore.getState().routes;
      void openRoute(remaining[0]?.id ?? null);
      setZoom(null);
      select(null);
    }
    showToast({
      message: `已刪除幹線「${nodeName}」`,
      actionLabel: "復原",
      onAction: () => void undoDelete(),
    });
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
                onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 4))}
                onKeyDown={onKeyDown}
                placeholder="E1"
                maxLength={4}
                spellCheck={false}
                className="techo-input w-24 font-latin uppercase text-[14px] tracking-[0.16em]"
              />
              {codeTaken && (
                <p className="ns-note mt-1.5">
                  已有其他路線使用「{codeVal}」——仍可儲存，只是圖示會重複。</p>
              )}
            </div>
          </>
        )}

        {editing && (
          <div className="flex items-center justify-between gap-4 pt-4 border-t border-dashed border-dash">
            <p className="ns-note">
              {childRouteCount > 0
                ? `連同底下 ${childRouteCount} 條路線一起刪除；6 秒內可復原。`
                : "刪除這條幹線；6 秒內可復原。"}
            </p>
            <button type="button" onClick={requestDelete} className="btn-ghost ns-btn-danger ns-btn ns-btn--sm shrink-0">
              刪除幹線
            </button>
          </div>
        )}
      </div>
    </DialogShell>
  );
}
