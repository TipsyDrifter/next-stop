/**
 * 手機路線詳情頁的內容（手機殼班第四輪 D-主-84／85）：MobileDetailHost 認到路線種類就畫這個，外框（MFullPage「路線詳情」、‹ 返回）照舊。
 * 桌機對照＝詳情側板的 RoutePanel＋StationList，欄位一對一（雙端同等）：
 *   票根列（路線徽章・幹線名・「路線」）→ 名稱 → 概要（桌機叫「描述」）→ 代碼 → 路線色 → 所屬幹線（幹線 ≥2 條才出）
 *   → 各線登記的路線欄位（筆記、時間、花費…；插槽 nodeFields 的 Mobile）→ 車站 → 刪除路線。
 * 寫入一律是桌機同一支：名稱／代碼／概要／色 → `updateNode`（代碼走 routeFlowRules 同一條規矩：打字轉大寫・最多 4 字・撞到別條淡提示，同桌機側板與新增表單）；
 *   所屬幹線 → `moveRouteToLine`（toast＋復原）；車站與刪除路線 → panel/routeFlows（桌機 StationList／RoutePanel 同一支）。
 * 刪除路線：確認框疊在頁上（ConfirmDialog z 50 ＞ MFullPage 46），按下刪除才關頁；「復原」後切回這條路線並把路線圖帶回它的第二層。
 * 返回層：頁本身是 MobileDetailHost 的 `core.detail`；所屬幹線的挑選 sheet、預定到站日（DateChip 的手機日期 sheet）
 *   開的那一刻底下有全螢幕頁 ⇒ 自動當 "dialog"，返回鍵一次關一層（MSheet／DateChip 檔頭的規矩）。
 * 車站列：觸控沒有 hover ⇒ 到站章與 × 常駐（未到站＝虛線淡章，§3.1「常駐淡態」）；剛蓋的那一站播蓋印動畫。
 * 路線色的自訂圓走原生 <input type="color">（ColorPicker 自己的）：Android WebView 的原生色盤沒在真機驗過（AVD 待驗）。
 */
import { useMemo, useRef, useState } from "react";
import type { NodeRow } from "../../../domain";
import { lineNodeFields } from "../../../lines/runtime";
import { useNodeStore } from "../../../store/nodeStore";
import { ColorPicker, routePresetColor } from "../../common/ColorPicker";
import { DateChip } from "../../common/DateChip";
import { EmptyState } from "../../common/EmptyState";
import { CommitInput, CommitTextarea } from "../../common/fields";
import { IconClose, IconPlus } from "../../common/icons";
import { MSheet, MSheetItem } from "../../common/MSheet";
import { fmtDateKey } from "../../panel/format";
import { moveRouteToLine } from "../../panel/moveRouteToLine";
import { addStation, removeStation, requestDeleteRoute, toggleStationArrived } from "../../panel/routeFlows";
import { codeInput, codeTakenByOther, codeTakenNote, codeValue } from "../../panel/routeFlowRules";
import { revealOnRouteMap } from "../routeMapReveal";
import { Row } from "./MobileStateRows";
import "../mobile-polish.css";
import "../routemap/route-manage.css";

/** null 色＝第 4 色（利休鼠）——書封 roundel、桌機票頭與側板挑色盤都這樣畫（同 RoutePanel） */
const NULL_ROUTE_COLOR = routePresetColor(4);

export function MobileRouteBody({ route, onClose }: { route: NodeRow; onClose: () => void }) {
  const updateNode = useNodeStore((s) => s.updateNode);
  const lines = useNodeStore((s) => s.lines);
  const routes = useNodeStore((s) => s.routes);
  const line = lines.find((l) => l.id === route.line_id);
  const color = route.color ?? NULL_ROUTE_COLOR;
  const [linePick, setLinePick] = useState(false);
  // 代碼欄的草稿（CommitInput 回報）：重複提示跟著打字走
  const [codeDraft, setCodeDraft] = useState(route.code ?? "");
  const codeTaken = codeTakenByOther(routes, route.id, codeDraft);

  const remove = () =>
    void requestDeleteRoute(route, {
      onConfirmed: onClose,
      // 復原後 routeFlows 已切回這條路線；手機再把路線圖帶回它的第二層（刪的時候路線圖已退回清單）
      onRestored: (id) => revealOnRouteMap(id),
    });

  return (
    <div className="m-dt m-rt">
      <div className="m-dt-stub">
        <span className="m-dt-route" style={{ ["--c" as string]: color }} aria-hidden="true">
          {route.code ?? route.name.slice(0, 1)}
        </span>
        <span className="m-dt-route-name">{line ? `幹線・${line.name}` : "幹線"}</span>
        <span className="m-dt-fare">路線</span>
      </div>
      <CommitInput
        value={route.name}
        onCommit={(name) => void updateNode(route.id, { name })}
        required
        wrap
        ariaLabel="路線名稱"
        className="m-dt-name"
      />
      <div className="m-dt-note">
        <CommitTextarea
          value={route.description ?? ""}
          onCommit={(v) => void updateNode(route.id, { description: v || null })}
          ariaLabel="路線說明"
          placeholder="這條路線通往哪裡……"
        />
      </div>

      <div className="m-dt-group">
        <Row label="代碼">
          <div className="m-rt-code-wrap">
            <CommitInput
              value={route.code ?? ""}
              onCommit={(v) => void updateNode(route.id, { code: codeValue(v) })}
              transform={codeInput}
              onDraftChange={setCodeDraft}
              attrs={{ maxLength: 4, spellCheck: false, autoCapitalize: "characters", enterKeyHint: "done" }}
              ariaLabel="路線代碼"
              placeholder="如 E1"
              className="m-rt-code"
            />
            {codeTaken && <span className="m-rf-note m-rt-code-note">{codeTakenNote(codeDraft)}</span>}
          </div>
        </Row>
        <Row label="路線色">
          <ColorPicker
            palette="route"
            custom
            showName
            className="m-rf-colors"
            value={color}
            onChange={(c) => void updateNode(route.id, { color: c })}
          />
        </Row>
        {/* 所屬幹線（E12）：只有一條幹線就沒得換、不畫（同桌機） */}
        {lines.length >= 2 && route.line_id && (
          <Row label="所屬幹線">
            <button type="button" className="m-dt-pick" onClick={() => setLinePick(true)}>
              <span>{line?.name ?? "—"}</span>
              <span className="m-dt-chev" aria-hidden="true">
                ›
              </span>
            </button>
          </Row>
        )}
      </div>

      <RouteLineFields route={route} />
      <Stations routeId={route.id} />

      <button type="button" className="ns-btn btn-ghost ns-btn-danger m-dt-delete" onClick={remove}>
        刪除路線
      </button>

      {linePick && (
        <MSheet list title="所屬幹線" onClose={() => setLinePick(false)}>
          {lines.map((l) => (
            <MSheetItem
              key={l.id}
              ariaLabel={l.id === route.line_id ? `${l.name}（目前）` : undefined}
              onClick={() => {
                setLinePick(false);
                if (l.id !== route.line_id) void moveRouteToLine(route.id, l.id);
              }}
            >
              {l.name}
              {l.id === route.line_id && <span className="m-tks-aside">目前</span>}
            </MSheetItem>
          ))}
        </MSheet>
      )}
    </div>
  );
}

/** 各線登記的「路線」欄位列（插槽 nodeFields，kinds 含 route；同桌機 RoutePanel 的 LineRows）；沒有任何一線登記＝不出 DOM */
function RouteLineFields({ route }: { route: NodeRow }) {
  const fields = lineNodeFields("mobile").filter((f) => f.Mobile && f.kinds.includes("route"));
  if (!fields.length) return null;
  return <div className="m-dt-lines">{fields.map((f) => (f.Mobile ? <f.Mobile key={f.id} node={route} /> : null))}</div>;
}

/* ───────────── 車站（桌機 StationList 的手機版） ───────────── */

function Stations({ routeId }: { routeId: string }) {
  const stations = useNodeStore((s) => s.stations);
  const updateNode = useNodeStore((s) => s.updateNode);
  const list = useMemo(() => stations.filter((s) => s.parent_id === routeId), [stations, routeId]);
  const arrivedCount = list.filter((s) => s.arrived_on).length;
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // 剛蓋章的那一站才播蓋印動畫（純視覺）
  const [freshId, setFreshId] = useState<string | null>(null);

  const add = async () => {
    const name = draft.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      if (await addStation(routeId, name)) setDraft("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="m-dt-sec m-rt-stations">
      <h3 className="m-dt-sec-title">
        車站{list.length > 0 && <span className="m-dt-sec-aside">{`${arrivedCount}/${list.length} 到站`}</span>}
      </h3>
      {list.length === 0 ? (
        <EmptyState inline tone="first" title="還沒有車站。" desc="加幾個階段目標，會顯示在路線底下。" className="m-rt-st-empty" />
      ) : (
        <ul className="m-rt-st-list">
          {list.map((st) => {
            const arrived = Boolean(st.arrived_on);
            return (
              <li key={st.id} className={"m-rt-st" + (arrived ? " is-arrived" : "") + (freshId === st.id ? " is-fresh" : "")}>
                <CommitInput
                  value={st.name}
                  onCommit={(name) => void updateNode(st.id, { name })}
                  required
                  ariaLabel="車站名稱"
                  className="m-rt-st-name"
                />
                <button
                  type="button"
                  className="m-rt-st-seal"
                  aria-label={arrived ? `取消到站——${st.name}` : `標記到站（今天）——${st.name}`}
                  aria-pressed={arrived}
                  onClick={() => setFreshId(toggleStationArrived(st) ? st.id : null)}
                >
                  <span aria-hidden>着</span>
                </button>
                <button
                  type="button"
                  className="ns-iconbtn m-rt-st-x"
                  aria-label={`刪除車站——${st.name}`}
                  onClick={() => void removeStation(st)}
                >
                  <IconClose />
                </button>
                <div className="m-rt-st-meta">
                  <span>預定</span>
                  <DateChip
                    date={st.expected_on}
                    onPick={(v) => void updateNode(st.id, { expected_on: v })}
                    allowPast
                    clearable
                    label="預定到站日"
                    emptyText="未定"
                  />
                  {st.arrived_on && <span className="m-rt-st-arr">・着 {fmtDateKey(st.arrived_on)}</span>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="m-dt-logadd">
        <input
          ref={inputRef}
          type="text"
          className="m-dt-loginput"
          placeholder="新增車站"
          aria-label="新增車站"
          enterKeyHint="done"
          autoComplete="off"
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter") {
              e.preventDefault();
              void add();
            }
          }}
        />
        <button
          type="button"
          className="ns-btn btn-ghost m-rt-st-addbtn"
          disabled={busy}
          onClick={() => {
            // 空著按＝把焦點交給輸入框（同桌機）
            if (draft.trim()) void add();
            else inputRef.current?.focus();
          }}
        >
          <IconPlus />
          新增
        </button>
      </div>
    </section>
  );
}
