/**
 * TagShareRows——占比卡「荷札」那一面的內容（⑥ 契約 §5.5；D-時-118～120、130；丙席）。卡頭與切換在 `ShareList`，這裡只畫卡身。
 *
 *   有荷札：一行淡字「一塊可能有好幾個荷札，加起來會超過 100%」（取代堆疊長條，0-10）→ 荷札樹 → 最後一列「沒掛荷札」（0 也列）→ 卡尾說明
 *   沒荷札（D-時-120）：空狀態句＋「去設定」開分類管理。UI 丙-4 D7／A3：換成卡內一行 EmptyState（inline），
 *     鈕字改「分類與設定」（＝頁首那顆的名字，叫法只剩一種；空狀態教第一步不算第二入口）
 *
 * 列＝`StatsResult.tags`（store 用 `tagShareRows` 排好：同層名稱升冪、父在子前、只列本期或上期 > 0 的；父層時數含子孫、同一塊不重複）。
 * 父層預設收合，有子的才有 ›；牌子照荷札牌（沒有顏色，只用墨與紙），虛資料夾框線退淡＋「虛資料夾」淡字。
 * 點名稱＝`setFilter({kind:"tag", id:key})`（再點取消，選中描金）；百分比分母＝已記錄（D-時-50）。
 * 「沒有荷札」的判斷：`tagStore.index` 已載、而且時刻表的塊與分類一個荷札都沒掛（目標的不算——它不影響占比）。index 還沒載＝照列（不閃空狀態）。
 */
import { useMemo, useState, type CSSProperties } from "react";
import { fmtDur } from "../../../domain/timetable";
import { fmtPct, type StatsResult, type StatsTagRow } from "../../../domain/timetableStats";
import { TT_TAG_BLOCK, TT_TAG_CATEGORY } from "../../../domain/timetableTags";
import { useTagStore } from "../../../store/tagStore";
import { TT_TEXT, useTimetableStore } from "../../../store/timetableStore";
import { useTimetableStatsStore } from "../../../store/timetableStatsStore";
import { EmptyState } from "../../common/EmptyState";
import { Delta } from "./parts";

/** 荷札空狀態的字（UI 丙-4 D7；只在這一支用。鈕字用 TT_TEXT.settingsBtn「分類與設定」） */
const TAG_EMPTY = { title: "還沒有荷札。", desc: "幫分類掛上預設荷札，過去的紀錄也會一起算進來。" } as const;

/** 荷札牌（小、唯讀）：父層段淡、末段正常；牌子上不印 #（荷札契約 §1-7）。統計列與趨勢的過濾鈕共用 */
export function StatsTagChip({ name, virtual = false }: { name: string; virtual?: boolean }) {
  const segs = name.split("/");
  return (
    <span className={"ns-tt-stag" + (virtual ? " is-virtual" : "")} aria-hidden="true">
      <span className="ns-tt-stag-nm">
        {segs.map((s, i) => (
          <span key={i}>
            {i > 0 && <i className="sl">/</i>}
            <span className={i < segs.length - 1 ? "pa" : "la"}>{s}</span>
          </span>
        ))}
      </span>
    </span>
  );
}

/** 時刻表的塊或分類有沒有掛任何荷札；index 還沒載＝null（不知道） */
function useHasTimetableTags(): boolean | null {
  const index = useTagStore((s) => s.index);
  return useMemo(() => {
    if (!index) return null;
    return index.ents.some((e) => (e.type === TT_TAG_BLOCK || e.type === TT_TAG_CATEGORY) && e.keys.length > 0);
  }, [index]);
}

/** 依收合狀態留下看得到的列：每一個祖先都展開了才看得到（列已經是父在子前的攤平順序） */
function visibleRows(rows: readonly StatsTagRow[], open: Record<string, boolean>): StatsTagRow[] {
  const shown = new Set<string>();
  const out: StatsTagRow[] = [];
  for (const row of rows) {
    if (row.parent !== null && !(shown.has(row.parent) && open[row.parent])) continue;
    shown.add(row.key);
    out.push(row);
  }
  return out;
}

export function TagShareRows({ r, desktop }: { r: StatsResult; desktop: boolean }) {
  const filter = useTimetableStatsStore((s) => s.filter);
  const setFilter = useTimetableStatsStore((s) => s.setFilter);
  const openSheet = useTimetableStore((s) => s.openSheet);
  const hasTags = useHasTimetableTags();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [justOpened, setJustOpened] = useState<string | null>(null);
  const T = TT_TEXT.tags;
  const S = TT_TEXT.statsUi;
  const rec = r.cur.recordedMs;
  const sel = filter && filter.kind === "tag" ? filter.id : null;

  if (hasTags === false && r.tags.length === 0) {
    return (
      <EmptyState
        inline
        tone="first"
        className="ns-tt-stats-tagempty"
        title={TAG_EMPTY.title}
        desc={TAG_EMPTY.desc}
        action={{ label: TT_TEXT.settingsBtn, onClick: () => openSheet({ kind: "categories" }) }}
      />
    );
  }

  const rows = visibleRows(r.tags, open);
  const toggle = (key: string): void => setFilter(sel === key ? null : { kind: "tag", id: key });

  return (
    <>
      <p className="ns-tt-stats-over">{T.overNote}</p>
      <div className="ns-tt-stats-list" role="list">
        {rows.map((row) => {
          const isOpen = !!open[row.key];
          const isSel = sel === row.key;
          return (
            <div
              key={row.key}
              role="listitem"
              className={
                "ns-tt-stats-row ns-tt-stats-trow" +
                (row.depth === 1 ? " is-top" : " is-kid") +
                (isSel ? " is-sel" : "") +
                (isOpen ? " is-open" : "") +
                (justOpened !== null && row.parent === justOpened ? " is-new" : "")
              }
              style={{ "--d": row.depth - 1 } as CSSProperties}
            >
              {row.hasKids ? (
                <button
                  type="button"
                  className="ns-tt-stats-exp"
                  aria-expanded={isOpen}
                  aria-label={isOpen ? S.collapseKids : S.expandKids}
                  onClick={() => {
                    setOpen((o) => ({ ...o, [row.key]: !o[row.key] }));
                    setJustOpened(isOpen ? null : row.key);
                  }}
                >
                  <i>›</i>
                </button>
              ) : (
                <span className="ns-tt-stats-exp is-blank" />
              )}
              <button
                type="button"
                className="ns-tt-stats-rname ns-tt-stats-tname"
                aria-pressed={isSel}
                aria-label={T.chip(row.name)}
                title={desktop ? T.filterTitle(isSel) : undefined}
                onClick={() => toggle(row.key)}
              >
                <StatsTagChip name={row.name} virtual={!row.real} />
                {!row.real && <em className="ns-tt-stats-vf">{T.virtual}</em>}
              </button>
              <span className="ns-tt-stats-rv ns-tt-num">{fmtDur(row.ms)}</span>
              <span className="ns-tt-stats-rp ns-tt-num">{fmtPct(row.ms, rec)}</span>
              <span className="ns-tt-stats-rd ns-tt-num">
                <Delta ms={row.ms - row.prevMs} prevMs={row.prevMs} showTitle={desktop} />
              </span>
            </div>
          );
        })}
        <div role="listitem" className="ns-tt-stats-row ns-tt-stats-trow is-top is-none">
          <span className="ns-tt-stats-exp is-blank" />
          <span className="ns-tt-stats-rname is-static">
            <span>{T.untagged}</span>
          </span>
          <span className="ns-tt-stats-rv ns-tt-num">{fmtDur(r.untagged.ms)}</span>
          <span className="ns-tt-stats-rp ns-tt-num">{fmtPct(r.untagged.ms, rec)}</span>
          <span className="ns-tt-stats-rd ns-tt-num">
            <Delta ms={r.untagged.ms - r.untagged.prevMs} prevMs={r.untagged.prevMs} showTitle={desktop} />
          </span>
        </div>
      </div>
      <p className="ns-tt-stats-foot">{T.shareFoot}</p>
    </>
  );
}
