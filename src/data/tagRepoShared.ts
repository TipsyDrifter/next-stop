/**
 * 荷札 repository 兩份實作（sqlite／memory）共用的小工具（旅客筆記車次③）。不是給別線用的介面——別線看 `tagRepository.ts`。
 */
import { TAGS_RECENT_KEY } from "../domain/tags";
import type { NodeRow } from "../domain";
import type { SettingsRepository } from "./settingsRepository";
import type { TaggedItem, TaggingRow, TagReceipt, TagRow } from "./tagRepository";

/** 收據只記第一次的改前值；同一手勢新建的列不記改前值 */
export function recordTagBefore(r: TagReceipt, t: Pick<TagRow, "id" | "name" | "deleted_at">): void {
  if (r.createdTagIds.includes(t.id) || r.tagsBefore.some((b) => b.id === t.id)) return;
  r.tagsBefore.push({ id: t.id, name: t.name, deleted_at: t.deleted_at });
}
export function recordTaggingBefore(r: TagReceipt, g: Pick<TaggingRow, "id" | "deleted_at">): void {
  if (r.createdTaggingIds.includes(g.id) || r.taggingsBefore.some((b) => b.id === g.id)) return;
  r.taggingsBefore.push({ id: g.id, deleted_at: g.deleted_at });
}

/** 「最近用過」：settings 的 JSON 陣列（裝置本地，契約 0-10）；壞掉或不在＝空 */
export async function readRecent(settings: SettingsRepository): Promise<string[]> {
  try {
    const raw = await settings.get(TAGS_RECENT_KEY);
    const v: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

export function pickNode(
  n: Pick<NodeRow, "id" | "name" | "kind" | "route_id" | "status" | "scheduled_on" | "parent_id" | "repeat_rule">,
): Extract<TaggedItem, { kind: "node" }>["node"] {
  return {
    id: n.id,
    name: n.name,
    kind: n.kind,
    route_id: n.route_id,
    status: n.status,
    scheduled_on: n.scheduled_on,
    parent_id: n.parent_id,
    repeat_rule: n.repeat_rule,
  };
}

export function byNameKey(a: { name_key: string }, b: { name_key: string }): number {
  return a.name_key < b.name_key ? -1 : a.name_key > b.name_key ? 1 : 0;
}
