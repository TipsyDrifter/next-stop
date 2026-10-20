/**
 * CategoryManagerPanel——「分類與設定」面板（車次①a 契約 §5.4、0-5；丙席）。
 * 依組列出：每組標題列（組名可改、↑↓ 排序、「＋ 分類」）；每個子分類一列 `div.ns-tt-mgr-row`：
 * Badge＋名稱（點了變輸入框，Enter／blur 存、Esc 還原）＋預設長度 select＋色盤 8 顆 swatch＋↑↓；底部「＋ 新增分組」。
 * 下方「設定」段：「長時間運行的保險上限」select；「運行中」開關一列——Android 寫「通知欄顯示運行中」
 * （沒有通知權限時「需要允許通知」＋按鈕），桌機寫「系統匣顯示運行中」、不問權限（①a 補充契約 §4；同一個設定鍵）。
 * 分流看真實平台（`onAndroid()`），不看排版：桌機視窗拉窄成手機排版也還是系統匣。
 * 車次①b Stage 0-B：「運行中」那一列＋權限提示原樣搬到 `NoticeSettings.tsx`（排在「設定」節之後；①c 由丁改寫成〈通知〉節）。
 * 不動任何集中檔（設定頁沒有三線插槽，契約 0-5）。
 *
 * 車次①b 進階管理（①b①c 契約 §5.6；乙席；長相＝原型 `v-e.js` 情境 6 manageBody、D-時-33「收在每一列的『⋯』裡」）：
 * - 每個子分類一列多一顆 `⋯`（↑↓ 旁邊），按了在那一列底下展開 div.ns-tt-mgr-x（同時只開一列）：
 *   「圓牌字」input.ns-tt-glyph-input（Enter／blur 存、Esc 還原、IME 護欄；空字串不存；不是一個字 ⇒ toast B10 不存）、
 *   「搬到」select（所有未刪除、未封存的頂層組；目前那組 selected）、「封存」鈕（toast B6 帶撤回）＋一行說明。
 * - 「＋ 新增分組」之後、「設定」節之前：details.ns-tt-mgr-archived「已封存 N 個」（0 個不畫；預設收起），每個一列＋「還原」。
 * - 不做刪除（〈開工決定〉二-5）；封存／搬組／圓牌字都只對子分類（頂層組的 ⋯ 是 ⑥ 加的，只放預設荷札）。
 * - 封存運行中那一班的分類：照封存（契約 §5.6「照跑、圓牌照畫」；原型是擋下來，資料語義以契約為準）。
 *
 * 車次⑥（⑥ 契約 §5.3；D-時-121、128、131；乙席；長相＝原型 `v-tags.js` mgrBody）：
 * - 每個子分類列：名字下一行淡字 div.ns-tt-mgr-tags「#拖延」（自己的預設荷札）＋「組帶的：#高效」（`.is-grp`；手機藏起來，D-時-131）。
 * - ⋯ 展開區最上面一列「預設荷札」：桌機 `EntityTagField` 實體模式（`timetable:category`；掛了就寫、toast＋復原；建議清單往下推開、
 *   不列組已經帶的）；手機牌子＋「＋ 荷札」開點選器 entity 模式。子分類另有一行「組帶的：[牌]（在組「X」的 ⋯ 改）」；最後一句說明。
 * - 組頭多一顆 ⋯（D-時-128），展開只放「預設荷札」＋說明；組名後面淡字列組的預設荷札。⋯ 同時只開一個（組或分類）。
 */
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { MIN, colorSlot, fmtDur, groupedCategories, type TimeCategoryRow } from "../../../domain/timetable";
import { LONG_RUN_MAX_DEFAULT, TT_TEXT, useTimetableStore } from "../../../store/timetableStore";
import { useUiStore } from "../../../store/uiStore";
import { CategoryBadge } from "../CategoryBadge";
import { Expand, Sub, type PanelProps } from "./controls";
import { NoticeSettings } from "./NoticeSettings";
import { TT_TAG_CATEGORY, catDefaults, type TimetableTagMaps } from "../../../domain/timetableTags";
import { EntityTagField } from "../../notes/tags/EntityTagField"; // 不經 ui/notes/desktop.ts（barrel 跟 lines/mounts 成圈；偏差記錄 10-20）
import { useShell } from "../../mobile/useShell";
import { FixedTagChips, MobileTagEntity, tagNameOf, ttBackRef, useTimetableTagMaps } from "../parts/TimetableTagChips";

const TX = TT_TEXT.tags;

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

/** ⋯ 展開區的「預設荷札」一列：桌機實體模式荷札欄／手機牌子＋點選器 */
function DefaultTagsRow({ id, name, exclude }: { id: string; name: string; exclude?: readonly string[] }) {
  const desk = useShell() === "desktop";
  const closeSheet = useTimetableStore((s) => s.closeSheet);
  return (
    <div className="ns-tt-mgr-tagrow">
      <span className="ns-tt-mgr-def-k">{TX.defaults}</span>
      {desk ? (
        <div className="ns-tt-tagfield">
          <EntityTagField
            entityType={TT_TAG_CATEGORY}
            entityId={id}
            exclude={exclude}
            suggestInline
            backRef={() => ttBackRef({ kind: "categories" })}
            afterOpen={closeSheet}
          />
        </div>
      ) : (
        <MobileTagEntity entityType={TT_TAG_CATEGORY} entityId={id} pickName={name} />
      )}
    </div>
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

const SWATCHES = [1, 2, 3, 4, 5, 6, 7, 8] as const;

function isImeKey(e: KeyboardEvent<HTMLElement>): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229;
}

/** 名稱：點了變輸入框；Enter／blur 存、Esc 還原；空字串不存 */
function EditableName({ value, onSave, label, big = false }: { value: string; onSave(name: string): void; label: string; big?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const cancelled = useRef(false);
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  const commit = (): void => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    setEditing(false);
    const t = draft.trim();
    if (t && t !== value) onSave(t);
    else setDraft(value);
  };

  if (!editing) {
    return (
      <button type="button" className={"ns-tt-mgr-name" + (big ? " is-group" : "")} onClick={() => setEditing(true)} aria-label={`${label}：${value}（點了改名）`}>
        {value}
      </button>
    );
  }
  return (
    <input
      className={"ns-tt-input ns-tt-mgr-name-input" + (big ? " is-group" : "")}
      value={draft}
      autoFocus
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (isImeKey(e)) return;
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          cancelled.current = true;
          setDraft(value);
          setEditing(false);
        }
      }}
      aria-label={label}
      enterKeyHint="done"
      spellCheck={false}
      autoComplete="off"
    />
  );
}

/** 新增分類／分組的一列輸入 */
function AddRow({ placeholder, onAdd, onCancel }: { placeholder: string; onAdd(name: string): void; onCancel(): void }) {
  const [text, setText] = useState("");
  const submit = (): void => {
    const t = text.trim();
    if (!t) return;
    onAdd(t);
    setText("");
  };
  return (
    <div className="ns-tt-mgr-add">
      <input
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
            submit();
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
      <button type="button" className="ns-btn btn-seal ns-btn--sm" disabled={!text.trim()} onClick={submit}>
        新增
      </button>
      <button type="button" className="ns-btn btn-ghost ns-btn--sm" onClick={onCancel}>
        取消
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
      aria-label={`${cat.name} 的圓牌字`}
      enterKeyHint="done"
      spellCheck={false}
      autoComplete="off"
    />
  );
}

function CategoryRow({
  cat,
  index,
  count,
  groups,
  open,
  flash,
  onToggle,
  categories,
  tagMaps,
}: {
  /** ⑥：推導預設荷札用（含封存的整張分類表） */
  categories: readonly TimeCategoryRow[];
  tagMaps: TimetableTagMaps;
  cat: TimeCategoryRow;
  index: number;
  count: number;
  /** 搬組的選項：未刪除、未封存的頂層組 */
  groups: readonly TimeCategoryRow[];
  /** ⋯ 展開著 */
  open: boolean;
  /** 剛還原：閃一下金底 */
  flash: boolean;
  onToggle(): void;
}) {
  const updateCategory = useTimetableStore((s) => s.updateCategory);
  const moveCategory = useTimetableStore((s) => s.moveCategory);
  const moveCategoryToGroup = useTimetableStore((s) => s.moveCategoryToGroup);
  const archiveCategory = useTimetableStore((s) => s.archiveCategory);
  const cur = cat.default_min ?? null;
  const opts = DEFAULT_MIN_OPTIONS.some((o) => o.v === cur) ? DEFAULT_MIN_OPTIONS : [...DEFAULT_MIN_OPTIONS, { v: cur, label: fmtDur((cur ?? 0) * MIN) }];
  const slot = colorSlot(cat.color_idx);
  // ⑥：自己的預設荷札＋組帶的
  const d = catDefaults(cat.id, categories, tagMaps);
  const group = categories.find((c) => c.id === cat.parent_id);
  return (
    <div className={"ns-tt-mgr-row" + (open ? " is-open" : "") + (flash ? " is-flash" : "")}>
      <CategoryBadge cat={cat} size="sm" />
      <span className="ns-tt-mgr-namecol">
        <EditableName value={cat.name} label="分類名稱" onSave={(name) => void updateCategory(cat.id, { name })} />
        <TagsLine own={d.own} grp={d.fromGroup} />
      </span>
      <span className="ns-tt-mgr-moves">
        <button type="button" className="ns-tt-mgr-move" disabled={index === 0} aria-label={`${cat.name} 往上`} onClick={() => void moveCategory(cat.id, -1)}>
          ↑
        </button>
        <button type="button" className="ns-tt-mgr-move" disabled={index >= count - 1} aria-label={`${cat.name} 往下`} onClick={() => void moveCategory(cat.id, 1)}>
          ↓
        </button>
        <button
          type="button"
          className={"ns-tt-mgr-move ns-tt-mgr-more" + (open ? " is-on" : "")}
          aria-expanded={open}
          aria-label={`${cat.name} 的更多：預設荷札、圓牌字、搬組、封存`}
          onClick={onToggle}
        >
          ⋯
        </button>
      </span>
      <div className="ns-tt-mgr-tools">
        <label className="ns-tt-mgr-def">
          <span className="ns-tt-mgr-def-k">預設長度</span>
          <select
            className="ns-tt-select"
            value={cur === null ? "" : String(cur)}
            onChange={(e) => void updateCategory(cat.id, { defaultMin: e.target.value === "" ? null : Number(e.target.value) })}
          >
            {opts.map((o) => (
              <option key={o.v === null ? "none" : o.v} value={o.v === null ? "" : String(o.v)}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <span className="ns-tt-swatches" role="group" aria-label={`${cat.name} 的顏色`}>
          {SWATCHES.map((n) => (
            <button
              key={n}
              type="button"
              className={"ns-tt-swatch" + (slot === n ? " is-on" : "")}
              style={{ "--c": `var(--ns-tt-cat-${n})` } as CSSProperties}
              aria-label={`第 ${n} 色`}
              aria-pressed={slot === n}
              onClick={() => {
                if (slot !== n) void updateCategory(cat.id, { colorIdx: n });
              }}
            />
          ))}
        </span>
      </div>
      {open && (
        <Expand className="ns-tt-mgr-x">
          <div className="ns-tt-mgr-xin">
            <DefaultTagsRow id={cat.id} name={cat.name} exclude={d.fromGroup} />
            {d.fromGroup.length > 0 && group && (
              <p className="ns-tt-panel-sub ns-tt-mgr-grptags">
                {TX.groupCarried}
                <FixedTagChips tags={d.fromGroup.map((key) => ({ key, from: TX.fromGroup(group.name) }))} sm />
                <span>{TX.grpEditAt(group.name)}</span>
              </p>
            )}
            <label className="ns-tt-mgr-def">
              <span className="ns-tt-mgr-def-k">圓牌字</span>
              <GlyphInput cat={cat} />
            </label>
            <label className="ns-tt-mgr-def">
              <span className="ns-tt-mgr-def-k">搬到</span>
              <select
                className="ns-tt-select"
                value={cat.parent_id ?? ""}
                onChange={(e) => {
                  if (e.target.value && e.target.value !== cat.parent_id) void moveCategoryToGroup(cat.id, e.target.value);
                }}
              >
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="ns-btn btn-ghost ns-btn--sm" onClick={() => void archiveCategory(cat.id, true)}>
              封存
            </button>
            <p className="ns-tt-panel-sub ns-tt-mgr-xnote">封存＝發車台、通知格、系統匣都不再出現；過去的時間塊照常顯示。不提供刪除。</p>
            <p className="ns-tt-panel-sub ns-tt-mgr-xnote">{TX.catNote}</p>
          </div>
        </Expand>
      )}
    </div>
  );
}

export function CategoryManagerPanel(_props: PanelProps) {
  const categories = useTimetableStore((s) => s.categories);
  const longRunMaxMin = useTimetableStore((s) => s.longRunMaxMin);
  const setLongRunMax = useTimetableStore((s) => s.setLongRunMax);
  const createCategory = useTimetableStore((s) => s.createCategory);
  const updateCategory = useTimetableStore((s) => s.updateCategory);
  const moveCategory = useTimetableStore((s) => s.moveCategory);

  const archiveCategory = useTimetableStore((s) => s.archiveCategory);
  const tagMaps = useTimetableTagMaps(); // ⑥

  /** 正在新增：`{ parentId }`（null＝新增分組） */
  const [adding, setAdding] = useState<{ parentId: string | null } | null>(null);
  /** ⋯ 展開的那一列（同時只開一列） */
  const [more, setMore] = useState<string | null>(null);
  /** 剛還原的那一列（閃一下） */
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 1400);
    return () => clearTimeout(t);
  }, [flash]);

  const groups = groupedCategories(categories);
  const topGroups = groups.map((g) => g.group);
  const archived = categories.filter((c) => c.parent_id !== null && c.archived_at !== null && c.deleted_at === null);
  const groupName = (id: string | null): string => categories.find((c) => c.id === id)?.name ?? "";
  const longRunOpts = LONG_RUN_OPTIONS.some((o) => o.v === longRunMaxMin)
    ? LONG_RUN_OPTIONS
    : [...LONG_RUN_OPTIONS, { v: longRunMaxMin, label: fmtDur(longRunMaxMin * MIN) }];

  const add = (parentId: string | null, name: string): void => {
    setAdding(null);
    void createCategory({ parentId, name, colorIdx: 1, defaultMin: null });
  };

  return (
    <div className="ns-tt-panel ns-tt-panel-mgr">
      {groups.map(({ group, children }, gi) => {
        const gOpen = more === group.id;
        const gTags = catDefaults(group.id, categories, tagMaps).own;
        return (
          <section key={group.id} className="ns-tt-mgr-group">
            <div className={"ns-tt-mgr-group-head" + (gOpen ? " is-open" : "")}>
              <span className="ns-tt-mgr-namecol is-group">
                <EditableName value={group.name} label="分組名稱" big onSave={(name) => void updateCategory(group.id, { name })} />
                <TagsLine own={gTags} grp={[]} />
              </span>
              <span className="ns-tt-mgr-moves">
                <button type="button" className="ns-tt-mgr-move" disabled={gi === 0} aria-label={`${group.name} 往上`} onClick={() => void moveCategory(group.id, -1)}>
                  ↑
                </button>
                <button
                  type="button"
                  className="ns-tt-mgr-move"
                  disabled={gi >= groups.length - 1}
                  aria-label={`${group.name} 往下`}
                  onClick={() => void moveCategory(group.id, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className={"ns-tt-mgr-move ns-tt-mgr-more" + (gOpen ? " is-on" : "")}
                  aria-expanded={gOpen}
                  aria-label={TX.groupMore(group.name)}
                  onClick={() => setMore(gOpen ? null : group.id)}
                >
                  ⋯
                </button>
              </span>
              <button type="button" className="ns-btn btn-ghost ns-btn--sm" onClick={() => setAdding({ parentId: group.id })}>
                ＋ 分類
              </button>
            </div>
            {gOpen && (
              <Expand className="ns-tt-mgr-x ns-tt-mgr-gx">
                <div className="ns-tt-mgr-xin">
                  <DefaultTagsRow id={group.id} name={group.name} />
                  <p className="ns-tt-panel-sub ns-tt-mgr-xnote">{TX.groupNote}</p>
                </div>
              </Expand>
            )}
            {adding?.parentId === group.id && <AddRow placeholder="新分類的名稱" onAdd={(name) => add(group.id, name)} onCancel={() => setAdding(null)} />}
            {children.length === 0 && adding?.parentId !== group.id && <Sub>這一組還沒有分類</Sub>}
            {children.map((c, i) => (
              <CategoryRow
                key={c.id}
                cat={c}
                index={i}
                count={children.length}
                groups={topGroups}
                open={more === c.id}
                flash={flash === c.id}
                onToggle={() => setMore(more === c.id ? null : c.id)}
                categories={categories}
                tagMaps={tagMaps}
              />
            ))}
          </section>
        );
      })}
      {adding !== null && adding.parentId === null ? (
        <AddRow placeholder="新分組的名稱" onAdd={(name) => add(null, name)} onCancel={() => setAdding(null)} />
      ) : (
        <button type="button" className="ns-btn btn-ghost ns-tt-mgr-addgroup" onClick={() => setAdding({ parentId: null })}>
          ＋ 新增分組
        </button>
      )}

      {archived.length > 0 && (
        <details className="ns-tt-mgr-archived">
          <summary>
            已封存 {archived.length} 個<i aria-hidden="true">›</i>
          </summary>
          <div className="ns-tt-mgr-archived-list">
            {archived.map((c) => (
              <div key={c.id} className="ns-tt-mgr-row is-archived">
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
              </div>
            ))}
          </div>
        </details>
      )}

      <section className="ns-tt-mgr-settings">
        <h4 className="ns-tt-mgr-sec">設定</h4>
        <label className="ns-tt-setting">
          <span className="ns-tt-setting-k">長時間運行的保險上限</span>
          <select className="ns-tt-select" value={String(longRunMaxMin)} onChange={(e) => void setLongRunMax(Number(e.target.value))}>
            {longRunOpts.map((o) => (
              <option key={o.v} value={String(o.v)}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <Sub>沒預估、分類也沒設預設長度時，跑超過這麼久就在回來時問一聲</Sub>
      </section>
      <NoticeSettings />
    </div>
  );
}
