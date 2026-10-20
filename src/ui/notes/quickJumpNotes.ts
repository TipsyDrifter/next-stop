/**
 * NOTES_QJ_NOTES／NOTES_QJ_DIARY——Ctrl+P 的「筆記」「日記」兩組結果（桌機；旅客筆記車次④契約 0-3 甲、§5.2）。
 *
 * 純邏輯、不畫：整合席在 `notes.mount.tsx` 把 `quickJump` 填成 `[NOTES_QUICK_JUMP, NOTES_QJ_NOTES, NOTES_QJ_DIARY]`
 * （三組順序＝荷札、筆記、日記）。
 *   沒有 `prefix` ⇒ 只在「一般結果之後的附加組」出現，每組 `limit`（QuickJump 給 4）列；打字要比對 title／body（LIKE 子字串）
 *   空字不查（附加組模式本來就只在有字時呼叫；保險回空）
 *   筆記列＝標題＋「M/D・路線名」；日記列＝「M/D（週X）」＋摘要；工作日誌不搜（Plan 第四節）
 *   收件匣裡的筆記也算筆記（`searchQuick` 不加 inbox 條件）；選了＝切到旅客筆記頁，再走既有 `goNote`／`goDiary`
 *   （在收件匣的就切收件匣選中，`tags/jump.ts`）；Ctrl+P 沒有「‹ 回到剛才」（那是荷札頁的機制，0-15）
 * 提供者 id 與荷札的 `notes.tags` 不重複（QuickJump 用 `<id>:<hit.id>` 當列 key）。
 * 磨光①：兩組都登記 `shells: ["desktop","mobile"]`，手機搜尋（MobileQuickJump）也列；手機選筆記改走 `requestMobileOpenNote`（開整頁）。
 */
import type { QuickJumpHit, QuickJumpProviderSpec } from "../../lines/types";
import { noteRepo } from "../../data/noteRepo";
import type { NoteListItem } from "../../data/noteRepository";
import type { NoteKind } from "../../domain/notes";
import { quickHitLabel } from "../../domain/notes";
import { dayKeyOf } from "../../lib/date";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { useNotesStore } from "../../store/notesStore";
import { goDiary, goNote } from "./tags/jump";
import { notesFlush } from "./notesFlush";

/** 目前是不是手機殼（Ctrl+P 只有桌機；手機搜尋〔磨光①〕也走這兩組） */
function isMobileShell(): boolean {
  return typeof document !== "undefined" && document.documentElement.getAttribute("data-shell") === "mobile";
}

/** 切到旅客筆記頁（先收掉編輯中的草稿，與荷札四個入口同一個順序） */
async function openNotesPage(): Promise<void> {
  await notesFlush.fn?.();
  const ui = useUiStore.getState();
  if (isMobileShell()) ui.setMobileTab("notes");
  else ui.setPage("notes");
}

/** 選了一則筆記：切頁 → `goNote`（清篩選、翻頁找到那則、在收件匣就切收件匣） */
export async function jumpNote(id: string): Promise<void> {
  if (isMobileShell()) {
    // 手機搜尋（磨光①）：筆記整頁開不開是 MobileNotes 的本地狀態，走它的請求（同路線圖詳情的筆記列，0-12；
    // 清篩選、翻頁找、在收件匣就切收件匣都在 MobileNotes 那支 effect 裡）
    await notesFlush.fn?.();
    useNotesStore.getState().requestMobileOpenNote(id);
    useUiStore.getState().setMobileTab("notes");
    return;
  }
  await openNotesPage();
  await goNote(id);
}

/** 選了一篇日記：切頁 → `goDiary`（到那天、選中那篇） */
export async function jumpDiary(id: string, day: string): Promise<void> {
  await openNotesPage();
  await goDiary(id, day);
}

function hitOf(n: NoteListItem, glyph: string, go: () => Promise<void>): QuickJumpHit {
  const ui = useUiStore.getState();
  const { label, aside } = quickHitLabel(n, {
    dayOf: (iso) => dayKeyOf(iso, ui.dayStartHour),
    routeName: (routeId) => useNodeStore.getState().routes.find((r) => r.id === routeId)?.name ?? null,
  });
  return { id: n.id, label, aside, glyph: { text: glyph }, go };
}

async function searchKind(kind: NoteKind, term: string, limit: number): Promise<NoteListItem[]> {
  const t = term.trim();
  if (!t) return [];
  try {
    return await noteRepo.searchQuick(kind, t, limit);
  } catch (e) {
    // 查詢失敗不擋 Ctrl+P 其他組：這一組當作沒有結果
    console.warn("Ctrl+P 搜尋" + (kind === "diary" ? "日記" : "筆記") + "失敗", e);
    return [];
  }
}

export const NOTES_QJ_NOTES: QuickJumpProviderSpec = {
  id: "notes.notes",
  group: "筆記",
  // go() 自己分殼（手機切 tab、開整頁）⇒ 手機搜尋也列（磨光①，契約 §0-4）
  shells: ["desktop", "mobile"],
  async search(term, limit) {
    const rows = await searchKind("note", term, limit);
    return rows.map((n) => hitOf(n, "記", () => jumpNote(n.id)));
  },
};

export const NOTES_QJ_DIARY: QuickJumpProviderSpec = {
  id: "notes.diary",
  group: "日記",
  // go() 自己分殼（`openNotesPage` 手機切 tab）⇒ 手機搜尋也列
  shells: ["desktop", "mobile"],
  async search(term, limit) {
    const rows = await searchKind("diary", term, limit);
    const dsh = useUiStore.getState().dayStartHour;
    // 日記一定有 entry_date；萬一缺（壞資料）就退回寫下它的那個日界線日，免得 openDiaryAt("") 把畫面弄壞
    return rows.map((n) => hitOf(n, "日", () => jumpDiary(n.id, n.entry_date || dayKeyOf(n.noted_at, dsh))));
  },
};
