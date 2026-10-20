/**
 * 時刻表線⑥：塊的手動荷札跟著 `fromId` 搬（⑥ 契約 0-8、§3.2；甲席資料）。
 *
 * 推導的預設荷札不寫資料（D-時-110），只有 `timetable:block` 的手動荷札要跟著塊的 id 走：
 *   - 切開／蓋掉切出的片段／整理切出的片段（insert 帶 `fromId`）⇒ `{ to: 新 id, from: fromId }`，不管 `inherit`；
 *   - 合併（`planMerge` 的 `absorbedInto`）⇒ `{ to: 留下的那塊, from: 被吞的 }`（聯集）。
 * 寫法：時刻表的批次交易提交**之後**，對每個 `to` 補掛 `from` 有、`to` 沒有的荷札（`tagRepo.attach`，不 toast）。
 * 兩個交易：`tagRepo` 沒有把 tag op 併進別人批次的介面，不為此改它的簽名。中途當掉＝新片段少了手動荷札，時間資料不受影響；
 * taggings 的 id 是決定性的（`taggingId(type, entityId, tagId)`），兩台各自整理出同一個片段時寫出同一列、收斂。
 *
 * 只 import 型別與純函式（相對路徑帶 `.ts`：`node --test` 直載；不會拉進 `tagRepo` 單例）；荷札 repository 由呼叫端注入。
 */
import type { TagRepository } from "./tagRepository.ts";
import { TT_TAG_BLOCK, carryPairs } from "../domain/timetableTags.ts";
import { normalizeName } from "../domain/tags.ts";

/** 搬荷札只用得到的兩支（測試可以給假的） */
export type CarryTagRepo = Pick<TagRepository, "listTagsOf" | "attach">;

/** 時刻表兩個 repository 注入的荷札 repository 形狀（搬荷札＋目標的荷札） */
export type TimetableTagRepo = Pick<TagRepository, "listTagsOf" | "attach" | "setTags">;

export interface CarryPair {
  to: string;
  from: string;
}

/**
 * 從 WritePlan 收集要搬的 pair（applyPlan 給了 inserts 的 id 之後呼叫）：insert 有 `fromId` ⇒ `{to: 新id, from: fromId}`；
 * `absorbedInto`（planMerge）⇒ 原樣。沒有就回空陣列。
 */
export function carryPairsOfPlan(
  inserts: readonly { fromId: string | null; noTagCarry?: boolean }[],
  ids: readonly string[],
  absorbedInto: readonly CarryPair[] | undefined,
): CarryPair[] {
  const out: CarryPair[] = [];
  inserts.forEach((ins, k) => {
    // D-時-132：「其實在做別的」切出的那段（planResolveLongRun 標 noTagCarry）不帶原塊的手動荷札
    if (ins.fromId && ids[k] && !ins.noTagCarry) out.push({ to: ids[k], from: ins.fromId });
  });
  if (absorbedInto) for (const p of absorbedInto) out.push({ to: p.to, from: p.from });
  return out;
}

/**
 * 0-8：把 `from` 的手動荷札補掛到 `to`。`pairs` 先過 `carryPairs`（去重、`to===from`／空 id 略過）；
 * 每個 `to`：`listTagsOf(TT_TAG_BLOCK, from)` 減掉 `listTagsOf(TT_TAG_BLOCK, to)` → `attach`。
 * 回「有沒有真的寫」（有寫 ⇒ store 要重載荷札 index）。每一對各自 try/catch、失敗只 `console.warn`（時間資料已經落地）。
 */
export async function carryBlockTags(pairs: readonly CarryPair[], repo: CarryTagRepo | null | undefined): Promise<boolean> {
  if (!repo || !pairs.length) return false;
  const todo = carryPairs(pairs);
  if (!todo.length) return false;
  let wrote = false;
  const fromCache = new Map<string, { name: string; name_key: string }[]>();
  for (const p of todo) {
    try {
      let src = fromCache.get(p.from);
      if (!src) {
        src = (await repo.listTagsOf(TT_TAG_BLOCK, p.from)).map((t) => ({ name: t.name, name_key: t.name_key }));
        fromCache.set(p.from, src);
      }
      if (!src.length) continue;
      const have = new Set((await repo.listTagsOf(TT_TAG_BLOCK, p.to)).map((t) => t.name_key));
      for (const t of src) {
        if (have.has(t.name_key)) continue;
        const r = await repo.attach(TT_TAG_BLOCK, p.to, t.name);
        have.add(t.name_key);
        if (!r.already) wrote = true;
      }
    } catch (e) {
      console.warn("時刻表：搬手動荷札失敗（時間資料已經寫好）", p, e);
    }
  }
  return wrote;
}

/**
 * 目標／塊的荷札草稿在寫之前先驗名稱（`tagRepo.setTags` 遇到不合法的名稱會安靜略過——草稿裡打錯的字要說出來）。
 * 不合法 ⇒ `RangeError(reason)`（旅客筆記的訊息，例「荷札名稱不能有空白」）；回去重、去掉開頭 # 之後的顯示名。
 */
export function checkTagNames(names: readonly string[]): string[] {
  const out: string[] = [];
  const keys = new Set<string>();
  for (const raw of names) {
    const n = normalizeName(raw);
    if (!n.ok) throw new RangeError(n.reason);
    if (keys.has(n.key)) continue;
    keys.add(n.key);
    out.push(n.name);
  }
  return out;
}

/* ── 改一塊的荷札草稿：只寫差集（⑥ 評審後；資料語義評審第 1 條） ── */

/** 草稿相對於「面板打開時的手動荷札」的差：add＝要掛的名稱（草稿原字）、remove＝要摘的 key */
export interface BlockTagEdit {
  add: string[];
  remove: string[];
}

/**
 * 面板打開時記下的手動荷札 key（`initialKeys`）× 送出時的草稿名稱 ⇒ 只列差集；沒變回 null（不寫）。
 * 不用整份 `setTags`：基準要是不完整（index 還沒載、或載的是舊的），整份換會把基準外的既有荷札摘掉；
 * 差集只摘「主人在面板上親手摘掉的」，基準外的照留。名稱不合法的照原字放進 add（store 先驗名稱、整筆不寫）。
 */
export function blockTagEditOf(initialKeys: readonly string[], draftNames: readonly string[]): BlockTagEdit | null {
  const init = new Set(initialKeys);
  const draft = new Set<string>();
  const add: string[] = [];
  for (const raw of draftNames) {
    const n = normalizeName(raw);
    const key = n.ok ? n.key : raw;
    if (draft.has(key)) continue;
    draft.add(key);
    if (!init.has(key)) add.push(raw);
  }
  const remove = initialKeys.filter((k, i) => !draft.has(k) && initialKeys.indexOf(k) === i);
  return add.length || remove.length ? { add, remove } : null;
}

/**
 * 把差集套到資料上：remove 逐個 `detach`、add 逐個 `attach`（都是冪等的：本來就沒掛／已經掛著＝不寫）。
 * 回「有沒有真的寫」（有寫 ⇒ store 要重載荷札 index）。丟錯照丟（store 收成「荷札沒掛上」的 toast；時間資料已經寫好）。
 */
export async function applyBlockTagEdit(
  repo: Pick<TagRepository, "attach" | "detach">,
  blockId: string,
  edit: BlockTagEdit,
): Promise<boolean> {
  let wrote = false;
  for (const key of edit.remove) {
    if (receiptWrote(await repo.detach(TT_TAG_BLOCK, blockId, key))) wrote = true;
  }
  for (const name of edit.add) {
    const r = await repo.attach(TT_TAG_BLOCK, blockId, name);
    if (!r.already) wrote = true;
  }
  return wrote;
}

/** setTags 的收據有沒有真的寫（同 `isEmptyReceipt` 的反面；這裡只看 taggings 與 tags 兩種） */
export function receiptWrote(r: { createdTagIds: readonly string[]; createdTaggingIds: readonly string[]; tagsBefore: readonly unknown[]; taggingsBefore: readonly unknown[] }): boolean {
  return r.createdTagIds.length > 0 || r.createdTaggingIds.length > 0 || r.tagsBefore.length > 0 || r.taggingsBefore.length > 0;
}
