/**
 * 路線面板（UI Flow 2.1 路線版）：名稱・代碼（選填）・描述・路線色（和色預設四格＋自訂 #hex）＋車站清單管理（StationList）＋刪除路線。
 * 路線色寫法：預設盤存 "var(--route-preset-N)"（跟著主題換色），自訂色存 "#rrggbb"；讀取端直接當 CSS background 用（與側欄一致）。
 * 刪除路線（同側欄語彙）：danger 確認 → soft delete → 若是目前路線就切到剩餘第一條（沒有＝null）、zoom／選取歸零 → 復原 toast。
 * 視覺＝原型語彙 1:1：票頭＝.panel-head（件一 m3-ext-routemap.html；一字題② 拍板 2026-09-05 換 M3 票頭式，
 *   依路線身分裁減：徽章〔代碼、字色＝路線色；無代碼＝.badge.dashed 空章，點了去填代碼〕＋類型字「路線」，無票種無票號）＋.d 襯線名稱；
 * 區段 .sec「概要」「車站」；代碼輸入＝.serial 的 Fraunces；路線色＝原型 .roundel 小圓盤（選中 ink 邊、自訂＝虛線空盤藏 color picker）。
 * UI 丙-3：
 *   - C3 路線色換共用 `ColorPicker palette="route" custom`（四格＋自訂入口，沒有色碼框）；自訂色在原生色盤關掉時才回呼，
 *     舊的 400ms 去抖與 toPickerHex 一併拿掉。**null 色**（舊資料、沒挑過）照書封與票頭的畫法＝第 4 色利休鼠
 *     （roundel.ts、本檔 `color`），所以挑色盤也亮利休鼠——畫面上看到哪一色就亮哪一格；不另存，使用者挑了才寫。
 *   - 丙-7（使用者 10-24）：自訂入口退回丙-3 以前的虛線圓「＋」、色名（自訂色＝色碼）回到色列右邊——都在 ColorPicker 裡
 *     （`showName`），新增路線彈窗同一個元件、同一種排法。
 *   - C2「所屬幹線」欄（E12，使用者 10-22 定做）：幹線 ≥2 條才畫（只有一條沒得換）；選了就 `moveRouteToLine`
 *     （接在新幹線最後＋toast「已移到幹線「X」」＋復原）。書封的分組在 store refresh 後立刻跟著變。
 *   - 路線的編輯全在這裡（規範 §3.2「一個資料欄只在一個地方編」：名稱、代碼、色、幹線）；書封 ✎ 開的也是這個側板（C1／C6）。
 * 手機殼班第四輪（D-主-84）：刪除路線的確認、切走、復原搬到 ./routeFlows 的 requestDeleteRoute（手機路線詳情頁同一支）。
 *   代碼欄改跟新增表單同一條規矩（routeFlowRules：打字轉大寫・最多 4 字・撞到別條路線淡提示不擋）——
 *   原本側板照打照存（小寫、超長都進得去），新增與編輯兩套標準；手機詳情頁同步。
 */
import { useRef, useState } from "react";
import type { NodeRow } from "../../domain";
import { useNodeStore } from "../../store/nodeStore";
import { ColorPicker, routePresetColor } from "../common/ColorPicker";
import { ActionButton, ActionsRow, CommitInput, CommitTextarea, FieldRow, SectionRule } from "./fields";
import { Choice } from "./Choice";
import { moveRouteToLine } from "./moveRouteToLine";
import { requestDeleteRoute } from "./routeFlows";
import { codeInput, codeTakenByOther, codeTakenNote, codeValue } from "./routeFlowRules";
import { StationList } from "./StationList";
import { LineRows } from "./TaskFields";

/** null 色＝第 4 色（利休鼠）——書封 roundel 與票頭都這樣畫 */
const NULL_ROUTE_COLOR = routePresetColor(4);

export function RoutePanel({ route }: { route: NodeRow }) {
  const updateNode = useNodeStore((s) => s.updateNode);

  const lines = useNodeStore((s) => s.lines);
  const routes = useNodeStore((s) => s.routes);

  const color = route.color ?? NULL_ROUTE_COLOR;
  const codeRef = useRef<HTMLDivElement>(null);
  // 代碼欄的草稿（CommitInput 回報）：重複提示跟著打字走
  const [codeDraft, setCodeDraft] = useState(route.code ?? "");
  const codeTaken = codeTakenByOther(routes, route.id, codeDraft);

  const removeRoute = () => void requestDeleteRoute(route);

  return (
    <div>
      {/* 票頭＝.panel-head（與 TaskFields 的 NameBlock 同結構；一字題② 拍板 2026-09-05）：
          路線不是一張票，故無 .fare-class 票種、無 .serial 票號；.panel-kind 一列＝票根徽章
          〔代碼、字色＝路線色；無代碼＝.badge.dashed 空章，點了去填代碼〕＋類型字「路線」，
          下接襯線名稱與虛線裁切線。M2 的「路線詳情 — ROUTE」overline 隨票頭化退場（件一沒有這一行）。 */}
      <header className="panel-head">
        <div className="panel-kind" style={{ color }}>
          {route.code ? (
            <span aria-hidden className="badge">
              {route.code}
            </span>
          ) : (
            <button
              type="button"
              aria-label="填入路線代碼"
              title="還沒有代碼——點一下填寫"
              className="badge dashed"
              onClick={() => codeRef.current?.querySelector("input")?.focus()}
            />
          )}
          <span className="line-name">路線</span>
        </div>
        <div className="date-line">
          <CommitInput
            value={route.name}
            onCommit={(name) => void updateNode(route.id, { name })}
            required
            wrap
            ariaLabel="路線名稱"
            className="d"
          />
        </div>
      </header>

      <SectionRule title="概要" />
      <div className="fields">
        <FieldRow label="代碼">
          <div ref={codeRef}>
            <CommitInput
              value={route.code ?? ""}
              onCommit={(v) => void updateNode(route.id, { code: codeValue(v) })}
              transform={codeInput}
              onDraftChange={setCodeDraft}
              attrs={{ maxLength: 4, spellCheck: false, autoCapitalize: "characters" }}
              ariaLabel="路線代碼"
              placeholder="如 E1"
              className="code"
            />
            {codeTaken && <p className="ns-note mt-1.5">{codeTakenNote(codeDraft)}</p>}
          </div>
        </FieldRow>

        <FieldRow label="路線色">
          {/* 色名（預設色名／自訂色碼）由 ColorPicker 寫在色列右邊，跟新增路線彈窗同一種排法 */}
          <ColorPicker
            palette="route"
            custom
            showName
            className="route-color"
            value={color}
            onChange={(c) => void updateNode(route.id, { color: c })}
          />
        </FieldRow>

        {/* 所屬幹線（E12）：只有一條幹線就沒得換、不畫 */}
        {lines.length >= 2 && route.line_id && (
          <FieldRow label="所屬幹線">
            <Choice
              value={route.line_id}
              options={lines.map((l) => ({ value: l.id, label: l.name }))}
              onChange={(lineId) => void moveRouteToLine(route.id, lineId)}
              ariaLabel="所屬幹線"
            />
          </FieldRow>
        )}

        <FieldRow label="描述" top>
          <CommitTextarea
            value={route.description ?? ""}
            onCommit={(v) => void updateNode(route.id, { description: v || null })}
            ariaLabel="路線說明"
            placeholder="這條路線通往哪裡……"
          />
        </FieldRow>

        {/* 別線登記的路線欄位列（插槽 nodeFields，kinds 含 route 才出）；沒有就零 DOM */}
        <LineRows node={route} />
      </div>

      <StationList routeId={route.id} />

      <ActionsRow
        right={
          <ActionButton ariaLabel="刪除路線" title="刪除這條路線（6 秒內可復原）" tone="danger" onClick={removeRoute}>
            刪除路線
          </ActionButton>
        }
      />
    </div>
  );
}
