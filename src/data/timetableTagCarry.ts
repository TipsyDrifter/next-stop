/**
 * 時刻表線⑥：塊的手動荷札跟著 `fromId` 搬（⑥ 契約 0-8、§3.2；甲席資料）。
 *
 * 推導的預設荷札不寫資料（D-時-110），只有 `timetable:block` 的手動荷札要跟著塊的 id 走：
 *   - 切開／蓋掉切出的片段／整理切出的片段（insert 帶 `fromId`）⇒ `{ to: 新 id, from: fromId }`，不管 `inherit`；
 *   - 合併（`planMerge` 的 `absorbedInto`）⇒ `{ to: 留下的那塊, from: 被吞的 }`（聯集）。
 * 磨光③ D-時-135：排除的預設荷札（`timetable:block-off`）黏在塊上、讀的時候才扣——片段**分類沒換**（`inherit`）才帶；
 * 合併不帶被吞那塊的（留下那塊自己的本來就在）；改分類不裁（不在新分類預設裡的排除讀時自然無效）。
 * 寫法：時刻表的批次交易提交**之後**，對每個 `to` 補掛 `from` 有、`to` 沒有的荷札（`tagRepo.attach`，不 toast）。
 * 兩個交易：`tagRepo` 沒有把 tag op 併進別人批次的介面，不為此改它的簽名。中途當掉＝新片段少了手動荷札，時間資料不受影響；
 * taggings 的 id 是決定性的（`taggingId(type, entityId, tagId)`），兩台各自整理出同一個片段時寫出同一列、收斂。
 *
 * 只 import 型別與純函式（相對路徑帶 `.ts`：`node --test` 直載；不會拉進 `tagRepo` 單例）；荷札 repository 由呼叫端注入。
 */
import type { TagRepository } from "./tagRepository.ts";
import { TT_TAG_BLOCK, TT_TAG_BLOCK_OFF, carryPairs, type TimetableTagEntityType } from "../domain/timetableTags.ts";
import { normalizeName } from "../domain/tags.ts";

/** 搬荷札只用得到的兩支（測試可以給假的） */
export type CarryTagRepo = Pick<TagRepository, "listTagsOf" | "attach">;

/** 時刻表兩個 repository 注入的荷札 repository 形狀（搬荷札＋目標的荷札） */
export type TimetableTagRepo = Pick<TagRepository, "listTagsOf" | "attach" | "setTags">;

export interface CarryPair {
  to: string;
  from: string;
  /** D-時-135：也帶排除的預設荷札（`timetable:block-off`）；不填＝false */
  off?: boolean;
}

/**
 * 從 WritePlan 收集要搬的 pair（applyPlan 給了 inserts 的 id 之後呼叫）：insert 有 `fromId` ⇒ `{to: 新id, from: fromId, off: inherit}`；
 * `absorbedInto`（planMerge）⇒ 原樣、`off: false`（被吞那塊的排除不帶）。沒有就回空陣列。
 */
export function carryPairsOfPlan(
  inserts: readonly { fromId: string | null; inherit?: boolean; noTagCarry?: boolean }[],
  ids: readonly string[],
  absorbedInto: readonly { to: string; from: string; off?: boolean }[] | undefined,
): CarryPair[] {
  const out: CarryPair[] = [];
  inserts.forEach((ins, k) => {
    // D-時-132：「其實在做別的」切出的那段（planResolveLongRun 標 noTagCarry）不帶原塊的手動荷札
    // D-時-135：分類沒換（inherit）的片段才帶排除
    if (ins.fromId && ids[k] && !ins.noTagCarry) out.push({ to: ids[k], from: ins.fromId, off: !!ins.inherit });
  });
  // 磨光⑦：併進運行中那列（off）才帶被吞那塊的排除——那一列的內容換成被吞那塊的
  if (absorbedInto) for (const p of absorbedInto) out.push({ to: p.to, from: p.from, off: !!p.off });
  return out;
}

/**
 * 0-8：把 `from` 的手動荷札補掛到 `to`。`pairs` 先過 `carryPairs`（去重、`to===from`／空 id 略過）；
 * 每個 `to`：`listTagsOf(TT_TAG_BLOCK, from)` 減掉 `listTagsOf(TT_TAG_BLOCK, to)` → `attach`。
 * D-時-135：`off` 為真的那幾對再用 `timetable:block-off` 跑一趟（排除也跟著分類沒換的片段走）。
 * 回「有沒有真的寫」（有寫 ⇒ store 要重載荷札 index）。每一對各自 try/catch、失敗只 `console.warn`（時間資料已經落地）。
 */
export async function carryBlockTags(pairs: readonly CarryPair[], repo: CarryTagRepo | null | undefined): Promise<boolean> {
  if (!repo || !pairs.length) return false;
  const manual = await carryTagsOfType(pairs, repo, TT_TAG_BLOCK);
  const offPairs = pairs.filter((p) => p.off);
  const off = offPairs.length ? await carryTagsOfType(offPairs, repo, TT_TAG_BLOCK_OFF) : false;
  return manual || off;
}

/** `carryBlockTags` 的一趟：把 `from` 掛的 `type` 荷札補到 `to`（只補 `to` 還沒有的） */
async function carryTagsOfType(pairs: readonly CarryPair[], repo: CarryTagRepo, type: TimetableTagEntityType): Promise<boolean> {
  const todo = carryPairs(pairs);
  if (!todo.length) return false;
  let wrote = false;
  const fromCache = new Map<string, { name: string; name_key: string }[]>();
  for (const p of todo) {
    try {
      let src = fromCache.get(p.from);
      if (!src) {
        src = (await repo.listTagsOf(type, p.from)).map((t) => ({ name: t.name, name_key: t.name_key }));
        fromCache.set(p.from, src);
      }
      if (!src.length) continue;
      const have = new Set((await repo.listTagsOf(type, p.to)).map((t) => t.name_key));
      for (const t of src) {
        if (have.has(t.name_key)) continue;
        const r = await repo.attach(type, p.to, t.name);
        have.add(t.name_key);
        if (!r.already) wrote = true;
      }
    } catch (e) {
      console.warn(type === TT_TAG_BLOCK ? "時刻表：搬手動荷札失敗（時間資料已經寫好）" : "時刻表：搬排除的荷札失敗（時間資料已經寫好）", p, e);
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
 * 排除那份（D-時-134）同一支：`initialKeys`＝面板打開時這一塊排除的 keys（`m.off[id]`）、`draftNames`＝草稿裡畫成刪除線的牌子。
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
 * `type` 預設手動荷札；排除那份（D-時-134）傳 `TT_TAG_BLOCK_OFF`，差集同樣用 `blockTagEditOf(面板打開時排除的 keys, 草稿排除的名稱)` 算。
 * 回「有沒有真的寫」（有寫 ⇒ store 要重載荷札 index）。丟錯照丟（store 收成「荷札沒掛上」的 toast；時間資料已經寫好）。
 */
export async function applyBlockTagEdit(
  repo: Pick<TagRepository, "attach" | "detach">,
  blockId: string,
  edit: BlockTagEdit,
  type: typeof TT_TAG_BLOCK | typeof TT_TAG_BLOCK_OFF = TT_TAG_BLOCK,
): Promise<boolean> {
  let wrote = false;
  for (const key of edit.remove) {
    if (receiptWrote(await repo.detach(type, blockId, key))) wrote = true;
  }
  for (const name of edit.add) {
    const r = await repo.attach(type, blockId, name);
    if (!r.already) wrote = true;
  }
  return wrote;
}

/** setTags 的收據有沒有真的寫（同 `isEmptyReceipt` 的反面；這裡只看 taggings 與 tags 兩種） */
export function receiptWrote(r: { createdTagIds: readonly string[]; createdTaggingIds: readonly string[]; tagsBefore: readonly unknown[]; taggingsBefore: readonly unknown[] }): boolean {
  return r.createdTagIds.length > 0 || r.createdTaggingIds.length > 0 || r.tagsBefore.length > 0 || r.taggingsBefore.length > 0;
}
