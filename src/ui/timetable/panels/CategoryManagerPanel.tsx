/**
 * CategoryManagerPanel——「分類與設定」面板（車次①a 契約 §5.4、0-5；丙席）。
 * 依組列出：每組標題列（組名可改、↑↓ 排序、「＋ 分類」）；每個子分類一列：名稱（行內改名）＋圓牌＋↑↓＋⋯。
 * 「運行中」開關一列——Android 寫「通知欄顯示運行中」（沒有通知權限時「需要允許通知」＋按鈕），桌機寫「系統匣顯示運行中」、
 * 不問權限（①a 補充契約 §4；同一個設定鍵）。分流看真實平台（`onAndroid()`），不看排版：桌機視窗拉窄成手機排版也還是系統匣。
 * 車次①b Stage 0-B：「運行中」那一列＋權限提示原樣搬到 `NoticeSettings.tsx`（①c 由丁改寫成〈通知〉節）。
 * 不動任何集中檔（設定頁沒有三線插槽，契約 0-5）。
 *
 * 車次①b 進階管理（①b①c 契約 §5.6；乙席；D-時-33「收在每一列的『⋯』裡」）：圓牌字（一個字；Enter／blur 存、Esc 還原、IME 護欄；
 * 空字串不存；不是一個字 ⇒ toast B10 不存）、搬到（未刪除、未封存的頂層組）、封存（toast B6 帶復原）；「已封存 N 個」摺疊＋「還原」。
 * 不做刪除（〈開工決定〉二-5，store 也沒有 API）；封存／搬組／圓牌字都只對子分類（頂層組的 ⋯ 只放預設荷札）。
 * 封存運行中那一班的分類：照封存（契約 §5.6「照跑、圓牌照畫」）。
 *
 * 車次⑥（⑥ 契約 §5.3；D-時-121、128、131）：每個子分類名字下一行淡字「#拖延」（自己的預設荷札）＋「群組預設：#高效」（`.is-grp`，
 * 手機藏起來）；⋯ 展開區有「預設荷札」（桌機 `EntityTagField` 實體模式、手機牌子＋點選器）。組頭的 ⋯ 只放組的預設荷札＋說明。
 *
 * 磨光③ 2-11：sheet 帶 `focusId`（荷札頁點分類／組列進來）⇒ 展開那一列、捲進畫面、`.is-flash` 閃一下；封存的分類就打開「已封存」摺疊。
 *
 * ── UI 丙-4 B1／B2（契約 §1 B、§5 P5／P7）──
 * - 對話框上方 `Tabs`：分類｜通知｜目標。開在哪一籤看 sheet：`focus:"notice"`→通知、`focusId`→分類（並定位）、其餘看 `tab`（省略＝分類）。
 *   通知籤＝`NoticeSettings`＋「忘記停車的提醒上限」（P5：它是「回來時問一聲」的門檻，跟提醒同一類，不再壓在分類底下）。
 *   開窗焦點落在目前的籤：Tabs 沒有 ref／focus API，等一拍（DialogShell 先把焦點放進卡）再用 DOM 查 `[role=tab][aria-selected=true]`
 *   （同 settings/SettingsPanel 丙-3 的做法）；之後換籤由 Tabs 自己帶焦點。sheet 換了 tab（例：開著時又被叫一次）就跟著換籤。
 * - 列換共用 `ManagerRow`：名稱行內改名、圓牌進 swatch、↑↓、⋯（「更多設定…」＝列下展開區、封存）；
 *   展開區＝顏色（`ColorPicker palette="category"`，不開自訂：`color_idx` 存不了色碼）、預設長度、預設荷札、圓牌字、搬到分組。
 *   下拉換規範 §2.5 底線式 `.ns-select-wrap`。同時只開一列（受控 `detailOpen`）。
 *   ManagerRow 沒有「名字下一行」的插槽 ⇒ 淡字荷札行另畫成緊接在後的 `li.ns-tt-mgr-subli`（aria-hidden：同樣的資訊在展開區讀得到），
 *   列展開時它收起來（展開區已經列出荷札）。
 * - 每組一張 `ManagerList`（組頭也是一列 ManagerRow：改名、↑↓、⋯ 預設荷札）；組尾「＋ 新增分類」、清單尾「＋ 新增分組」都是文字鈕。
 *   新增列的「新增」是次鈕、「取消」是文字鈕——即時存的面板沒有主鈕（規範 §2.3）。
 *
 * ── 時刻表⑦（B 席；契約 §3、§6 D-時-166） ──
 * - 第四籤「作息」＝`RoutinesTab`（作息範本編輯器）。sheet `focus:"routine"`（＋`focusId`＝範本 id）⇒ 開作息籤、展開那一套；
 *   這時 focusId 不給分類籤。
 * - 分類清單接共用拖曳（`common/dragReorder`，tree 模式兩層）：同組換序、拖到別組＝搬組（落在新組的那個位置）、組本身也能拖（帶著子分類）；
 *   寫入＝store `placeCategory`（一次 write）。↑↓ 與 ⋯「搬到」照留（鍵盤與讀屏的入口）。
 */
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { MIN, colorSlot, fmtDur, groupedCategories, type TimeCategoryRow } from "../../../domain/timetable";
import { LONG_RUN_MAX_DEFAULT, TT_TEXT, useTimetableStore, type TimetableSheet } from "../../../store/timetableStore";
import { useUiStore } from "../../../store/uiStore";
import { CategoryBadge } from "../CategoryBadge";
import { Sub, type PanelProps } from "./controls";
import { NoticeSettings } from "./NoticeSettings";
import { GoalsTab } from "./GoalsTab";
import { RoutinesTab } from "./RoutinesTab";
import { TT_TAG_CATEGORY, catDefaults, type TimetableTagMaps } from "../../../domain/timetableTags";
import { EntityTagField } from "../../common/EntityTagField"; // 不經 ui/notes/desktop.ts（barrel 跟 lines/mounts 成圈；偏差記錄 10-20）
import { useShell } from "../../mobile/useShell";
import { FixedTagChips, MobileTagEntity, tagNameOf, ttBackRef, useTimetableTagMaps } from "../parts/TimetableTagChips";
import { Tabs, type TabItem } from "../../common/Tabs";
import { ManagerList, ManagerRow, type PopMenuItem } from "../../common/ManagerRow";
import { ColorPicker } from "../../common/ColorPicker";
import { IconPlus } from "../../common/icons";
import { Select } from "../../common/Select";
import { indexOfAnchor, useDragReorder } from "../../common/dragReorder";
import "./routines-tab.css"; // ⑦ B 席：拖曳時名字下那行跟著淡、目標籤的 ↑↓（樣式都在這支）

const TX = TT_TEXT.tags;

/** ⑦ 拖曳放不下的理由（指標旁那一句） */
const CAT_DRAG = {
  noPlace: "不能放這裡",
  groupBetween: "分組只能放在兩組之間",
  catInGroup: "分類要放進某一組",
} as const;

type MgrTab = "cats" | "notice" | "goals" | "routines";
const TABS: readonly TabItem<MgrTab>[] = [
  { key: "cats", label: "分類" },
  { key: "notice", label: "通知" },
  { key: "goals", label: "目標" },
  { key: "routines", label: "作息" }, // ⑦ B 席：作息範本編輯器（RoutinesTab）
];

/** sheet → 開在哪一籤（舊的 focus／focusId 照收，見 timetableStore 的 sheet 型別註解） */
function tabOf(sheet: TimetableSheet | null): MgrTab {
  if (sheet?.kind !== "categories") return "cats";
  if (sheet.focus === "notice") return "notice";
  if (sheet.focus === "routine") return "routines"; // ⑦：focusId 這時是範本 id
  if (sheet.focusId) return "cats";
  return sheet.tab ?? "cats";
}

/** 名字下（組：名字後）的淡字：自己的預設荷札＋組帶的 */
function TagsLine({ own, grp }: { own: readonly string[]; grp: readonly string[] }) {
  if (!own.length && !grp.length) return null;
  const hashes = (ks: readonly string[]): string => ks.map((k) => TX.chip(tagNameOf(k))).join(" ");
  return (
    <span className="ns-tt-mgr-tags">
      {own.length > 0 && <span className="ns-tt-mgr-own">{hashes(own)}</span>}
      {grp.length > 0 && (
        <span className="is-grp">
          {TX.groupCarried}
          {hashes(grp)}
        </span>
      )}
    </span>
  );
}

/** ManagerRow 後面那一行淡字荷札（沒有就不畫；樣式見 timetable.css「丙-4 T3」） */
function SubLine({ own, grp }: { own: readonly string[]; grp: readonly string[] }) {
  if (!own.length && !grp.length) return null;
  return (
    <li className="ns-tt-mgr-subli" aria-hidden="true">
      <TagsLine own={own} grp={grp} />
    </li>
  );
}

/** 展開區裡的一格：左欄小標、右欄控件 */
function Field({ k, children, top = false }: { k: string; children: ReactNode; top?: boolean }) {
  return (
    <div className={"ns-tt-mgr-field" + (top ? " is-top" : "")}>
      <span className="ns-tt-mgr-def-k">{k}</span>
      <span className="ns-tt-mgr-field-v">{children}</span>
    </div>
  );
}

/** ⋯ 展開區的「預設荷札」：桌機實體模式荷札欄／手機牌子＋點選器 */
function DefaultTagsRow({ id, name, exclude }: { id: string; name: string; exclude?: readonly string[] }) {
  const desk = useShell() === "desktop";
  const closeSheet = useTimetableStore((s) => s.closeSheet);
  return (
    <Field k={TX.defaults} top>
      {desk ? (
        <div className="ns-tt-tagfield">
          <EntityTagField
            entityType={TT_TAG_CATEGORY}
            entityId={id}
            exclude={exclude}
            suggestInline
            backRef={() => ttBackRef({ kind: "categories", focusId: id })}
            afterOpen={closeSheet}
          />
        </div>
      ) : (
        <MobileTagEntity entityType={TT_TAG_CATEGORY} entityId={id} pickName={name} />
      )}
    </Field>
  );
}

const DEFAULT_MIN_OPTIONS: readonly { v: number | null; label: string }[] = [
  { v: null, label: "無" },
  { v: 30, label: "30 分" },
  { v: 60, label: "1h" },
  { v: 90, label: "1h30" },
  { v: 120, label: "2h" },
  { v: 180, label: "3h" },
  { v: 240, label: "4h" },
  { v: 300, label: "5h" },
  { v: 360, label: "6h" },
  { v: 480, label: "8h" },
  { v: 600, label: "10h" },
  { v: 720, label: "12h" },
];

const LONG_RUN_OPTIONS: readonly { v: number; label: string }[] = [
  { v: 0, label: "關" },
  { v: 480, label: "8h" },
  { v: 600, label: "10h" },
  { v: 720, label: "12h" },
  { v: LONG_RUN_MAX_DEFAULT, label: "14h（預設）" },
  { v: 960, label: "16h" },
  { v: 1200, label: "20h" },
  { v: 1440, label: "24h" },
];

function isImeKey(e: KeyboardEvent<HTMLElement>): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229;
}

/** 新增分類／分組的一列輸入（UI 丙-4 B2：即時存的面板沒有主鈕——「新增」次鈕在右、「取消」文字鈕在左） */
function AddRow({ placeholder, onAdd, onCancel }: { placeholder: string; onAdd(name: string, keepOpen?: boolean): void; onCancel(): void }) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const submit = (keepOpen = false): void => {
    const t = text.trim();
    if (!t) return;
    onAdd(t, keepOpen);
    setText("");
    if (keepOpen) inputRef.current?.focus();
  };
  return (
    <div className="ns-tt-mgr-add">
      <input
        ref={inputRef}
        className="ns-tt-input"
        value={text}
        autoFocus
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (isImeKey(e)) return;
          if (e.key === "Enter") {
            e.preventDefault();
            submit(e.ctrlKey || e.metaKey);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
        enterKeyHint="done"
        spellCheck={false}
        autoComplete="off"
      />
      <button type="button" className="ns-btn btn-text ns-btn--sm" onClick={onCancel}>
        取消
      </button>
      <button type="button" className="ns-btn btn-ghost ns-btn--sm" disabled={!text.trim()} onClick={() => submit(false)}>
        新增
      </button>
    </div>
  );
}

/** 圓牌字：一個字；Enter／blur 存、Esc 還原；空字串不存；不是一個字 ⇒ toast B10、還原 */
function GlyphInput({ cat }: { cat: TimeCategoryRow }) {
  const setCategoryGlyph = useTimetableStore((s) => s.setCategoryGlyph);
  const shown = cat.glyph ?? Array.from(cat.name)[0] ?? "";
  const [draft, setDraft] = useState(shown);
  const skip = useRef(false);
  useEffect(() => setDraft(shown), [shown]);

  const commit = (): void => {
    if (skip.current) {
      skip.current = false;
      return;
    }
    const t = draft.trim();
    if (!t || t === shown) {
      setDraft(shown);
      return;
    }
    if (Array.from(t).length !== 1) {
      useUiStore.getState().showToast({ message: TT_TEXT.glyphInvalid });
      setDraft(shown);
      return;
    }
    void setCategoryGlyph(cat.id, t);
  };

  return (
    <input
      className="ns-tt-input ns-tt-glyph-input"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (isImeKey(e)) return;
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
          skip.current = true; // 之後的 blur 不再存一次
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          skip.current = true;
          setDraft(shown);
          e.currentTarget.blur();
        }
      }}
      onFocus={(e) => e.currentTarget.select()}
      aria-label={`${cat.name} 的縮寫字`}
      enterKeyHint="done"
      spellCheck={false}
      autoComplete="off"
    />
  );
}

/** 子分類列的展開區（⋯「更多設定…」） */
function CategoryDetail({
  cat,
  groups,
  categories,
  fromGroup,
}: {
  cat: TimeCategoryRow;
  /** 搬組的選項：未刪除、未封存的頂層組 */
  groups: readonly TimeCategoryRow[];
  categories: readonly TimeCategoryRow[];
  fromGroup: readonly string[];
}) {
  const updateCategory = useTimetableStore((s) => s.updateCategory);
  const moveCategoryToGroup = useTimetableStore((s) => s.moveCategoryToGroup);
  const cur = cat.default_min ?? null;
  const opts = DEFAULT_MIN_OPTIONS.some((o) => o.v === cur) ? DEFAULT_MIN_OPTIONS : [...DEFAULT_MIN_OPTIONS, { v: cur, label: fmtDur((cur ?? 0) * MIN) }];
  const slot = colorSlot(cat.color_idx);
  const group = categories.find((c) => c.id === cat.parent_id);
  return (
    <>
      <Field k="顏色">
        <ColorPicker
          palette="category"
          value={slot}
          label={`${cat.name} 的顏色`}
          onChange={(n) => {
            if (typeof n === "number" && n !== slot) void updateCategory(cat.id, { colorIdx: n });
          }}
        />
      </Field>
      <Field k="預設長度">
        <span className="ns-select-wrap">
          <Select
            className="techo-input"
            aria-label={`${cat.name} 的預設長度`}
            value={cur === null ? "" : String(cur)}
            onChange={(v) => void updateCategory(cat.id, { defaultMin: v === "" ? null : Number(v) })}
          >
            {opts.map((o) => (
              <option key={o.v === null ? "none" : o.v} value={o.v === null ? "" : String(o.v)}>
                {o.label}
              </option>
            ))}
          </Select>
        </span>
      </Field>
      <DefaultTagsRow id={cat.id} name={cat.name} exclude={fromGroup} />
      {fromGroup.length > 0 && group && (
        <p className="ns-tt-panel-sub ns-tt-mgr-grptags">
          {TX.groupCarried}
          <FixedTagChips tags={fromGroup.map((key) => ({ key, from: TX.fromGroup(group.name) }))} sm />
          <span>{TX.grpEditAt(group.name)}</span>
        </p>
      )}
      <Field k="圓牌字">
        <GlyphInput cat={cat} />
      </Field>
      <Field k="搬到">
        <span className="ns-select-wrap">
          <Select
            className="techo-input"
            aria-label={`${cat.name} 搬到哪一組`}
            value={cat.parent_id ?? ""}
            onChange={(v) => {
              if (v && v !== cat.parent_id) void moveCategoryToGroup(cat.id, v);
            }}
          >
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </Select>
        </span>
      </Field>
      <p className="ns-tt-panel-sub ns-tt-mgr-xnote">{TX.catNote}</p>
    </>
  );
}

/** 分類籤（onFocused：定位做完回報給外層，切籤再切回來就不再定位——UI 丙-4 修） */
function CategoriesTab({ focusId, onFocused }: { focusId?: string; onFocused?: () => void }) {
  const categories = useTimetableStore((s) => s.categories);
  const createCategory = useTimetableStore((s) => s.createCategory);
  const updateCategory = useTimetableStore((s) => s.updateCategory);
  const moveCategory = useTimetableStore((s) => s.moveCategory);
  const archiveCategory = useTimetableStore((s) => s.archiveCategory);
  const deleteCategory = useTimetableStore((s) => s.deleteCategory);
  const tagMaps: TimetableTagMaps = useTimetableTagMaps(); // ⑥

  /** 正在新增：`{ parentId }`（null＝新增分組） */
  const [adding, setAdding] = useState<{ parentId: string | null } | null>(null);
  /** 展開的那一列（同時只開一列，組或分類） */
  const [more, setMore] = useState<string | null>(null);
  /** 剛還原／定位到的那一列（閃一下） */
  const [flash, setFlash] = useState<string | null>(null);
  const [archOpen, setArchOpen] = useState(false);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 1400);
    return () => clearTimeout(t);
  }, [flash]);

  const groups = groupedCategories(categories);
  const topGroups = groups.map((g) => g.group);
  const archived = categories.filter((c) => c.parent_id !== null && c.archived_at !== null && c.deleted_at === null);
  const groupName = (id: string | null): string => categories.find((c) => c.id === id)?.name ?? "";

  // 磨光③ 2-11：從荷札頁點分類列（focusId）進來 ⇒ 展開、捲進畫面、閃一下（封存的分類 ⇒ 打開「已封存」摺疊）
  const rootRef = useRef<HTMLDivElement | null>(null);
  const isArchivedTarget = !!focusId && archived.some((c) => c.id === focusId);
  useEffect(() => {
    if (!focusId) return;
    onFocused?.();
    if (isArchivedTarget) setArchOpen(true);
    else setMore(focusId);
    setFlash(focusId);
    // 等一拍再捲：這一拍展開區還沒畫出來（setMore 下一次 render 才開），本文的可捲高度不夠，清單後段的列捲不到頂、
    // 停在卡底附近（實測：後段的「旅遊」停在卡底）。等展開區畫好再捲。不用 smooth：跟展開的動畫同時跑會被打斷；位置靠閃一下交代。
    // ManagerRow 掛 data-id、已封存列掛 data-cat-id
    const id = requestAnimationFrame(() => {
      const root = rootRef.current;
      if (!root) return;
      const el = Array.from(root.querySelectorAll<HTMLElement>("[data-id], [data-cat-id]")).find((n) => (n.dataset.id ?? n.dataset.catId) === focusId);
      el?.scrollIntoView({ block: "start" });
    });
    return () => cancelAnimationFrame(id);
    // 只在掛上時定位一次（換定位目標＝sheet 換 key、整個面板重掛）
  }, []);

  // ⑦ 拖曳排序（B 席，D-時-166）：組＋子分類攤平成兩層的樹（組 depth 0、子分類 depth 1）。組只在組之間換位置（帶著它的子分類走）；
  // 子分類放進任何一組＝同組換序或搬組（placeCategory：一次 write）。SubLine／空狀態等不是列的 <li> 沒有 data-drag-id，不算；封存區不參與。
  const [dragRoot, setDragRoot] = useState<HTMLDivElement | null>(null);
  const setRoot = useCallback((el: HTMLDivElement | null) => {
    rootRef.current = el;
    setDragRoot(el);
  }, []);
  const placeCategory = useTimetableStore((s) => s.placeCategory);
  const dragItems = groups.flatMap(({ group, children }) => [{ id: group.id, depth: 0 }, ...children.map((c) => ({ id: c.id, depth: 1 }))]);
  useDragReorder({
    root: dragRoot,
    items: dragItems,
    tree: {
      indent: 16,
      carried: (ids) => groups.filter((g) => ids.includes(g.group.id)).flatMap((g) => g.children.map((c) => c.id)),
    },
    resolve: (ids, place) => {
      if (place.kind !== "slot") return CAT_DRAG.noPlace;
      const me = categories.find((c) => c.id === ids[0]);
      if (!me) return CAT_DRAG.noPlace;
      if (me.parent_id === null) return place.depth === 0 ? true : CAT_DRAG.groupBetween;
      return place.depth === 1 && place.parent !== null ? true : CAT_DRAG.catInGroup;
    },
    onDrop: (ids, place) => {
      if (place.kind !== "slot") return;
      const id = ids[0];
      const latest = groupedCategories(useTimetableStore.getState().categories);
      const me = useTimetableStore.getState().catById[id];
      if (!me) return;
      const layer = me.parent_id === null ? latest.map((g) => g.group.id) : (latest.find((g) => g.group.id === place.parent)?.children.map((c) => c.id) ?? null);
      if (!layer) return;
      const at = indexOfAnchor(layer, id, place);
      if (at === null) return;
      const order = layer.filter((x) => x !== id);
      order.splice(at, 0, id);
      void placeCategory(id, me.parent_id === null ? null : place.parent, order);
    },
  });

  const add = (parentId: string | null, name: string, keepOpen = false): void => {
    if (!keepOpen) setAdding(null);
    void createCategory({ parentId, name, colorIdx: 1, defaultMin: null });
  };
  const toggle = (id: string) => (open: boolean) => setMore(open ? id : more === id ? null : more);

  return (
    <div className="ns-tt-mgr-cats" ref={setRoot}>
      {groups.map(({ group, children }, gi) => {
        const gTags = catDefaults(group.id, categories, tagMaps).own;
        return (
          <section key={group.id} className="ns-tt-mgr-group">
            <ManagerList label={`分組「${group.name}」`} className="ns-tt-mgr-list">
              <ManagerRow
                name={group.name}
                onRename={(name) => void updateCategory(group.id, { name })}
                onUp={gi > 0 ? () => void moveCategory(group.id, -1) : undefined}
                onDown={gi < groups.length - 1 ? () => void moveCategory(group.id, 1) : undefined}
                menu={[]}
                detail={
                  <>
                    <DefaultTagsRow id={group.id} name={group.name} />
                    <p className="ns-tt-panel-sub ns-tt-mgr-xnote">{TX.groupNote}</p>
                  </>
                }
                detailOpen={more === group.id}
                onDetailOpenChange={toggle(group.id)}
                className={"ns-tt-mgr-grow" + (flash === group.id ? " is-flash" : "")}
                dataId={group.id}
                dragId={group.id}
              />
              <SubLine own={gTags} grp={[]} />
              {children.map((c, i) => {
                const d = catDefaults(c.id, categories, tagMaps);
                const menu: PopMenuItem[] = [{ key: "archive", label: "封存", cut: true, onSelect: () => void archiveCategory(c.id, true) }]; // 己-2 A3：排在上移下移之後
                return [
                  <ManagerRow
                    key={c.id}
                    name={c.name}
                    onRename={(name) => void updateCategory(c.id, { name })}
                    swatch={<CategoryBadge cat={c} size="sm" />}
                    onUp={i > 0 ? () => void moveCategory(c.id, -1) : undefined}
                    onDown={i < children.length - 1 ? () => void moveCategory(c.id, 1) : undefined}
                    menu={menu}
                    detail={<CategoryDetail cat={c} groups={topGroups} categories={categories} fromGroup={d.fromGroup} />}
                    detailOpen={more === c.id}
                    onDetailOpenChange={toggle(c.id)}
                    className={flash === c.id ? "is-flash" : undefined}
                    dataId={c.id}
                    dragId={c.id}
                  />,
                  <SubLine key={c.id + "-sub"} own={d.own} grp={d.fromGroup} />,
                ];
              })}
              {children.length === 0 && adding?.parentId !== group.id && (
                <li className="ns-tt-mgr-emptyli">
                  <Sub>這一組還沒有分類</Sub>
                </li>
              )}
            </ManagerList>
            {adding?.parentId === group.id ? (
              <AddRow placeholder="新分類的名稱" onAdd={(name, keepOpen) => add(group.id, name, keepOpen)} onCancel={() => setAdding(null)} />
            ) : (
              <button type="button" className="ns-btn btn-text ns-btn--sm ns-tt-mgr-addbtn" onClick={() => setAdding({ parentId: group.id })}>
                <IconPlus />
                新增分類
              </button>
            )}
          </section>
        );
      })}
      {adding !== null && adding.parentId === null ? (
        <AddRow placeholder="新分組的名稱" onAdd={(name, keepOpen) => add(null, name, keepOpen)} onCancel={() => setAdding(null)} />
      ) : (
        <button type="button" className="ns-btn btn-text ns-tt-mgr-addbtn ns-tt-mgr-addgroup" onClick={() => setAdding({ parentId: null })}>
          <IconPlus />
          新增分組
        </button>
      )}

      {archived.length > 0 && (
        <details className="ns-tt-mgr-archived" open={archOpen} onToggle={(e) => setArchOpen(e.currentTarget.open)}>
          <summary>
            已封存 {archived.length} 個<i aria-hidden="true">›</i>
          </summary>
          <div className="ns-tt-mgr-archived-list">
            {archived.map((c) => (
              <div key={c.id} className={"ns-tt-mgr-row is-archived" + (flash === c.id ? " is-flash" : "")} data-cat-id={c.id}>
                <CategoryBadge cat={c} size="sm" />
                <span className="ns-tt-mgr-archived-name">
                  {c.name}
                  <small>{groupName(c.parent_id)}</small>
                </span>
                <button
                  type="button"
                  className="ns-btn btn-ghost ns-btn--sm"
                  onClick={() => {
                    setFlash(c.id);
                    void archiveCategory(c.id, false);
                  }}
                >
                  還原
                </button>
                <button
                  type="button"
                  className="ns-btn btn-ghost ns-btn--sm ns-btn-danger"
                  onClick={() => void deleteCategory(c.id)}
                >
                  刪除
                </button>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/** 通知籤：〈通知〉節＋忘記停車的提醒上限（§5 P5） */
function NoticeTab() {
  const longRunMaxMin = useTimetableStore((s) => s.longRunMaxMin);
  const setLongRunMax = useTimetableStore((s) => s.setLongRunMax);
  const selectId = useId();
  const longRunOpts = LONG_RUN_OPTIONS.some((o) => o.v === longRunMaxMin)
    ? LONG_RUN_OPTIONS
    : [...LONG_RUN_OPTIONS, { v: longRunMaxMin, label: fmtDur(longRunMaxMin * MIN) }];
  return (
    <>
      <NoticeSettings />
      <section className="ns-tt-mgr-settings ns-tt-mgr-longrun">
        <div className="ns-tt-setting">
          <label className="ns-tt-setting-k" htmlFor={selectId}>
            忘記停車的提醒上限
          </label>
          <span className="ns-select-wrap">
            <Select id={selectId} className="techo-input" value={String(longRunMaxMin)} onChange={(v) => void setLongRunMax(Number(v))}>
              {longRunOpts.map((o) => (
                <option key={o.v} value={String(o.v)}>
                  {o.label}
                </option>
              ))}
            </Select>
          </span>
        </div>
        <Sub>沒預估、分類也沒設預設長度時，跑超過這麼久就在回來時問一聲</Sub>
      </section>
    </>
  );
}

export function CategoryManagerPanel(_props: PanelProps) {
  const sheet = useTimetableStore((s) => s.sheet);
  const routineFocus = sheet?.kind === "categories" && sheet.focus === "routine";
  const focusId = sheet?.kind === "categories" && !routineFocus ? sheet.focusId : undefined;
  const routineFocusId = sheet?.kind === "categories" && routineFocus ? sheet.focusId : undefined;
  const want = tabOf(sheet);
  const [tab, setTab] = useState<MgrTab>(want);
  // 開著時 sheet 換了籤（又被叫一次、帶不同的 tab）⇒ 跟著換；使用者自己點籤不受影響（want 沒變就不動）
  useEffect(() => setTab(want), [want]);

  const tabsId = useId();
  const panelId = (k: MgrTab): string => `${tabsId}-panel-${k}`;
  const tabsRef = useRef<HTMLDivElement>(null);
  // 開窗焦點落在目前的籤（Tabs 沒有 focus API；等 DialogShell／MSheet 先把焦點放進殼）。preventScroll：定位捲動不要被拉回頂
  useEffect(() => {
    const id = requestAnimationFrame(() =>
      tabsRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(id);
  }, []);
  const current = TABS.find((t) => t.key === tab) ?? TABS[0];
  // UI 丙-4 修（T7 評審 4）：focusId 只定位一次。分類籤是條件渲染，切到通知／目標再切回來會重掛，
  // 不記住的話又展開、又閃、又捲一次，還蓋掉使用者自己展開的別列。sheet 換 focusId＝整個面板重掛，ref 跟著歸零。
  const focusDone = useRef(false);
  const routineFocusDone = useRef(false); // ⑦：作息籤的定位同樣只做一次

  return (
    <div className="ns-tt-panel ns-tt-panel-mgr">
      <div ref={tabsRef} className="ns-tt-mgr-tabs">
        <Tabs items={TABS} value={tab} onChange={setTab} size="md" aria-label="分類與設定分頁" getPanelId={panelId} />
      </div>
      {/* Tabs 不給籤鈕 id，分頁內容用 aria-label（籤名）命名（同設定頁） */}
      <div role="tabpanel" id={panelId(tab)} aria-label={current.label} className="ns-tt-mgr-tabpanel">
        {tab === "cats" && (
          <CategoriesTab
            focusId={focusDone.current ? undefined : focusId}
            onFocused={() => {
              focusDone.current = true;
            }}
          />
        )}
        {tab === "notice" && <NoticeTab />}
        {tab === "goals" && <GoalsTab />}
        {tab === "routines" && (
          <RoutinesTab
            focusId={routineFocusDone.current ? undefined : routineFocusId}
            onFocused={() => {
              routineFocusDone.current = true;
            }}
          />
        )}
      </div>
    </div>
  );
}
