/**
 * 路線面板（UI Flow 2.1 路線版）：名稱・代碼（選填）・描述・路線色（和色預設四格＋自訂 #hex）＋車站清單管理（StationList）＋刪除路線。
 * 路線色寫法：預設盤存 "var(--route-preset-N)"（跟著主題換色），自訂色存 "#rrggbb"；讀取端直接當 CSS background 用（與側欄一致）。
 * 刪除路線（同側欄語彙）：danger 確認 → soft delete → 若是目前路線就切到剩餘第一條（沒有＝null）、zoom／選取歸零 → 復原 toast。
 * 視覺＝原型語彙 1:1：票頭＝.panel-head（件一 m3-ext-routemap.html；一字題② 拍板 2026-09-05 換 M3 票頭式，
 *   依路線身分裁減：徽章〔代碼、字色＝路線色；無代碼＝.badge.dashed 空章，點了去填代碼〕＋類型字「路線」，無票種無票號）＋.d 襯線名稱；
 * 區段 .sec「概要」「車站」；代碼輸入＝.serial 的 Fraunces；路線色＝原型 .roundel 小圓盤（選中 ink 邊、自訂＝虛線空盤藏 color picker）。
 * 已知取捨：自訂色 picker 連續觸發 → 400ms 去抖後寫回；色盤未選（null）時視同預設第 4 色（利休鼠）高亮。
 */
import { useRef } from "react";
import type { NodeRow } from "../../domain";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { ActionButton, ActionsRow, CommitInput, CommitTextarea, FieldRow, SectionRule, useDebouncedCommit } from "./fields";
import { StationList } from "./StationList";

/* 預設盤的和色名跟著 theme.css 的 --route-preset-N 走（M3 ② 換裝：值＝件一的四支路線色 E1／J／L2／無）。
   第 2 格粉彩星空版是 #964468（梅紫）而非舊的洗朱，名字一併改正——標籤是給主人認色用的，對不上就沒用。 */
const PRESETS = [
  { n: 1, name: "藍鼠" },
  { n: 2, name: "梅紫" },
  { n: 3, name: "松葉" },
  { n: 4, name: "利休鼠" },
] as const;

const presetVar = (n: number) => `var(--route-preset-${n})`;
const HEX_RE = /^#[0-9a-f]{6}$/i;

/** 把目前路線色換成 <input type=color> 吃得下的 #rrggbb（預設盤→讀 computed style；解析不到回空字串，交給瀏覽器自行 sanitize，僅作 picker 初值） */
function toPickerHex(color: string | null): string {
  if (color && HEX_RE.test(color)) return color;
  const m = color?.match(/^var\((--[\w-]+)\)$/);
  const resolved = getComputedStyle(document.documentElement)
    .getPropertyValue(m ? m[1] : "--route-preset-4")
    .trim();
  return HEX_RE.test(resolved) ? resolved : "";
}

export function RoutePanel({ route }: { route: NodeRow }) {
  const updateNode = useNodeStore((s) => s.updateNode);
  const deleteNode = useNodeStore((s) => s.deleteNode);
  const undoDelete = useNodeStore((s) => s.undoDelete);
  const openRoute = useNodeStore((s) => s.openRoute);
  const askConfirm = useUiStore((s) => s.askConfirm);
  const showToast = useUiStore((s) => s.showToast);
  const setZoom = useUiStore((s) => s.setZoom);
  const select = useUiStore((s) => s.select);

  const custom = route.color && HEX_RE.test(route.color) ? route.color : null;
  const { schedule, flush } = useDebouncedCommit<string>((hex) => void updateNode(route.id, { color: hex }), 400);

  const activePreset = PRESETS.find((p) => presetVar(p.n) === route.color)?.n ?? (route.color ? null : 4);
  const colorLabel = custom ?? PRESETS.find((p) => p.n === activePreset)?.name ?? route.color ?? "";
  const color = route.color ?? "var(--route-preset-4)";
  const codeRef = useRef<HTMLDivElement>(null);

  const removeRoute = () => {
    askConfirm({
      title: `刪除路線「${route.name}」？`,
      body: "底下的支線、列車、車票與車站會一起移除；刪除後 10 秒內可從提示列復原。",
      confirmLabel: "刪除路線",
      danger: true,
      onConfirm: () =>
        void (async () => {
          const ids = await deleteNode(route.id);
          if (!ids.length) return;
          const ns = useNodeStore.getState();
          if (ns.routeId === route.id) {
            const next = ns.routes.find((r) => r.id !== route.id) ?? null;
            await openRoute(next ? next.id : null);
            setZoom(null);
            select(null);
          }
          showToast({
            message: `已刪除路線「${route.name}」`,
            actionLabel: "復原",
            onAction: () =>
              void (async () => {
                await undoDelete();
                await openRoute(route.id);
                setZoom(null);
                select(null);
              })(),
          });
        })(),
    });
  };

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
              title="還沒有代碼——點一下去填"
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
              onCommit={(v) => void updateNode(route.id, { code: v || null })}
              ariaLabel="路線代碼"
              placeholder="如 E1"
              className="code"
            />
          </div>
        </FieldRow>

        <FieldRow label="路線色">
          <div className="swatches">
            {PRESETS.map((p) => {
              const v = presetVar(p.n);
              const active = activePreset === p.n;
              return (
                <button
                  key={p.n}
                  type="button"
                  aria-label={`路線色：${p.name}`}
                  aria-pressed={active}
                  title={p.name}
                  onClick={() => void updateNode(route.id, { color: v })}
                  className={`roundel ${active ? "on" : ""}`}
                  style={{ background: v }}
                />
              );
            })}
            <label
              title="自訂色"
              className={`roundel custom ${custom ? "on" : ""}`}
              style={custom ? { background: custom } : undefined}
            >
              <input
                type="color"
                aria-label="自訂路線色"
                value={toPickerHex(route.color)}
                onChange={(e) => schedule(e.target.value)}
                onBlur={flush}
              />
              {!custom && <span aria-hidden>+</span>}
            </label>
            <span className="meta" style={{ marginTop: 0 }}>
              {colorLabel}
            </span>
          </div>
        </FieldRow>

        <FieldRow label="描述" top>
          <CommitTextarea
            value={route.description ?? ""}
            onCommit={(v) => void updateNode(route.id, { description: v || null })}
            ariaLabel="路線描述"
            placeholder="這條路線通往哪裡……"
          />
        </FieldRow>
      </div>

      <StationList routeId={route.id} />

      <ActionsRow
        right={
          <ActionButton ariaLabel="刪除路線" title="刪除這條路線（10 秒內可復原）" tone="danger" onClick={removeRoute}>
            刪除路線
          </ActionButton>
        }
      />
    </div>
  );
}
