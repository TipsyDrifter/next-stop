/**
 * useQuickAdd——建票列的共用邏輯（回饋甲 D-主-127、135；契約 §一 A）：桌機 `QuickAddRow` 與手機 `MobileQuickAdd` 都吃這支，畫面各寫。
 *
 * 管的事：
 *   - 輸入框的字＋IME 守門（isComposing／keyCode 229／composition 旗標三重；組字中不解析、不送出——同 MobileNewTicket）
 *   - 解析（domain/quickAdd parseQuickAdd；@路線/列車 第二段要的列車清單在這裡懶載）
 *   - chips 的值（quickAddModel：chip ＞ 文字 ＞ 預設）；chip 改值＝stripTokens 把文字裡同種片段拿掉
 *   - 送出（一筆 createNode 寫完乘車日／幾點／長度／締切／優先＋建好後掛荷札；票離開眼前才出 toast＋「復原」）
 *   - 連打：送出後清空，chips 裡「掛到」「乘車日」保留，其餘清掉
 * 大綱的位置型草稿列（`positional`）建票走大綱 controller（落點、Tab 改層級在那邊）——這裡只出 `extra()` 給它帶進 createNode。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { nodeRepo, type CreateNodeInput } from "../../../data";
import { tagRepo } from "../../../data/tagRepo";
import type { NodeKind, NodeRow, Priority } from "../../../domain";
import { normalizeDateRange } from "../../../domain/dateRange";
import { compareSiblings } from "../../../domain/nodeOrder";
import { excludeSubtrees } from "../../../domain/moveTo";
import { parseQuickAdd, stripTokens, type QuickAddCtx, type QuickAddParse, type QuickTokenKind } from "../../../domain/quickAdd";
import { todayKey } from "../../../lib/date";
import { useNodeStore } from "../../../store/nodeStore";
import { useTagStore } from "../../../store/tagStore";
import { useUiStore } from "../../../store/uiStore";
import { flattenAttachTree, type AttachKind } from "../../notes/useAttachOptions";
import {
  CHIP_TOKENS,
  leaveNote,
  mergeQuick,
  resolveQuickTarget,
  type QuickChipKey,
  type QuickChips,
  type QuickDefaults,
  type QuickDest,
  type QuickHere,
  type QuickTarget,
  type QuickValues,
  type RouteKind,
} from "./quickAddModel";

/** 大綱位置型草稿列建票時多帶的東西（useOutlineController 的 createFromDraft 收） */
export interface QuickExtra {
  input: Pick<
    CreateNodeInput,
    | "stationId"
    | "scheduledOn"
    | "scheduledEnd"
    | "isMultiDay"
    | "scheduledTime"
    | "estimateMin"
    | "dueOn"
    | "priority"
    | "isPlaceholder"
    | "dayStartHour"
  >;
  /** 建好之後（掛荷札） */
  afterCreate(row: NodeRow): Promise<void>;
}

export interface UseQuickAddOptions {
  /** 掛到與乘車日的預設 */
  defaults: QuickDefaults;
  /** 掛到路線（或支線）時預設建成什麼；省略＝車票（操作 2：路線大綱可切「車票｜支線」） */
  routeKind?: RouteKind;
  /** 強制隱藏「車票｜支線」切換段（如看板欄內新增車票、行內編輯列） */
  hideRouteKind?: boolean;
  /** 大綱位置型：建成的種類由位置決定、不認 @、不出掛到 chip；建票走呼叫端（extra()） */
  positional?: { kind: NodeKind };
  /** 行內編輯既有項目：保留原項目種類（不自己 createNode），但 movable 時完整支援 `@路線` 語法與補完！ */
  inlineEdit?: {
    kind: NodeKind;
    allowDest: boolean;
    excludeId?: string;
    allowedDestKinds?: readonly AttachKind[];
    routeSelectable?: boolean;
  };
  /** 行內編輯既有車票時的初始標題與締切同步狀態 */
  initialText?: string;
  initialSyncDue?: boolean;
  /** 在哪一頁（決定建好之後要不要出「已放進收件匣」這類收據） */
  here: QuickHere;
  /** 插在這個兄弟之後（省略＝尾端） */
  afterId?: string | null;
  /** 建好了（stays＝票還在眼前、沒出 toast，而且使用者還在建票列上——失焦送出一律 false，選取別動） */
  onCreated?(row: NodeRow, stays: boolean): void;
}

export interface QuickSubmitOptions {
  /** 點去別處時送出（焦點與選取已經是使用者剛點的那一列）：onCreated 的 stays 給 false */
  away?: boolean;
}

export interface QuickAddApi {
  text: string;
  setText(t: string): void;
  /** 組字中（畫面別疊反白；Enter 不送出） */
  composing: boolean;
  /** 掛到輸入框上：composition 旗標（第三重守門） */
  compositionProps: { onCompositionStart(): void; onCompositionEnd(): void };
  /** Enter 該不該當送出（三重守門都過才算） */
  isSubmitKey(e: KeyboardEvent<HTMLInputElement>): boolean;
  parse: QuickAddParse;
  /** 輸入框裡的反白片段（組字中、或字跟解析對不上時為空） */
  tokens: QuickAddParse["tokens"];
  values: QuickValues;
  target: QuickTarget;
  /** 當前場景是否允許顯示「車票｜支線」分段鈕（只在路線大綱 here.kind === "route" 且掛到路線／支線時為 true） */
  canChooseKind: boolean;
  routeKind: RouteKind;
  setRouteKind(k: RouteKind): void;
  setDest(d: QuickDest): void;
  setStation(id: string | null): void;
  setDate(d: string | null): void;
  setDateRange(start: string | null, end: string | null, isMultiDay?: boolean): void;
  setTime(t: string | null, estimateMin: number | null): void;
  setDue(d: string | null): void;
  /** 締切與乘車日同步開關 */
  syncDueWithScheduled: boolean;
  setSyncDueWithScheduled(on: boolean): void;
  setPriority(p: Priority | null): void;
  setTags(names: readonly string[]): void;
  /** 有名字、不在組字中 */
  canSubmit: boolean;
  /** 自己建（非 positional）；成功回新票、清成下一張 */
  submit(o?: QuickSubmitOptions): Promise<NodeRow | null>;
  /** positional 用：要帶進 createNode 的欄位與建好後要做的事 */
  extra(): QuickExtra;
  /** 清成下一張（positional 呼叫端建好後叫；submit 自己會叫） */
  reset(): void;
  today: string;
  dayStartHour: number;
  routes: NodeRow[];
  /** 目前目標路線底下的車站（無路線或無車站時為空陣列） */
  stations: NodeRow[];
  routeName(id: string | null): string | null;
  stationName(id: string | null): string | null;
  /** 子節點的名字（文字認出來的 @路線/子項） */
  nodeName(id: string | null): string | null;
  /** 聚焦時叫：把 @路線/子項 要用的節點清單載新 */
  warm(): void;
  /** 給 QuickField 行內補完（useQuickSuggest）的設定 */
  suggestConfig: {
    allowDest: boolean;
    allowTag: boolean;
    excludeId?: string;
    allowedDestKinds?: readonly AttachKind[];
    routeSelectable?: boolean;
  };
}

type TaskLite = { id: string; name: string; kind: NodeKind };

/** 建好後掛荷札（建票那一筆 op 之後；不 toast，失敗才說） */
export async function attachQuickTags(nodeId: string, names: readonly string[]): Promise<void> {
  if (!names.length) return;
  try {
    await tagRepo.setTags("node", nodeId, names);
    await useTagStore.getState().loadIndex();
  } catch (e) {
    console.warn("建票列：荷札沒掛上", e);
    useUiStore.getState().showToast({ message: "荷札沒掛上——請在詳情裡再掛一次" }, 4000);
  }
}

export function useQuickAdd(opts: UseQuickAddOptions): QuickAddApi {
  const routes = useNodeStore((s) => s.liveRoutes);
  const allRoutes = useNodeStore((s) => s.routes);
  const allStations = useNodeStore((s) => s.stations);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const weekStart = useUiStore((s) => s.weekStart);
  const today = todayKey(dayStartHour);
  const positional = !!opts.positional;
  const inlineEdit = opts.inlineEdit;
  const disableDest = positional || (inlineEdit ? !inlineEdit.allowDest : false);
  const fixedKind = opts.positional?.kind ?? inlineEdit?.kind ?? null;
  const excludeId = inlineEdit?.excludeId;
  const allowedDestKindsKey = inlineEdit?.allowedDestKinds?.join(",") ?? "";

  const [text, setTextState] = useState(opts.initialText ?? "");
  /** 解析用的字：組字中凍結在組字前那一版 */
  const [parsedText, setParsedText] = useState(opts.initialText ?? "");
  const [composing, setComposing] = useState(false);
  const composingRef = useRef(false);
  const textRef = useRef(opts.initialText ?? "");
  const [chips, setChips] = useState<QuickChips>({});
  /** 連打留下來的掛到／車站／乘車日（含區間訖日與多日旗標）：當預設用——這一張打的字照樣蓋得過 */
  const [carry, setCarry] = useState<
    Partial<Pick<QuickDefaults, "dest" | "stationId" | "scheduledOn" | "scheduledEnd" | "isMultiDay">>
  >({});
  const chipsRef = useRef(chips);
  chipsRef.current = chips;
  // v1.31 Bug 1：新建葉節點預設統一為 ticket；顯式指定 routeKind="branch" 時建立支線
  const [routeKind, setRouteKind] = useState<RouteKind>(opts.routeKind ?? "ticket");
  const [tasks, setTasks] = useState<ReadonlyMap<string, readonly TaskLite[]>>(new Map());
  const tasksFresh = useRef(false);
  const busy = useRef(false);

  // 呼叫端換了預設的建成種類（頁首「新增車票」重開）就跟著換
  useEffect(() => {
    if (opts.routeKind) setRouteKind(opts.routeKind);
  }, [opts.routeKind]);

  const warm = useCallback(() => {
    if (tasksFresh.current || disableDest) return;
    tasksFresh.current = true;
    const list = useNodeStore.getState().liveRoutes;
    const excl = excludeId ? new Set([excludeId]) : null;
    const allowedSet = allowedDestKindsKey ? new Set(allowedDestKindsKey.split(",")) : null;
    Promise.all(
      list.map((r) =>
        nodeRepo.listRouteTree(r.id).then((rows) => {
          const flat = flattenAttachTree(r.id, rows);
          const filtered = excl ? excludeSubtrees(flat, excl) : flat;
          const items: TaskLite[] = filtered
            .filter((o) => !allowedSet || allowedSet.has(o.kind))
            .map((o) => ({ id: o.id, name: o.name, kind: o.kind }));
          return [r.id, items] as const;
        }),
      ),
    )
      .then((pairs) => setTasks(new Map(pairs)))
      .catch((e: unknown) => {
        tasksFresh.current = false;
        console.warn("建票列：載入節點清單失敗", e);
      });
  }, [disableDest, excludeId, allowedDestKindsKey]);

  // 打到 @ 即預熱節點清單，讓 @路線/ 與跨路線補完秒出
  useEffect(() => {
    if (!disableDest && parsedText.includes("@")) warm();
  }, [parsedText, disableDest, warm]);

  const ctx: QuickAddCtx = useMemo(
    () => ({
      today,
      dayStartHour,
      weekStart,
      // 位置型（或不可搬移之行內編輯）：@ 一律不認（留在名稱裡）
      routes: disableDest ? [] : routes.map((r) => ({ id: r.id, name: r.name, code: r.code })),
      tasksOf: disableDest ? undefined : (routeId: string) => tasks.get(routeId) ?? [],
    }),
    [today, dayStartHour, weekStart, routes, tasks, disableDest],
  );
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const parse = useMemo(() => parseQuickAdd(parsedText, ctx), [parsedText, ctx]);

  // 使用者在點過 chip 後若又主動在輸入框打出同種語法（如 `=`、`14:00-15:30`、`@路線`），自動釋放該格 chip 覆寫讓新打語法生效
  const prevTokKindsRef = useRef<Set<QuickTokenKind>>(new Set());
  useEffect(() => {
    const curKinds = new Set(parse.tokens.map((t) => t.kind));
    const prevKinds = prevTokKindsRef.current;
    prevTokKindsRef.current = curKinds;
    const added = [...curKinds].filter((k) => !prevKinds.has(k));
    if (!added.length) return;
    setChips((c) => {
      let next = c;
      const drop = <K extends keyof QuickChips>(k: K) => {
        if (k in next) {
          const copy = { ...next };
          delete copy[k];
          next = copy;
        }
      };
      if (added.includes("dest")) drop("dest");
      if (added.includes("date")) {
        drop("scheduledOn");
        drop("scheduledEnd");
        drop("isMultiDay");
      }
      if (added.includes("time") || added.includes("length")) {
        drop("scheduledTime");
        drop("estimateMin");
      }
      if (added.includes("due")) {
        drop("dueOn");
        drop("syncDueWithScheduled");
      }
      if (added.includes("priority")) drop("priority");
      if (added.includes("tag")) drop("tags");
      return next;
    });
  }, [parse]);

  const nodeKindOf = useCallback(
    (id: string): QuickDest["nodeKind"] => {
      for (const list of tasks.values()) {
        const hit = list.find((t) => t.id === id);
        if (hit && (hit.kind === "branch" || hit.kind === "train" || hit.kind === "car" || hit.kind === "ticket")) {
          return hit.kind;
        }
      }
      return null;
    },
    [tasks],
  );
  const mergedDefaults = useMemo<QuickDefaults>(
    () => ({
      ...opts.defaults,
      ...(opts.initialSyncDue !== undefined ? { syncDueWithScheduled: opts.initialSyncDue } : {}),
      ...carry,
    }),
    [opts.defaults, opts.initialSyncDue, carry],
  );
  const destNameOf = useCallback(
    (d: QuickDest): string | null => {
      if (d.nodeId) {
        for (const list of tasks.values()) {
          const hit = list.find((t) => t.id === d.nodeId);
          if (hit) return hit.name;
        }
      }
      if (d.routeId) return allRoutes.find((r) => r.id === d.routeId)?.name ?? null;
      return null;
    },
    [tasks, allRoutes],
  );
  const rawValues = useMemo(
    () => mergeQuick(parse, chips, mergedDefaults, nodeKindOf, disableDest, destNameOf),
    [parse, chips, mergedDefaults, nodeKindOf, disableDest, destNameOf],
  );
  const targetRouteId = positional
    ? (opts.here.kind === "route" ? opts.here.routeId : mergedDefaults.dest.routeId)
    : rawValues.dest.routeId;
  const availableStations = useMemo(
    () => (targetRouteId ? allStations.filter((s) => s.parent_id === targetRouteId).sort(compareSiblings) : []),
    [allStations, targetRouteId],
  );
  const values = useMemo<QuickValues>(() => {
    if (!rawValues.stationId) return rawValues;
    if (availableStations.some((s) => s.id === rawValues.stationId)) return rawValues;
    const nextOn = new Set(rawValues.on);
    nextOn.delete("station");
    return { ...rawValues, stationId: null, on: nextOn };
  }, [rawValues, availableStations]);
  const allowBranchChoice = opts.here.kind === "route" && !opts.hideRouteKind && !fixedKind;
  const effectiveRouteKind: RouteKind = allowBranchChoice ? routeKind : "ticket";
  const target: QuickTarget = fixedKind
    ? { kind: fixedKind, parentId: null, routeTagId: null, canChoose: false }
    : resolveQuickTarget(values.dest, effectiveRouteKind);
  const canChooseKind = allowBranchChoice && target.canChoose;

  const setText = useCallback((t: string) => {
    textRef.current = t;
    setTextState(t);
    if (!composingRef.current) setParsedText(t);
  }, []);

  const compositionProps = useMemo(
    () => ({
      onCompositionStart() {
        composingRef.current = true;
        setComposing(true);
      },
      onCompositionEnd() {
        composingRef.current = false;
        setComposing(false);
        setParsedText(textRef.current);
      },
    }),
    [],
  );

  const isSubmitKey = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return false;
    return !(e.nativeEvent.isComposing || e.keyCode === 229 || composingRef.current);
  }, []);

  /** chip 改值：文字裡同種片段一起拿掉 */
  const stripFor = useCallback(
    (key: QuickChipKey) => {
      let t = textRef.current;
      for (const k of CHIP_TOKENS[key] as readonly QuickTokenKind[]) t = stripTokens(t, k, ctxRef.current);
      if (t !== textRef.current) setText(t);
    },
    [setText],
  );

  const setDest = useCallback(
    (d: QuickDest) => {
      setChips((c) => {
        const curRoute = live.current.values.dest.routeId;
        if (d.routeId !== curRoute && "stationId" in c) {
          const copy = { ...c, dest: d };
          delete copy.stationId;
          return copy;
        }
        return { ...c, dest: d };
      });
      stripFor("dest");
    },
    [stripFor],
  );
  const setStation = useCallback((id: string | null) => (setChips((c) => ({ ...c, stationId: id })), stripFor("station")), [stripFor]);
  const setDateRange = useCallback(
    (start: string | null, end: string | null, isMultiDay = false) => {
      const norm = normalizeDateRange(start, end);
      setChips((c) => ({
        ...c,
        scheduledOn: norm.scheduledOn,
        scheduledEnd: norm.scheduledEnd,
        isMultiDay: norm.scheduledEnd ? Boolean(isMultiDay) : false,
      }));
      stripFor("date");
    },
    [stripFor],
  );
  const setDate = useCallback((d: string | null) => setDateRange(d, null, false), [setDateRange]);
  const setTime = useCallback(
    (t: string | null, estimateMin: number | null) => (setChips((c) => ({ ...c, scheduledTime: t, estimateMin })), stripFor("time")),
    [stripFor],
  );
  const setDue = useCallback(
    (d: string | null) => (setChips((c) => ({ ...c, dueOn: d, syncDueWithScheduled: false })), stripFor("due")),
    [stripFor],
  );
  const setSyncDueWithScheduled = useCallback(
    (on: boolean) => {
      setChips((c) => ({ ...c, syncDueWithScheduled: on, dueOn: on ? undefined : null }));
      stripFor("due");
    },
    [stripFor],
  );
  const setPriority = useCallback((p: Priority | null) => (setChips((c) => ({ ...c, priority: p })), stripFor("priority")), [stripFor]);
  const setTags = useCallback((names: readonly string[]) => (setChips((c) => ({ ...c, tags: [...names] })), stripFor("tags")), [stripFor]);

  const reset = useCallback(() => {
    setText("");
    // 連打（Todoist 慣例）：chip 設的掛到、車站與乘車日留著（降成預設，見 carry），其餘清掉；文字認出來的不留（那是上一張的）
    const c = chipsRef.current;
    setCarry((prev) => ({
      ...prev,
      ...(c.dest !== undefined ? { dest: c.dest } : {}),
      ...(c.stationId !== undefined ? { stationId: c.stationId } : {}),
      ...(c.scheduledOn !== undefined
        ? { scheduledOn: c.scheduledOn, scheduledEnd: c.scheduledEnd ?? null, isMultiDay: Boolean(c.scheduledEnd && c.isMultiDay) }
        : {}),
    }));
    setChips({});
    tasksFresh.current = false;
  }, [setText]);

  const routeName = useCallback(
    (id: string | null) => (id ? (allRoutes.find((r) => r.id === id)?.name ?? null) : null),
    [allRoutes],
  );
  const stationName = useCallback(
    (id: string | null) => (id ? (allStations.find((s) => s.id === id)?.name ?? null) : null),
    [allStations],
  );
  const nodeName = useCallback(
    (id: string | null) => {
      if (!id) return null;
      for (const list of tasks.values()) {
        const hit = list.find((t) => t.id === id);
        if (hit) return hit.name;
      }
      return null;
    },
    [tasks],
  );

  const live = useRef({ values, target, opts, dayStartHour });
  live.current = { values, target, opts, dayStartHour };

  const extra = useCallback((): QuickExtra => {
    const { values: v, target: t, dayStartHour: dsh } = live.current;
    if (t.kind === "branch") {
      return {
        input: {
          stationId: v.stationId,
          scheduledOn: null,
          scheduledEnd: null,
          isMultiDay: undefined,
          scheduledTime: null,
          estimateMin: null,
          dueOn: null,
          priority: undefined,
          isPlaceholder: undefined,
          dayStartHour: dsh,
        },
        afterCreate: async () => undefined,
      };
    }
    return {
      input: {
        stationId: v.stationId,
        scheduledOn: v.scheduledOn,
        scheduledEnd: v.scheduledEnd,
        isMultiDay: v.isMultiDay || undefined,
        scheduledTime: v.scheduledTime,
        estimateMin: v.estimateMin,
        dueOn: v.dueOn,
        priority: v.priority ?? undefined,
        isPlaceholder: v.isPlaceholder || undefined,
        dayStartHour: dsh,
      },
      afterCreate: (row) => attachQuickTags(row.id, v.tags),
    };
  }, []);

  const submit = useCallback(async (so?: QuickSubmitOptions): Promise<NodeRow | null> => {
    if (busy.current || composingRef.current) return null;
    const { values: v, target: t, opts: o, dayStartHour: dsh } = live.current;
    const isBranch = t.kind === "branch";
    const name = (isBranch ? v.name : v.effectiveName).trim();
    if (!name || o.positional || o.inlineEdit) return null;
    busy.current = true;
    try {
      const ns = useNodeStore.getState();
      const row = await ns.createNode({
        kind: t.kind,
        name,
        parentId: t.parentId,
        routeTagId: t.routeTagId,
        stationId: v.stationId,
        afterId: o.afterId ?? undefined,
        scheduledOn: isBranch ? null : v.scheduledOn,
        scheduledEnd: isBranch ? null : v.scheduledEnd,
        isMultiDay: isBranch ? undefined : (v.isMultiDay || undefined),
        scheduledTime: isBranch ? null : v.scheduledTime,
        estimateMin: isBranch ? null : v.estimateMin,
        dueOn: isBranch ? null : v.dueOn,
        priority: isBranch ? undefined : (v.priority ?? undefined),
        isPlaceholder: isBranch ? undefined : (v.isPlaceholder || undefined),
        dayStartHour: dsh,
      });
      if (!row) {
        useUiStore.getState().showToast({ message: "新增失敗——請再試一次" });
        return null;
      }
      if (!isBranch) await attachQuickTags(row.id, v.tags);
      const note = leaveNote(
        o.here,
        {
          scheduledOn: isBranch ? null : v.scheduledOn,
          scheduledEnd: isBranch ? null : v.scheduledEnd,
          isMultiDay: isBranch ? false : v.isMultiDay,
          target: t,
          routeId: v.dest.routeId,
        },
        (id) => useNodeStore.getState().routes.find((r) => r.id === id)?.name ?? null,
      );
      if (note) {
        useUiStore.getState().showToast({
          message: note,
          actionLabel: "復原", // 反悔動作一律叫「復原」（視覺規範 §2.8）；一筆建票＝一次刪掉整張
          onAction: () => void useNodeStore.getState().deleteNode(row.id),
        });
      }
      reset();
      o.onCreated?.(row, !note && !so?.away);
      return row;
    } finally {
      busy.current = false;
    }
  }, [reset]);

  const highlight = !composing && parsedText === text;

  return {
    text,
    setText,
    composing,
    compositionProps,
    isSubmitKey,
    parse,
    tokens: highlight ? parse.tokens : [],
    values,
    target,
    canChooseKind,
    routeKind: effectiveRouteKind,
    setRouteKind,
    setDest,
    setStation,
    setDate,
    setDateRange,
    setTime,
    setDue,
    syncDueWithScheduled: values.syncDueWithScheduled,
    setSyncDueWithScheduled,
    setPriority,
    setTags,
    canSubmit: !composing && !!(target.kind === "branch" ? values.name : values.effectiveName).trim(),
    submit,
    extra,
    reset,
    today,
    dayStartHour,
    routes: allRoutes,
    stations: availableStations,
    routeName,
    stationName,
    nodeName,
    warm,
    suggestConfig: {
      allowDest: !disableDest,
      allowTag: fixedKind !== "branch" && effectiveRouteKind !== "branch",
      excludeId,
      allowedDestKinds: inlineEdit?.allowedDestKinds,
      routeSelectable: inlineEdit?.routeSelectable,
    },
  };
}
