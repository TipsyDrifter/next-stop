/**
 * RouteDialog——UI Flow 2.3 幹線・路線 新增／編輯 dialog（置中紙卡，讀 uiStore.routeDialog）。
 * 新增幹線＝只有名稱；新增／編輯路線＝名稱・路線色（四個預設 swatch＝CSS 變數 --route-preset-1..4，另可填 #hex）・代碼（選填 ≤4 字、大寫）。
 * 編輯模式底部＝危險區：「刪除這條路線／幹線」→ askConfirm（danger，寫明連同子樹）→ nodeStore.deleteNode（repository soft delete 整個子樹）
 *   → 若刪到目前路線（或其所屬幹線）就切到剩餘第一條路線或 null → toast「復原」走 undoDelete。
 * 取捨：預設色存成 "var(--route-preset-N)" 字串（跟著主題換夜間燈色版，側欄／大綱以 background 直接吃）；代碼重複只淡提示不擋；
 *       新增路線成功後直接切到該路線（接著就能鋪軌）。Enter 送出、Esc 關閉（殼層處理）、名稱空白不送。
 * 視覺：DialogShell 票面紙卡＋燙金 overline；欄位 .techo-label／底線輸入 .techo-input；swatch .ns-swatch（選中燙金外環）；主鈕 .btn-seal（朱印）、次鈕 .btn-ghost、危險鈕 ghost＋late 字。
 */
import { useState, type KeyboardEvent } from "react";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore, type RouteDialogState } from "../../store/uiStore";
import { DialogShell } from "../common/DialogShell";
import "../common/overlay.css";

const PRESETS = [1, 2, 3, 4].map((n) => `var(--route-preset-${n})`);
const PRESET_NAMES = ["藍鼠", "洗朱", "松葉", "利休鼠"];
const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function RouteDialog() {
  const dialog = useUiStore((s) => s.routeDialog);
  if (!dialog) return null;
  // key：換一個對象就重建內部狀態（避免 useEffect 同步表單）
  return <RouteDialogForm key={`${dialog.editId ?? "new"}:${dialog.lineId ?? "root"}`} {...dialog} />;
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

  const editing = editId
    ? (lines.find((l) => l.id === editId) ?? routes.find((r) => r.id === editId) ?? null)
    : null;
  const kind: "line" | "route" = editing ? (editing.kind === "line" ? "line" : "route") : lineId ? "route" : "line";
  const kindLabel = kind === "line" ? "幹線" : "路線";
  const parentLineId = editing?.kind === "route" ? editing.line_id : lineId;
  const parentLineName = lines.find((l) => l.id === parentLineId)?.name ?? null;

  const [name, setName] = useState(editing?.name ?? "");
  const [color, setColor] = useState<string | null>(
    editing ? editing.color : kind === "route" ? PRESETS[routes.length % 3] : null,
  );
  const [hex, setHex] = useState(editing?.color && HEX_RE.test(editing.color) ? editing.color : "");
  const [code, setCode] = useState(editing?.code ?? "");
  const [saving, setSaving] = useState(false);

  const trimmedName = name.trim();
  const codeVal = code.trim().toUpperCase();
  const codeTaken =
    kind === "route" &&
    codeVal.length > 0 &&
    routes.some((r) => r.id !== editId && r.code?.toUpperCase() === codeVal);
  const canSave = trimmedName.length > 0 && !saving;

  const title = editing ? `編輯${kindLabel}` : `新增${kindLabel}`;
  const overline = kind === "route" && parentLineName ? `幹線・${parentLineName}` : "路線網絡 — NETWORK";

  /** 幹線底下的路線數（刪除幹線的確認文案用） */
  const childRouteCount = kind === "line" && editing ? routes.filter((r) => r.line_id === editing.id).length : 0;

  async function submit() {
    if (!canSave) return;
    setSaving(true);
    try {
      if (editing) {
        await updateNode(
          editing.id,
          kind === "route" ? { name: trimmedName, color, code: codeVal || null } : { name: trimmedName },
        );
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

  /** 刪除（連同子樹；repository soft delete，10 秒內可由 toast 復原） */
  function requestDelete() {
    if (!editing) return;
    const target = editing;
    const label = kindLabel;
    // 刪到目前路線、或目前路線所屬的幹線 → 確認後要換路線
    const affectsCurrent =
      kind === "line"
        ? routes.some((r) => r.line_id === target.id && r.id === currentRouteId)
        : target.id === currentRouteId;
    const body =
      kind === "line"
        ? childRouteCount > 0
          ? `底下的 ${childRouteCount} 條路線，連同其下所有支線、列車、車廂、車票會一起刪除；10 秒內可復原。`
          : "會連同其下所有內容一起刪除；10 秒內可復原。"
        : "這條路線底下的支線、列車、車廂、車票會一起刪除；10 秒內可復原。";
    askConfirm({
      title: `刪除${label}「${target.name}」？`,
      body,
      confirmLabel: "刪除",
      danger: true,
      onConfirm: () => void performDelete(target.id, target.name, label, affectsCurrent),
    });
  }

  async function performDelete(id: string, nodeName: string, label: string, affectsCurrent: boolean) {
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
      message: `已刪除${label}「${nodeName}」`,
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

  const onHexChange = (v: string) => {
    setHex(v);
    const t = v.trim();
    if (HEX_RE.test(t)) setColor(t);
  };

  return (
    <DialogShell title={title} overline={overline} onClose={close}>
      <div className="space-y-5">
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
            placeholder={kind === "line" ? "例：工作、學習、身體" : "例：全端開發"}
            className="techo-input w-full font-display text-[16px] tracking-[0.04em]"
          />
        </div>

        {kind === "route" && (
          <>
            <div>
              <span className="techo-label block mb-2">路線色</span>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2" role="radiogroup" aria-label="預設路線色">
                  {PRESETS.map((p, i) => {
                    const selected = color === p;
                    return (
                      <button
                        key={p}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        aria-label={`預設色 ${PRESET_NAMES[i]}`}
                        title={PRESET_NAMES[i]}
                        onClick={() => {
                          setColor(p);
                          setHex("");
                        }}
                        className={`ns-swatch${selected ? " is-on" : ""}`}
                        style={{ background: p }}
                      />
                    );
                  })}
                </div>
                <span className="techo-label">或</span>
                <div className="flex items-center gap-1.5 flex-1 min-w-0">
                  <span
                    aria-hidden
                    className={`ns-swatch ns-swatch--hex shrink-0${color && HEX_RE.test(color) ? " is-on" : ""}`}
                    style={{ background: color && HEX_RE.test(color) ? color : "transparent" }}
                  />
                  <input
                    value={hex}
                    onChange={(e) => onHexChange(e.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder="#4e6e8e"
                    spellCheck={false}
                    aria-label="自訂色碼"
                    className="techo-input w-full font-latin text-[12.5px]"
                  />
                </div>
              </div>
            </div>

            <div>
              <label className="techo-label block mb-1" htmlFor="route-dialog-code">
                代碼 <span className="tracking-normal">（選填・≤4 字・大寫）</span>
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
                  代碼「{codeVal}」已有其他路線使用——不影響儲存，只是徽章會長得一樣。
                </p>
              )}
            </div>
          </>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          {trimmedName.length === 0 && <span className="ns-note mr-auto">名稱不能空白</span>}
          <button type="button" onClick={close} className="btn-ghost ns-btn">
            取消
          </button>
          <button type="button" onClick={() => void submit()} disabled={!canSave} className="btn-seal ns-btn">
            {editing ? "儲存" : "建立"}
          </button>
        </div>

        {editing && (
          <div className="flex items-center justify-between gap-4 pt-4 border-t border-dashed border-dash">
            <p className="ns-note">
              {kind === "line"
                ? childRouteCount > 0
                  ? `連同底下 ${childRouteCount} 條路線一起刪除；10 秒內可復原。`
                  : "刪除這條幹線；10 秒內可復原。"
                : "連同其下所有內容一起刪除；10 秒內可復原。"}
            </p>
            <button type="button" onClick={requestDelete} className="btn-ghost ns-btn-danger ns-btn ns-btn--sm shrink-0">
              刪除這條{kindLabel}
            </button>
          </div>
        )}
      </div>
    </DialogShell>
  );
}
