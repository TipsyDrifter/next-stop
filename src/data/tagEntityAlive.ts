/**
 * 別線實體的「還在不在」登記表（接縫：時刻表⑥ 契約 0-6 (a)；零行為插槽）。
 *
 * 荷札的掛載表 `taggings` 允許別線用 `'<頁面id>:<自訂>'` 當 entity_type（荷札契約 §3.3），但本線不認得那些實體表，
 * 原本一律算存活（`loadIndexSource`／`listUnder` 的 `g.entity_type NOT IN ('node','note')`）。別線的實體會被刪、
 * 被同步引擎「編輯勝刪除」復活，靠「刪的時候摘掉」追不上復活——所以改成讀取時由那條線宣告存活條件，跟 node／note 的 EXISTS 同一招。
 *
 * 登記由 `lines/runtime.ts` 的 `installLineMounts` 從各線 `LineMount.tagEntities` 收進來（data 層不 import lines，沒有循環）。
 * **沒有任何登記時，產生的 SQL 與記憶體判斷跟插槽之前逐字相同。**
 */

export interface TagEntityAlive {
  /** 'timetable:block' 這種；要跟 taggings.entity_type 完全一樣（含冒號、不可用裸 node／note） */
  type: `${string}:${string}`;
  /**
   * SQL 片段：`g.entity_id` 指到的實體還在（`g` 是 taggings 的別名）。
   * 例 `EXISTS (SELECT 1 FROM time_blocks x WHERE x.id = g.entity_id AND x.deleted_at IS NULL)`。
   */
  existsSql: string;
  /** mock 模式（MemoryTagRepository）用的同一個判斷 */
  aliveMemory(id: string): Promise<boolean>;
}

let registered: readonly TagEntityAlive[] = [];

/** 只給 `lines/runtime.ts` 呼叫（整份換掉；HMR 重裝也安全） */
export function setTagEntityAlive(specs: readonly TagEntityAlive[]): void {
  // 型別已擋掉 node／note，這裡再防一次執行期硬塞（`as` 繞過型別）的：一定要有冒號
  registered = specs.filter((s) => (s.type as string).includes(":"));
}

export function tagEntityAliveList(): readonly TagEntityAlive[] {
  return registered;
}

const sqlStr = (s: string): string => "'" + s.replace(/'/g, "''") + "'";

/**
 * node／note 以外的掛載「算存活」的條件（別名 `g`）。沒有登記＝`g.entity_type NOT IN ('node','note')`（插槽之前的原句）；
 * 有登記＝沒登記的別線照舊一律算存活、有登記的照它的 `existsSql`，整段包一層括號可直接接在 AND／OR 後面。
 */
export function otherEntitiesAliveSql(): string {
  if (!registered.length) return "g.entity_type NOT IN ('node','note')";
  const types = registered.map((s) => sqlStr(s.type)).join(",");
  const each = registered.map((s) => `(g.entity_type = ${sqlStr(s.type)} AND ${s.existsSql})`).join(" OR ");
  return `(g.entity_type NOT IN ('node','note',${types}) OR ${each})`;
}

/** 記憶體版：有登記就問它；沒登記＝一律算存活（插槽之前的行為） */
export async function otherEntityAliveMemory(type: string, id: string): Promise<boolean> {
  const spec = registered.find((s) => s.type === type);
  return spec ? spec.aliveMemory(id) : true;
}
