/**
 * TimetableTagChips——時刻表面板裡的荷札牌與小件（⑥ 契約 §5.1～5.4、§5.8；D-時-115、116、121、122、125～129；乙席）。
 *
 * 旅客筆記的 `TagChip` 沒匯出（也不該跨線借 class），時刻表畫自己的一份：`span.ns-tt-tag[.is-fixed][.is-sm]`
 *   ＞ `button|span.ns-tt-tag-nm`（名稱照「父層淡、末段正常、分隔 /」排；牌上不印 #）＋可選 `button.ns-tt-tag-x`（摘）。
 * 造型照荷札牌（細框、左端切角、打孔小圓），**沒有顏色**：只用墨與紙推導（timetable.css §⑥L）。
 *   - `.is-fixed`＝分類（或組）帶的：框線退淡、牌面＝面板的紙、不打孔、沒有 ×（可排除時才有，見下）；滑過寫「來自分類「娛樂」」／「來自組「主線」」。
 *
 * 匯出：
 *   - `useTimetableTagMaps()`：`tagStore.index` → `tagMapsOf`（index 沒載過就載一次，0-9）
 *   - `fixedTagsOf(catId, cats, m)`：分類帶的牌子（自己的在前、組帶的在後；各升冪）＋各自的滑過字
 *   - `runTagNames(block, cats, m)`：運行列淡字的順序（分類自己的 → 手動的 → 組帶的；原型定案 1、差異 9）
 *   - `TtTag`／`FixedTagChips`：牌子與「分類帶的」一排（`hideKeys`＝手動也有的那幾顆不畫，D-時-127；`off`＋`onToggleOff`＝可排除）
 *   - `setBlockOff(blockId, key, off)`：立刻寫排除／還原（運行中那班的荷札小面板）
 *   - `MobileTagDraft`：手機草稿欄（牌子＋「掛荷札」開點選器 insert 模式，交回的名稱併進草稿；D-時-125）
 *   - `MobileTagEntity`：手機立刻寫欄（牌子＋「掛荷札」開點選器 entity 模式；分類管理、荷札小面板）
 *   - `pickerName(cat, start, running)`：點選器 entity 模式的 `name`（標題＝「荷札・<name>」，D-時-129）
 *   - `ttBackRef(sheet)`：點牌進荷札頁時的「回到剛才」＝回時刻表、重開這個面板
 *
 * 磨光③ 2-1（D-時-134、136；原型定案 A1）：分類帶的牌子可以「這一塊不算」——`FixedTagChips` 給了 `off`＋`onToggleOff` 才畫 ×：
 *   × 了變 `.is-off`（刪除線＋淡字、留在原位），× 換成常顯的 ↺；點牌子或 ↺ 都還原。塊面板交草稿、運行中的荷札小面板（桌機）
 *   立刻寫（`setBlockOff`，toast＋復原）。手機運行中那班沒有排除入口（點選器只列手動的，D-時-126／127）。
 * 運行列淡字（`runTagKeys`）也扣排除（`defaultsAfterOff`）。
 */
import { useEffect, useMemo, type ReactNode } from "react";
import { type TimeCategoryRow } from "../../../domain/timetable";
import { keyOf } from "../../../domain/tags";
import {
  TT_TAG_BLOCK,
  TT_TAG_BLOCK_OFF,
  catDefaults,
  defaultsAfterOff,
  tagMapsOf,
  type TimetableTagMaps,
  EMPTY_TAG_MAPS,
} from "../../../domain/timetableTags";
import type { TagEntityType } from "../../../data/tagRepository";
import { tagRepo } from "../../../data/tagRepo";
import { useTagStore, type TagBackRef } from "../../../store/tagStore";
import { TT_TEXT, useTimetableStore, type TimetableSheet } from "../../../store/timetableStore";
import { useUiStore } from "../../../store/uiStore";

const TX = TT_TEXT.tags;

/** `tagStore.index` → 時刻表的四張對照（塊、分類、目標、排除）；index 還沒載 ⇒ 空對照，並載一次 */
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
  /** 滑過字：來自分類「…」／來自組「…」 */
  from: string;
  /** 排除時的滑過字用：分類「…」／組「…」（磨光③ 2-1；沒給＝不能排除） */
  src?: string;
}

/** 分類帶的牌子：分類自己的（升冪）→ 組帶的（升冪，扣掉自己已有的）；catId null ⇒ 空 */
export function fixedTagsOf(catId: string | null, cats: readonly TimeCategoryRow[], m: TimetableTagMaps): FixedTag[] {
  if (!catId) return [];
  const d = catDefaults(catId, cats, m);
  const cat = cats.find((c) => c.id === catId);
  const group = cat?.parent_id ? cats.find((c) => c.id === cat.parent_id) : undefined;
  const cn = cat?.name ?? "？";
  const gn = group?.name ?? "？";
  return [
    ...d.own.map((key) => ({ key, from: TX.fromCategory(cn), src: TX.srcCategory(cn) })),
    ...d.fromGroup.map((key) => ({ key, from: TX.fromGroup(gn), src: TX.srcGroup(gn) })),
  ];
}

/** 運行列淡字的順序（原型定案 1／差異 9）：分類自己的 → 手動的 → 組帶的；去重。分類帶的扣掉這一塊排除的（磨光③ 2-1） */
export function runTagKeys(b: { id: string; category_id: string }, cats: readonly TimeCategoryRow[], m: TimetableTagMaps): string[] {
  const d = defaultsAfterOff(b.id, b.category_id, cats, m);
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

/** 分類帶的牌子的排除開關（磨光③ 2-1）：on＝這一塊不算；src＝分類「…」／組「…」；toggle＝排除⇄還原 */
export interface TagOffCtl {
  on: boolean;
  src: string;
  toggle(): void;
}

/**
 * 一張荷札牌。`fixed`＝分類帶的（淡一階、沒有 ×；值＝滑過字）；`onOpen` 沒給＝名稱不能點。
 * `off`（只對 fixed）：× ＝這一塊不算；排除後 `.is-off`（刪除線淡字）、名稱與 ↺ 都是「還原」（原型定案 A1）。
 */
export function TtTag({
  name,
  fixed,
  sm = false,
  onOpen,
  onRemove,
  off,
}: {
  name: string;
  fixed?: string;
  sm?: boolean;
  onOpen?: () => void;
  onRemove?: () => void;
  off?: TagOffCtl;
}) {
  const ctl = fixed ? off : undefined;
  const title = fixed ?? (onOpen ? TX.openList(name) : TX.chip(name));
  if (ctl) {
    return (
      <span className={"ns-tt-tag is-fixed" + (ctl.on ? " is-off" : "") + (sm ? " is-sm" : "")}>
        {ctl.on ? (
          <button type="button" className="ns-tt-tag-nm" title={TX.offTitleRestore(name, ctl.src)} onClick={ctl.toggle}>
            <TagSegs name={name} />
          </button>
        ) : onOpen ? (
          <button type="button" className="ns-tt-tag-nm" title={title} onClick={onOpen}>
            <TagSegs name={name} />
          </button>
        ) : (
          <span className="ns-tt-tag-nm" title={title}>
            <TagSegs name={name} />
          </span>
        )}
        <button
          type="button"
          className="ns-tt-tag-x"
          title={ctl.on ? TX.restoreTitle(name) : TX.offTitle(name, ctl.src)}
          aria-label={ctl.on ? TX.restoreLabel(name) : TX.offLabel(name)}
          onClick={ctl.toggle}
        >
          {ctl.on ? "↺" : "✕"}
        </button>
      </span>
    );
  }
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

/** 分類帶的一排（淡牌）；`hideKeys`＝手動也掛了的 key，只畫手動那顆（D-時-127）；`onToggleOff` 給了＝每顆可以「這一塊不算」 */
export function FixedTagChips({
  tags,
  hideKeys,
  sm = false,
  onOpen,
  off,
  onToggleOff,
}: {
  tags: readonly FixedTag[];
  hideKeys?: readonly string[];
  sm?: boolean;
  /** 給了＝點牌進荷札頁（只在立刻寫的面板用；草稿面板不給，免得離開面板丟了草稿） */
  onOpen?: (key: string) => void;
  /** 磨光③ 2-1：這一塊排除的 keys（畫成 .is-off） */
  off?: readonly string[];
  /** 磨光③ 2-1：× ／↺ 按下（key、按完要不要排除）；沒給＝唯讀（分類管理、手機運行中） */
  onToggleOff?: (key: string, off: boolean) => void;
}) {
  return (
    <>
      {tags
        .filter((t) => !hideKeys?.includes(t.key))
        .map((t) => {
          const on = !!off?.includes(t.key);
          const ctl: TagOffCtl | undefined =
            onToggleOff && t.src ? { on, src: t.src, toggle: () => onToggleOff(t.key, !on) } : undefined;
          return <TtTag key={t.key} name={tagNameOf(t.key)} fixed={t.from} sm={sm} onOpen={onOpen ? () => onOpen(t.key) : undefined} off={ctl} />;
        })}
    </>
  );
}

/**
 * 磨光③ 2-1：運行中那班的荷札小面板（桌機）立刻寫排除／還原（`timetable:block-off`）；toast＋復原。
 * 跟 `tagStore.attach／detach` 同一個節奏（repo → loadIndex → toast），但字是「這一塊不算／也算 #X」，不是「掛上／摘下」。
 */
export async function setBlockOff(blockId: string, key: string, off: boolean): Promise<void> {
  const ts = useTagStore.getState();
  const name = ts.nameOf(key);
  const ui = useUiStore.getState();
  try {
    const receipt = off ? (await tagRepo.attach(TT_TAG_BLOCK_OFF, blockId, name)).receipt : await tagRepo.detach(TT_TAG_BLOCK_OFF, blockId, key);
    await useTagStore.getState().loadIndex();
    ui.showToast({
      message: off ? TX.offToast(name) : TX.onToast(name),
      actionLabel: "復原",
      onAction: () =>
        void (async () => {
          try {
            await tagRepo.undo(receipt);
          } catch (e) {
            console.warn("時刻表：排除的復原失敗", e);
          }
          await useTagStore.getState().loadIndex();
        })(),
    });
  } catch (e) {
    console.warn("時刻表：排除沒寫進去", e);
    ui.showToast({ message: TT_TEXT.saveFailed });
  }
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

/** 「掛荷札」（手機；虛線框；字跟桌機、旅客筆記同，磨光③ 2-10） */
function AddBtn({ onClick }: { onClick(): void }) {
  return (
    <button type="button" className="ns-tt-tagadd is-m" onClick={onClick}>
      {TX.add}
    </button>
  );
}

/**
 * 手機草稿欄（塊面板 edit／fill、目標面板；D-時-125）：分類帶的淡牌＋草稿牌（× 常駐）＋「掛荷札」。
 * 「掛荷札」開點選器 insert 模式（標題＝`title`，沒給＝「插入荷札」；磨光③ 2-8），完成時交回的名稱併進草稿（不寫資料；按「改好了／補上／儲存」才寫）。
 * 磨光③ 2-1：塊面板另給 `off`／`onToggleOff`＝分類帶的牌子可以「這一塊不算」（也是草稿）。
 */
export function MobileTagDraft({
  fixed,
  value,
  onChange,
  empty,
  title,
  off,
  onToggleOff,
}: {
  fixed: readonly FixedTag[];
  value: readonly string[];
  onChange(names: string[]): void;
  /** 牌子一顆都沒有時的淡字 */
  empty?: string;
  /** 點選器標題（「荷札・娛樂 23:20」／「荷札・目標」） */
  title?: string;
  off?: readonly string[];
  onToggleOff?: (key: string, off: boolean) => void;
}) {
  const keys = draftKeys(value);
  const shown = fixed.filter((t) => !keys.includes(t.key));
  return (
    <div className="ns-tt-tagfield is-m">
      <FixedTagChips tags={shown} off={off} onToggleOff={onToggleOff} />
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
            title,
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
 * 手機立刻寫欄（分類管理的預設荷札、運行中那班的荷札）：分類帶的淡牌＋掛著的牌子（× 常駐＝立刻摘，toast＋復原）＋「掛荷札」。
 * 「掛荷札」開點選器 entity 模式（完成＝一次 setTags，toast＋復原是旅客筆記的）。
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
