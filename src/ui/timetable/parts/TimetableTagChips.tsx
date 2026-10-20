/**
 * TimetableTagChips——時刻表面板裡的荷札牌與小件（⑥ 契約 §5.1～5.4、§5.8；D-時-115、116、121、122、125～129；乙席）。
 *
 * 旅客筆記的 `TagChip` 沒匯出（也不該跨線借 class），時刻表畫自己的一份：`span.ns-tt-tag[.is-fixed][.is-sm]`
 *   ＞ `button|span.ns-tt-tag-nm`（名稱照「父層淡、末段正常、分隔 /」排；牌上不印 #）＋可選 `button.ns-tt-tag-x`（摘）。
 * 造型照荷札牌（細框、左端切角、打孔小圓），**沒有顏色**：只用墨與紙推導（timetable.css §⑥L）。
 *   - `.is-fixed`＝分類（或組）帶的：框線退淡、牌面＝面板的紙、不打孔、沒有 ×；滑過寫「來自分類『娛樂』」／「來自組『主線』」。
 *
 * 匯出：
 *   - `useTimetableTagMaps()`：`tagStore.index` → `tagMapsOf`（index 沒載過就載一次，0-9）
 *   - `fixedTagsOf(catId, cats, m)`：分類帶的牌子（自己的在前、組帶的在後；各升冪）＋各自的滑過字
 *   - `runTagNames(block, cats, m)`：運行列淡字的順序（分類自己的 → 手動的 → 組帶的；原型定案 1、差異 9）
 *   - `TtTag`／`FixedTagChips`：牌子與「分類帶的」一排（`hideKeys`＝手動也有的那幾顆不畫，D-時-127）
 *   - `MobileTagDraft`：手機草稿欄（牌子＋「＋ 荷札」開點選器 insert 模式，交回的名稱併進草稿；D-時-125）
 *   - `MobileTagEntity`：手機立刻寫欄（牌子＋「＋ 荷札」開點選器 entity 模式；分類管理、荷札小面板）
 *   - `pickerName(cat, start, running)`：點選器 entity 模式的 `name`（標題＝「荷札・<name>」，D-時-129）
 *   - `ttBackRef(sheet)`：點牌進荷札頁時的「回到剛才」＝回時刻表、重開這個面板
 */
import { useEffect, useMemo, type ReactNode } from "react";
import { type TimeCategoryRow } from "../../../domain/timetable";
import { keyOf } from "../../../domain/tags";
import { TT_TAG_BLOCK, catDefaults, tagMapsOf, type TimetableTagMaps, EMPTY_TAG_MAPS } from "../../../domain/timetableTags";
import type { TagEntityType } from "../../../data/tagRepository";
import { useTagStore, type TagBackRef } from "../../../store/tagStore";
import { TT_TEXT, useTimetableStore, type TimetableSheet } from "../../../store/timetableStore";
import { useUiStore } from "../../../store/uiStore";

const TX = TT_TEXT.tags;

/** `tagStore.index` → 時刻表的三張對照；index 還沒載 ⇒ 空對照，並載一次 */
export function useTimetableTagMaps(): TimetableTagMaps {
  const index = useTagStore((s) => s.index);
  useEffect(() => {
    const st = useTagStore.getState();
    if (!st.index && !st.loading) void st.loadIndex();
  }, []);
  return useMemo(() => (index ? tagMapsOf(index.ents) : EMPTY_TAG_MAPS), [index]);
}

/** 荷札 key → 顯示名（index 找不到＝key） */
export function tagNameOf(key: string): string {
  return useTagStore.getState().nameOf(key);
}

export interface FixedTag {
  key: string;
  /** 滑過字：來自分類『…』／來自組『…』 */
  from: string;
}

/** 分類帶的牌子：分類自己的（升冪）→ 組帶的（升冪，扣掉自己已有的）；catId null ⇒ 空 */
export function fixedTagsOf(catId: string | null, cats: readonly TimeCategoryRow[], m: TimetableTagMaps): FixedTag[] {
  if (!catId) return [];
  const d = catDefaults(catId, cats, m);
  const cat = cats.find((c) => c.id === catId);
  const group = cat?.parent_id ? cats.find((c) => c.id === cat.parent_id) : undefined;
  return [
    ...d.own.map((key) => ({ key, from: TX.fromCategory(cat?.name ?? "？") })),
    ...d.fromGroup.map((key) => ({ key, from: TX.fromGroup(group?.name ?? "？") })),
  ];
}

/** 運行列淡字的順序（原型定案 1／差異 9）：分類自己的 → 手動的 → 組帶的；去重 */
export function runTagKeys(b: { id: string; category_id: string }, cats: readonly TimeCategoryRow[], m: TimetableTagMaps): string[] {
  const d = catDefaults(b.category_id, cats, m);
  const manual = (m.block[b.id] ?? []).slice().sort();
  const out: string[] = [];
  for (const k of [...d.own, ...manual, ...d.fromGroup]) if (!out.includes(k)) out.push(k);
  return out;
}

/** 點選器 entity 模式的 name（MobileTagPicker 的標題＝「荷札・<name>」；字由 TT_TEXT.tags.pickerTitle 組，這裡只去掉前綴） */
export function pickerName(cat: string, start: number, running: boolean): string {
  const full = TX.pickerTitle(cat, start, running);
  const head = "荷札・";
  return full.startsWith(head) ? full.slice(head.length) : full;
}

/** 「‹ 回到剛才」：回時刻表、重開這個面板 */
export function ttBackRef(sheet: TimetableSheet): TagBackRef {
  return {
    label: TX.backLabel,
    restore: () => {
      const ui = useUiStore.getState();
      if (typeof document !== "undefined" && document.documentElement.getAttribute("data-shell") === "mobile") ui.setMobileTab("timetable");
      else ui.setPage("timetable");
      useTimetableStore.getState().openSheet(sheet);
    },
  };
}

/** 名稱三段式：父層淡、末段正常、分隔 / */
function TagSegs({ name }: { name: string }) {
  const segs = name.split(/[/／]/);
  const out: ReactNode[] = [];
  segs.forEach((s, i) => {
    if (i) out.push(<i key={`s${i}`} className="sl">/</i>);
    out.push(
      <span key={i} className={i < segs.length - 1 ? "pa" : "la"}>
        {s}
      </span>,
    );
  });
  return <>{out}</>;
}

/** 一張荷札牌。`fixed`＝分類帶的（淡一階、沒有 ×；值＝滑過字）；`onOpen` 沒給＝名稱不能點 */
export function TtTag({
  name,
  fixed,
  sm = false,
  onOpen,
  onRemove,
}: {
  name: string;
  fixed?: string;
  sm?: boolean;
  onOpen?: () => void;
  onRemove?: () => void;
}) {
  const title = fixed ?? (onOpen ? TX.openList(name) : TX.chip(name));
  return (
    <span className={"ns-tt-tag" + (fixed ? " is-fixed" : "") + (sm ? " is-sm" : "")}>
      {onOpen ? (
        <button type="button" className="ns-tt-tag-nm" title={title} onClick={onOpen}>
          <TagSegs name={name} />
        </button>
      ) : (
        <span className="ns-tt-tag-nm" title={title}>
          <TagSegs name={name} />
        </span>
      )}
      {onRemove && (
        <button type="button" className="ns-tt-tag-x" title={TX.remove} aria-label={TX.removeLabel(name)} onClick={onRemove}>
          ✕
        </button>
      )}
    </span>
  );
}

/** 分類帶的一排（唯讀淡牌）；`hideKeys`＝手動也掛了的 key，只畫手動那顆（D-時-127） */
export function FixedTagChips({
  tags,
  hideKeys,
  sm = false,
  onOpen,
}: {
  tags: readonly FixedTag[];
  hideKeys?: readonly string[];
  sm?: boolean;
  /** 給了＝點牌進荷札頁（只在立刻寫的面板用；草稿面板不給，免得離開面板丟了草稿） */
  onOpen?: (key: string) => void;
}) {
  return (
    <>
      {tags
        .filter((t) => !hideKeys?.includes(t.key))
        .map((t) => (
          <TtTag key={t.key} name={tagNameOf(t.key)} fixed={t.from} sm={sm} onOpen={onOpen ? () => onOpen(t.key) : undefined} />
        ))}
    </>
  );
}

/** 草稿名稱 → key（不合法的名字退回原字；只拿來比對「手動也有」與去重） */
export function draftKeys(names: readonly string[]): string[] {
  return names.map((n) => keyOf(n) ?? n);
}

/** 名稱併進草稿（同 key 不重複） */
export function mergeNames(cur: readonly string[], add: readonly string[]): string[] {
  const out = cur.slice();
  const have = new Set(draftKeys(cur));
  for (const n of add) {
    const k = keyOf(n) ?? n;
    if (!have.has(k)) {
      have.add(k);
      out.push(n);
    }
  }
  return out;
}

/** 「＋ 荷札」（手機；虛線框） */
function AddBtn({ onClick }: { onClick(): void }) {
  return (
    <button type="button" className="ns-tt-tagadd is-m" onClick={onClick}>
      {TX.add}
    </button>
  );
}

/**
 * 手機草稿欄（塊面板 edit／fill、目標面板；D-時-125）：分類帶的淡牌＋草稿牌（× 常駐）＋「＋ 荷札」。
 * 「＋ 荷札」開點選器 insert 模式（標題「插入荷札」），完成時交回的名稱併進草稿（不寫資料；按「改好了／補上／儲存」才寫）。
 */
export function MobileTagDraft({
  fixed,
  value,
  onChange,
  empty,
}: {
  fixed: readonly FixedTag[];
  value: readonly string[];
  onChange(names: string[]): void;
  /** 牌子一顆都沒有時的淡字 */
  empty?: string;
}) {
  const keys = draftKeys(value);
  const shown = fixed.filter((t) => !keys.includes(t.key));
  return (
    <div className="ns-tt-tagfield is-m">
      <FixedTagChips tags={shown} />
      {value.map((n, i) => (
        <TtTag key={keys[i] + "|" + i} name={n} onRemove={() => onChange(value.filter((_, j) => j !== i))} />
      ))}
      {!shown.length && !value.length && empty && <span className="ns-tt-tagfield-empty">{empty}</span>}
      <AddBtn
        onClick={() =>
          useTagStore.getState().openPicker({
            mode: "insert",
            entityType: null,
            entityId: null,
            name: "",
            onInsert: (names) => {
              if (names.length) onChange(mergeNames(value, names));
            },
          })
        }
      />
    </div>
  );
}

/**
 * 手機立刻寫欄（分類管理的預設荷札、運行中那班的荷札）：分類帶的淡牌＋掛著的牌子（× 常駐＝立刻摘，toast＋復原）＋「＋ 荷札」。
 * 「＋ 荷札」開點選器 entity 模式（完成＝一次 setTags，toast＋復原是旅客筆記的）。
 */
export function MobileTagEntity({
  entityType,
  entityId,
  pickName,
  fixed = [],
  empty,
}: {
  entityType: TagEntityType;
  entityId: string;
  /** 點選器標題「荷札・<pickName>」 */
  pickName: string;
  fixed?: readonly FixedTag[];
  empty?: string;
}) {
  const index = useTagStore((s) => s.index);
  const keys = useMemo(() => (index ? useTagStore.getState().keysOf(entityType, entityId) : []), [index, entityType, entityId]);
  const shown = fixed.filter((t) => !keys.includes(t.key));
  const open = (): void => useTagStore.getState().openPicker({ mode: "entity", entityType, entityId, name: pickName });
  return (
    <div className="ns-tt-tagfield is-m">
      <FixedTagChips tags={shown} />
      {keys.map((k) => (
        <TtTag key={k} name={tagNameOf(k)} onRemove={() => void useTagStore.getState().detach(entityType, entityId, k)} />
      ))}
      {!shown.length && !keys.length && empty && <span className="ns-tt-tagfield-empty">{empty}</span>}
      <AddBtn onClick={open} />
    </div>
  );
}

/** 運行中那一班的點選器（手機運行列「荷札 N」；D-時-126、129） */
export function openRunPicker(blockId: string, cat: string, start: number): void {
  useTagStore.getState().openPicker({ mode: "entity", entityType: TT_TAG_BLOCK, entityId: blockId, name: pickerName(cat, start, true) });
}
