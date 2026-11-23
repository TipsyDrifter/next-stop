/**
 * 寫方針・行路企劃書工作台（戊 D-主-261；辛 §7；回饋專卷 D-FB-6：討論 4 ＋ 畫面 1）。
 *
 * 三種視窗形態共用同一套多期間草稿帳本（`WorkbenchLedger`）：
 *   1. 桌機「年／月／週」展開式三欄同屏工作台（`DialogShell width={1140}`）：
 *      左欄「今年方針」｜中欄「本月方針」｜右欄「本週方針」並排對照，三欄皆可直接打字、掛路線、獨立翻閱 `‹ 期 ›`；
 *      左／中欄每句附「帶入本月 ›」「帶入本週 ›」一鍵跨尺度引流（剛打字尚未存檔的新句亦能即時帶入下層！），
 *      各欄下方保留「上一期沒済的」一鍵帶入；底部「存檔」依「年 → 月 → 週」順序一次寫入所有有異動的期間。
 *   2. 桌機「車站方針」雙欄規劃窗（`DialogShell width={760}`）：
 *      左欄編輯本站方針，右欄並排對照「今年方針／本月方針」並支援一鍵「帶入本站」。
 *   3. 手機全螢幕面板（`MSheet height="full"`）：
 *      頂部「今年｜本月｜本週」分頁共用同一份記憶體草稿帳本（切分頁或翻期絕不丟草稿），搭配可收合的上層方針參照與上一期未済引流。
 *
 * 討論 4（方針掛路線一鍵秒選 ＋ 寬敞幹線分組選單）：
 *   - 方針掛載挑選器收斂為 `depth="route"`，點任一路線一鍵秒選、不再鑽支線；輸入 `@` 同樣直接補完依幹線分組的路線。
 *   - 桌機路線選單以 `createPortal(..., document.body)` 寬幅浮層（`368px × 410px`）錨定於按鈕旁，徹底擺脫欄內裁切與 5 列窄框。
 *   - 句子輸入框升級自動增高多行 `<textarea>`（`Enter` 移至下一句、`Shift+Enter` 換行、`Ctrl/⌘+Enter` 存檔）。
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import {
  AIM_TEXT_MAX,
  MAX_AIMS,
  adjacentKey,
  aimLimitMessage,
  aimNumeral,
  carryCandidates,
  currentKeyOf,
  doneCount,
  normalizeAimText,
  periodNavText,
  periodOfKey,
  periodOverline,
  periodShortLabel,
  periodStepText,
  periodTitle,
  stationHeadText,
  stationIdOfKey,
  upperKeyOf,
  type AimDraft,
  type ReviewPeriod,
  type WeekAimRow,
} from "../../domain/weekAims";
import type { NodeRow } from "../../domain";
import type { AttachTarget } from "../../domain/notes";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { useWeekAimStore } from "../../store/weekAimStore";
import { DialogShell } from "../common/DialogShell";
import { MSheet } from "../common/MSheet";
import { AttachPicker } from "../common/AttachPicker";
import { MobileAttachPicker } from "../common/MobileAttachPicker";
import { IconBack, IconChevron, IconClose, IconPlus } from "../common/icons";
import { useQuickSuggest } from "../common/quickadd/useQuickSuggest";
import { useShell } from "../mobile/useShell";
import {
  carryDraftAcrossColumns,
  carryRowIntoLedger,
  dirtyPeriodKeys,
  draftsOfAims,
  flowTargetShort,
  isPeriodDirty,
  nonEmptyAimCount,
  pickTargetOfRoute,
  resolveInitialWorkbenchKeys,
  type WorkbenchLedger,
} from "./aimWorkbenchModel";
import {
  IconCheckMini,
  RouteMark,
  RouteTag,
  StationMark,
  aimPlaceName,
  aimPlacePath,
  useAimPlaceOf,
  type AimPlace,
} from "./parts";
import "../common/quickadd/quickadd.css";

const EMPTY: WeekAimRow[] = [];
const SCALES: readonly ReviewPeriod[] = ["year", "month", "week"];

const SCALE_BADGE: Record<ReviewPeriod, { zh: string; latin: string }> = {
  year: { zh: "年度羅盤", latin: "YEAR" },
  month: { zh: "月間進路", latin: "MONTH" },
  week: { zh: "本週行路", latin: "WEEK" },
};

/** 掛著的 host，照掛上的先後排：只有排第一的那個畫（同頁可能有告示又有車站小卡，寫方針框任何時候只能有一個） */
const hostQueue: object[] = [];
const hostListeners = new Set<() => void>();

function useIsFirstHost(): boolean {
  const [me] = useState(() => ({}));
  useLayoutEffect(() => {
    hostQueue.push(me);
    hostListeners.forEach((fn) => fn());
    return () => {
      hostQueue.splice(hostQueue.indexOf(me), 1);
      hostListeners.forEach((fn) => fn());
    };
  }, [me]);
  return useSyncExternalStore(
    (fn) => {
      hostListeners.add(fn);
      return () => hostListeners.delete(fn);
    },
    () => hostQueue[0] === me,
  );
}

/**
 * 掛在帶子裡、畫到 body（帶子是 z-index 疊放脈絡，fixed 的對話框困在裡面會被別的東西壓住）。
 * portal 的 React 事件仍會冒到頁面（今日頁的鍵盤表）：Esc 以外的鍵在這裡截住——Esc 要留給殼掛在 window 的關窗。
 */
export function WeekAimsEditorHost({ today, weekStart }: { today: string; weekStart: 0 | 1 }) {
  const editor = useWeekAimStore((s) => s.editor);
  const first = useIsFirstHost();
  const stationId = editor ? stationIdOfKey(editor.weekOn) : null;
  const stationGone = useNodeStore((s) => stationId !== null && !s.stations.some((x) => x.id === stationId));
  useEffect(() => {
    if (stationGone) useWeekAimStore.getState().closeEditor();
  }, [stationGone]);
  if (!editor || !first || stationGone) return null;
  return createPortal(
    <div
      className="wa-ed-host"
      onKeyDown={(e) => {
        if (e.key !== "Escape") e.stopPropagation();
      }}
    >
      <WeekAimsEditor
        key={editor.weekOn}
        aimKey={editor.weekOn}
        preCarry={editor.preCarry}
        today={today}
        weekStart={weekStart}
      />
    </div>,
    document.body,
  );
}

interface PickState {
  periodKey: string;
  rowIndex: number;
  anchorEl: HTMLElement | null;
}

function WeekAimsEditor({
  aimKey: initialKey,
  preCarry,
  today,
  weekStart,
}: {
  aimKey: string;
  preCarry: readonly WeekAimRow[];
  today: string;
  weekStart: 0 | 1;
}) {
  const mobile = useShell() === "mobile";
  const isStation = periodOfKey(initialKey) === "station";

  const initKeys = useMemo(
    () => resolveInitialWorkbenchKeys(initialKey, today, weekStart),
    [initialKey, today, weekStart],
  );
  const [colKeys, setColKeys] = useState<Record<ReviewPeriod, string>>({
    year: initKeys.yearKey,
    month: initKeys.monthKey,
    week: initKeys.weekKey,
  });
  const [focusScale, setFocusScale] = useState<ReviewPeriod>(initKeys.focusScale);

  // 車站模式也同時載入今年與本月方針作為參照
  const curYearKey = useMemo(() => currentKeyOf("year", today, weekStart), [today, weekStart]);
  const curMonthKey = useMemo(() => currentKeyOf("month", today, weekStart), [today, weekStart]);

  const activeKeys = useMemo(
    () =>
      isStation
        ? [initialKey, curYearKey, curMonthKey]
        : [colKeys.year, colKeys.month, colKeys.week],
    [isStation, initialKey, curYearKey, curMonthKey, colKeys.year, colKeys.month, colKeys.week],
  );

  const weeksMap = useWeekAimStore((s) => s.weeks);
  const stationId = stationIdOfKey(initialKey);
  const station = useNodeStore((s) => (stationId ? (s.stations.find((x) => x.id === stationId) ?? null) : null));
  const placeOf = useAimPlaceOf();

  const resolveRouteId = useCallback(
    (nodeId: string | null): string | null => {
      if (!nodeId) return null;
      return placeOf(nodeId)?.route.id ?? nodeId;
    },
    [placeOf],
  );

  const [ledger, setLedger] = useState<WorkbenchLedger>({});
  const [pickState, setPickState] = useState<PickState | null>(null);
  const [saving, setSaving] = useState(false);
  const [mobileRefOpen, setMobileRefOpen] = useState(true);
  const pendingCarry = useRef<readonly WeekAimRow[]>(preCarry);
  const inputRefs = useRef<Record<string, (HTMLTextAreaElement | null)[]>>({});

  // 載入所有需要顯示與對照的期間（loadWeek 同時載入週／月／年的上一期）
  useEffect(() => {
    const st = useWeekAimStore.getState();
    for (const k of activeKeys) {
      void st.loadWeek(k);
    }
  }, [activeKeys]);

  // 當 store 的期間列載入完成、且帳本裡尚未建檔時，建立該期間的 { drafts, base }
  useEffect(() => {
    const missing = activeKeys.filter((k) => weeksMap[k] !== undefined && ledger[k] === undefined);
    if (!missing.length) return;

    setLedger((prev) => {
      const next = { ...prev };
      for (const k of missing) {
        if (next[k] !== undefined) continue;
        const rows = weeksMap[k] ?? EMPTY;
        const start = draftsOfAims(rows);
        next[k] = { drafts: start, base: start };
      }
      return next;
    });

    if (missing.includes(initialKey) && pendingCarry.current.length > 0) {
      const toCarry = pendingCarry.current;
      pendingCarry.current = [];
      void (async () => {
        const st = useWeekAimStore.getState();
        const add: AimDraft[] = [];
        for (const src of toCarry) {
          const d = await st.carryDraft(src, initialKey);
          add.push({ ...d, nodeId: resolveRouteId(d.nodeId) });
        }
        setLedger((prev) => {
          const entry = prev[initialKey];
          if (!entry) return prev;
          const have = new Set(entry.drafts.map((x) => x.carriedFrom).filter(Boolean));
          const merged = [...entry.drafts];
          for (const d of add) {
            if (have.has(d.carriedFrom) || nonEmptyAimCount(merged) >= MAX_AIMS) continue;
            have.add(d.carriedFrom);
            merged.push(d);
          }
          return { ...prev, [initialKey]: { ...entry, drafts: merged } };
        });
      })();
    }
  }, [activeKeys, weeksMap, ledger, initialKey, resolveRouteId]);

  const dirtyKeys = useMemo(() => dirtyPeriodKeys(ledger), [ledger]);

  const close = useCallback(() => {
    setPickState(null);
    useWeekAimStore.getState().closeEditor();
  }, []);

  const handleShellClose = useCallback(() => {
    if (pickState !== null) {
      setPickState(null);
      return;
    }
    close();
  }, [pickState, close]);

  const saveAll = useCallback(async () => {
    if (saving) return;
    const keysToSave = dirtyPeriodKeys(ledger);
    if (keysToSave.length === 0) {
      close();
      return;
    }
    setSaving(true);
    const st = useWeekAimStore.getState();
    const savedKeys: string[] = [];
    let allOk = true;

    for (const k of keysToSave) {
      const entry = ledger[k];
      if (!entry) continue;
      const ok = await st.saveWeek(k, entry.drafts, entry.base);
      if (!ok) {
        allOk = false;
        const p = periodOfKey(k);
        if (p !== "station") setFocusScale(p);
        break;
      }
      savedKeys.push(k);
    }

    if (savedKeys.length > 0 && !allOk) {
      const freshWeeks = useWeekAimStore.getState().weeks;
      setLedger((prev) => {
        const next = { ...prev };
        for (const k of savedKeys) {
          const fresh = draftsOfAims(freshWeeks[k] ?? EMPTY);
          next[k] = { drafts: fresh, base: fresh };
        }
        return next;
      });
    }

    setSaving(false);
    if (allOk) {
      if (!isStation && st.todayPick !== "ideal") {
        st.setTodayPick(focusScale);
      }
      close();
    }
  }, [saving, ledger, close, isStation, focusScale]);

  const patchDraft = useCallback((periodKey: string, index: number, patch: Partial<AimDraft>) => {
    setLedger((prev) => {
      const entry = prev[periodKey];
      if (!entry) return prev;
      const nextDrafts = [...entry.drafts];
      if (index >= nextDrafts.length) {
        nextDrafts.push({ id: null, text: "", nodeId: null, carriedFrom: null, ...patch });
      } else {
        nextDrafts[index] = { ...nextDrafts[index], ...patch };
      }
      return { ...prev, [periodKey]: { ...entry, drafts: nextDrafts } };
    });
  }, []);

  const removeDraft = useCallback((periodKey: string, index: number) => {
    setPickState((cur) => (cur?.periodKey === periodKey && cur.rowIndex === index ? null : cur));
    setLedger((prev) => {
      const entry = prev[periodKey];
      if (!entry) return prev;
      return {
        ...prev,
        [periodKey]: {
          ...entry,
          drafts: entry.drafts.filter((_, j) => j !== index),
        },
      };
    });
  }, []);

  const pickRouteForRow = useCallback(
    (periodKey: string, rowIndex: number, t: AttachTarget) => {
      setPickState(null);
      patchDraft(periodKey, rowIndex, { nodeId: t.routeId ?? null });
    },
    [patchDraft],
  );

  const shiftColumnPeriod = useCallback((scale: ReviewPeriod, dir: -1 | 1) => {
    setPickState(null);
    setFocusScale(scale);
    setColKeys((prev) => ({
      ...prev,
      [scale]: adjacentKey(prev[scale], dir),
    }));
  }, []);

  /** 跨欄引流（左欄今年 → 中欄本月、中欄本月 → 右欄本週，或手機上層草稿 → 本層） */
  const handleFlowAcross = useCallback(
    async (sourceKey: string, sourceIndex: number, targetKey: string) => {
      const res = await carryDraftAcrossColumns({
        ledger,
        sourceKey,
        sourceIndex,
        targetKey,
        resolveRouteId,
      });
      if (res.status === "target_full") {
        useUiStore.getState().showToast({ message: aimLimitMessage(targetKey) });
        return;
      }
      if (res.status === "carried" || res.ledger !== ledger) {
        setLedger(res.ledger);
      }
    },
    [ledger, resolveRouteId],
  );

  /** 已落庫方針列（上一期未済／車站右側年與月參照）帶入目標期間 */
  const handleCarrySavedRow = useCallback(
    async (srcRow: WeekAimRow, targetKey: string) => {
      const res = await carryRowIntoLedger({
        ledger,
        srcRow,
        targetKey,
        resolveRouteId,
      });
      if (res.status === "target_full") {
        useUiStore.getState().showToast({ message: aimLimitMessage(targetKey) });
        return;
      }
      if (res.status === "carried") {
        setLedger(res.ledger);
      }
    },
    [ledger, resolveRouteId],
  );

  /** 查詢某句 `carriedFrom` 的來源短標（支援剛在上層欄打字尚未存檔的新句！） */
  const resolveOriginLabel = useCallback(
    (periodKey: string, carriedFrom: string | null): string | null => {
      if (!carriedFrom) return null;
      const p = periodOfKey(periodKey);
      if (p !== "station") {
        const prevK = adjacentKey(periodKey, -1);
        if ((weeksMap[prevK] ?? EMPTY).some((a) => a.id === carriedFrom)) {
          return periodTitle(prevK, today, weekStart).rel;
        }
        const upK =
          p === "week"
            ? colKeys.month
            : p === "month"
              ? colKeys.year
              : upperKeyOf(periodKey, today);
        const stdUpK = upperKeyOf(periodKey, today);
        for (const candidateKey of [upK, stdUpK]) {
          if (!candidateKey) continue;
          const inDrafts = ledger[candidateKey]?.drafts.some((d) => d.id === carriedFrom);
          const inSaved = (weeksMap[candidateKey] ?? EMPTY).some((a) => a.id === carriedFrom);
          if (inDrafts || inSaved) {
            return periodShortLabel(candidateKey, today, weekStart);
          }
        }
        return null;
      }
      // 車站：可能來自今年、本月或上一站
      if (
        ledger[curYearKey]?.drafts.some((d) => d.id === carriedFrom) ||
        (weeksMap[curYearKey] ?? EMPTY).some((a) => a.id === carriedFrom)
      ) {
        return periodShortLabel(curYearKey, today, weekStart);
      }
      if (
        ledger[curMonthKey]?.drafts.some((d) => d.id === carriedFrom) ||
        (weeksMap[curMonthKey] ?? EMPTY).some((a) => a.id === carriedFrom)
      ) {
        return periodShortLabel(curMonthKey, today, weekStart);
      }
      return "上一站";
    },
    [weeksMap, ledger, today, weekStart, colKeys.month, colKeys.year, curYearKey, curMonthKey],
  );

  const registerInputRef = useCallback((periodKey: string, idx: number, el: HTMLTextAreaElement | null) => {
    const arr = inputRefs.current[periodKey] ?? (inputRefs.current[periodKey] = []);
    arr[idx] = el;
  }, []);

  const handleRowEnter = useCallback(
    (periodKey: string, idx: number) => {
      const arr = inputRefs.current[periodKey] ?? [];
      const nextEl = arr[idx + 1];
      if (nextEl) {
        nextEl.focus();
        return;
      }
      // 若本欄已滿五句且在三欄工作台，順勢跳往下一尺度首句；否則若無處可跳則存檔
      if (!mobile && !isStation) {
        const p = periodOfKey(periodKey);
        const nextScale: ReviewPeriod | null = p === "year" ? "month" : p === "month" ? "week" : null;
        if (nextScale) {
          setFocusScale(nextScale);
          const nextColInput = inputRefs.current[colKeys[nextScale]]?.[0];
          if (nextColInput) {
            nextColInput.focus();
            return;
          }
        }
      }
    },
    [mobile, isStation, colKeys],
  );

  // 目前開啟挑選器那一列的關聯路線值
  const pickingDraft =
    pickState !== null ? (ledger[pickState.periodKey]?.drafts[pickState.rowIndex] ?? null) : null;
  const pickingPlace = pickTargetOfRoute(resolveRouteId(pickingDraft?.nodeId ?? null));

  const readyCount = activeKeys.filter((k) => ledger[k] !== undefined).length;
  const anyReady = readyCount > 0;

  const foot = (
    <>
      {!mobile && (
        <span className="wa-wb-foothint">
          打 <kbd className="ns-kbd">@</kbd> 秒掛路線 · <kbd className="ns-kbd">Enter</kbd> 下一句 ·{" "}
          <span className="ns-kbd-seq">
            <kbd className="ns-kbd">Shift</kbd>
            <span className="ns-kbd-plus">+</span>
            <kbd className="ns-kbd">Enter</kbd>
          </span>{" "}
          換行 ·{" "}
          <span className="ns-kbd-seq">
            <kbd className="ns-kbd">Ctrl</kbd>
            <span className="ns-kbd-plus">+</span>
            <kbd className="ns-kbd">Enter</kbd>
          </span>{" "}
          存檔
          {dirtyKeys.length > 1 && <b className="wa-wb-dirtycount">（{dirtyKeys.length} 期已修改）</b>}
        </span>
      )}
      <button type="button" className="ns-btn btn-ghost" onClick={close}>
        取消
      </button>
      <button type="button" className="ns-btn btn-seal" disabled={!anyReady || saving} onClick={() => void saveAll()}>
        {dirtyKeys.length > 1 ? `存檔（${dirtyKeys.length} 期）` : "存檔"}
      </button>
    </>
  );

  /* ═══════════ 手機全螢幕面板（MSheet full） ═══════════ */
  if (mobile) {
    const mobileActiveKey = isStation ? initialKey : colKeys[focusScale];
    const mobileEntry = ledger[mobileActiveKey];
    const mobileHead = periodTitle(mobileActiveKey, today, weekStart);
    const mobileStep = periodStepText(mobileActiveKey);
    const mobileUpperScale: ReviewPeriod | null = isStation
      ? null
      : focusScale === "week"
        ? "month"
        : focusScale === "month"
          ? "year"
          : null;
    const mobileUpperKey = mobileUpperScale ? colKeys[mobileUpperScale] : null;
    const mobileUpperDrafts = mobileUpperKey ? (ledger[mobileUpperKey]?.drafts ?? []) : [];
    const mobilePrevKey = isStation ? null : adjacentKey(mobileActiveKey, -1);
    const mobilePrevCandidates = carryCandidates(mobilePrevKey ? (weeksMap[mobilePrevKey] ?? EMPTY) : EMPTY);
    const mobileCarriedIds = new Set(
      (mobileEntry?.drafts ?? []).map((d) => d.carriedFrom).filter(Boolean) as string[],
    );

    const mTitle = isStation ? `${stationHeadText(station)}的方針` : "行路企劃書";
    const mOverline = isStation ? periodOverline(initialKey).zh : `${mobileHead.rel} · 方針工作台`;

    return (
      <MSheet
        title={mTitle}
        overline={mOverline}
        height="full"
        onClose={close}
        foot={foot}
        className="wa-ms wa-ms-ed"
      >
        <div className="wa-ed-top">
          {!isStation ? (
            <>
              <div className="wa-tabs" role="tablist" aria-label="方針尺度">
                {SCALES.map((scale) => {
                  const k = colKeys[scale];
                  const dirty = isPeriodDirty(ledger[k]);
                  const lbl = scale === "year" ? "今年" : scale === "month" ? "本月" : "本週";
                  return (
                    <button
                      key={scale}
                      type="button"
                      role="tab"
                      aria-selected={focusScale === scale}
                      className={"wa-tab" + (focusScale === scale ? " on" : "")}
                      disabled={saving}
                      onClick={() => {
                        setPickState(null);
                        setFocusScale(scale);
                      }}
                    >
                      {lbl}
                      {dirty && <span className="wa-dirty-dot" aria-label="未存變更" />}
                    </button>
                  );
                })}
              </div>
              <div className="wa-ed-week">
                <button
                  type="button"
                  className="ns-iconbtn"
                  aria-label={mobileStep.prev}
                  title={mobileStep.prev}
                  onClick={() => shiftColumnPeriod(focusScale, -1)}
                >
                  <IconBack />
                </button>
                <span className="t">{periodNavText(mobileActiveKey)}</span>
                <button
                  type="button"
                  className="ns-iconbtn"
                  aria-label={mobileStep.next}
                  title={mobileStep.next}
                  onClick={() => shiftColumnPeriod(focusScale, 1)}
                >
                  <IconChevron />
                </button>
              </div>
            </>
          ) : (
            <div className="wa-ed-week">
              <span className="t is-station">
                <StationMark /> {stationHeadText(station)}
              </span>
            </div>
          )}
        </div>

        <AimColumnEditorList
          periodKey={mobileActiveKey}
          relLabel={mobileHead.rel}
          entry={mobileEntry}
          savedRows={weeksMap[mobileActiveKey] ?? EMPTY}
          mobile
          autoFocusFirst={false}
          flowTargetKey={null}
          flowTargetLabel={null}
          flowTargetCarriedIds={null}
          pickState={pickState}
          placeOf={placeOf}
          resolveOriginLabel={resolveOriginLabel}
          onFocusColumn={() => undefined}
          onRegisterInput={registerInputRef}
          onPatch={patchDraft}
          onRemove={removeDraft}
          onOpenPicker={(rowIndex, anchorEl) =>
            setPickState((cur) =>
              cur?.periodKey === mobileActiveKey && cur.rowIndex === rowIndex
                ? null
                : { periodKey: mobileActiveKey, rowIndex, anchorEl },
            )
          }
          onFlowRow={() => undefined}
          onEnterRow={(idx) => handleRowEnter(mobileActiveKey, idx)}
          onSaveAll={() => void saveAll()}
        />

        {/* 手機可收合上層參照（本月看今年、本週看本月；直接讀即時草稿，剛打的未存方針也能一鍵帶入！） */}
        {mobileUpperKey && mobileUpperDrafts.some((d) => normalizeAimText(d.text) !== "") && (
          <div className="wa-ed-sec wa-m-upper">
            <button
              type="button"
              className="wa-m-upper-toggle"
              aria-expanded={mobileRefOpen}
              onClick={() => setMobileRefOpen((v) => !v)}
            >
              <h4>{periodTitle(mobileUpperKey, today, weekStart).title}（可一鍵帶入）</h4>
              <span className={"wa-m-upper-chev" + (mobileRefOpen ? " is-open" : "")} aria-hidden>
                <IconChevron size={12} />
              </span>
            </button>
            {mobileRefOpen &&
              mobileUpperDrafts.map((d, idx) => {
                const txt = normalizeAimText(d.text);
                if (!txt) return null;
                const place = placeOf(d.nodeId);
                const already = d.id !== null && mobileCarriedIds.has(d.id);
                const savedDone =
                  d.id !== null && (weeksMap[mobileUpperKey] ?? EMPTY).some((a) => a.id === d.id && a.done_at !== null);
                return (
                  <div key={d.id ?? `up-${idx}`} className={"wa-ed-carry" + (already ? " is-carried" : "")}>
                    <span className="t">{txt}</span>
                    {place && <RouteTag place={place} shell="mobile" onGo={close} />}
                    {already ? (
                      <span className="done">
                        <IconCheckMini />
                        已帶進來
                      </span>
                    ) : savedDone ? (
                      <span className="done">已済</span>
                    ) : (
                      <button
                        type="button"
                        className="ns-btn btn-ghost ns-btn--sm"
                        disabled={!mobileEntry}
                        onClick={() => void handleFlowAcross(mobileUpperKey, idx, mobileActiveKey)}
                      >
                        帶進來
                      </button>
                    )}
                  </div>
                );
              })}
          </div>
        )}

        {/* 手機車站模式：參照今年與本月方針 */}
        {isStation && (
          <StationHorizonReference
            stationKey={initialKey}
            yearKey={curYearKey}
            monthKey={curMonthKey}
            yearRows={weeksMap[curYearKey] ?? EMPTY}
            monthRows={weeksMap[curMonthKey] ?? EMPTY}
            carriedIds={mobileCarriedIds}
            disabled={!mobileEntry}
            shell="mobile"
            placeOf={placeOf}
            onCarry={(row) => void handleCarrySavedRow(row, initialKey)}
            onGoRoute={close}
          />
        )}

        {mobilePrevKey && mobilePrevCandidates.length > 0 && (
          <PrevUncompletedSection
            prevRel={periodTitle(mobilePrevKey, today, weekStart).rel}
            targetRel={mobileHead.rel}
            candidates={mobilePrevCandidates}
            carriedIds={mobileCarriedIds}
            disabled={!mobileEntry}
            shell="mobile"
            placeOf={placeOf}
            onCarry={(row) => void handleCarrySavedRow(row, mobileActiveKey)}
            onGoRoute={close}
          />
        )}

        {pickState !== null && (
          <MobileAttachPicker
            title="掛到哪條路線"
            depth="route"
            backKind="dialog"
            value={pickingPlace}
            onPick={(t) => pickRouteForRow(pickState.periodKey, pickState.rowIndex, t)}
            onClear={() => {
              const { periodKey, rowIndex } = pickState;
              setPickState(null);
              patchDraft(periodKey, rowIndex, { nodeId: null });
            }}
            clearLabel="不掛路線"
            onClose={() => setPickState(null)}
          />
        )}
      </MSheet>
    );
  }

  /* ═══════════ 桌機「車站方針」雙欄對照對話框（width={760}） ═══════════ */
  if (isStation) {
    const stEntry = ledger[initialKey];
    const stCarriedIds = new Set(
      (stEntry?.drafts ?? []).map((d) => d.carriedFrom).filter(Boolean) as string[],
    );
    return (
      <>
        <DialogShell
          title={`${stationHeadText(station)} · 車站方針`}
          overline={periodOverline(initialKey)}
          width={760}
          topClass="pt-[8vh]"
          onClose={handleShellClose}
          foot={foot}
        >
          <div className="wa-stn-wb">
            <div className="wa-stn-main">
              <div className="wa-stn-head">
                <StationMark size={14} />
                <span className="nm">{stationHeadText(station)}</span>
                <span className="cap">最多 {MAX_AIMS} 句</span>
              </div>
              <AimColumnEditorList
                periodKey={initialKey}
                relLabel="這一站"
                entry={stEntry}
                savedRows={weeksMap[initialKey] ?? EMPTY}
                mobile={false}
                autoFocusFirst
                flowTargetKey={null}
                flowTargetLabel={null}
                flowTargetCarriedIds={null}
                pickState={pickState}
                placeOf={placeOf}
                resolveOriginLabel={resolveOriginLabel}
                onFocusColumn={() => undefined}
                onRegisterInput={registerInputRef}
                onPatch={patchDraft}
                onRemove={removeDraft}
                onOpenPicker={(rowIndex, anchorEl) =>
                  setPickState((cur) =>
                    cur?.periodKey === initialKey && cur.rowIndex === rowIndex
                      ? null
                      : { periodKey: initialKey, rowIndex, anchorEl },
                  )
                }
                onFlowRow={() => undefined}
                onEnterRow={(idx) => handleRowEnter(initialKey, idx)}
                onSaveAll={() => void saveAll()}
              />
            </div>
            <aside className="wa-stn-ref" aria-label="今年與本月方針參照">
              <StationHorizonReference
                stationKey={initialKey}
                yearKey={curYearKey}
                monthKey={curMonthKey}
                yearRows={weeksMap[curYearKey] ?? EMPTY}
                monthRows={weeksMap[curMonthKey] ?? EMPTY}
                carriedIds={stCarriedIds}
                disabled={!stEntry}
                shell="desktop"
                placeOf={placeOf}
                onCarry={(row) => void handleCarrySavedRow(row, initialKey)}
                onGoRoute={close}
              />
            </aside>
          </div>
        </DialogShell>
        {pickState !== null && (
          <AnchoredRoutePicker
            anchorEl={pickState.anchorEl}
            value={pickingPlace}
            onPick={(t) => pickRouteForRow(pickState.periodKey, pickState.rowIndex, t)}
            onClear={() => {
              const { periodKey, rowIndex } = pickState;
              setPickState(null);
              patchDraft(periodKey, rowIndex, { nodeId: null });
            }}
            onClose={() => setPickState(null)}
          />
        )}
      </>
    );
  }

  /* ═══════════ 桌機寬幅展開式「行路企劃書」三欄同屏對照工作台（width={1140}） ═══════════ */
  const monthTargetShort = flowTargetShort(colKeys.month, today, weekStart);
  const weekTargetShort = flowTargetShort(colKeys.week, today, weekStart);
  const monthCarriedSet = new Set(
    (ledger[colKeys.month]?.drafts ?? []).map((d) => d.carriedFrom).filter(Boolean) as string[],
  );
  const weekCarriedSet = new Set(
    (ledger[colKeys.week]?.drafts ?? []).map((d) => d.carriedFrom).filter(Boolean) as string[],
  );

  return (
    <>
      <DialogShell
        title="今年 · 本月 · 本週方針"
        overline={{ zh: "行路企劃書", latin: "Horizon & Route Plan" }}
        width={1140}
        topClass="pt-[5vh]"
        onClose={handleShellClose}
        foot={foot}
      >
        <div className="wa-wb-grid" role="region" aria-label="三尺度方針同屏工作台">
          {SCALES.map((scale) => {
            const periodKey = colKeys[scale];
            const entry = ledger[periodKey];
            const savedRows = weeksMap[periodKey] ?? EMPTY;
            const head = periodTitle(periodKey, today, weekStart);
            const step = periodStepText(periodKey);
            const badge = SCALE_BADGE[scale];
            const isFocus = focusScale === scale;
            const dirty = isPeriodDirty(entry);
            const prevKey = adjacentKey(periodKey, -1);
            const prevCandidates = carryCandidates(weeksMap[prevKey] ?? EMPTY);
            const colCarriedIds = new Set(
              (entry?.drafts ?? []).map((d) => d.carriedFrom).filter(Boolean) as string[],
            );
            const { done: doneN, total: savedTotal } = doneCount(savedRows);

            const flowTargetKey = scale === "year" ? colKeys.month : scale === "month" ? colKeys.week : null;
            const flowTargetLabel =
              scale === "year" ? monthTargetShort : scale === "month" ? weekTargetShort : null;
            const flowTargetCarriedIds =
              scale === "year" ? monthCarriedSet : scale === "month" ? weekCarriedSet : null;

            return (
              <section
                key={scale}
                className={"wa-wb-col" + (isFocus ? " is-focus" : "")}
                aria-label={head.title}
                onMouseDown={() => {
                  if (focusScale !== scale) setFocusScale(scale);
                }}
              >
                <header className="wa-wb-col-head">
                  <div className="wa-wb-col-eyebrow">
                    <span className="wa-wb-scale-tag">
                      <span className="lat">{badge.latin}</span>
                      <span className="zh">{badge.zh}</span>
                    </span>
                    {savedTotal > 0 && (
                      <span className="wa-wb-done-stat">
                        済 <b>{doneN}</b>/{savedTotal}
                      </span>
                    )}
                  </div>
                  <div className="wa-wb-col-titlebar">
                    <h3 className="wa-wb-col-title">
                      {head.title}
                      {dirty && <span className="wa-dirty-dot" title="此期間有未存變更" />}
                    </h3>
                    <div className="wa-wb-stepper">
                      <button
                        type="button"
                        className="ns-iconbtn"
                        aria-label={step.prev}
                        title={step.prev}
                        onClick={() => shiftColumnPeriod(scale, -1)}
                      >
                        <IconBack />
                      </button>
                      <span className="wa-wb-period-txt">{periodNavText(periodKey)}</span>
                      <button
                        type="button"
                        className="ns-iconbtn"
                        aria-label={step.next}
                        title={step.next}
                        onClick={() => shiftColumnPeriod(scale, 1)}
                      >
                        <IconChevron />
                      </button>
                    </div>
                  </div>
                </header>

                <div className="wa-wb-col-body">
                  <AimColumnEditorList
                    periodKey={periodKey}
                    relLabel={head.rel}
                    entry={entry}
                    savedRows={savedRows}
                    mobile={false}
                    autoFocusFirst={initKeys.focusScale === scale}
                    flowTargetKey={flowTargetKey}
                    flowTargetLabel={flowTargetLabel}
                    flowTargetCarriedIds={flowTargetCarriedIds}
                    pickState={pickState}
                    placeOf={placeOf}
                    resolveOriginLabel={resolveOriginLabel}
                    onFocusColumn={() => setFocusScale(scale)}
                    onRegisterInput={registerInputRef}
                    onPatch={patchDraft}
                    onRemove={removeDraft}
                    onOpenPicker={(rowIndex, anchorEl) =>
                      setPickState((cur) =>
                        cur?.periodKey === periodKey && cur.rowIndex === rowIndex
                          ? null
                          : { periodKey, rowIndex, anchorEl },
                      )
                    }
                    onFlowRow={(rowIndex) => {
                      if (flowTargetKey) void handleFlowAcross(periodKey, rowIndex, flowTargetKey);
                    }}
                    onEnterRow={(idx) => handleRowEnter(periodKey, idx)}
                    onSaveAll={() => void saveAll()}
                  />

                  {prevCandidates.length > 0 && (
                    <PrevUncompletedSection
                      prevRel={periodTitle(prevKey, today, weekStart).rel}
                      targetRel={head.rel}
                      candidates={prevCandidates}
                      carriedIds={colCarriedIds}
                      disabled={!entry}
                      shell="desktop"
                      placeOf={placeOf}
                      onCarry={(row) => void handleCarrySavedRow(row, periodKey)}
                      onGoRoute={close}
                    />
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </DialogShell>

      {pickState !== null && (
        <AnchoredRoutePicker
          anchorEl={pickState.anchorEl}
          value={pickingPlace}
          onPick={(t) => pickRouteForRow(pickState.periodKey, pickState.rowIndex, t)}
          onClear={() => {
            const { periodKey, rowIndex } = pickState;
            setPickState(null);
            patchDraft(periodKey, rowIndex, { nodeId: null });
          }}
          onClose={() => setPickState(null)}
        />
      )}
    </>
  );
}

/* ═══════════ 單欄方針草稿編輯清單（桌機三欄、車站主欄、手機主欄共用） ═══════════ */

function AimColumnEditorList({
  periodKey,
  relLabel,
  entry,
  savedRows,
  mobile,
  autoFocusFirst,
  flowTargetKey,
  flowTargetLabel,
  flowTargetCarriedIds,
  pickState,
  placeOf,
  resolveOriginLabel,
  onFocusColumn,
  onRegisterInput,
  onPatch,
  onRemove,
  onOpenPicker,
  onFlowRow,
  onEnterRow,
  onSaveAll,
}: {
  periodKey: string;
  relLabel: string;
  entry: { drafts: AimDraft[]; base: AimDraft[] } | undefined;
  savedRows: readonly WeekAimRow[];
  mobile: boolean;
  autoFocusFirst: boolean;
  flowTargetKey: string | null;
  flowTargetLabel: string | null;
  flowTargetCarriedIds: ReadonlySet<string> | null;
  pickState: PickState | null;
  placeOf: (id: string | null) => AimPlace | null;
  resolveOriginLabel: (periodKey: string, carriedFrom: string | null) => string | null;
  onFocusColumn: () => void;
  onRegisterInput: (periodKey: string, idx: number, el: HTMLTextAreaElement | null) => void;
  onPatch: (periodKey: string, idx: number, patch: Partial<AimDraft>) => void;
  onRemove: (periodKey: string, idx: number) => void;
  onOpenPicker: (idx: number, anchorEl: HTMLElement) => void;
  onFlowRow: (idx: number) => void;
  onEnterRow: (idx: number) => void;
  onSaveAll: () => void;
}) {
  if (!entry) {
    return <p className="wa-ed-cap">載入中…</p>;
  }

  const rows = entry.drafts;
  const shown: AimDraft[] =
    rows.length < MAX_AIMS
      ? [...rows, { id: null, text: "", nodeId: null, carriedFrom: null }]
      : rows;
  const doneIds = new Set(savedRows.filter((r) => r.done_at !== null).map((r) => r.id));

  return (
    <>
      <ol className="wa-wb-list">
        {shown.map((d, i) => {
          const place = placeOf(d.nodeId);
          const from = resolveOriginLabel(periodKey, d.carriedFrom);
          const hasText = normalizeAimText(d.text) !== "";
          const isPickOpen = pickState?.periodKey === periodKey && pickState.rowIndex === i;
          const isAlreadyFlowed =
            d.id !== null && !!flowTargetCarriedIds && flowTargetCarriedIds.has(d.id);
          const isDone = d.id !== null && doneIds.has(d.id);

          return (
            <li key={d.id ?? `new-${i}`} className={"wa-wb-item" + (isDone ? " is-done" : "")}>
              <div className="wa-wb-line">
                <span className="wa-num" aria-hidden>
                  {aimNumeral(i)}
                </span>
                <div className="wa-wb-inp">
                  <AimSentenceInput
                    inputRef={(el) => onRegisterInput(periodKey, i, el)}
                    value={d.text}
                    placeholder={
                      i === 0
                        ? `${relLabel}想推進的方向（可打 @ 秒掛路線）`
                        : "再寫一句（可打 @ 掛路線）"
                    }
                    ariaLabel={`${relLabel}第${aimNumeral(i).replace("、", "")}句`}
                    autoFocus={autoFocusFirst && i === 0 && !mobile}
                    onFocus={onFocusColumn}
                    onChange={(nextText) => onPatch(periodKey, i, { text: nextText })}
                    onPickRoute={(route, cleanedText) => {
                      onPatch(periodKey, i, { text: cleanedText, nodeId: route.id });
                    }}
                    onEnter={() => onEnterRow(i)}
                    onSaveAll={onSaveAll}
                  />
                </div>
                {i < rows.length ? (
                  <button
                    type="button"
                    className="ns-iconbtn wa-wb-del"
                    aria-label="刪掉這句"
                    title="刪掉這句"
                    onClick={() => onRemove(periodKey, i)}
                  >
                    <IconClose />
                  </button>
                ) : (
                  <span className="wa-wb-del-sp" aria-hidden />
                )}
              </div>

              <div className="wa-wb-meta">
                {place ? (
                  <button
                    type="button"
                    data-pop-toggle={isPickOpen ? "" : undefined}
                    className={"chip ns-chip wa-chip" + (isPickOpen ? " is-open" : "")}
                    title={`掛在「${aimPlacePath(place)}」——點擊換一條路線`}
                    aria-haspopup="dialog"
                    aria-expanded={isPickOpen}
                    onClick={(e) => onOpenPicker(i, e.currentTarget)}
                  >
                    <RouteMark route={place.route} />
                    <span className="nm">{aimPlaceName(place)}</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    data-pop-toggle={isPickOpen ? "" : undefined}
                    className={"chip ns-chip wa-chip is-empty" + (isPickOpen ? " is-open" : "")}
                    aria-haspopup="dialog"
                    aria-expanded={isPickOpen}
                    onClick={(e) => onOpenPicker(i, e.currentTarget)}
                  >
                    <IconPlus size={12} />
                    掛路線
                  </button>
                )}

                {isDone && <span className="wa-wb-done-pill">已済</span>}
                {from && <span className="wa-wb-from">{from}帶來</span>}

                {hasText && flowTargetKey && flowTargetLabel && (
                  <span className="wa-wb-flow">
                    {isAlreadyFlowed ? (
                      <span className="wa-flow-done">
                        <IconCheckMini />
                        已帶入{flowTargetLabel}
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="wa-flow-btn"
                        title={`將這句方針一鍵帶入「${flowTargetLabel}」草稿`}
                        onClick={() => onFlowRow(i)}
                      >
                        帶入{flowTargetLabel} ›
                      </button>
                    )}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      <p className="wa-wb-cap">
        已寫 {nonEmptyAimCount(rows)}/{MAX_AIMS} 句
      </p>
    </>
  );
}

/* ═══════════ 上一期未済方針區 ═══════════ */

function PrevUncompletedSection({
  prevRel,
  targetRel,
  candidates,
  carriedIds,
  disabled,
  shell,
  placeOf,
  onCarry,
  onGoRoute,
}: {
  prevRel: string;
  targetRel: string;
  candidates: readonly WeekAimRow[];
  carriedIds: ReadonlySet<string>;
  disabled: boolean;
  shell: "desktop" | "mobile";
  placeOf: (id: string | null) => AimPlace | null;
  onCarry: (row: WeekAimRow) => void;
  onGoRoute: () => void;
}) {
  return (
    <div className="wa-ed-sec wa-wb-prev">
      <h4>{prevRel}沒済的</h4>
      {candidates.map((c) => {
        const place = placeOf(c.node_id);
        const done = carriedIds.has(c.id);
        return (
          <div key={c.id} className={"wa-ed-carry" + (done ? " is-carried" : "")}>
            <span className="t">{c.text}</span>
            {place && <RouteTag place={place} shell={shell} onGo={onGoRoute} />}
            {done ? (
              <span className="done">
                <IconCheckMini />
                已帶到{targetRel}
              </span>
            ) : (
              <button
                type="button"
                className="ns-btn btn-ghost ns-btn--sm"
                disabled={disabled}
                onClick={() => onCarry(c)}
              >
                帶到{targetRel}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ═══════════ 車站方針的「今年／本月方針」參照區 ═══════════ */

function StationHorizonReference({
  yearKey,
  monthKey,
  yearRows,
  monthRows,
  carriedIds,
  disabled,
  shell,
  placeOf,
  onCarry,
  onGoRoute,
}: {
  stationKey: string;
  yearKey: string;
  monthKey: string;
  yearRows: readonly WeekAimRow[];
  monthRows: readonly WeekAimRow[];
  carriedIds: ReadonlySet<string>;
  disabled: boolean;
  shell: "desktop" | "mobile";
  placeOf: (id: string | null) => AimPlace | null;
  onCarry: (row: WeekAimRow) => void;
  onGoRoute: () => void;
}) {
  const groups = [
    { key: yearKey, title: "今年方針", rows: yearRows },
    { key: monthKey, title: "本月方針", rows: monthRows },
  ].filter((g) => g.rows.length > 0);

  if (groups.length === 0) {
    return (
      <div className="wa-stn-ref-empty">
        <h4>今年 · 本月方針參照</h4>
        <p>目前還沒有今年或本月的方針；寫好後可在這裡一鍵帶入本站。</p>
      </div>
    );
  }

  return (
    <div className="wa-stn-ref-groups">
      {groups.map((g) => (
        <div key={g.key} className="wa-ed-sec wa-stn-ref-sec">
          <h4>{g.title}</h4>
          {g.rows.map((c) => {
            const place = placeOf(c.node_id);
            const already = carriedIds.has(c.id);
            return (
              <div key={c.id} className={"wa-ed-carry" + (already ? " is-carried" : "")}>
                <span className="t">{c.text}</span>
                {place && <RouteTag place={place} shell={shell} onGo={onGoRoute} />}
                {already ? (
                  <span className="done">
                    <IconCheckMini />
                    已帶入本站
                  </span>
                ) : c.done_at !== null ? (
                  <span className="done">已済</span>
                ) : (
                  <button
                    type="button"
                    className="ns-btn btn-ghost ns-btn--sm"
                    disabled={disabled}
                    onClick={() => onCarry(c)}
                  >
                    帶入本站
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/* ═══════════ 桌機寬敞錨定路線挑選浮層（Portal 至 body，依幹線分組一鍵秒選） ═══════════ */

function AnchoredRoutePicker({
  anchorEl,
  value,
  onPick,
  onClear,
  onClose,
}: {
  anchorEl: HTMLElement | null;
  value: AttachTarget;
  onPick: (t: AttachTarget) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const [pos, setPos] = useState<{
    left: number;
    top?: number;
    bottom?: number;
    width: number;
    listMaxH: number;
  } | null>(null);

  useLayoutEffect(() => {
    const compute = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const width = Math.min(368, Math.max(280, vw - 24));
      if (!anchorEl || !anchorEl.isConnected) {
        setPos({
          left: Math.max(12, Math.round((vw - width) / 2)),
          top: Math.max(24, Math.round(vh * 0.2)),
          width,
          listMaxH: 340,
        });
        return;
      }
      const r = anchorEl.getBoundingClientRect();
      const left = Math.max(12, Math.min(Math.round(r.left), vw - width - 12));
      const spaceBelow = vh - r.bottom - 14;
      const spaceAbove = r.top - 14;
      if (spaceBelow >= 340 || spaceBelow >= spaceAbove) {
        const avail = Math.max(200, spaceBelow);
        setPos({
          left,
          top: Math.round(r.bottom + 6),
          width,
          listMaxH: Math.min(356, Math.max(160, avail - 92)),
        });
      } else {
        const avail = Math.max(200, spaceAbove);
        setPos({
          left,
          bottom: Math.round(vh - r.top + 6),
          width,
          listMaxH: Math.min(356, Math.max(160, avail - 92)),
        });
      }
    };
    compute();
    window.addEventListener("resize", compute);
    window.addEventListener("scroll", compute, true);
    return () => {
      window.removeEventListener("resize", compute);
      window.removeEventListener("scroll", compute, true);
    };
  }, [anchorEl]);

  if (!pos) return null;

  return createPortal(
    <div
      className="wa-route-pop"
      style={{
        left: pos.left,
        top: pos.top,
        bottom: pos.bottom,
        width: pos.width,
        ["--wa-route-list-maxh" as string]: `${pos.listMaxH}px`,
      }}
      onKeyDown={(e) => {
        if (e.key !== "Escape") e.stopPropagation();
      }}
    >
      <AttachPicker
        depth="route"
        float
        label="掛到哪條路線（依幹線分組・點擊直接套用）"
        value={value}
        onPick={onPick}
        onClear={onClear}
        clearLabel="不掛路線"
        onClose={onClose}
      />
    </div>,
    document.body,
  );
}

/* ═══════════ 方針多行自動增高輸入框（支援 @ 一鍵掛路線補完） ═══════════ */

function AimSentenceInput({
  inputRef,
  value,
  placeholder,
  ariaLabel,
  autoFocus,
  onFocus,
  onChange,
  onPickRoute,
  onEnter,
  onSaveAll,
}: {
  inputRef: (el: HTMLTextAreaElement | null) => void;
  value: string;
  placeholder: string;
  ariaLabel: string;
  autoFocus?: boolean;
  onFocus?: () => void;
  onChange(nextText: string): void;
  onPickRoute(route: NodeRow, cleanedText: string): void;
  onEnter(): void;
  onSaveAll(): void;
}) {
  const ownRef = useRef<HTMLTextAreaElement | null>(null);

  const syncHeight = useCallback(() => {
    const el = ownRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.max(30, el.scrollHeight)}px`;
  }, []);

  useLayoutEffect(() => {
    syncHeight();
  }, [value, syncHeight]);

  useEffect(() => {
    const el = ownRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => syncHeight());
    ro.observe(el);
    return () => ro.disconnect();
  }, [syncHeight]);

  const sug = useQuickSuggest({
    inputRef: ownRef,
    value,
    allowDest: true,
    allowTag: false,
    allowSubNode: false,
    routeSelectable: true,
    onTextChange: onChange,
    onPickDest: ({ route, cleanedText }) => {
      onPickRoute(route, cleanedText);
      return true;
    },
  });

  const charLen = useMemo(() => Array.from(normalizeAimText(value)).length, [value]);
  const showCount = charLen >= AIM_TEXT_MAX - 12;

  return (
    <div className="wa-textarea-wrap">
      <textarea
        ref={(el) => {
          ownRef.current = el;
          inputRef(el);
        }}
        rows={1}
        className="techo-input wa-textarea"
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        maxLength={AIM_TEXT_MAX + 20}
        autoFocus={autoFocus}
        onFocus={onFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyUp={sug.bind.onKeyUp}
        onSelect={sug.bind.onSelect}
        onClick={sug.bind.onClick}
        onBlur={sug.close}
        {...sug.compositionBind}
        onKeyDown={(e) => {
          if (sug.onKeyDown(e)) return;
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            onSaveAll();
            return;
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onEnter();
          }
        }}
      />
      {showCount && (
        <span className={"wa-char-count" + (charLen > AIM_TEXT_MAX ? " is-over" : "")}>
          {charLen}/{AIM_TEXT_MAX}
        </span>
      )}
      {sug.popup}
    </div>
  );
}
