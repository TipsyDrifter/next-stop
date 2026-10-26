/**
 * MobileRouteForm——手機「新增路線」底部 sheet 表單（手機殼班第四輪 D-主-85；桌機＝RouteDialog 的新增路線）。
 * 欄位與規則跟桌機同一份（panel/routeFlowRules）：名稱・路線色（共用 ColorPicker palette="route"，四格＋自訂圓「＋」＋色名）
 *   ・代碼（選填、打字就轉大寫、最多 4 字；重複只淡提示不擋）。預設色前三格輪流。
 * 寫入走 panel/routeFlows.createRoute（建好就切到那條路線）；成功後交給呼叫端 `onCreated`（路線圖接著進那條路線的第二層）。
 * 殼＝共用 MSheet（拉柄、襯線標題「新增路線・幹線名」、黏底「取消｜建立」）；返回層由呼叫端登記、`backId` 合併成一層（同 MobileTextSheet）。
 * 名稱空白不給送；Enter（名稱、代碼框）＝建立；IME 組字中不攔（同 MobileTextSheet 三道守門）。
 * 自訂色走原生 <input type="color">（ColorPicker 自己的）：Android WebView 的原生色盤行為沒在真機驗過（AVD 待驗）。
 */
import { useRef, useState, type KeyboardEvent } from "react";
import { useNodeStore } from "../../../store/nodeStore";
import { ColorPicker, routePresetColor } from "../../common/ColorPicker";
import { MSheet } from "../../common/MSheet";
import { createRoute } from "../../panel/routeFlows";
import { codeInput, codeTaken, codeTakenNote, codeValue, defaultRouteColorIndex } from "../../panel/routeFlowRules";
import "../mobile-polish.css";
import "./route-manage.css";

export interface MobileRouteFormProps {
  lineId: string;
  /** 標題列「新增路線・幹線名」 */
  lineName: string;
  backId?: string;
  onCreated(routeId: string): void;
  onClose(): void;
}

export function MobileRouteForm({ lineId, lineName, backId, onCreated, onClose }: MobileRouteFormProps) {
  const routes = useNodeStore((s) => s.routes);
  const [name, setName] = useState("");
  const [color, setColor] = useState<string>(() => routePresetColor(defaultRouteColorIndex(useNodeStore.getState().routes.length)));
  const [code, setCode] = useState("");
  const [saving, setSaving] = useState(false);
  const composing = useRef(false);
  const trimmed = name.trim();
  const taken = codeTaken(routes, code);

  const submit = async () => {
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      const row = await createRoute({ lineId, name: trimmed, color, code: codeValue(code) });
      if (row) onCreated(row.id);
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229 || composing.current) return;
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    }
  };
  const ime = {
    onCompositionStart: () => {
      composing.current = true;
    },
    onCompositionEnd: () => {
      composing.current = false;
    },
  };

  return (
    <MSheet
      title={`新增路線・${lineName}`}
      backId={backId}
      onClose={onClose}
      foot={
        <>
          <button type="button" className="ns-btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button type="button" className="ns-btn btn-seal" onClick={() => void submit()} disabled={!trimmed || saving}>
            建立
          </button>
        </>
      }
    >
      <div className="m-rf">
        <label className="m-rf-field">
          <span className="m-rf-label">名稱</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={onKeyDown}
            {...ime}
            autoFocus
            placeholder="例：日文檢定、年度旅遊"
            enterKeyHint="done"
            spellCheck={false}
            autoComplete="off"
            className="m-nt-input m-txs-input"
          />
        </label>
        <div className="m-rf-field">
          <span className="m-rf-label">
            路線色
          </span>
          <ColorPicker palette="route" custom showName value={color} onChange={setColor} className="m-rf-colors" />
        </div>
        <label className="m-rf-field">
          <span className="m-rf-label">
            代碼<span className="m-rf-hint">（選填・最多 4 個大寫字母）</span>
          </span>
          <input
            value={code}
            onChange={(e) => setCode(codeInput(e.target.value))}
            onKeyDown={onKeyDown}
            {...ime}
            placeholder="E1"
            maxLength={4}
            enterKeyHint="done"
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="characters"
            className="m-nt-input m-rf-code"
          />
          {taken && <span className="m-rf-note">{codeTakenNote(code)}</span>}
        </label>
      </div>
    </MSheet>
  );
}
