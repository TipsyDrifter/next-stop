/**
 * 荷札頁「別處」那段的分組與列字（時刻表⑥ 契約 0-6 (b)；零行為插槽）。桌機 `TagList`、手機 `MobileTagPage` 共用。
 *
 * 別線用 `LineMount.tagEntities` 登記的類型 ⇒ 依 `group` 分段（照登記順序），列字由該線的 `describe` 給；
 * 沒登記的類型 ⇒ 照舊收進最後一段「別處」、印原始 entity_type 字串、不能點。
 * **沒有任何線登記時回 `[{ title: "別處", rows: 全部 }]`、每列 `row: null`——跟插槽之前畫出來的一樣。**
 */
import { useEffect, useMemo, useState } from "react";
import type { GroupedTaggedItem } from "../../../domain/tags";
import { lineTagEntities } from "../../../lines/runtime";
import type { TagEntityRow } from "../../../lines/types";

export interface OtherSectionRow {
  it: GroupedTaggedItem;
  /** null＝沒登記或 describe 沒給 ⇒ 畫原始字串、不能點 */
  row: TagEntityRow | null;
}
export interface OtherSection {
  title: string;
  rows: OtherSectionRow[];
}

const OTHER_TITLE = "別處";
const refOf = (it: GroupedTaggedItem) => (it.kind === "other" ? it.entityType + "\u0001" + it.id : "");

export function useOtherSections(other: readonly GroupedTaggedItem[], shell: "desktop" | "mobile"): OtherSection[] {
  const specs = useMemo(() => lineTagEntities(shell), [shell]);
  const [rows, setRows] = useState<Record<string, TagEntityRow | null>>({});

  useEffect(() => {
    if (!specs.length || !other.length) return;
    let alive = true;
    void Promise.all(
      specs.map(async (spec) => {
        const ids = other.filter((it) => it.kind === "other" && it.entityType === spec.type).map((it) => it.id);
        if (!ids.length) return [] as [string, TagEntityRow | null][];
        try {
          const got = await spec.describe(ids);
          return ids.map((id) => [spec.type + "\u0001" + id, got[id] ?? null] as [string, TagEntityRow | null]);
        } catch (e) {
          console.warn("荷札頁：別線 describe 失敗", spec.type, e);
          return [];
        }
      }),
    ).then((parts) => {
      if (alive) setRows(Object.fromEntries(parts.flat()));
    });
    return () => {
      alive = false;
    };
  }, [specs, other]);

  return useMemo(() => {
    if (!specs.length) return [{ title: OTHER_TITLE, rows: other.map((it) => ({ it, row: null })) }];
    const out: OtherSection[] = [];
    const byTitle = new Map<string, OtherSection>();
    const sectionOf = (title: string) => {
      let s = byTitle.get(title);
      if (!s) byTitle.set(title, (s = { title, rows: [] }));
      return s;
    };
    for (const spec of specs) if (!byTitle.has(spec.group)) out.push(sectionOf(spec.group));
    const rest = sectionOf(OTHER_TITLE);
    for (const it of other) {
      const spec = it.kind === "other" ? specs.find((s) => s.type === it.entityType) : undefined;
      (spec ? sectionOf(spec.group) : rest).rows.push({ it, row: spec ? (rows[refOf(it)] ?? null) : null });
    }
    out.push(rest);
    return out.filter((s) => s.rows.length);
  }, [specs, other, rows]);
}
