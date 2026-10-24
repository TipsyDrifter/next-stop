/**
 * GoalPanel——時數目標的新增／編輯（③ 契約 §5.4；D-時-42、59、65；乙席）。
 * 欄位：名字（必填 ≤ 24 字）、分類（兩層樹：頂層預設收合、有勾子分類的那組自動展開；勾頂層＝整組，子分類跟著勾、灰掉）、
 * 期間（分段：週期重複／從某天起／到某天為止／單一區間；週期重複再選每日／每週／每月）、日期列依期間出現
 * （從某天起＝起點；到某天為止＝截止必填、起點預設今天收在「改起點」裡；單一區間＝起訖都必填、訖 ≥ 起）、方向（至少／至多）、
 * 目標時數（小時 stepper＋分鐘 chips，> 0）。底部：儲存；編輯時多「封存」「刪除」（store 的 toast 帶撤回）。最下「已封存的目標」可展開、還原（從目標籤點進來時不畫，UI 丙-4 修）。
 * 寫入一律走 store（createGoal／updateGoal／archiveGoal／deleteGoal），回 true 才關；驗證失敗的字在預覽行（儲存鈕灰掉）。
 *
 * 車次⑥（⑥ 契約 §5.4、0-11；D-時-122；乙席；長相＝原型 `v-tags.js` goalBody）：分類樹下一段「荷札」（div.ns-tt-row.ns-tt-tagrow）：
 * 桌機 `EntityTagField` 受控模式（草稿；建議清單往下推開）、手機牌子＋「掛荷札」開點選器 insert 模式（標題「荷札・目標」，磨光③ 2-8）；下面一行說明。
 * 草稿＝`tagDraft`（null＝沒動過：跟著目標現在綁的荷札，`Goal.tagKeys`／荷札 index 的 `timetable:goal`）。
 * 驗證：分類與荷札至少一個（`TT_TEXT.tags.goalScopeEmpty`，跟 normalizeGoalInput 同字）。
 * 存檔把 `tagNames` 交給 createGoal／updateGoal（荷札 index 載過、或已經動過草稿才帶；沒載過又沒動＝不帶＝不動荷札）。
 *
 * UI 丙-4 C4／C5（契約 §1 C4、C5）：
 * - 按鈕列＝［封存］［刪除］（次要、靠左；刪除赭框）…［取消］［儲存］（唯一一顆 seal）；`<Actions>` 由宿主搬進黏底 foot。
 *   找不到這個目標的退路只剩殼的 ×（規範 §4：不改東西只是關＝×，不畫「關閉」鈕）。
 * - 期間、週期、方向三組單選換共用 `Segmented`（規範 §2.2：表單內的單選）；分鐘那排是快選 chip、留 Opt。
 * - 起訖日換共用 `DateChip`（桌機貼著 chip 的 DatePicker、手機 MobileDatePicker；返回層由 DateChip 自己登記成一層）。
 *   起日可以挑過去（目標可以從上週算起，同舊行為）；迄日 `min`＝起日。
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { TimeCategoryRow } from "../../../domain/timetable";
import { GOAL_NAME_MAX, parseGoal, type Goal, type GoalDirection, type GoalInput, type GoalPeriod } from "../../../domain/timetableStats";
import { timetableRepo } from "../../../data/timetableRepository";
import { todayKey } from "../../../lib/date";
import { TT_TEXT, useTimetableStore } from "../../../store/timetableStore";
import { useTimetableStatsStore } from "../../../store/timetableStatsStore";
import { useUiStore } from "../../../store/uiStore";
import { catColor, goalPeriodText, md, scopeText } from "../stats/format";
import { Actions, Opt, Opts, Row, Sub, type PanelProps } from "./controls";
import { Segmented } from "../../common/Segmented";
import { DateChip } from "../../common/DateChip";
import { TT_TAG_GOAL } from "../../../domain/timetableTags";
import { useTagStore } from "../../../store/tagStore";
import { EntityTagField } from "../../common/EntityTagField"; // 不經 ui/notes/desktop.ts（barrel 跟 lines/mounts 成圈；偏差記錄 10-20）
import { useShell } from "../../mobile/useShell";
import { MobileTagDraft, tagNameOf } from "../parts/TimetableTagChips";

type Kind = "repeat" | "since" | "until" | "range";
type Rep = "day" | "week" | "month";

interface Form {
  name: string;
  cats: string[];
  kind: Kind;
  rep: Rep;
  startOn: string;
  endOn: string;
  startOpen: boolean;
  dir: GoalDirection;
  h: number;
  m: number;
}

const kindOf = (p: GoalPeriod): Kind => (p === "day" || p === "week" || p === "month" ? "repeat" : p);
const MINUTE_CHIPS = [0, 15, 30, 45] as const;

function problemOf(f: Form, tagCount: number): string {
  const T = TT_TEXT.statsUi;
  if (!f.name.trim()) return T.noName;
  if (!f.cats.length && !tagCount) return TT_TEXT.tags.goalScopeEmpty; // ⑥：分類或荷札至少一個
  if (!(f.h * 60 + f.m > 0)) return T.noHours;
  if ((f.kind === "until" || f.kind === "range") && !f.endOn) return f.kind === "until" ? T.noEndUntil : T.noEndRange;
  if (f.kind !== "repeat" && !f.startOn) return T.noStart;
  if ((f.kind === "until" || f.kind === "range") && f.endOn < f.startOn) return f.kind === "until" ? T.endBeforeUntil : T.endBeforeRange;
  return "";
}

function inputOf(f: Form, tagNames?: readonly string[]): GoalInput {
  return {
    ...(tagNames !== undefined ? { tagNames: tagNames.slice() } : {}),
    name: f.name.trim(),
    categoryIds: f.cats.slice(),
    period: f.kind === "repeat" ? f.rep : f.kind,
    targetMin: f.h * 60 + f.m,
    direction: f.dir,
    startOn: f.kind === "repeat" ? null : f.startOn,
    endOn: f.kind === "until" || f.kind === "range" ? f.endOn : null,
  };
}

export function GoalPanel({ onDone }: PanelProps) {
  const sheet = useTimetableStore((s) => s.sheet);
  const categories = useTimetableStore((s) => s.categories);
  const catById = useTimetableStore((s) => s.catById);
  const createGoal = useTimetableStore((s) => s.createGoal);
  const updateGoal = useTimetableStore((s) => s.updateGoal);
  const archiveGoal = useTimetableStore((s) => s.archiveGoal);
  const deleteGoal = useTimetableStore((s) => s.deleteGoal);
  const goalList = useTimetableStatsStore((s) => s.goalList);
  const archived = useTimetableStatsStore((s) => s.archivedGoals);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const T = TT_TEXT.statsUi;

  const goalId = sheet?.kind === "goal" ? sheet.goalId : null;
  // UI 丙-4 修（T7 評審 5、28）：從「分類與設定」目標籤點進來的，做完回到那一籤；已封存清單交給目標籤（同一動作一個入口）
  const fromGoalsTab = sheet?.kind === "goal" && sheet.back === "goals";
  const openSheet = useTimetableStore((s) => s.openSheet);
  const finish = fromGoalsTab ? () => openSheet({ kind: "categories", tab: "goals" }) : onDone;
  const listGoal = goalId ? (goalList.find((g) => g.id === goalId) ?? null) : null;
  // 統計頁還沒算好（剛切過來就開、或從同步清單點進來而統計頁沒開著）時 goalList 是空的：直接向 repository 要那一列
  const [fetched, setFetched] = useState<Goal | "loading" | "gone" | null>(null);
  useEffect(() => {
    if (!goalId || listGoal) return;
    let alive = true;
    setFetched("loading");
    timetableRepo
      .getGoal(goalId, { withDeleted: true })
      .then((r) => {
        if (!alive) return;
        const g = r && r.deleted_at === null ? parseGoal(r, dayStartHour) : null;
        setFetched(g ?? "gone");
      })
      .catch(() => alive && setFetched("gone"));
    return () => {
      alive = false;
    };
  }, [goalId, listGoal, dayStartHour]);
  const goal = listGoal ?? (fetched !== null && typeof fetched === "object" ? fetched : null);
  const today = todayKey(dayStartHour);

  const blank = (): Form => ({ name: "", cats: [], kind: "repeat", rep: "week", startOn: today, endOn: "", startOpen: false, dir: "atLeast", h: 10, m: 0 });
  const formOf = (g: Goal): Form => {
    const k = kindOf(g.period);
    return {
      name: g.name,
      cats: g.categoryIds.slice(),
      kind: k,
      rep: k === "repeat" ? (g.period as Rep) : "week",
      startOn: g.startOn ?? today,
      endOn: g.endOn ?? "",
      startOpen: k === "until" && (g.startOn ?? today) !== today,
      dir: g.direction,
      h: Math.floor(g.targetMin / 60),
      m: g.targetMin % 60,
    };
  };
  const openOf = (cats: readonly string[]): Record<string, boolean> => {
    const o: Record<string, boolean> = {};
    for (const c of cats) {
      const p = catById[c]?.parent_id;
      if (p) o[p] = true; // D-時-65：有勾選子分類的那組自動展開
    }
    return o;
  };

  const [f, setFRaw] = useState<Form>(() => (goal ? formOf(goal) : blank()));
  /** 表單是用哪個目標填的（null＝空白）；目標晚到時補填一次 */
  const [filledFor, setFilledFor] = useState<string | null>(goal?.id ?? null);
  const dirty = useRef(false);
  const setF: typeof setFRaw = (v) => {
    dirty.current = true;
    setFRaw(v);
  };
  const set = (patch: Partial<Form>): void => setF((x) => ({ ...x, ...patch }));
  const [busy, setBusy] = useState(false);
  const [archOpen, setArchOpen] = useState(false);
  const [openTops, setOpenTops] = useState<Record<string, boolean>>(() => openOf(f.cats));
  // ⑥：荷札草稿（null＝沒動過，跟著目標現在綁的）
  const desk = useShell() === "desktop";
  const tagIndex = useTagStore((s) => s.index);
  useEffect(() => {
    const st = useTagStore.getState();
    if (!st.index && !st.loading) void st.loadIndex();
  }, []);
  const [tagDraft, setTagDraftRaw] = useState<string[] | null>(null);
  const setTagDraft = (names: string[]): void => {
    dirty.current = true;
    setTagDraftRaw(names);
  };
  const liveTagKeys: readonly string[] = goal
    ? tagIndex
      ? useTagStore.getState().keysOf(TT_TAG_GOAL, goal.id)
      : (goal.tagKeys ?? [])
    : [];
  const tagNames: string[] = tagDraft ?? liveTagKeys.map(tagNameOf);
  /** 存檔時帶不帶 tagNames：動過草稿、或荷札 index 載過（帶現值，免得只綁荷札的目標過不了驗證）；否則不帶＝不動荷札 */
  const tagsToSave: readonly string[] | undefined = tagDraft !== null || tagIndex ? tagNames : undefined;
  useEffect(() => {
    if (!goal || filledFor === goal.id || dirty.current) return;
    const next = formOf(goal);
    setFRaw(next);
    setOpenTops(openOf(next.cats));
    setFilledFor(goal.id);
    // formOf／openOf 只讀 today／catById：跟著 goal 換就夠
  }, [goal, filledFor]);

  // 分類樹：頂層（未刪除；封存的只在已勾時出現）＋底下子分類
  const tree = useMemo(() => {
    const alive = (c: TimeCategoryRow): boolean => c.deleted_at === null && (c.archived_at === null || f.cats.includes(c.id));
    const byPos = (a: TimeCategoryRow, b: TimeCategoryRow): number => a.position - b.position;
    const tops = categories.filter((c) => c.parent_id === null && alive(c)).sort(byPos);
    return tops.map((t) => ({ top: t, kids: categories.filter((c) => c.parent_id === t.id && alive(c)).sort(byPos) }));
    // f.cats 只影響「封存的已勾分類要不要列」：掛上與補填時各算一次就夠（避免勾掉後立刻消失）
  }, [categories, filledFor]);

  if (goalId && !goal) {
    const loading = fetched === "loading" || fetched === null;
    return (
      <div className="ns-tt-panel">
        <Sub>{loading ? T.loading : T.goalGone}</Sub>
      </div>
    );
  }

  const toggleCat = (id: string, on: boolean): void => {
    const isTop = (catById[id]?.parent_id ?? null) === null;
    setF((x) => {
      let cats = x.cats.filter((c) => c !== id);
      if (on) {
        if (isTop) cats = cats.filter((c) => catById[c]?.parent_id !== id); // 勾頂層＝整組；子分類不另存
        cats.push(id);
      }
      return { ...x, cats };
    });
  };

  const bad = problemOf(f, tagNames.length);
  const save = async (): Promise<void> => {
    if (bad || busy) return;
    setBusy(true);
    const input = inputOf(f, tagsToSave);
    const ok = goal ? await updateGoal(goal.id, input) : await createGoal(input);
    setBusy(false);
    if (ok) finish();
  };
  const run = async (fn: () => Promise<boolean>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    const ok = await fn();
    setBusy(false);
    if (ok) finish();
  };

  const kinds: readonly (readonly [Kind, string])[] = [
    ["repeat", T.kindRepeat],
    ["since", TT_TEXT.goalPeriodWord.since],
    ["until", TT_TEXT.goalPeriodWord.until],
    ["range", TT_TEXT.goalPeriodWord.range],
  ];
  /** 起訖日 chip（UI 丙-4 C5）：起日不設下限（可以從過去算起）；迄日 min＝起日 */
  const date = (field: "startOn" | "endOn", min?: string) => {
    const label = field === "startOn" ? T.fStart : T.fEnd;
    return (
      <DateChip
        className="ns-tt-goal-date"
        label={label}
        date={f[field] || null}
        min={min}
        allowPast={field === "startOn"}
        today={today}
        emptyText="挑日期…"
        onPick={(d) => {
          if (d) set({ [field]: d } as Partial<Form>);
        }}
      />
    );
  };
  const minuteChips = MINUTE_CHIPS.includes(f.m as (typeof MINUTE_CHIPS)[number]) ? MINUTE_CHIPS : [...MINUTE_CHIPS, f.m].sort((a, b) => a - b);

  return (
    <div className="ns-tt-panel ns-tt-goal-form">
      <Row k={T.fName}>
        <input
          className="ns-tt-input ns-tt-goal-name-in"
          value={f.name}
          maxLength={GOAL_NAME_MAX}
          placeholder={T.namePlaceholder}
          onChange={(e) => set({ name: e.target.value })}
          aria-label={T.fName}
        />
        <span className="ns-tt-goal-count ns-tt-num">
          {Array.from(f.name).length}/{GOAL_NAME_MAX}
        </span>
      </Row>
      <Row k={T.fCats} top>
        <div className="ns-tt-goal-tree">
          {tree.map(({ top, kids }) => {
            const topOn = f.cats.includes(top.id);
            const picked = kids.filter((k) => f.cats.includes(k.id)).length;
            const isOpen = !!openTops[top.id];
            return (
              <div key={top.id} className={"ns-tt-goal-tg" + (isOpen ? " is-open" : "")}>
                <div className="ns-tt-goal-tgh">
                  <label className="ns-tt-goal-ck is-grp">
                    <input type="checkbox" checked={topOn} onChange={(e) => toggleCat(top.id, e.target.checked)} />
                    <span className="ns-tt-goal-ckbox" aria-hidden="true" />
                    <b>{top.name}</b>
                    <small>{topOn ? T.groupWhole : picked ? T.groupPicked(picked) : ""}</small>
                  </label>
                  {kids.length > 0 && (
                    <button
                      type="button"
                      className="ns-tt-goal-tgx"
                      aria-expanded={isOpen}
                      aria-label={isOpen ? T.collapseKids : T.expandKids}
                      onClick={() => setOpenTops((o) => ({ ...o, [top.id]: !o[top.id] }))}
                    >
                      <i>›</i>
                    </button>
                  )}
                </div>
                {isOpen && (
                  <div className="ns-tt-goal-kids">
                    {kids.map((k) => (
                      <label key={k.id} className={"ns-tt-goal-ck" + (topOn ? " is-dis" : "")}>
                        <input type="checkbox" checked={topOn || f.cats.includes(k.id)} disabled={topOn} onChange={(e) => toggleCat(k.id, e.target.checked)} />
                        <span className="ns-tt-goal-ckbox" aria-hidden="true" />
                        <i className="ns-tt-stats-dot" style={{ "--c": catColor(k) } as CSSProperties} aria-hidden="true" />
                        {k.name}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Row>
      <div className="ns-tt-row is-top ns-tt-tagrow ns-tt-goal-tagrow">
        <span className="ns-tt-row-k">{TT_TEXT.tags.goalSection}</span>
        <span className="ns-tt-row-v">
          {desk ? (
            <div className="ns-tt-tagfield">
              <EntityTagField value={tagNames} onChange={setTagDraft} suggestInline resetKey={goalId ?? "new"} />
            </div>
          ) : (
            <MobileTagDraft fixed={[]} value={tagNames} onChange={setTagDraft} title={TT_TEXT.tags.pickerGoal} />
          )}
          <span className="ns-tt-tag-hint">{TT_TEXT.tags.goalTagHint}</span>
        </span>
      </div>
      <Row k={T.fPeriod}>
        <Segmented
          className="ns-tt-goal-kseg"
          aria-label={T.fPeriod}
          options={kinds.map(([value, label]) => ({ value, label }))}
          value={f.kind}
          onChange={(kind) => set({ kind })}
        />
      </Row>
      {f.kind === "repeat" && (
        <div className="ns-tt-row ns-tt-goal-subrow">
          <span className="ns-tt-row-k" />
          <span className="ns-tt-row-v">
            <Segmented
              compact
              aria-label={T.kindRepeat}
              options={(["day", "week", "month"] as const).map((r) => ({ value: r, label: TT_TEXT.goalPeriodWord[r] }))}
              value={f.rep}
              onChange={(rep) => set({ rep })}
            />
          </span>
        </div>
      )}
      {f.kind === "since" && (
        <div className="ns-tt-row ns-tt-goal-subrow">
          <span className="ns-tt-row-k">{T.fStart}</span>
          <span className="ns-tt-row-v">
            {date("startOn")}
            <span className="ns-tt-goal-hint">{T.hintSince}</span>
          </span>
        </div>
      )}
      {f.kind === "until" && (
        <>
          <div className="ns-tt-row ns-tt-goal-subrow">
            <span className="ns-tt-row-k">{T.fEnd}</span>
            <span className="ns-tt-row-v">
              {date("endOn", f.startOn)}
              <span className="ns-tt-goal-hint">{T.hintUntil}</span>
            </span>
          </div>
          {f.startOpen ? (
            <div className="ns-tt-row ns-tt-goal-subrow">
              <span className="ns-tt-row-k">{T.fStart}</span>
              <span className="ns-tt-row-v">
                {date("startOn")}
                <span className="ns-tt-goal-hint">{T.hintStartDefault}</span>
              </span>
            </div>
          ) : (
            <div className="ns-tt-goal-startlink">
              <button type="button" className="ns-tt-goal-link" onClick={() => set({ startOpen: true })}>
                {T.startLink(f.startOn ? md(f.startOn) : "？")}
              </button>
            </div>
          )}
        </>
      )}
      {f.kind === "range" && (
        <div className="ns-tt-row ns-tt-goal-subrow">
          <span className="ns-tt-row-k">{T.fRange}</span>
          <span className="ns-tt-row-v">
            {date("startOn")}
            <span className="ns-tt-goal-dash">–</span>
            {date("endOn", f.startOn)}
          </span>
        </div>
      )}
      <Row k={T.fDir}>
        <Segmented
          aria-label={T.fDir}
          options={(["atLeast", "atMost"] as const).map((d) => ({ value: d, label: TT_TEXT.goalDirectionWord[d] }))}
          value={f.dir}
          onChange={(dir) => set({ dir })}
        />
      </Row>
      <Row k={T.fHours}>
        <span className="ns-tt-stepper" role="group" aria-label={T.fHours}>
          {[-10, -1].map((d) => (
            <button type="button" key={d} className="ns-tt-step" disabled={f.h + d < 0} aria-label={T.hoursDown(-d)} onClick={() => setF((x) => ({ ...x, h: Math.max(0, x.h + d) }))}>
              −{-d}
            </button>
          ))}
          <span className="ns-tt-val ns-tt-goal-hval" aria-live="polite">
            {f.h}
            <small>{T.hourUnit}</small>
          </span>
          {[1, 10].map((d) => (
            <button type="button" key={d} className="ns-tt-step" disabled={f.h + d > 999} aria-label={T.hoursUp(d)} onClick={() => setF((x) => ({ ...x, h: Math.min(999, x.h + d) }))}>
              +{d}
            </button>
          ))}
        </span>
        <Opts>
          {minuteChips.map((m) => (
            <Opt key={m} on={f.m === m} onClick={() => set({ m })}>
              {T.minutes(m)}
            </Opt>
          ))}
        </Opts>
      </Row>
      <p className="ns-tt-goal-preview">
        {bad ? <span className="ns-tt-goal-warn">{bad}</span> : `${goalPeriodText(inputOf(f))}・${scopeText(f.cats, catById, tagNames)}`}
      </p>
      <Actions>
        {goal && (
          <>
            <button type="button" className="ns-btn btn-ghost is-aux" disabled={busy} onClick={() => void run(() => archiveGoal(goal.id, true))}>
              {T.archive}
            </button>
            <button type="button" className="ns-btn btn-ghost ns-btn-danger is-aux" disabled={busy} onClick={() => void run(() => deleteGoal(goal.id))}>
              {T.remove}
            </button>
          </>
        )}
        <button type="button" className="ns-btn btn-ghost" disabled={busy} onClick={finish}>
          取消
        </button>
        <button type="button" className="ns-btn btn-seal" disabled={!!bad || busy} onClick={() => void save()}>
          {T.save}
        </button>
      </Actions>
      {archived.length > 0 && !fromGoalsTab && (
        <div className={"ns-tt-goal-arch" + (archOpen ? " is-open" : "")}>
          <button type="button" className="ns-tt-goal-arch-h" aria-expanded={archOpen} onClick={() => setArchOpen((x) => !x)}>
            {T.archivedList(archived.length)}
            <i aria-hidden="true">›</i>
          </button>
          {archOpen &&
            archived.map((g) => (
              <div key={g.id} className="ns-tt-goal-arch-row">
                <span>
                  <b>{g.name}</b>
                  <small>
                    {goalPeriodText(g)}・{scopeText(g.categoryIds, catById, (g.tagKeys ?? []).map(tagNameOf))}
                  </small>
                </span>
                <button type="button" className="ns-btn btn-ghost ns-btn--sm" disabled={busy} onClick={() => void archiveGoal(g.id, false)}>
                  {T.restore}
                </button>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
