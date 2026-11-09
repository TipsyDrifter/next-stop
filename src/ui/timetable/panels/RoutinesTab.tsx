import { Select } from "../../common/Select";
/**
 * RoutinesTab——「分類與設定」第四籤「作息」：作息範本編輯器（時刻表⑦ B 席；契約 §3 畫面、D-時-156／160／166／167／168；
 * 原型 `prototypes/時刻表-⑦.html` 題 3、原型回報 3）。長相照原型的 `.ns-tt-rtmgr-*`，樣式在同目錄 `routines-tab.css`。
 *
 * - 清單：一套一列（`ManagerRow`：名字行內改、淡字「平日・8 段」＝`weekdaysSummary`、↑↓、⋯ 封存／刪除〔toast 帶復原〕）；
 *   名字前一顆 › 展開（`lead` 插槽；段是這一列的內容本身，不藏進 ⋯——原型回報 3）。同時只展開一套。封存的收進「已封存 N 套」＋還原。
 * - 展開區＝緊接的 `li.ns-tt-rtmgr-detailli`（不用 ManagerRow 的 `detail`：那個的開關固定在 ⋯「更多設定…」，會跟 › 重複）：
 *   「哪幾天」七顆（`toggleWeekday`）＋每天／平日／週末；被前面那套佔掉的日子＝淡化斜紋＋一行「一、三已給『工作日』」（`weekdayOwners`）。
 *   「時段」段列＝分類（原生 select 疊在圓牌＋名字上：只列子分類、依組分 optgroup，D-時-168）｜名字（選填，placeholder＝分類名，D-時-167）｜
 *   起–訖（共用 `ClockInput` compact、拿掉微調鈕；營業日表記可 ≥24）｜長度｜×。
 *   段一改就存（即時存、沒有完成鈕）；畫面上的順序等焦點離開那一段才照開始時刻重排（打字中不跳列）；跟前一段重疊＝開始時刻轉赭。
 *   「＋加一段」（接在最後一段後、60 分、分類同上一段）、「從某天的記錄帶入…」（`routineFromDay`；選日期→「共 N 段」→帶入／取消；
 *   原本有段時淡字「會換掉現在的 N 段」；帶入後 toast 帶復原）。
 * - 改了今天已落地的那一套（段或週幾）⇒ toast「已改『X』・今天照舊」＋「套用到今天」（原型回報 2；改範本只影響還沒落地的日子，D-時-160）。
 * - 拖曳排序（D-時-166）：共用 `useDragReorder`，一層清單；放開＝`reorderRoutines`（整組寫）。↑↓ 照留（鍵盤、讀屏入口）。
 * - 定位：sheet `focus:"routine"`＋`focusId` ⇒ 展開那一套、捲進畫面閃一下（封存的打開「已封存」）。只定位一次（同分類籤）。
 * - 寫入一律經 `useTimetablePlanStore` 的範本動作；錯誤由 store toast（RangeError 的人話）。讀不懂的範本（新版寫的）只能改名、封存、刪除。
 * 手機：同一元件在 MobileSheetHost 裡；ManagerRow 手機列高 44、欄位的標籤疊在欄位上（CSS `[data-shell="mobile"]`）。
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { MIN, fmtDur, groupedCategories, toSpan, type TimeCategoryRow } from "../../../domain/timetable";
import {
  WEEKDAY_CHARS,
  WEEKDAYS_EVERY,
  WEEKDAYS_WEEKEND,
  WEEKDAYS_WORK,
  parseRoutineItems,
  routineFromDay,
  serializeRoutineItems,
  toggleWeekday,
  weekdayOwners,
  weekdaysSummary,
  type RoutineItem,
  type TimeRoutineRow,
} from "../../../domain/timetableRoutine";
import { timetableRepo } from "../../../data/timetableRepository";
import { addDays, clockInstant, clockMinutes, clockText, dayWindow, type ClockText } from "../../../lib/date";
import { useTimetablePlanStore } from "../../../store/timetablePlanStore";
import { useTimetableStore } from "../../../store/timetableStore";
import { useUiStore } from "../../../store/uiStore";
import { ManagerList, ManagerRow, type PopMenuItem } from "../../common/ManagerRow";
import { ClockInput } from "../../common/ClockInput";
import { DateChip } from "../../common/DateChip";
import { EmptyState } from "../../common/EmptyState";
import { IconChevron, IconClose, IconPlus } from "../../common/icons";
import { indexOfAnchor, useDragReorder, type DropPlace } from "../../common/dragReorder";
import { CategoryBadge } from "../CategoryBadge";
import "./routines-tab.css";

const toast = (message: string, actionLabel?: string, onAction?: () => void): void =>
  useUiStore.getState().showToast(actionLabel ? { message, actionLabel, onAction } : { message });

const RT = {
  empty: "還沒有作息範本",
  emptyDesc: "例如：平日的一天怎麼過。",
  add: "新增作息範本",
  addPh: "範本的名字（例：工作日）",
  days: "哪幾天",
  segs: "時段",
  addSeg: "＋加一段",
  importOpen: "從某天的記錄帶入…",
  archive: "封存",
  remove: "刪除",
  restore: "還原",
  undo: "復原",
  archived: (n: string) => `已封存「${n}」`,
  deleted: (n: string) => `已刪除「${n}」`,
  segDeleted: "已刪除這段",
  imported: (n: number) => `帶入了 ${n} 段`,
  todayKept: (n: string) => `已改「${n}」・今天照舊`,
  applyToday: "套用到今天",
  unreadable: "這一套是新版本做的，這一版只能改名、封存或刪除。",
  needCat: "先到「分類」建一個分類",
  noSegs: "還沒有段",
  quick: [
    { label: "每天", mask: WEEKDAYS_EVERY },
    { label: "平日", mask: WEEKDAYS_WORK },
    { label: "週末", mask: WEEKDAYS_WEEKEND },
  ],
} as const;

/* ───────── 時刻：營業日表記 ↔ ClockInput 的毫秒（以「今天」當參考日；範本沒有日期，只借它換算） ───────── */

function useClockFrame() {
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const refDay = useTimetableStore((s) => s.todayKey);
  return useMemo(() => {
    const midnight = clockInstant(refDay, "00:00") ?? Date.now();
    const lo = midnight + dayStartHour * 60 * MIN;
    return {
      refDay,
      dayStartHour,
      lo,
      /** 開始最晚＝這一天最後一分；結束最晚＝這一天的終點（"30:00" 在日界線 06:00 下可以當結束） */
      hiStart: lo + 1439 * MIN,
      hiEnd: lo + 1440 * MIN,
      toMs: (t: ClockText): number => midnight + (clockMinutes(t) ?? dayStartHour * 60) * MIN,
      toText: (ms: number): ClockText | null => clockText(Math.round((ms - midnight) / MIN)),
      minStart: dayStartHour * 60,
      maxEnd: dayStartHour * 60 + 1440,
    };
  }, [refDay, dayStartHour]);
}

const startMin = (it: RoutineItem): number => clockMinutes(it.s) ?? 0;
const endMin = (it: RoutineItem): number => clockMinutes(it.e) ?? 0;

/* ───────── 段的草稿：每段一個穩定 key（打字中不跳列、焦點不錯位） ───────── */

interface DraftSeg {
  k: number;
  it: RoutineItem;
}
let draftKey = 0;
const toDraft = (items: readonly RoutineItem[]): DraftSeg[] => items.map((it) => ({ k: ++draftKey, it }));
const sortDraft = (d: readonly DraftSeg[]): DraftSeg[] =>
  d.slice().sort((a, b) => startMin(a.it) - startMin(b.it) || endMin(a.it) - endMin(b.it) || (a.it.cat < b.it.cat ? -1 : a.it.cat > b.it.cat ? 1 : 0));

/** 跟（依開始排後的）前面任何一段重疊的段 key */
function overlapKeys(d: readonly DraftSeg[]): Set<number> {
  const out = new Set<number>();
  let maxEnd = -1;
  for (const x of sortDraft(d)) {
    if (startMin(x.it) < maxEnd) out.add(x.k);
    maxEnd = Math.max(maxEnd, endMin(x.it));
  }
  return out;
}

const isIme = (e: KeyboardEvent<HTMLElement>): boolean => e.nativeEvent.isComposing || e.keyCode === 229;

/* ───────── 籤本體 ───────── */

export function RoutinesTab({ focusId, onFocused }: { focusId?: string; onFocused?: () => void }) {
  const routines = useTimetablePlanStore((s) => s.routines);
  const loaded = useTimetablePlanStore((s) => s.routinesLoaded);
  const updateRoutine = useTimetablePlanStore((s) => s.updateRoutine);
  const archiveRoutine = useTimetablePlanStore((s) => s.archiveRoutine);
  const deleteRoutine = useTimetablePlanStore((s) => s.deleteRoutine);
  const restoreRoutine = useTimetablePlanStore((s) => s.restoreRoutine);
  const reorderRoutines = useTimetablePlanStore((s) => s.reorderRoutines);
  const createRoutine = useTimetablePlanStore((s) => s.createRoutine);

  useEffect(() => {
    if (!useTimetablePlanStore.getState().routinesLoaded) void useTimetablePlanStore.getState().load();
  }, []);

  const active = useMemo(() => routines.filter((r) => r.archived_at === null && r.deleted_at === null), [routines]);
  const archived = useMemo(() => routines.filter((r) => r.archived_at !== null && r.deleted_at === null), [routines]);
  const owners = useMemo(() => weekdayOwners(routines), [routines]);

  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [archOpen, setArchOpen] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 1400);
    return () => clearTimeout(t);
  }, [flash]);

  // 定位（focus "routine"＋focusId）：資料到了才做一次
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const focusPending = useRef(!!focusId);
  useEffect(() => {
    if (!focusPending.current || !focusId || !loaded) return;
    focusPending.current = false;
    onFocused?.();
    if (archived.some((r) => r.id === focusId)) setArchOpen(true);
    else if (active.some((r) => r.id === focusId)) setOpen(focusId);
    else return;
    setFlash(focusId);
    const id = requestAnimationFrame(() => {
      const el = Array.from(root?.querySelectorAll<HTMLElement>("[data-id], [data-rt-id]") ?? []).find((n) => (n.dataset.id ?? n.dataset.rtId) === focusId);
      el?.scrollIntoView({ block: "start" });
    });
    return () => cancelAnimationFrame(id);
  }, [focusId, loaded, active, archived, onFocused, root]);

  // 拖曳排序（一層清單；只有沒封存的參與）
  const listIds = active.map((r) => r.id);
  const onDrop = useCallback(
    (ids: readonly string[], place: DropPlace) => {
      if (place.kind !== "slot") return;
      const latest = useTimetablePlanStore
        .getState()
        .routines.filter((r) => r.archived_at === null && r.deleted_at === null)
        .map((r) => r.id);
      const at = indexOfAnchor(latest, ids, place);
      if (at === null) return;
      const rest = latest.filter((x) => !ids.includes(x));
      rest.splice(at, 0, ...ids);
      void reorderRoutines(rest);
    },
    [reorderRoutines],
  );
  const [listEl, setListEl] = useState<HTMLElement | null>(null);
  useDragReorder({ root: listEl, items: listIds.map((id) => ({ id })), onDrop });

  const move = (id: string, delta: 1 | -1): void => {
    const i = listIds.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= listIds.length) return;
    const next = listIds.slice();
    next[i] = listIds[j];
    next[j] = listIds[i];
    void reorderRoutines(next);
  };

  const onCreate = async (name: string): Promise<void> => {
    setAdding(false);
    const row = await createRoutine({ name, items: [], weekdays: 0 });
    if (row) {
      setOpen(row.id);
      setFlash(row.id);
    }
  };

  if (!loaded) return null; // 資料未到不畫空狀態（§1.8）

  return (
    <div className="ns-tt-rtmgr" ref={setRoot}>
      {active.length === 0 && !adding ? (
        <EmptyState tone="first" inline title={RT.empty} desc={RT.emptyDesc} action={{ label: RT.add, icon: <IconPlus />, onClick: () => setAdding(true) }} />
      ) : (
        <div ref={setListEl} className="ns-tt-rtmgr-listwrap">
          <ManagerList label="作息範本" className="ns-tt-rtmgr-list">
            {active.map((r, i) => {
              const items = parseRoutineItems(r.items);
              const isOpen = open === r.id;
              const taken = takenDays(r, owners);
              const allTaken = r.weekdays !== 0 && taken.length > 0 && taken.length === countBits(r.weekdays);
              const note = `${weekdaysSummary(r.weekdays)}${allTaken ? "（都已給別套）" : ""}・${items ? `${items.length} 段` : "新版本"}`;
              const detailId = `rt-detail-${r.id}`;
              const menu: PopMenuItem[] = [
                {
                  key: "archive",
                  label: RT.archive,
                  cut: true, // 己-2 A3：封存與刪除一組、排在上移下移之後（managerRowMenu）
                  onSelect: () =>
                    void archiveRoutine(r.id, true).then((ok) => {
                      if (!ok) return;
                      if (open === r.id) setOpen(null);
                      toast(RT.archived(r.name), RT.undo, () => void archiveRoutine(r.id, false));
                    }),
                },
                {
                  key: "delete",
                  label: RT.remove,
                  danger: true,
                  onSelect: () =>
                    void deleteRoutine(r.id).then((ok) => {
                      if (!ok) return;
                      if (open === r.id) setOpen(null);
                      toast(RT.deleted(r.name), RT.undo, () => void restoreRoutine(r.id));
                    }),
                },
              ];
              return [
                <ManagerRow
                  key={r.id}
                  name={r.name}
                  onRename={(name) => updateRoutine(r.id, { name }).then((ok) => ok)}
                  lead={
                    <button
                      type="button"
                      className="ns-tt-rtmgr-chev"
                      aria-expanded={isOpen}
                      aria-controls={isOpen ? detailId : undefined}
                      aria-label={`${isOpen ? "收起" : "展開"}「${r.name}」`}
                      title={isOpen ? "收起" : "展開"}
                      onClick={() => setOpen(isOpen ? null : r.id)}
                    >
                      <IconChevron open={isOpen} />
                    </button>
                  }
                  note={note}
                  onUp={i > 0 ? () => move(r.id, -1) : undefined}
                  onDown={i < active.length - 1 ? () => move(r.id, 1) : undefined}
                  menu={menu}
                  dataId={r.id}
                  dragId={r.id}
                  className={"ns-tt-rtmgr-row" + (isOpen ? " is-xopen" : "") + (flash === r.id ? " is-flash" : "")}
                />,
                isOpen && (
                  <li key={r.id + "-detail"} id={detailId} className="ns-tt-rtmgr-detailli">
                    <div role="group" aria-label={`「${r.name}」的內容`}>
                      <RoutineDetail row={r} items={items} routines={routines} owners={owners} />
                    </div>
                  </li>
                ),
              ];
            })}
          </ManagerList>
        </div>
      )}

      {adding ? (
        <AddRoutineRow onAdd={(name) => void onCreate(name)} onCancel={() => setAdding(false)} />
      ) : (
        active.length > 0 && (
          <button type="button" className="ns-btn btn-text ns-btn--sm ns-tt-mgr-addbtn ns-tt-rtmgr-new" onClick={() => setAdding(true)}>
            <IconPlus />
            {RT.add}
          </button>
        )
      )}

      {archived.length > 0 && (
        <details className="ns-tt-mgr-archived" open={archOpen} onToggle={(e) => setArchOpen(e.currentTarget.open)}>
          <summary>
            已封存 {archived.length} 套<i aria-hidden="true">›</i>
          </summary>
          <div className="ns-tt-mgr-archived-list">
            {archived.map((r) => {
              const n = parseRoutineItems(r.items)?.length;
              return (
                <div key={r.id} className={"ns-tt-mgr-row is-archived" + (flash === r.id ? " is-flash" : "")} data-rt-id={r.id}>
                  <span className="ns-tt-mgr-archived-name">
                    {r.name}
                    <small>
                      {weekdaysSummary(r.weekdays)}
                      {n !== undefined ? `・${n} 段` : ""}
                    </small>
                  </span>
                  <button
                    type="button"
                    className="ns-btn btn-ghost ns-btn--sm"
                    onClick={() => {
                      setFlash(r.id);
                      void archiveRoutine(r.id, false);
                    }}
                  >
                    {RT.restore}
                  </button>
                </div>
              );
            })}
          </div>
        </details>
      )}
    </div>
  );
}

function countBits(mask: number): number {
  let n = 0;
  for (let b = 0; b < 7; b++) if (mask & (1 << b)) n++;
  return n;
}

/** 這一套勾了、但被前面那套拿走的日子（bit 序號） */
function takenDays(r: TimeRoutineRow, owners: readonly (string | null)[]): number[] {
  const out: number[] = [];
  for (let b = 0; b < 7; b++) if (r.weekdays & (1 << b) && owners[b] !== null && owners[b] !== r.id) out.push(b);
  return out;
}

/** 新增一套的輸入列（同分類籤的 AddRow：「新增」次鈕、「取消」文字鈕） */
function AddRoutineRow({ onAdd, onCancel }: { onAdd(name: string): void; onCancel(): void }) {
  const [text, setText] = useState("");
  const submit = (): void => {
    const t = text.trim();
    if (t) onAdd(t);
  };
  return (
    <div className="ns-tt-mgr-add ns-tt-rtmgr-add">
      <input
        className="ns-tt-input"
        value={text}
        autoFocus
        placeholder={RT.addPh}
        aria-label={RT.addPh}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (isIme(e)) return;
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
        enterKeyHint="done"
        spellCheck={false}
        autoComplete="off"
      />
      <button type="button" className="ns-btn btn-text ns-btn--sm" onClick={onCancel}>
        取消
      </button>
      <button type="button" className="ns-btn btn-ghost ns-btn--sm" disabled={!text.trim()} onClick={submit}>
        新增
      </button>
    </div>
  );
}

/* ───────── 展開區 ───────── */

function RoutineDetail({
  row,
  items,
  routines,
  owners,
}: {
  row: TimeRoutineRow;
  /** null＝讀不懂（新版寫的） */
  items: RoutineItem[] | null;
  routines: readonly TimeRoutineRow[];
  owners: readonly (string | null)[];
}) {
  const updateRoutine = useTimetablePlanStore((s) => s.updateRoutine);
  const categories = useTimetableStore((s) => s.categories);
  const catById = useTimetableStore((s) => s.catById);
  const frame = useClockFrame();
  const groups = useMemo(() => groupedCategories(categories).filter((g) => g.children.length > 0), [categories]);
  const firstCat = groups[0]?.children[0]?.id ?? null;

  // 草稿：外面（同步、另一個殼、自己的寫入）改了段 ⇒ 內容不同才換掉（自己的寫入照開始排序後內容相同，草稿留著、key 不變）
  const [draft, setDraft] = useState<DraftSeg[]>(() => toDraft(items ?? []));
  const [seen, setSeen] = useState(row.items);
  if (seen !== row.items) {
    setSeen(row.items);
    if (items && serializeRoutineItems(draft.map((d) => d.it)) !== row.items) setDraft(toDraft(items));
  }
  const [importing, setImporting] = useState(false);

  /** 改了今天已落地的這一套 ⇒ 提醒今天照舊、給「套用到今天」 */
  const nudgeToday = (): void => {
    const st = useTimetablePlanStore.getState();
    const today = useTimetableStore.getState().todayKey;
    const d = st.rowsForDay(today);
    if (d && d.materialized && d.routineId === row.id) {
      toast(RT.todayKept(row.name), RT.applyToday, () => void useTimetablePlanStore.getState().applyRoutine(today, row.id));
    }
  };

  const writeItems = async (next: DraftSeg[], undoMsg?: string): Promise<void> => {
    const before = items ?? [];
    setDraft(next);
    const ok = await updateRoutine(row.id, { items: next.map((d) => d.it) });
    if (!ok) {
      // 沒存成（store 已 toast 理由）：草稿退回目前存著的
      const cur = useTimetablePlanStore.getState().routines.find((r) => r.id === row.id);
      setDraft(toDraft(parseRoutineItems(cur?.items) ?? []));
      return;
    }
    if (undoMsg) toast(undoMsg, RT.undo, () => void updateRoutine(row.id, { items: before }));
    else nudgeToday();
  };

  const writeDays = async (mask: number): Promise<void> => {
    if (mask === row.weekdays) return;
    if (await updateRoutine(row.id, { weekdays: mask })) nudgeToday();
  };

  const patchSeg = (k: number, patch: Partial<RoutineItem>): void => {
    const next = draft.map((d) => {
      if (d.k !== k) return d;
      const it: RoutineItem = { ...d.it, ...patch };
      if (patch.n !== undefined && !patch.n) delete it.n;
      return { k, it };
    });
    void writeItems(next);
  };

  const addSeg = (): void => {
    const sorted = sortDraft(draft);
    const last = sorted[sorted.length - 1]?.it;
    const cat = last?.cat ?? firstCat;
    if (!cat) {
      toast(RT.needCat);
      return;
    }
    let s = last ? endMin(last) : Math.max(9 * 60, frame.minStart);
    if (s > frame.maxEnd - 60) s = frame.maxEnd - 60;
    const e = Math.min(s + 60, frame.maxEnd);
    const st = clockText(s);
    const et = clockText(e);
    if (!st || !et) return;
    void writeItems([...draft, { k: ++draftKey, it: { cat, s: st, e: et } }]);
  };

  // 跟今天的日子判斷「被前面那套拿走」
  const taken = takenDays(row, owners);
  const takenNote = (() => {
    const by = new Map<string, number[]>();
    for (const b of taken) {
      const o = owners[b]!;
      by.set(o, [...(by.get(o) ?? []), b]);
    }
    return Array.from(by.entries())
      .map(([id, bs]) => `${bs.map((b) => WEEKDAY_CHARS[b]).join("、")}已給「${routines.find((r) => r.id === id)?.name ?? "別套"}」`)
      .join("・");
  })();

  const bad = overlapKeys(draft);

  return (
    <div className="ns-tt-rtmgr-detail">
      <div className="ns-tt-rtmgr-f">
        <span className="ns-tt-rtmgr-k">{RT.days}</span>
        <div className="ns-tt-rtmgr-v">
          <div className="ns-tt-rtmgr-days" role="group" aria-label={RT.days}>
            {WEEKDAY_CHARS.map((ch, b) => {
              const on = (row.weekdays & (1 << b)) !== 0;
              const isTaken = on && taken.includes(b);
              const ownerName = isTaken ? (routines.find((r) => r.id === owners[b])?.name ?? "別套") : "";
              return (
                <button
                  key={b}
                  type="button"
                  className={"ns-tt-rtmgr-day" + (on ? " is-on" : "") + (isTaken ? " is-taken" : "")}
                  aria-pressed={on}
                  aria-label={`週${ch}`}
                  title={isTaken ? `週${ch}已給「${ownerName}」` : `週${ch}`}
                  onClick={() => void writeDays(toggleWeekday(row.weekdays, b))}
                >
                  {ch}
                </button>
              );
            })}
            <span className="ns-tt-rtmgr-quick">
              {RT.quick.map((q) => (
                <button
                  key={q.label}
                  type="button"
                  className={"ns-btn btn-text ns-btn--sm" + ((row.weekdays & WEEKDAYS_EVERY) === q.mask ? " is-on" : "")}
                  aria-pressed={(row.weekdays & WEEKDAYS_EVERY) === q.mask}
                  onClick={() => void writeDays(q.mask)}
                >
                  {q.label}
                </button>
              ))}
            </span>
          </div>
          {takenNote && <span className="ns-tt-rtmgr-taken">{takenNote}</span>}
        </div>
      </div>

      <div className="ns-tt-rtmgr-f">
        <span className="ns-tt-rtmgr-k">{RT.segs}</span>
        <div className="ns-tt-rtmgr-v">
          {items === null ? (
            <p className="ns-tt-rtmgr-taken">{RT.unreadable}</p>
          ) : (
            <>
              {draft.length > 0 ? (
                <ul className="ns-tt-rtmgr-segs">
                  {draft.map((d) => (
                    <SegRow
                      key={d.k}
                      seg={d}
                      overlap={bad.has(d.k)}
                      groups={groups}
                      catById={catById}
                      frame={frame}
                      onPatch={(p) => patchSeg(d.k, p)}
                      onRemove={() =>
                        void writeItems(
                          draft.filter((x) => x.k !== d.k),
                          RT.segDeleted,
                        )
                      }
                      onLeave={() => setDraft((cur) => sortDraft(cur))}
                    />
                  ))}
                </ul>
              ) : (
                <span className="ns-tt-rtmgr-taken ns-tt-rtmgr-none">{RT.noSegs}</span>
              )}
              <div className="ns-tt-rtmgr-foot">
                <button type="button" className="ns-btn btn-text ns-btn--sm" onClick={addSeg}>
                  {RT.addSeg}
                </button>
                {!importing && (
                  <button type="button" className="ns-btn btn-text ns-btn--sm" onClick={() => setImporting(true)}>
                    {RT.importOpen}
                  </button>
                )}
              </div>
              {importing && (
                <ImportRow
                  current={draft.length}
                  frame={frame}
                  onCancel={() => setImporting(false)}
                  onImport={(next) => {
                    setImporting(false);
                    void writeItems(toDraft(next), RT.imported(next.length));
                  }}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

type Frame = ReturnType<typeof useClockFrame>;

/** 段列：分類｜名字｜起–訖｜長度｜× */
function SegRow({
  seg,
  overlap,
  groups,
  catById,
  frame,
  onPatch,
  onRemove,
  onLeave,
}: {
  seg: DraftSeg;
  overlap: boolean;
  groups: readonly { group: TimeCategoryRow; children: TimeCategoryRow[] }[];
  catById: Record<string, TimeCategoryRow>;
  frame: Frame;
  onPatch(p: Partial<RoutineItem>): void;
  onRemove(): void;
  onLeave(): void;
}) {
  const { it } = seg;
  const cat = catById[it.cat] ?? null;
  const live = groups.some((g) => g.children.some((c) => c.id === it.cat));
  const len = endMin(it) - startMin(it);
  const catName = cat?.name ?? "分類不在了";
  const name = it.n ?? catName;
  return (
    <li
      className={"ns-tt-rtmgr-seg" + (overlap ? " is-overlap" : "")}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onLeave();
      }}
    >
      <span className="ns-tt-rtmgr-cat">
        <CategoryBadge cat={cat} size="sm" />
        <span className="ns-tt-rtmgr-catname">{catName}</span>
        <span className="car" aria-hidden="true" />
        <Select overlay aria-label={`「${name}」的分類`} value={it.cat} onChange={(v) => v && onPatch({ cat: v })}>
          {!live && <option value={it.cat}>{cat ? `${cat.name}（已封存）` : "分類不在了"}</option>}
          {groups.map((g) => (
            <optgroup key={g.group.id} label={g.group.name}>
              {g.children.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
      </span>
      <SegName value={it.n ?? ""} placeholder={catName} label={`「${catName}」這一段的名字`} onCommit={(n) => onPatch({ n })} />
      <span className="ns-tt-rtmgr-time">
        <span className={"ns-tt-rtmgr-t" + (overlap ? " is-bad" : "")} title={overlap ? "跟前一段重疊" : undefined}>
          {startMin(it) >= 1440 && <NextDayMark />}
          <ClockInput
            variant="compact"
            label={`「${name}」開始${overlap ? "（跟前一段重疊）" : ""}`}
            value={frame.toMs(it.s)}
            lo={frame.lo}
            hi={frame.hiStart}
            refDay={frame.refDay}
            dateLabel={false}
            left={<></>}
            right={<></>}
            onChange={(ms) => {
              const s = frame.toText(ms);
              if (!s || s === it.s) return;
              // 開始推到結束之後 ⇒ 結束跟著走、長度不變（夾在這一天的終點）
              const sm = clockMinutes(s) ?? 0;
              if (sm >= endMin(it)) {
                const e = clockText(Math.min(sm + Math.max(len, 15), frame.maxEnd));
                if (e && (clockMinutes(e) ?? 0) > sm) return onPatch({ s, e });
              }
              onPatch({ s });
            }}
          />
        </span>
        <span className="ns-tt-rtmgr-dash" aria-hidden="true">
          –
        </span>
        <span className="ns-tt-rtmgr-t">
          {endMin(it) > 1440 && <NextDayMark />}
          <ClockInput
            variant="compact"
            label={`「${name}」結束`}
            value={frame.toMs(it.e)}
            lo={frame.lo + MIN}
            hi={frame.hiEnd}
            refDay={frame.refDay}
            dateLabel={false}
            left={<></>}
            right={<></>}
            onChange={(ms) => {
              const e = frame.toText(ms);
              if (e && e !== it.e) onPatch({ e });
            }}
          />
        </span>
        <span className="ns-tt-rtmgr-len ns-tt-num">{len > 0 ? fmtDur(len * MIN) : ""}</span>
        {/* 手機沒有滑過提示：重疊的原因直接寫在這一段（桌機靠赭色＋滑過；讀屏讀開始框的名字） */}
        {overlap && (
          <span className="ns-tt-rtmgr-olap" aria-hidden="true">
            跟前一段重疊
          </span>
        )}
      </span>
      <button type="button" className="ns-iconbtn is-dim ns-tt-rtmgr-x" aria-label={`刪「${name}」這一段`} title="刪這段" onClick={onRemove}>
        <IconClose />
      </button>
    </li>
  );
}

/**
 * 過了午夜的時刻（營業日表記 ≥ 24:00，例「27:00」）：時刻框照牆鐘顯示「03:00」，框上角補一個淡字「隔天」，
 * 不然排在一天最後的「03:00」看起來像寫錯（ClockInput 的日期說明行在這裡關掉了：範本沒有日期）
 */
function NextDayMark() {
  return <span className="ns-tt-rtmgr-next">隔天</span>;
}

/** 段的名字（選填）：Enter／失焦存、Esc 還原；空白＝用分類名 */
function SegName({ value, placeholder, label, onCommit }: { value: string; placeholder: string; label: string; onCommit(n: string): void }) {
  const [text, setText] = useState(value);
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setText(value);
  }
  const skip = useRef(false);
  const commit = (): void => {
    if (skip.current) {
      skip.current = false;
      return;
    }
    const t = text.replace(/\s+/g, " ").trim();
    if (t !== text) setText(t);
    if (t !== value) onCommit(t);
  };
  return (
    <input
      className="techo-input ns-tt-rtmgr-name"
      value={text}
      placeholder={placeholder}
      aria-label={label}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (isIme(e)) return;
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
          skip.current = true;
          e.currentTarget.blur();
        } else if (e.key === "Escape" && text !== value) {
          e.preventDefault();
          e.stopPropagation();
          setText(value);
        }
      }}
      enterKeyHint="done"
      spellCheck={false}
      autoComplete="off"
    />
  );
}

/** 「從某天的記錄帶入…」展開的那一行：選一天 → 共 N 段 → 帶入／取消 */
function ImportRow({ current, frame, onImport, onCancel }: { current: number; frame: Frame; onImport(items: RoutineItem[]): void; onCancel(): void }) {
  const [day, setDay] = useState(() => addDays(frame.refDay, -1));
  const [got, setGot] = useState<{ day: string; items: RoutineItem[] } | null>(null);
  const labelId = useId();
  useEffect(() => {
    let alive = true;
    const w = dayWindow(day, frame.dayStartHour);
    timetableRepo
      .listBlocks(w.start, w.end)
      .then((rows) => {
        if (alive) setGot({ day, items: routineFromDay(rows.map(toSpan), day, frame.dayStartHour, Date.now()) });
      })
      .catch((e) => {
        console.warn("時刻表：那天的記錄讀不到", e);
        if (alive) setGot({ day, items: [] });
      });
    return () => {
      alive = false;
    };
  }, [day, frame.dayStartHour]);
  const ready = got !== null && got.day === day;
  const n = ready ? got.items.length : null;
  return (
    <div className="ns-tt-rtmgr-import" role="group" aria-labelledby={labelId}>
      <span id={labelId}>帶入</span>
      <DateChip date={day} onPick={(d) => d && setDay(d)} allowPast max={frame.refDay} label="哪一天的記錄" />
      <span className="ns-tt-rtmgr-import-n" aria-live="polite">
        {n === null ? "" : n === 0 ? "那天沒有 10 分以上的記錄" : `的記錄・共 ${n} 段`}
      </span>
      <span className="ns-tt-rtmgr-import-acts">
        <button type="button" className="ns-btn btn-text ns-btn--sm" onClick={onCancel}>
          取消
        </button>
        <button type="button" className="ns-btn btn-ghost ns-btn--sm" disabled={!n} onClick={() => ready && got && onImport(got.items)}>
          帶入
        </button>
      </span>
      {current > 0 && n !== null && n > 0 && <small>會換掉現在的 {current} 段</small>}
    </div>
  );
}
