/**
 * notesStore——旅客筆記線的畫面狀態與動作（車次①；契約 §3.6）。
 *
 * 桌機（乙席）與手機（丙席）共用這一份：子畫面與選取、捕捉框狀態機、變待辦預覽（契約 0-6
 * 「共用狀態機＋純函式、元件各寫」）。UI 只讀 store、呼叫動作，**不自己碰 repository**。
 *
 * 錯誤處理：寫入失敗一律 toast（`useUiStore.getState().showToast`），不寫 `error` 欄位釘紅字橫幅
 * （`nodeStore.ts` 的教訓）；`error` 只給載入失敗用。
 *
 * 狀態形狀與動作名在 Stage 0 定稿（契約 §2.5 第 3 點：之後只加不改）。甲席 §2.1 之後另加的：
 * `freshNoteId`（剛捕捉進收件匣那一則，受付章 fresh 用）、`notesHasMore`＋`loadMoreNotes`（列表分頁）。
 *
 * 車次②（契約 §3.6；Stage 0 定稿、只加不改）：`section` 加 "diary"、日記／足跡／月份記號三組狀態與動作、
 * 捕捉框的日記票根真的落庫、別線登記的捕捉目的地（`captureStubList`／`captureTargetOf`，D-筆-36）。
 *
 * 建車票一律經既有 `nodeRepo.create`／`nodeStore` 的動作（D-筆-18）；變待辦不是單一交易（契約 0-9）：
 * 中途失敗＝已建的票留著、筆記不刪、toast 說明＋復原鈕刪掉已建的。
 */
import { create } from "zustand";
import { nodeRepo } from "../data";
import { noteRepo } from "../data/noteRepo";
import { useNodeStore } from "./nodeStore";
import { useUiStore } from "./uiStore";
import { addDays, dayKeyOf, todayKey } from "../lib/date";
import { dayBlocksProvider } from "../ui/notes/footprintBlocks";
import type { CaptureSaveResult, CaptureTargetSpec, LineReloadContext } from "../lines/types";
import { lineCaptureTargets } from "../lines/runtime";
import { useTagStore } from "./tagStore";
import type { NodeRow } from "../domain";
import {
  CAPTURE_STUBS,
  captureToast,
  clampDay,
  diaryToast,
  isBuiltinStub,
  fmtMonthDay,
  monthDays,
  monthKey,
  type FootprintDay,
  lineCount,
  nextStub,
  needsPreview,
  parseRoutePrefix,
  previewDestination,
  resolveDestination,
  splitTodoLines,
  type AttachTarget,
  type CaptureStub,
  type RouteLike,
  type RoutePrefix,
  type TodoLine,
} from "../domain/notes";
import type { NoteListItem, NotePatch, NotesQuery } from "../data/noteRepository";

export type InboxRef = { kind: "note"; id: string } | { kind: "ticket"; id: string };

export interface CaptureState {
  text: string;
  /** 內建票根或別線登記的捕捉目的地 id（車次② D-筆-36；清單見 `captureStubList(shell)`） */
  stub: CaptureStub;
  /** 主人按 × 或在開頭 Backspace 取消過的前綴字串（＝parseRoutePrefix().matched）；文字一變就重新判 */
  dismissedPrefix: string | null;
  /** Esc 二段確認：有內容時第一次 Esc 只亮提示 */
  confirmEsc: boolean;
}

export interface PreviewState {
  source: "capture" | "note";
  /** source==="note" 時＝要 soft delete 的筆記 */
  noteId: string | null;
  /** 去掉路線前綴後的內文 */
  text: string;
  /** splitTodoLines(text)；single 時只有一筆 */
  lines: TodoLine[];
  /** lineCount(text) <= 1 ⇒ 不顯示清單、只顯示欄位列 */
  single: boolean;
  /** 「掛到哪」（D-筆-26 合成一欄） */
  attach: AttachTarget;
  /** 預設 todayKey(dayStartHour)；null＝清除（沒路線也沒節點＝留在收件匣） */
  scheduledOn: string | null;
}

/** 旅客筆記的子畫面（車次②加 "diary"；車次③加 "tags"） */
export type NotesSection = "inbox" | "notes" | "diary" | "tags";

export interface NotesStore {
  /* ── 子畫面與列表 ── */
  section: NotesSection;
  inboxNotes: NoteListItem[];
  inboxTickets: NodeRow[];
  inboxSelected: InboxRef | null;
  notes: NoteListItem[];
  /** { routeId?: string|"none"; query?: string } */
  notesQuery: NotesQuery;
  selectedNoteId: string | null;
  /** 寫與讀分兩態（D-筆-24）：true＝內文是打字框 */
  editing: boolean;
  /** 「新筆記」按下、還沒寫字：不落庫（空筆記不建）；第一次非空存檔才 create */
  draftNew: boolean;
  loading: boolean;
  error: string | null;
  /* ── 浮層狀態機（桌機與手機共用） ── */
  capture: CaptureState | null;
  preview: PreviewState | null;
  /** 剛從捕捉框存進收件匣的那一則（受付章 `fresh`／toast 旁小章用）；下一次捕捉或 reload(wiped) 換掉 */
  freshNoteId: string | null;
  /** 筆記列表還有下一頁（上一次載入剛好滿一頁） */
  notesHasMore: boolean;

  /* ── 車次②・日記（子畫面＝一天；契約 §3.6） ── */
  /** 本文的日；初值＝建立當下的 todayKey(dayStartHour)，第一次進日記子畫面時以當下設定重算 */
  diaryDay: string;
  /** listDiary(diaryDay)；noted_at ASC, created_at ASC */
  diaryEntries: NoteListItem[];
  /** 鍵盤 ↑↓／Enter／Delete 的目標篇 */
  diarySelectedId: string | null;
  /** 讀寫兩態：正在打字的那一篇（D-筆-24）；null＝全部閱讀態 */
  diaryEditingId: string | null;
  /** 「寫日記／補記／再寫一篇」草稿開著（內容在 UI 本地，不落庫；空的離開＝丟棄） */
  diaryDraftOpen: boolean;
  /** 頁內搜尋字；空＝日視圖 */
  diaryQuery: string;
  /** searchDiary 結果（diaryQuery 非空時） */
  diaryHits: NoteListItem[];
  diaryLoading: boolean;
  /* ── 車次②・當天足跡 ── */
  /** 足跡欄的日；setDiaryDay 時跟著設；可獨立翻 */
  fpDay: string;
  /** listFootprints(fpDay)＋時間塊插槽；null＝還沒載 */
  footprint: FootprintDay | null;
  /* ── 車次②・月份記號（頁務件月曆／手機月份條） ── */
  /** YYYY-MM；初值＝diaryDay 的月 */
  marksMonth: string;
  /** listDiaryMarks(月首, 月底)：{ [day]: 篇數 } */
  diaryMarks: Record<string, number>;
  /** listFootprintDays(月首, 月底, h) */
  footprintDays: string[];
  /* ── 車次③・近 12 週方格（D-筆-45；契約 §5.7） ── */
  /** listDiaryMarks(本週末日往前 83 天, 本週末日)：{ [day]: 篇數 }（週首照 uiStore.weekStart） */
  weekMarks: Record<string, number>;

  /* ── 載入 ── */
  setSection(s: NotesSection): void;
  /** Promise.all([noteRepo.listInbox(), noteRepo.listInboxTickets()]) */
  loadInbox(): Promise<void>;
  /** noteRepo.listNotes(notesQuery) */
  loadNotes(): Promise<void>;
  /** 設完立刻 loadNotes（搜尋由 UI 去抖 150ms 再叫） */
  setNotesQuery(q: NotesQuery): Promise<void>;
  /** 捲到底：同一個 notesQuery 再載下一頁（offset＝目前筆數），接在尾端 */
  loadMoreNotes(): Promise<void>;
  /** mount 檔的 reload 指到這裡（契約 §3.7） */
  reload(ctx: LineReloadContext): Promise<void>;

  /* ── 收件匣 ── */
  selectInbox(ref: InboxRef | null): void;
  /** update {inbox:false} → loadInbox → toast 7（undo: update {inbox:true}） */
  keepNote(id: string): Promise<void>;
  /** softDelete → loadInbox/loadNotes → toast 8／13（undo: restore） */
  deleteNote(id: string): Promise<void>;
  /** preview={source:"note", attach 預設＝筆記所掛的路線（route_id）…} */
  openPreviewFromNote(id: string): void;
  /** 車票：四個去處都轉呼叫 nodeStore，完成後 loadInbox */
  scheduleTicket(id: string, date: string): Promise<void>;
  attachTicket(id: string, parentId: string): Promise<void>;
  tagTicket(id: string, routeId: string): Promise<void>;
  /** nodeStore.deleteNode(id)（undo: nodeStore.undoDelete） */
  deleteTicket(id: string): Promise<void>;

  /* ── 筆記頁 ── */
  /** 換選取：若上一則是 draftNew 且空 ⇒ 丟棄；editing=false */
  selectNote(id: string | null): void;
  /** draftNew=true, selectedNoteId=null, editing=true */
  startNewNote(): void;
  setEditing(on: boolean): void;
  /** 內文／標題自動存檔入口（UI 去抖 500ms＋blur／Esc 立即）：draftNew 且內容非空 ⇒ create 後 selectedNoteId=新 id */
  saveNote(patch: NotePatch): Promise<void>;
  /** update {noted_at} */
  setNoteDate(id: string, notedAt: string): Promise<void>;
  /** update {node_id}（null＝摘掉） */
  setNoteAttach(id: string, nodeId: string | null): Promise<void>;
  /** ＝openPreviewFromNote */
  openPreviewFromNotePage(id: string): void;

  /* ── 捕捉 ── */
  /** 互斥規則見契約 §5.2；preview 開著時不開 */
  openCapture(stub?: CaptureStub): void;
  closeCapture(): void;
  /** 文字變了就把 confirmEsc 清掉；若 parseRoutePrefix().matched !== dismissedPrefix ⇒ dismissedPrefix=null */
  setCaptureText(text: string): void;
  setCaptureStub(stub: CaptureStub): void;
  /** nextStub 在 captureStubList("desktop") 間輪（內建四枚＋別線登記的；車次② D-筆-36） */
  cycleStub(dir: 1 | -1): void;
  /** dismissedPrefix = parseRoutePrefix(text).matched */
  dismissRoute(): void;
  /** 有內容且 !confirmEsc ⇒ confirmEsc=true；否則 closeCapture */
  escapeCapture(): void;
  /** 存檔分流（resolveDestination）。回 "empty"（沒內容）／"preview"（多行待辦 ⇒ 已開預覽）／"saved" */
  saveCapture(): Promise<"empty" | "preview" | "saved">;

  /* ── 變待辦預覽 ── */
  setPreviewLine(i: number, checked: boolean): void;
  setPreviewAttach(t: AttachTarget): void;
  setPreviewDate(d: string | null): void;
  cancelPreview(): void;
  confirmPreview(): Promise<void>;

  /* ── 車次②・日記動作 ── */
  /** 夾到 today；同時 fpDay=day、清編輯／草稿／選取、marksMonth=day 的月；然後 loadDiary＋loadFootprint（月變了再 loadMarks） */
  setDiaryDay(day: string): void;
  /** dir=1 且已在今天 ⇒ 不動 */
  stepDiaryDay(dir: 1 | -1): void;
  goDiaryToday(): void;
  loadDiary(): Promise<void>;
  selectDiaryEntry(id: string | null): void;
  setDiaryEditing(id: string | null): void;
  /** diaryDraftOpen=true、diaryEditingId=null（一次只編一處） */
  openDiaryDraft(): void;
  cancelDiaryDraft(): void;
  /** 草稿存檔：title 與 body 都空白 ⇒ 關草稿、不建不 toast、回 null；否則建在 diaryDay → toast 19；回新 id */
  saveDiaryDraft(input: { title: string; body: string }): Promise<string | null>;
  /** 既有篇的自動存檔（UI 去抖 500ms＋blur／Esc 立即）；只改 title／body，就地合併不整份重載 */
  saveDiaryEntry(id: string, patch: Pick<NotePatch, "title" | "body">): Promise<void>;
  /** 改歸屬日（0-5，只改 entry_date）→ toast 21（復原＝改回來） */
  setDiaryEntryDate(id: string, day: string): Promise<void>;
  /** softDelete → toast 20（復原＝restore） */
  deleteDiaryEntry(id: string): Promise<void>;
  /** 設完就 searchDiary（UI 去抖 150ms 再叫）；空字串 ⇒ diaryHits=[] */
  setDiaryQuery(q: string): Promise<void>;
  /** 搜尋結果點一則：跳到那天並選中那篇；diaryQuery 保留（Esc 才清） */
  openDiaryHit(id: string, day: string): void;
  /** 收件匣／筆記頁「記成日記」（0-10 就地改 kind；歸屬日＝dayKeyOf(noted_at, h)）→ toast 18（復原＝反向 patch） */
  noteToDiary(id: string): Promise<void>;
  /** 外部入口：setSection("diary")＋setDiaryDay(day) */
  openDiaryAt(day: string): void;
  /* ── 車次②・足跡動作 ── */
  /** 夾到 today；loadFootprint */
  setFpDay(day: string): void;
  /** dir=1 且已在今天 ⇒ 不動 */
  stepFpDay(dir: 1 | -1): void;
  /** fpDay = diaryDay */
  fpBackToDiaryDay(): void;
  /** listFootprints(fpDay, h)；blocks＝footprintBlocks 插槽（本車次恆 null） */
  loadFootprint(): Promise<void>;
  /* ── 車次②・記號 ── */
  /** 不可晚於今天的月；loadMarks */
  setMarksMonth(month: string): Promise<void>;
  /** listDiaryMarks＋listFootprintDays（marksMonth 的月首～月底） */
  loadMarks(): Promise<void>;
  /* ── 車次③ ── */
  /** 近 12 週方格的資料（契約 §5.7）；日記寫入後、進日記子畫面、同步重載時都會叫 */
  loadWeekMarks(): Promise<void>;
  /** 日期挑選器自畫月格的記號（0-6 甲、D-筆-46 修訂）：month（YYYY-MM）裡有日記的日子，升冪；失敗＝[]。不動 store 狀態 */
  diaryDaysOf(month: string): Promise<string[]>;
}

/* ───────── 純輔助（UI 也可用：捕捉框的路線票根與落點要即時顯示） ───────── */

/**
 * 捕捉框該畫的票根列（車次② D-筆-36）：內建（`CAPTURE_STUBS`）＋該殼通車的線登記的捕捉目的地 id。
 * 桌機 CaptureOverlay 傳 "desktop"、手機 MobileCaptureSheet 傳 "mobile"；Tab 輪替（`cycleStub`）用桌機這份。
 */
export function captureStubList(shell: "desktop" | "mobile"): CaptureStub[] {
  return [...CAPTURE_STUBS, ...lineCaptureTargets(shell).map((t) => t.id)];
}

/** 登記的票根 id → 它的 spec（內建票根或該線已不通車＝null）。兩殼都找：票根是哪一殼選的，store 不必知道 */
export function captureTargetOf(stub: CaptureStub): CaptureTargetSpec | null {
  if (isBuiltinStub(stub)) return null;
  return [...lineCaptureTargets("desktop"), ...lineCaptureTargets("mobile")].find((t) => t.id === stub) ?? null;
}

/** 捕捉框目前認到的路線前綴；主人取消過的（dismissedPrefix）不算 */
export function captureRouteOf(c: CaptureState, routes: readonly RouteLike[]): RoutePrefix | null {
  const p = parseRoutePrefix(c.text, routes);
  if (!p || p.matched === c.dismissedPrefix) return null;
  return p;
}

/* ───────── 內部輔助 ───────── */

/** 筆記列表一頁幾則（契約 §5.1：預設 200，捲到底再載下一頁） */
const NOTES_PAGE = 200;

const routesNow = (): readonly NodeRow[] => useNodeStore.getState().routes;
const todayNow = (): string => todayKey(useUiStore.getState().dayStartHour);
const routeName = (id: string | null | undefined): string =>
  (id && routesNow().find((r) => r.id === id)?.name) || "";

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e ?? "");
}

/** toast（契約 §5.8）：有復原動作就帶「復原」鈕 */
function toast(text: string, undo?: () => Promise<void>): void {
  useUiStore.getState().showToast(
    undo ? { message: text, actionLabel: "復原", onAction: () => void undo() } : { message: text },
  );
}

/** toast 15：任何寫入失敗（錯誤訊息有內容就吐它） */
function failToast(e: unknown): void {
  console.warn("notesStore 寫入失敗", e);
  toast(message(e).trim() || "存檔失敗——請再試一次");
}

/** 復原動作本身失敗也只 toast，不讓 Promise 漏成 unhandled rejection */
function safeUndo(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    try {
      await fn();
    } catch (e) {
      failToast(e);
    }
  };
}

/** 新筆記草稿的第一次 create 正在飛：之後的 saveNote 等它落地再 update，不重複建 */
let draftCreating: Promise<string> | null = null;
/** confirmPreview 不可重入（Ctrl+Enter 連按） */
let confirming = false;
/** saveDiaryDraft 不可重入（Ctrl+Enter 連按會建兩篇） */
let draftSaving = false;
/** 進過日記子畫面沒有（沒進過就不在同步重載時白查日記與足跡） */
let diaryTouched = false;

const dayStartNow = (): number => useUiStore.getState().dayStartHour;

/**
 * 近 12 週方格的區間（契約 §5.7）：以 weekStart（0＝週日、1＝週一）對齊的「本週末日」往前 83 天（共 84 天＝12 週）。
 */
function weekGridRange(today: string, weekStart: number): [string, string] {
  const [y, m, d] = today.split("-").map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  const end = addDays(today, 6 - ((dow - weekStart + 7) % 7));
  return [addDays(end, -83), end];
}

/** YYYY-MM → [月首, 月底] */
function monthRange(month: string): [string, string] {
  const days = monthDays(month);
  return [days[0], days[days.length - 1]];
}

export const useNotesStore = create<NotesStore>((set, get) => {
  /**
   * 收件匣車票的去處共用：動作 → 重載收件匣 → 判成敗。
   * nodeStore 的 reschedule 吞錯只寫 error，所以「票還在收件匣」也算沒成功。回 true＝成功。
   */
  async function ticketAction(
    id: string,
    run: () => Promise<{ ok: boolean; reason?: string } | void>,
  ): Promise<boolean> {
    let reason: string | undefined;
    try {
      const r = await run();
      if (r && !r.ok) reason = r.reason ?? "";
    } catch (e) {
      reason = message(e);
    }
    await get().loadInbox();
    if (reason === undefined && get().inboxTickets.some((t) => t.id === id)) {
      reason = useNodeStore.getState().error ?? "";
    }
    if (reason !== undefined) {
      failToast(new Error(reason));
      return false;
    }
    return true;
  }

  async function reloadLists(): Promise<void> {
    await Promise.all([get().loadInbox(), get().loadNotes()]);
  }

  /** 日記寫入後的重載：當天清單＋月份記號＋（有搜尋字時）搜尋結果 */
  async function reloadDiary(): Promise<void> {
    const q = get().diaryQuery;
    await Promise.all([
      get().loadDiary(),
      get().loadMarks(),
      get().loadWeekMarks(),
      q.trim() ? get().setDiaryQuery(q) : Promise.resolve(),
    ]);
  }

  /**
   * 寫入／撤回一篇日記之後：月份記號一律重載（側欄「日記 N」要跟著變，契約 §3.6、§5.1）；
   * 進過日記子畫面才連當天清單與搜尋結果一起重載。沒進過日記時 marksMonth 先對齊今天的月。
   */
  async function refreshAfterDiaryWrite(): Promise<void> {
    if (diaryTouched) {
      await reloadDiary();
      return;
    }
    set({ marksMonth: monthKey(todayNow()) });
    await Promise.all([get().loadMarks(), get().loadWeekMarks()]);
  }

  /**
   * 別線登記的票根存檔（D-筆-36）：找不到 spec（該線已不通車）或內容空白 ⇒ "empty"、框留著；
   * `save` throw ⇒ 框留著＋失敗 toast；回 null ⇒ 當空內容；成功 ⇒ 關框＋spec 給的 toast（有 undo 就帶復原）。
   */
  async function saveToTarget(c: CaptureState, p: RoutePrefix | null): Promise<"empty" | "saved"> {
    const spec = captureTargetOf(c.stub);
    if (!spec) return "empty";
    const text = c.text.replace(/\s+$/, "");
    const useRoute = spec.acceptsRoute && p !== null;
    const body = (useRoute ? p.body : text).replace(/\s+$/, "");
    if (!body.trim()) return "empty";
    let res: CaptureSaveResult | null;
    try {
      res = await spec.save({ text, body, routeId: useRoute ? p.route.id : null, dayKey: todayNow() });
    } catch (e) {
      failToast(e);
      return "empty";
    }
    if (!res) return "empty";
    set({ capture: null });
    toast(res.toast, res.undo ? safeUndo(res.undo) : undefined);
    return "saved";
  }

  const day0 = todayNow();

  return {
    section: "inbox",
    diaryDay: day0,
    diaryEntries: [],
    diarySelectedId: null,
    diaryEditingId: null,
    diaryDraftOpen: false,
    diaryQuery: "",
    diaryHits: [],
    diaryLoading: false,
    fpDay: day0,
    footprint: null,
    marksMonth: monthKey(day0),
    diaryMarks: {},
    footprintDays: [],
    weekMarks: {},
    inboxNotes: [],
    inboxTickets: [],
    inboxSelected: null,
    notes: [],
    notesQuery: {},
    selectedNoteId: null,
    editing: false,
    draftNew: false,
    loading: false,
    error: null,
    capture: null,
    preview: null,
    freshNoteId: null,
    notesHasMore: false,

    /* ── 載入 ── */
    setSection(s) {
      set({ section: s });
      // 第一次進日記：以「當下」的日界線設定重算今天再載（store 建立時 loadSettings 可能還沒回來）
      if (s === "diary" && !diaryTouched) {
        diaryTouched = true;
        get().goDiaryToday();
        void get().loadMarks();
      }
      if (s === "diary") void get().loadWeekMarks();
      // 車次③：主人自己切子畫面＝「回到剛才」失效（0-16）；第一次進荷札載 index（補掛由頁根 effect 的 ensureBackfill 做）
      const tags = useTagStore.getState();
      if (s !== "tags" && tags.back) useTagStore.setState({ back: null });
      // 每次進荷札都重載（不只第一次）：本機刪車票／筆記不會通知 tagStore，數量要在進頁時對上（真機代驗 10-15）
      if (s === "tags") void tags.loadIndex();
    },
    async loadInbox() {
      set({ loading: true });
      try {
        const [inboxNotes, inboxTickets] = await Promise.all([noteRepo.listInbox(), noteRepo.listInboxTickets()]);
        const sel = get().inboxSelected;
        // 選中的那一則已離開收件匣（被整理走／別台改掉）⇒ 清掉選取，免得鍵盤動作落在不存在的列上
        const stillThere =
          !sel ||
          (sel.kind === "note" ? inboxNotes.some((n) => n.id === sel.id) : inboxTickets.some((t) => t.id === sel.id));
        set({ inboxNotes, inboxTickets, loading: false, error: null, ...(stillThere ? {} : { inboxSelected: null }) });
      } catch (e) {
        console.warn("notesStore.loadInbox 失敗", e);
        set({ loading: false, error: message(e) });
      }
    },
    async loadNotes() {
      const q = get().notesQuery;
      const limit = q.limit ?? NOTES_PAGE;
      set({ loading: true });
      try {
        const notes = await noteRepo.listNotes({ ...q, limit, offset: 0 });
        if (get().notesQuery !== q) return; // 途中換了篩選／搜尋：以後到的那一趟為準
        set({ notes, notesHasMore: notes.length >= limit, loading: false, error: null });
      } catch (e) {
        console.warn("notesStore.loadNotes 失敗", e);
        set({ loading: false, error: message(e) });
      }
    },
    async setNotesQuery(q) {
      set({ notesQuery: q });
      await get().loadNotes();
    },
    async loadMoreNotes() {
      const { notesQuery: q, notes, notesHasMore } = get();
      if (!notesHasMore) return;
      const limit = q.limit ?? NOTES_PAGE;
      try {
        const more = await noteRepo.listNotes({ ...q, limit, offset: notes.length });
        if (get().notesQuery !== q) return; // 載的途中換了篩選／搜尋：丟掉這一頁
        const cur = get().notes;
        const seen = new Set(cur.map((n) => n.id));
        set({ notes: [...cur, ...more.filter((n) => !seen.has(n.id))], notesHasMore: more.length >= limit });
      } catch (e) {
        console.warn("notesStore.loadMoreNotes 失敗", e);
        set({ error: message(e) });
      }
    },
    async reload(ctx) {
      const has = (t: string) => ctx.wiped || ctx.changed.includes(t);
      if (ctx.wiped) {
        const today = todayNow();
        set({
          inboxSelected: null,
          selectedNoteId: null,
          editing: false,
          draftNew: false,
          capture: null,
          preview: null,
          freshNoteId: null,
          diarySelectedId: null,
          diaryEditingId: null,
          diaryDraftOpen: false,
          diaryQuery: "",
          diaryHits: [],
          diaryDay: today,
          fpDay: today,
          marksMonth: monthKey(today),
        });
      }
      // 車票區與 JOIN 都依賴 nodes；足跡另看 work_logs／occurrences（車次② §3.6）
      const lists = has("notes") || has("nodes");
      const diary = diaryTouched && has("notes");
      const fp = diaryTouched && (has("nodes") || has("work_logs") || has("occurrences"));
      if (lists || diary || fp) {
        try {
          await Promise.all([
            lists ? reloadLists() : Promise.resolve(),
            diary ? reloadDiary() : Promise.resolve(),
            fp ? get().loadFootprint() : Promise.resolve(),
            fp && !diary ? get().loadMarks() : Promise.resolve(),
          ]);
        } catch (e) {
          console.warn("notesStore.reload 失敗", e);
        }
      }
      // 車次③（契約 §3.6）：荷札的 index 與頁面狀態
      await useTagStore.getState().reload(ctx);
    },

    /* ── 收件匣 ── */
    selectInbox: (ref) => set({ inboxSelected: ref }),
    async keepNote(id) {
      try {
        await noteRepo.update(id, { inbox: 0 });
      } catch (e) {
        failToast(e);
        return;
      }
      await reloadLists();
      toast(
        "已留作筆記，可以在「筆記」裡找到",
        safeUndo(async () => {
          await noteRepo.update(id, { inbox: 1 });
          await reloadLists();
        }),
      );
    },
    async deleteNote(id) {
      try {
        await noteRepo.softDelete(id);
      } catch (e) {
        failToast(e);
        return;
      }
      if (get().selectedNoteId === id) set({ selectedNoteId: null, editing: false });
      await reloadLists();
      toast(
        "已刪除",
        safeUndo(async () => {
          await noteRepo.restore([id]);
          await reloadLists();
        }),
      );
    },
    openPreviewFromNote(id) {
      const s = get();
      if (s.capture) return; // 捕捉框開著時不疊第二層
      const n = s.inboxNotes.find((x) => x.id === id) ?? s.notes.find((x) => x.id === id);
      if (!n) return;
      const text = (n.body.trim() ? n.body : (n.title ?? "")).replace(/\s+$/, "");
      // 預設掛筆記所屬的路線；路線本身已不在（原節點已刪除的情形）就不掛
      const routeId = n.route_id && routesNow().some((r) => r.id === n.route_id) ? n.route_id : null;
      set({
        preview: {
          source: "note",
          noteId: n.id,
          text,
          lines: splitTodoLines(text),
          single: lineCount(text) <= 1,
          attach: { routeId, nodeId: null, nodeKind: routeId ? "route" : null },
          scheduledOn: todayNow(),
        },
      });
    },
    async scheduleTicket(id, date) {
      const ok = await ticketAction(id, () => useNodeStore.getState().reschedule(id, date));
      if (!ok) return;
      toast(
        date === todayNow() ? "已排進今日" : `已排到 ${fmtMonthDay(date)}`,
        safeUndo(async () => {
          await useNodeStore.getState().reschedule(id, null);
          await get().loadInbox();
        }),
      );
    },
    async attachTicket(id, parentId) {
      const before = get().inboxTickets.find((t) => t.id === id);
      let parentName = "";
      const ok = await ticketAction(id, async () => {
        const parent = await nodeRepo.getNode(parentId);
        if (!parent || parent.deleted_at) return { ok: false, reason: "那班列車已經不在了" };
        parentName = parent.name;
        const routeId = parent.kind === "route" ? parent.id : parent.route_id;
        const siblings = routeId
          ? (await nodeRepo.listRouteTree(routeId)).filter((n) => n.parent_id === parentId)
          : [];
        const index = siblings.reduce((m, n) => Math.max(m, n.position), -1) + 1;
        return useNodeStore.getState().moveNode(id, parentId, index);
      });
      if (!ok) return;
      const origPos = before?.position ?? 0;
      toast(
        `已掛進 ${parentName}`,
        safeUndo(async () => {
          await useNodeStore.getState().moveNode(id, null, origPos);
          // 搬回根層時 move 會把列車所屬路線留成「路線標籤」（臨時車票保留路線標籤的規則）；
          // 收件匣的票本來沒有標籤，一併清掉才回得到收件匣
          if (!before?.route_id) await useNodeStore.getState().setRouteTag(id, null);
          await get().loadInbox();
        }),
      );
    },
    async tagTicket(id, routeId) {
      const ok = await ticketAction(id, () => useNodeStore.getState().setRouteTag(id, routeId));
      if (!ok) return;
      toast(
        `已掛上 ${routeName(routeId)}`,
        safeUndo(async () => {
          await useNodeStore.getState().setRouteTag(id, null);
          await get().loadInbox();
        }),
      );
    },
    async deleteTicket(id) {
      const name = get().inboxTickets.find((t) => t.id === id)?.name ?? (await nodeRepo.getNode(id))?.name ?? "";
      const removed = await useNodeStore.getState().deleteNode(id);
      await get().loadInbox();
      if (!removed.length) {
        failToast(new Error(useNodeStore.getState().error ?? ""));
        return;
      }
      // 沿今日頁同一句（useTodayController.ts 的刪除 toast）
      toast(
        `已刪除『${name}』${removed.length > 1 ? `（含 ${removed.length - 1} 個子項）` : ""}`,
        safeUndo(async () => {
          await useNodeStore.getState().undoDelete();
          await get().loadInbox();
        }),
      );
    },

    /* ── 筆記頁 ── */
    selectNote(id) {
      // draftNew 還沒落庫（空筆記不建）：換選取＝丟棄草稿
      set({ selectedNoteId: id, editing: false, draftNew: false });
    },
    startNewNote: () => set({ draftNew: true, selectedNoteId: null, editing: true }),
    setEditing: (on) => set({ editing: on }),
    async saveNote(patch) {
      const s = get();
      try {
        if (s.draftNew && !s.selectedNoteId) {
          // 正在 create 的途中又來一筆（去抖存檔＋blur 連發）⇒ 等它落地後當成 update，不重複建
          if (draftCreating) {
            const createdId = await draftCreating;
            await noteRepo.update(createdId, patch);
            await get().loadNotes();
            return;
          }
          const body = (patch.body ?? "").replace(/\s+$/, "");
          const title = patch.title ?? null;
          if (!body.trim() && !(title ?? "").trim()) return; // 空筆記不建、不吐 toast
          // 正在依路線篩選時新建＝掛那條路線（不然一建好就從目前的列表消失；照原型 newNote）
          const filter = s.notesQuery.routeId;
          const nodeId = patch.node_id ?? (filter && filter !== "none" ? filter : null);
          draftCreating = noteRepo
            .create({ kind: "note", body, title, nodeId, inbox: false, notedAt: patch.noted_at })
            .then((row) => row.id);
          try {
            const createdId = await draftCreating;
            // 還停在這份草稿上才接手選取（途中換了選取＝主人已經離開，筆記照樣留著）
            if (get().draftNew && !get().selectedNoteId) set({ selectedNoteId: createdId, draftNew: false });
          } finally {
            draftCreating = null;
          }
          await get().loadNotes();
          return;
        }
        const id = s.selectedNoteId;
        if (!id) return;
        await noteRepo.update(id, patch);
        if (patch.noted_at !== undefined || patch.node_id !== undefined || patch.inbox !== undefined) {
          await reloadLists(); // 排序／JOIN／歸屬會變：整份重載
          return;
        }
        // 只改標題／內文：就地補進列表（不重載——去抖存檔每 500ms 一次，整份換掉會閃）
        const now = new Date().toISOString();
        const merge = (n: NoteListItem): NoteListItem =>
          n.id !== id
            ? n
            : {
                ...n,
                ...(patch.body !== undefined ? { body: patch.body } : {}),
                ...(patch.title !== undefined ? { title: patch.title && patch.title.trim() ? patch.title : null } : {}),
                updated_at: now,
              };
        set({ notes: get().notes.map(merge), inboxNotes: get().inboxNotes.map(merge) });
      } catch (e) {
        failToast(e);
      }
    },
    async setNoteDate(id, notedAt) {
      try {
        await noteRepo.update(id, { noted_at: notedAt });
      } catch (e) {
        failToast(e);
        return;
      }
      await reloadLists();
    },
    async setNoteAttach(id, nodeId) {
      try {
        await noteRepo.update(id, { node_id: nodeId });
      } catch (e) {
        failToast(e);
        return;
      }
      await reloadLists();
    },
    openPreviewFromNotePage(id) {
      get().openPreviewFromNote(id);
    },

    /* ── 捕捉 ── */
    openCapture(stub) {
      const s = get();
      if (s.preview) return;
      if (s.capture) {
        if (stub) set({ capture: { ...s.capture, stub } });
        return;
      }
      // 互斥（契約 §5.2）：有輸入或決定的卡片開著就不開（Esc 會打架）；指引疊層與快速跳轉先關再開
      const ui = useUiStore.getState();
      if (ui.confirm || ui.routeDialog || ui.completeCardFor || ui.settingsOpen) return;
      if (ui.quickJumpOpen) ui.setQuickJumpOpen(false);
      if (ui.hotkeyGuideOpen) ui.setHotkeyGuideOpen(false);
      set({ capture: { text: "", stub: stub ?? "inbox", dismissedPrefix: null, confirmEsc: false } });
    },
    closeCapture: () => set({ capture: null }),
    setCaptureText(text) {
      const c = get().capture;
      if (!c) return;
      let dismissedPrefix = c.dismissedPrefix;
      if (dismissedPrefix !== null && parseRoutePrefix(text, routesNow())?.matched !== dismissedPrefix) {
        dismissedPrefix = null;
      }
      set({ capture: { ...c, text, dismissedPrefix, confirmEsc: false } });
    },
    setCaptureStub(stub) {
      const c = get().capture;
      if (c) set({ capture: { ...c, stub } });
    },
    cycleStub(dir) {
      const c = get().capture;
      // 只有桌機有 Tab；手機直接點票根（setCaptureStub）
      if (c) set({ capture: { ...c, stub: nextStub(c.stub, dir, captureStubList("desktop")) } });
    },
    dismissRoute() {
      const c = get().capture;
      if (!c) return;
      set({ capture: { ...c, dismissedPrefix: parseRoutePrefix(c.text, routesNow())?.matched ?? null } });
    },
    escapeCapture() {
      const c = get().capture;
      if (!c) return;
      if (c.text.trim() && !c.confirmEsc) set({ capture: { ...c, confirmEsc: true } });
      else set({ capture: null });
    },
    async saveCapture() {
      const c = get().capture;
      if (!c) return "empty";
      const p = captureRouteOf(c, routesNow());
      if (!isBuiltinStub(c.stub)) return saveToTarget(c, p);
      const dest = resolveDestination(c.stub, !!p);
      const body = (dest.consumePrefix && p ? p.body : c.text).replace(/\s+$/, "");
      if (!body.trim()) return "empty";
      if (needsPreview(c.stub, body)) {
        set({
          capture: null,
          preview: {
            source: "capture",
            noteId: null,
            text: body,
            lines: splitTodoLines(body),
            single: false,
            attach: { routeId: p ? p.route.id : null, nodeId: null, nodeKind: p ? "route" : null },
            scheduledOn: todayNow(),
          },
        });
        return "preview";
      }
      const route = dest.withRoute && p ? p.route : null;
      const text = captureToast(c.stub, dest, route?.name ?? "").text;
      try {
        if (dest.target === "diary") {
          // 車次② §3.6：存檔當下才算今天（不是開框時）；原文照留（consumePrefix=false，前綴也進內文）、不掛路線
          const day = todayNow();
          const row = await noteRepo.create({ kind: "diary", body, inbox: false, entryDate: day });
          set({ capture: null });
          await Promise.all([refreshAfterDiaryWrite(), useTagStore.getState().syncNoteTags(row.id, body)]);
          toast(
            diaryToast("capture", day, day),
            safeUndo(async () => {
              await noteRepo.softDelete(row.id);
              await refreshAfterDiaryWrite();
            }),
          );
          return "saved";
        }
        if (dest.target === "today") {
          const row = await nodeRepo.create({
            kind: "ticket",
            name: body,
            parentId: null,
            routeTagId: route?.id ?? null,
            scheduledOn: todayNow(),
          });
          set({ capture: null });
          await useNodeStore.getState().refresh();
          toast(
            text,
            safeUndo(async () => {
              await nodeRepo.softDelete(row.id);
              await useNodeStore.getState().refresh();
            }),
          );
          return "saved";
        }
        const inbox = dest.target === "inbox";
        const row = await noteRepo.create({ kind: "note", body, inbox, nodeId: route?.id ?? null });
        set({ capture: null, ...(inbox ? { freshNoteId: row.id } : {}) });
        await Promise.all([inbox ? get().loadInbox() : get().loadNotes(), useTagStore.getState().syncNoteTags(row.id, body)]);
        toast(
          text,
          safeUndo(async () => {
            await noteRepo.softDelete(row.id);
            await reloadLists();
          }),
        );
        return "saved";
      } catch (e) {
        failToast(e); // capture 留著（內容沒丟），主人可以再按一次
        return "empty";
      }
    },

    /* ── 變待辦預覽 ── */
    setPreviewLine(i, checked) {
      const pv = get().preview;
      if (!pv || !pv.lines[i]) return;
      const lines = pv.lines.map((l, k) => (k === i ? { ...l, checked } : l));
      set({ preview: { ...pv, lines } });
    },
    setPreviewAttach(t) {
      const pv = get().preview;
      if (pv) set({ preview: { ...pv, attach: t } });
    },
    setPreviewDate(d) {
      const pv = get().preview;
      if (pv) set({ preview: { ...pv, scheduledOn: d } });
    },
    cancelPreview: () => set({ preview: null }),
    async confirmPreview() {
      const pv = get().preview;
      if (!pv || confirming) return;
      const items = (
        pv.single ? [pv.lines[0]?.text ?? pv.text.trim()] : pv.lines.filter((l) => l.checked).map((l) => l.text)
      ).filter((t) => t.trim());
      if (!items.length) return;
      const { attach, scheduledOn } = pv;
      // 列車／車廂＝掛進樹；路線或支線＝根層臨時車票帶路線標籤（支線視同路線，Plan 附錄 M1）
      const parentId =
        (attach.nodeKind === "train" || attach.nodeKind === "car") && attach.nodeId ? attach.nodeId : null;
      const routeTagId = parentId ? undefined : attach.routeId;
      const noteId = pv.source === "note" ? pv.noteId : null;
      confirming = true;
      const created: string[] = [];
      try {
        const parentName = parentId ? ((await nodeRepo.getNode(parentId))?.name ?? "") : "";
        for (let k = 0; k < items.length; k++) {
          try {
            const row = await nodeRepo.create({ kind: "ticket", name: items[k], parentId, routeTagId, scheduledOn });
            created.push(row.id);
          } catch (e) {
            console.warn("notesStore.confirmPreview 建票失敗", e);
            if (!created.length) {
              failToast(e); // 一張都沒建：預覽留著，主人可以直接再按一次
              return;
            }
            // 契約 0-9／toast 16：已建的留著、筆記不刪；預覽收起（留著再按會重複建）
            set({ preview: null });
            await useNodeStore.getState().refresh();
            await reloadLists();
            const done = [...created];
            toast(
              `建到第 ${k + 1} 張時失敗，已建的 ${k} 張留著`,
              safeUndo(async () => {
                for (const x of done) await nodeRepo.softDelete(x);
                await useNodeStore.getState().refresh();
                await get().loadInbox();
              }),
            );
            return;
          }
        }
        if (noteId) {
          try {
            await noteRepo.softDelete(noteId);
          } catch (e) {
            failToast(e); // 票都建好了、筆記沒刪掉：留著讓主人自己刪（不回滾）
          }
        }
        set({
          preview: null,
          ...(noteId && get().selectedNoteId === noteId ? { selectedNoteId: null, editing: false } : {}),
        });
        await useNodeStore.getState().refresh();
        await reloadLists();
        const where = previewDestination(
          { routeId: routeTagId ?? null, parentId, scheduledOn },
          todayNow(),
          { route: routeName(routeTagId), parent: parentName },
        );
        toast(
          `已建立 ${created.length} 張車票 → ${where}`,
          safeUndo(async () => {
            for (const x of created) await nodeRepo.softDelete(x);
            if (noteId) await noteRepo.restore([noteId]);
            await useNodeStore.getState().refresh();
            await reloadLists();
          }),
        );
      } finally {
        confirming = false;
      }
    },

    /* ── 車次②・日記 ── */
    setDiaryDay(day) {
      diaryTouched = true;
      const d = clampDay(day, todayNow());
      const monthChanged = monthKey(d) !== get().marksMonth;
      set({
        diaryDay: d,
        fpDay: d,
        diaryEditingId: null,
        diaryDraftOpen: false,
        diarySelectedId: null,
        marksMonth: monthKey(d),
      });
      void get().loadDiary();
      void get().loadFootprint();
      if (monthChanged) void get().loadMarks();
    },
    stepDiaryDay(dir) {
      const { diaryDay } = get();
      if (dir === 1 && diaryDay >= todayNow()) return;
      get().setDiaryDay(addDays(diaryDay, dir));
    },
    goDiaryToday() {
      get().setDiaryDay(todayNow());
    },
    async loadDiary() {
      const day = get().diaryDay;
      set({ diaryLoading: true });
      try {
        const fresh = await noteRepo.listDiary(day);
        if (get().diaryDay !== day) return; // 途中換了日：以後到的那一趟為準
        const sel = get().diarySelectedId;
        const editing = get().diaryEditingId;
        // 正在打字的那篇被別台刪掉或搬走：先留在畫面上（契約 7.4-8「沒在打字時才跟上」），
        // 離開編輯時 setDiaryEditing(null) 會重載一次，那時才消失
        const orphan =
          editing && !fresh.some((n) => n.id === editing) ? get().diaryEntries.find((n) => n.id === editing) : undefined;
        const diaryEntries = orphan
          ? [...fresh, orphan].sort((a, b) => a.noted_at.localeCompare(b.noted_at) || a.created_at.localeCompare(b.created_at))
          : fresh;
        set({
          diaryEntries,
          diaryLoading: false,
          error: null,
          // 選中的那篇已不在這天（被刪、改日期、別台改掉）⇒ 清掉，免得鍵盤動作落在不存在的列上
          ...(sel && sel !== editing && !diaryEntries.some((n) => n.id === sel) ? { diarySelectedId: null } : {}),
          ...(editing && !diaryEntries.some((n) => n.id === editing) ? { diaryEditingId: null } : {}),
        });
      } catch (e) {
        console.warn("notesStore.loadDiary 失敗", e);
        set({ diaryLoading: false, error: message(e) });
      }
    },
    selectDiaryEntry: (id) => set({ diarySelectedId: id }),
    setDiaryEditing(id) {
      const prev = get().diaryEditingId;
      set({ diaryEditingId: id });
      // 離開編輯：若那篇在打字期間被別台刪掉／搬走，loadDiary 曾把它留著，這裡重載讓它照實消失
      if (prev && prev !== id && !id) void get().loadDiary();
    },
    openDiaryDraft: () => set({ diaryDraftOpen: true, diaryEditingId: null }),
    cancelDiaryDraft: () => set({ diaryDraftOpen: false }),
    async saveDiaryDraft(input) {
      const body = input.body.replace(/\s+$/, "");
      const title = input.title;
      if (!body.trim() && !title.trim()) {
        set({ diaryDraftOpen: false }); // 空草稿＝丟棄，不建不 toast（原型施工決定 14）
        return null;
      }
      if (draftSaving) return null;
      draftSaving = true;
      const day = get().diaryDay;
      try {
        const row = await noteRepo.create({ kind: "diary", body, title, inbox: false, entryDate: day });
        set({ diaryDraftOpen: false, diarySelectedId: row.id });
        await Promise.all([reloadDiary(), useTagStore.getState().syncNoteTags(row.id, body)]);
        toast(
          diaryToast("draft", day, todayNow()),
          safeUndo(async () => {
            await noteRepo.softDelete(row.id);
            await reloadDiary();
          }),
        );
        return row.id;
      } catch (e) {
        failToast(e); // 草稿留著（內容在 UI 本地），主人可以再按一次
        return null;
      } finally {
        draftSaving = false;
      }
    },
    async saveDiaryEntry(id, patch) {
      try {
        await noteRepo.update(id, patch);
      } catch (e) {
        failToast(e);
        return;
      }
      // 只改標題／內文：就地合併（去抖存檔每 500ms 一次，整份換掉會閃；與 saveNote 同法）
      const now = new Date().toISOString();
      const merge = (n: NoteListItem): NoteListItem =>
        n.id !== id
          ? n
          : {
              ...n,
              ...(patch.body !== undefined ? { body: patch.body } : {}),
              ...(patch.title !== undefined ? { title: patch.title && patch.title.trim() ? patch.title : null } : {}),
              updated_at: now,
            };
      set({ diaryEntries: get().diaryEntries.map(merge), diaryHits: get().diaryHits.map(merge) });
    },
    async setDiaryEntryDate(id, day) {
      const d = clampDay(day, todayNow());
      const orig =
        get().diaryEntries.find((n) => n.id === id)?.entry_date ?? (await noteRepo.getNote(id))?.entry_date ?? null;
      if (!orig || orig === d) return;
      // 自己改日期＝那篇本來就該從這天離開，不走「編輯中先留著」
      if (get().diaryEditingId === id) set({ diaryEditingId: null });
      try {
        await noteRepo.update(id, { entry_date: d });
      } catch (e) {
        failToast(e);
        return;
      }
      await reloadDiary();
      toast(
        `已改到 ${fmtMonthDay(d)}`,
        safeUndo(async () => {
          await noteRepo.update(id, { entry_date: orig });
          await reloadDiary();
        }),
      );
    },
    async deleteDiaryEntry(id) {
      try {
        await noteRepo.softDelete(id);
      } catch (e) {
        failToast(e);
        return;
      }
      const s = get();
      if (s.diarySelectedId === id || s.diaryEditingId === id) {
        set({
          ...(s.diarySelectedId === id ? { diarySelectedId: null } : {}),
          ...(s.diaryEditingId === id ? { diaryEditingId: null } : {}),
        });
      }
      await reloadDiary();
      toast(
        "已刪除日記",
        safeUndo(async () => {
          await noteRepo.restore([id]);
          await reloadDiary();
        }),
      );
    },
    async setDiaryQuery(q) {
      set({ diaryQuery: q });
      if (!q.trim()) {
        set({ diaryHits: [] });
        return;
      }
      try {
        const hits = await noteRepo.searchDiary({ query: q });
        if (get().diaryQuery !== q) return; // 打字途中又變了：以後到的那一趟為準
        set({ diaryHits: hits });
      } catch (e) {
        console.warn("notesStore.setDiaryQuery 失敗", e);
        set({ error: message(e) });
      }
    },
    openDiaryHit(id, day) {
      get().setDiaryDay(day);
      set({ diarySelectedId: id }); // setDiaryDay 會清選取；loadDiary 回來時那篇在清單裡，選取保留
    },
    async noteToDiary(id) {
      const s = get();
      const n =
        s.inboxNotes.find((x) => x.id === id) ?? s.notes.find((x) => x.id === id) ?? (await noteRepo.getNote(id));
      if (!n || n.kind !== "note") return;
      const day = dayKeyOf(n.noted_at, dayStartNow());
      const orig = { inbox: n.inbox, node_id: n.node_id };
      try {
        // 0-10：就地改 kind（id 不變、歷史不變）；日記不掛節點（D-筆-22）、不在收件匣
        await noteRepo.update(id, { kind: "diary", entry_date: day, inbox: 0, node_id: null });
      } catch (e) {
        failToast(e);
        return;
      }
      if (get().selectedNoteId === id) set({ selectedNoteId: null, editing: false });
      if (get().inboxSelected?.id === id) set({ inboxSelected: null });
      await Promise.all([reloadLists(), refreshAfterDiaryWrite()]);
      toast(
        diaryToast("convert", day, todayNow()),
        safeUndo(async () => {
          await noteRepo.update(id, { kind: "note", entry_date: null, inbox: orig.inbox, node_id: orig.node_id });
          await Promise.all([reloadLists(), refreshAfterDiaryWrite()]);
        }),
      );
    },
    openDiaryAt(day) {
      diaryTouched = true;
      set({ section: "diary" });
      get().setDiaryDay(day);
      void get().loadMarks();
    },

    /* ── 車次②・足跡 ── */
    setFpDay(day) {
      set({ fpDay: clampDay(day, todayNow()) });
      void get().loadFootprint();
    },
    stepFpDay(dir) {
      const { fpDay } = get();
      if (dir === 1 && fpDay >= todayNow()) return;
      get().setFpDay(addDays(fpDay, dir));
    },
    fpBackToDiaryDay() {
      get().setFpDay(get().diaryDay);
    },
    async loadFootprint() {
      const day = get().fpDay;
      const h = dayStartNow();
      try {
        const f = await noteRepo.listFootprints(day, h);
        const blocks = dayBlocksProvider ? await dayBlocksProvider(day, h) : null;
        if (get().fpDay !== day) return;
        set({ footprint: { ...f, blocks } });
      } catch (e) {
        console.warn("notesStore.loadFootprint 失敗", e);
        set({ error: message(e) });
      }
    },

    /* ── 車次②・記號 ── */
    async setMarksMonth(month) {
      const cap = monthKey(todayNow());
      set({ marksMonth: month > cap ? cap : month });
      await get().loadMarks();
    },
    async loadMarks() {
      const month = get().marksMonth;
      const [from, to] = monthRange(month);
      try {
        const [diaryMarks, footprintDays] = await Promise.all([
          noteRepo.listDiaryMarks(from, to),
          noteRepo.listFootprintDays(from, to, dayStartNow()),
        ]);
        if (get().marksMonth !== month) return;
        set({ diaryMarks, footprintDays });
      } catch (e) {
        console.warn("notesStore.loadMarks 失敗", e);
        set({ error: message(e) });
      }
    },

    /* ── 車次③・近 12 週方格 ── */
    async loadWeekMarks() {
      const [from, to] = weekGridRange(todayNow(), useUiStore.getState().weekStart);
      try {
        const weekMarks = await noteRepo.listDiaryMarks(from, to);
        set({ weekMarks });
      } catch (e) {
        console.warn("notesStore.loadWeekMarks 失敗", e);
      }
    },
    async diaryDaysOf(month) {
      const [from, to] = monthRange(month);
      try {
        return await noteRepo.listDiaryDays(from, to);
      } catch (e) {
        console.warn("notesStore.diaryDaysOf 失敗", e);
        return [];
      }
    },
  };
});

