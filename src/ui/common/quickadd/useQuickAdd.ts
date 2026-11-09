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
import { parseQuickAdd, stripTokens, type QuickAddCtx, type QuickAddParse, type QuickTokenKind } from "../../../domain/quickAdd";
import { todayKey } from "../../../lib/date";
import { useNodeStore } from "../../../store/nodeStore";
import { useTagStore } from "../../../store/tagStore";
import { useUiStore } from "../../../store/uiStore";
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
  input: Pick<CreateNodeInput, "scheduledOn" | "scheduledTime" | "estimateMin" | "dueOn" | "priority" | "dayStartHour">;
  /** 建好之後（掛荷札） */
  afterCreate(row: NodeRow): Promise<void>;
}

export interface UseQuickAddOptions {
  /** 掛到與乘車日的預設 */
  defaults: QuickDefaults;
  /** 掛到路線（或支線）時預設建成什麼；省略＝路線圖列車、其他頁車票（契約 §一 A「路線圖預設列車」） */
  routeKind?: RouteKind;
  /** 大綱位置型：建成的種類由位置決定、不認 @、不出掛到 chip；建票走呼叫端（extra()） */
  positional?: { kind: NodeKind };
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
  routeKind: RouteKind;
  setRouteKind(k: RouteKind): void;
  setDest(d: QuickDest): void;
  setDate(d: string | null): void;
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
  routeName(id: string | null): string | null;
  /** 列車／車廂的名字（文字認出來的 @路線/列車） */
  nodeName(id: string | null): string | null;
  /** 聚焦時叫：把 @路線/列車 要用的列車清單載新 */
  warm(): void;
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
  const routes = useNodeStore((s) => s.routes);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const today = todayKey(dayStartHour);
  const positional = !!opts.positional;

  const [text, setTextState] = useState(opts.initialText ?? "");
  /** 解析用的字：組字中凍結在組字前那一版 */
  const [parsedText, setParsedText] = useState(opts.initialText ?? "");
  const [composing, setComposing] = useState(false);
  const composingRef = useRef(false);
  const textRef = useRef(opts.initialText ?? "");
  const [chips, setChips] = useState<QuickChips>(() => (opts.initialSyncDue ? { syncDueWithScheduled: true } : {}));
  /** 連打留下來的掛到／乘車日（上一張用 chip 設的）：當預設用——這一張打的字照樣蓋得過（不然認出來的片段被拿掉、值卻被丟掉） */
  const [carry, setCarry] = useState<Partial<Pick<QuickDefaults, "dest" | "scheduledOn">>>({});
  const chipsRef = useRef(chips);
  chipsRef.current = chips;
  const [routeKind, setRouteKind] = useState<RouteKind>(opts.routeKind ?? (opts.here.kind === "route" ? "train" : "ticket"));
  const [tasks, setTasks] = useState<ReadonlyMap<string, readonly TaskLite[]>>(new Map());
  const tasksFresh = useRef(false);
  const busy = useRef(false);

  // 呼叫端換了預設的建成種類（頁首「新增車票」重開）就跟著換
  useEffect(() => {
    if (opts.routeKind) setRouteKind(opts.routeKind);
  }, [opts.routeKind]);

  const warm = useCallback(() => {
    if (tasksFresh.current || positional) return;
    tasksFresh.current = true;
    const list = useNodeStore.getState().routes;
    Promise.all(
      list.map((r) =>
        nodeRepo
          .listRouteTree(r.id)
          .then((rows) => [r.id, rows.filter((n) => n.kind === "train" || n.kind === "car").map((n) => ({ id: n.id, name: n.name, kind: n.kind }))] as const),
      ),
    )
      .then((pairs) => setTasks(new Map(pairs)))
      .catch((e: unknown) => {
        tasksFresh.current = false;
        console.warn("建票列：載入列車清單失敗", e);
      });
  }, [positional]);

  // 打到 @…/ 才需要列車清單：沒載過就載
  useEffect(() => {
    if (!positional && /@\S*\//.test(parsedText)) warm();
  }, [parsedText, positional, warm]);

  const ctx: QuickAddCtx = useMemo(
    () => ({
      today,
      dayStartHour,
      // 位置型：掛到由位置決定，@ 一律不認（留在名稱裡）
      routes: positional ? [] : routes.map((r) => ({ id: r.id, name: r.name, code: r.code })),
      tasksOf: positional ? undefined : (routeId: string) => tasks.get(routeId) ?? [],
    }),
    [today, dayStartHour, routes, tasks, positional],
  );
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const parse = useMemo(() => parseQuickAdd(parsedText, ctx), [parsedText, ctx]);
  const nodeKindOf = useCallback(
    (id: string): QuickDest["nodeKind"] => {
      for (const list of tasks.values()) {
        const hit = list.find((t) => t.id === id);
        if (hit) return hit.kind === "car" ? "car" : "train";
      }
      return null;
    },
    [tasks],
  );
  const values = useMemo(
    () => mergeQuick(parse, chips, { ...opts.defaults, ...carry }, nodeKindOf, positional),
    [parse, chips, carry, opts.defaults, nodeKindOf, positional],
  );
  const target: QuickTarget = opts.positional
    ? { kind: opts.positional.kind, parentId: null, routeTagId: null, canChoose: false }
    : resolveQuickTarget(values.dest, routeKind);

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

  const setDest = useCallback((d: QuickDest) => (setChips((c) => ({ ...c, dest: d })), stripFor("dest")), [stripFor]);
  const setDate = useCallback((d: string | null) => (setChips((c) => ({ ...c, scheduledOn: d })), stripFor("date")), [stripFor]);
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
    // 連打（Todoist 慣例）：chip 設的掛到與乘車日留著（降成預設，見 carry），其餘清掉；文字認出來的不留（那是上一張的）
    const c = chipsRef.current;
    setCarry((prev) => ({
      ...prev,
      ...(c.dest !== undefined ? { dest: c.dest } : {}),
      ...(c.scheduledOn !== undefined ? { scheduledOn: c.scheduledOn } : {}),
    }));
    setChips({});
    tasksFresh.current = false;
  }, [setText]);

  const routeName = useCallback(
    (id: string | null) => (id ? (routes.find((r) => r.id === id)?.name ?? null) : null),
    [routes],
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
    const v = live.current.values;
    return {
      input: {
        scheduledOn: v.scheduledOn,
        scheduledTime: v.scheduledTime,
        estimateMin: v.estimateMin,
        dueOn: v.dueOn,
        priority: v.priority ?? undefined,
        dayStartHour: live.current.dayStartHour,
      },
      afterCreate: (row) => attachQuickTags(row.id, v.tags),
    };
  }, []);

  const submit = useCallback(async (so?: QuickSubmitOptions): Promise<NodeRow | null> => {
    if (busy.current || composingRef.current) return null;
    const { values: v, target: t, opts: o, dayStartHour: dsh } = live.current;
    const name = v.name.trim();
    if (!name || o.positional) return null;
    busy.current = true;
    try {
      const ns = useNodeStore.getState();
      const row = await ns.createNode({
        kind: t.kind,
        name,
        parentId: t.parentId,
        routeTagId: t.routeTagId,
        afterId: o.afterId ?? undefined,
        scheduledOn: v.scheduledOn,
        scheduledTime: v.scheduledTime,
        estimateMin: v.estimateMin,
        dueOn: v.dueOn,
        priority: v.priority ?? undefined,
        dayStartHour: dsh,
      });
      if (!row) {
        useUiStore.getState().showToast({ message: "新增失敗——請再試一次" });
        return null;
      }
      await attachQuickTags(row.id, v.tags);
      const note = leaveNote(
        o.here,
        { scheduledOn: v.scheduledOn, target: t, routeId: v.dest.routeId },
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
    routeKind,
    setRouteKind,
    setDest,
    setDate,
    setTime,
    setDue,
    syncDueWithScheduled: !!chips.syncDueWithScheduled && parse.dueOn === undefined,
    setSyncDueWithScheduled,
    setPriority,
    setTags,
    canSubmit: !!values.name.trim() && !composing,
    submit,
    extra,
    reset,
    today,
    dayStartHour,
    routes,
    routeName,
    nodeName,
    warm,
  };
}
