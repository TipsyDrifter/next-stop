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
 * 建車票一律經既有 `nodeRepo.create`／`nodeStore` 的動作（D-筆-18）；變待辦不是單一交易（契約 0-9）：
 * 中途失敗＝已建的票留著、筆記不刪、toast 說明＋復原鈕刪掉已建的。
 */
import { create } from "zustand";
import { nodeRepo } from "../data";
import { noteRepo } from "../data/noteRepo";
import { useNodeStore } from "./nodeStore";
import { useUiStore } from "./uiStore";
import { todayKey } from "../lib/date";
import type { LineReloadContext } from "../lines/types";
import type { NodeRow } from "../domain";
import {
  captureToast,
  fmtMonthDay,
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
  /** 車次①值域 "inbox" | "todo" | "note"（"diary" 型別保留、UI 不顯示） */
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

export interface NotesStore {
  /* ── 子畫面與列表 ── */
  section: "inbox" | "notes";
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

  /* ── 載入 ── */
  setSection(s: "inbox" | "notes"): void;
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
  /** nextStub（車次①在 ["inbox","todo","note"] 三枚間輪） */
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
}

/* ───────── 純輔助（UI 也可用：捕捉框的路線票根與落點要即時顯示） ───────── */

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

  return {
    section: "inbox",
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
    setSection: (s) => set({ section: s }),
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
      if (ctx.wiped) {
        set({
          inboxSelected: null,
          selectedNoteId: null,
          editing: false,
          draftNew: false,
          capture: null,
          preview: null,
          freshNoteId: null,
        });
      } else if (!ctx.changed.includes("notes") && !ctx.changed.includes("nodes")) {
        return; // 車票區與 JOIN 都依賴 nodes；兩者都沒動就不重載
      }
      try {
        await reloadLists();
      } catch (e) {
        console.warn("notesStore.reload 失敗", e);
      }
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
      if (c) set({ capture: { ...c, stub: nextStub(c.stub, dir) } });
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
      // 車次①捕捉框不顯示日記票根（CAPTURE_STUBS 只有三枚）；萬一進來，當作沒存、框留著
      if (dest.target === "diary") return "empty";
      const route = dest.withRoute && p ? p.route : null;
      const text = captureToast(c.stub, dest, route?.name ?? "").text;
      try {
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
        await (inbox ? get().loadInbox() : get().loadNotes());
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
  };
});

