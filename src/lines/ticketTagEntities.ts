/**
 * ticketTagEntities——售票口掛在荷札上的東西，給旅客筆記的荷札頁認（售票口④ 契約 §1；樣子照 `timetableTagEntities.ts`）。
 * `ticket.mount.tsx` 的 `tagEntities` 直接用這幾筆；登記由 `lines/runtime.ts` 收進 `data/tagEntityAlive.ts`（存活條件）。
 *
 *   ticket:entry   一筆帳。存活＝`tk_entries.deleted_at IS NULL`；列字「11/1 −120 午餐「麥味登」 · 現金」；點了跳到那筆（`jumpToEntry`）
 *   ticket:repeat  定期帳規則（它記出來的每一筆帶規則的荷札）。存活＝沒刪（暫停的算在）；列字「定期帳「每月 5 日 · 房租」」；點了開定期帳管理
 *   ticket:wish    願望（買了那筆帶過去）。存活＝沒刪（已買的也算在）；列字「願望「降噪耳機」」；點了跳到候車室頁
 *   ticket:template 常用票種（填出來的草稿帶過去）。存活＝沒刪；列字「常用票種「午餐」」；點了開管帳的「常用票種」
 *
 * 種類常數定義在 `domain/ticketTags.ts`（store 與純函式也要用），這裡 re-export。
 * 段名一律「售票口」。`aliveMemory` 只在 mock 模式被叫（那時 `ticketRepo` 就是 memory 版）。
 * 列字要帳戶、分類名：store 還沒 warm 就先 warm（荷札頁可能比售票口先開）。
 */
import type { TagEntityRow, TagEntitySpec } from "./types";
import { ticketRepo } from "../data/ticketRepository";
import { parseFixedRule } from "../domain/ticketPlan";
import { describeRule } from "../domain/repeat";
import { bareName } from "../domain/ticket";
import { shortDay } from "../domain/ticketView";
import { useTicketStore } from "../store/ticketStore";
import { useUiStore } from "../store/uiStore";
import type { MobileTabKey } from "../ui/mobile/tabs";
import type { PageId } from "../ui/shell/pages";
import { entryJumpLabel } from "../ui/ticket/quickJump";
import { TK_TAG_ENTRY, TK_TAG_REPEAT, TK_TAG_TEMPLATE, TK_TAG_WISH } from "../domain/ticketTags";

export { TK_TAG_ENTRY, TK_TAG_REPEAT, TK_TAG_TEMPLATE, TK_TAG_WISH } from "../domain/ticketTags";

const GROUP = "售票口";
const TABLES = ["tk_entries", "tk_repeats", "tk_wishes", "tk_templates"] as const;

/** 荷札頁在哪個殼（同 tagStore：useShell 把 data-shell 同步到 <html>） */
function shellNow(): "desktop" | "mobile" {
  return typeof document !== "undefined" && document.documentElement.getAttribute("data-shell") === "mobile" ? "mobile" : "desktop";
}

/** 先去候車室頁（壬 D-主-513：願望搬到候車室，售票口不再有願望籤；桌機關掉設定面板再換頁；手機換 tab） */
function gotoWaitroom(): void {
  const ui = useUiStore.getState();
  // TODO(壬 整合)：候車室頁進 PageId／MobileTabKey 之後，拿掉這兩個 `as string as`（同 ui/depot/Yearbook.tsx 的做法）
  if (shellNow() === "desktop") {
    ui.setSettingsOpen(false);
    ui.setPage("waitroom" as string as PageId);
  } else ui.setMobileTab("waitroom" as string as MobileTabKey);
}

/** 先回售票口頁（桌機關掉設定面板再換頁；手機換 tab） */
function gotoTicket(): void {
  const ui = useUiStore.getState();
  if (shellNow() === "desktop") {
    ui.setSettingsOpen(false);
    ui.setPage("ticket");
  } else ui.setMobileTab("ticket");
}

async function describeEntries(ids: readonly string[]): Promise<Record<string, TagEntityRow | null>> {
  await useTicketStore.getState().warm().catch(() => undefined);
  const rows = await Promise.all(ids.map((id) => ticketRepo.getEntry(id).catch(() => null)));
  const out: Record<string, TagEntityRow | null> = {};
  ids.forEach((id, i) => {
    const e = rows[i];
    out[id] = e
      ? {
          label: `${shortDay(e.occurred_on)} ${entryJumpLabel(e)}`,
          open: () => {
            gotoTicket();
            void useTicketStore.getState().jumpToEntry(id);
          },
        }
      : null;
  });
  return out;
}

async function describeRepeats(ids: readonly string[]): Promise<Record<string, TagEntityRow | null>> {
  await useTicketStore.getState().warm().catch(() => undefined);
  const rows = await ticketRepo.listRepeats().catch(() => []);
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const catById = useTicketStore.getState().catById;
  const out: Record<string, TagEntityRow | null> = {};
  for (const id of ids) {
    const r = byId.get(id);
    if (!r) {
      out[id] = null;
      continue;
    }
    const fixed = parseFixedRule(r.rule);
    const cat = r.category_id ? catById[r.category_id] : undefined;
    const what = r.note || (cat ? bareName(cat.name) || cat.name : r.kind === "transfer" ? "轉帳" : "未分類");
    out[id] = {
      label: `定期帳「${fixed ? describeRule(fixed) : "規則看不懂"} · ${what}」`,
      sub: r.paused_at ? "暫停中" : undefined,
      open: () => {
        gotoTicket();
        useTicketStore.getState().openDialog({ kind: "repeats" });
      },
    };
  }
  return out;
}

async function describeWishes(ids: readonly string[]): Promise<Record<string, TagEntityRow | null>> {
  const rows = await ticketRepo.listWishes().catch(() => []);
  const byId = new Map(rows.map((w) => [w.id, w] as const));
  const out: Record<string, TagEntityRow | null> = {};
  for (const id of ids) {
    const w = byId.get(id);
    out[id] = w
      ? {
          label: `願望「${w.name}」`,
          open: () => {
            gotoWaitroom();
          },
        }
      : null;
  }
  return out;
}

async function describeTemplates(ids: readonly string[]): Promise<Record<string, TagEntityRow | null>> {
  const rows = await ticketRepo.listTemplates().catch(() => []);
  const byId = new Map(rows.map((t) => [t.id, t] as const));
  const out: Record<string, TagEntityRow | null> = {};
  for (const id of ids) {
    const t = byId.get(id);
    out[id] = t
      ? {
          label: `常用票種「${t.name}」`,
          open: () => {
            gotoTicket();
            useTicketStore.getState().openDialog({ kind: "templates" });
          },
        }
      : null;
  }
  return out;
}

const existsIn = (table: (typeof TABLES)[number]): string =>
  `EXISTS (SELECT 1 FROM ${table} x WHERE x.id = g.entity_id AND x.deleted_at IS NULL)`;

export const TICKET_TAG_ENTITIES: readonly TagEntitySpec[] = [
  {
    type: TK_TAG_ENTRY,
    group: GROUP,
    existsSql: existsIn("tk_entries"),
    aliveMemory: async (id) => (await ticketRepo.getEntry(id).catch(() => null)) !== null,
    describe: describeEntries,
    tables: TABLES,
  },
  {
    type: TK_TAG_REPEAT,
    group: GROUP,
    existsSql: existsIn("tk_repeats"),
    aliveMemory: async (id) => (await ticketRepo.listRepeats().catch(() => [])).some((r) => r.id === id),
    describe: describeRepeats,
    tables: TABLES,
  },
  {
    type: TK_TAG_WISH,
    group: GROUP,
    existsSql: existsIn("tk_wishes"),
    aliveMemory: async (id) => (await ticketRepo.listWishes().catch(() => [])).some((w) => w.id === id),
    describe: describeWishes,
    tables: TABLES,
  },
  {
    type: TK_TAG_TEMPLATE,
    group: GROUP,
    existsSql: existsIn("tk_templates"),
    aliveMemory: async (id) => (await ticketRepo.listTemplates().catch(() => [])).some((t) => t.id === id),
    describe: describeTemplates,
    tables: TABLES,
  },
];
