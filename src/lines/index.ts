/**
 * 三線登記處的彙整（並行地基・契約 §5.1）。純資料：probe 在 node 直接載入本檔，
 * 所以不得 import React／store／Tauri API，值 import 一律寫完整路徑含 `.ts`。
 *
 * 順序固定：notes → timetable → ticket（與 Rust 登記表、gnav 下排、SCENES 插入順序相同）。
 * 各線不必改本檔——改自己的 `<line>.manifest.ts` 就好。
 */
import type { LineId, LineManifest } from "./types";
import { NOTES } from "./notes.manifest.ts";
import { TIMETABLE } from "./timetable.manifest.ts";
import { TICKET } from "./ticket.manifest.ts";

export type { LineId, LineManifest, LineStatus } from "./types";

/**
 * 三線的登記檔（順序 notes → timetable → ticket）。
 * 元素型別刻意放寬成 `LineManifest`：`status` 等欄在登記檔裡是字面值（"planned"），
 * 集中檔要能寫 `status === "open"` 的判斷；需要字面值的型別（表名、scope 名）由下面從各檔個別導出。
 */
export const LINE_MANIFESTS: readonly LineManifest[] = [NOTES, TIMETABLE, TICKET];

export function lineById(id: LineId): LineManifest {
  const m = LINE_MANIFESTS.find((x) => x.id === id);
  if (!m) throw new Error(`lines: 未登錄的線「${id}」`);
  return m;
}

/** 三線登記的同步表名（地基階段三線都是空的 ⇒ never） */
export type LineSyncTable =
  | (typeof NOTES.syncTables)[number]
  | (typeof TIMETABLE.syncTables)[number]
  | (typeof TICKET.syncTables)[number];

/** 三線宣告的快捷鍵 scope（地基階段＝"notes" | "timetable" | "ticket"） */
export type LineHotkeyScope =
  | (typeof NOTES.hotkeyScopes)[number]
  | (typeof TIMETABLE.hotkeyScopes)[number]
  | (typeof TICKET.hotkeyScopes)[number];
