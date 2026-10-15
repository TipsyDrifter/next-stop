/**
 * MobileTagPicker——手機的荷札點選器（底部抽屜約八成高；旅客筆記車次③契約 §5.5；原型 app.js:786-828、1081-1122）。
 *
 * 由 NotesMobileOverlay 依 `tagStore.picker` 畫（每個 tab 都在）；誰都可以 `tagStore.openPicker(...)` 叫它：
 *   - entity 模式：掛在某個實體上（路線圖詳情「＋ 掛荷札」、之後的票卡 ⋯ →「荷札…」）。
 *     開的時候已掛的牌子就是「已選」；完成＝`setTags(type, id, 已選名稱)`——一個交易、一個 toast、一次復原（原型 9）。
 *   - insert 模式：筆記／日記編輯工具列的「#」。完成＝`onInsert(已選名稱)`（可能是空陣列：呼叫端把焦點放回打字框）。
 * 完成＝右上「完成」或點暗幕（原型 9：點暗幕也算完成）。
 *
 * 由上而下：標題（「荷札・<名稱>」／「插入荷札」）＋完成 → 已選的牌子（× 常駐）→ 搜尋（不用打 #）
 *   → 有字：「建立 ○○」、提示、`難度/` 的瀏覽標頭、結果列（勾選框＋名稱＋數量）
 *   → 沒字：「最近用過」一排（≤6）＋「全部荷札」樹（勾選；虛資料夾只能展開）；長按一列 500ms
 *     ⇒ 該列下方出「在 #○○ 底下建立…」⇒ 搜尋框填成 `○○/`、聚焦。
 * 樹的展開狀態是本元件自己的（不動荷札頁的 openKeys：點選器關掉，荷札頁的樹不該跟著變）。
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { flattenTree } from "../../../domain/tags";
import { useTagStore, type TagPickerState } from "../../../store/tagStore";
import { IconPlus, IconSearch } from "./mobileDiaryBits";
import { IconCaretRight, IconCheck, MTag, TagGlyph, TagName } from "./mobileTagBits";
import "../notes-mobile.css";

interface Sel {
  key: string;
  name: string;
}

const LONG_PRESS_MS = 500;
/** 長按期間手指移動超過這麼多 px＝在捲動，不算長按 */
const LONG_PRESS_SLOP = 8;

export function MobileTagPicker({ picker }: { picker: TagPickerState }) {
  const index = useTagStore((s) => s.index);
  const recent = useTagStore((s) => s.recent);
  const suggest = useTagStore((s) => s.suggest);
  const nameOf = useTagStore((s) => s.nameOf);
  const closePicker = useTagStore((s) => s.closePicker);
  const setTags = useTagStore((s) => s.setTags);

  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Sel[]>([]);
  const [open, setOpen] = useState<Record<string, 1>>({});
  /** 長按出「在這底下建立…」的那一列 */
  const [lp, setLp] = useState<string | null>(null);
  const inited = useRef(false);
  const composing = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const press = useRef<{ t: number; key: string; x: number; y: number; fired: boolean } | null>(null);
  const done = useRef(false);

  // 已掛的牌子＝初始的「已選」（index 可能還沒載回來：載到的第一刻補）
  useEffect(() => {
    if (inited.current || !index) return;
    inited.current = true;
    if (picker.mode === "entity" && picker.entityType && picker.entityId) {
      setSel(useTagStore.getState().keysOf(picker.entityType, picker.entityId).map((k) => ({ key: k, name: nameOf(k) })));
    }
  }, [index, picker, nameOf]);

  useEffect(() => () => window.clearTimeout(press.current?.t), []);

  const has = (key: string) => sel.some((s) => s.key === key);
  const toggle = (key: string, name?: string) => {
    setLp(null);
    setSel((cur) => (cur.some((s) => s.key === key) ? cur.filter((s) => s.key !== key) : [...cur, { key, name: name ?? nameOf(key) }]));
  };

  const qq = q.trim();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const res = useMemo(() => (qq ? suggest(qq, { limit: 14 }) : null), [suggest, qq, index]);
  const rows = useMemo(() => (index && !qq ? flattenTree(index, open, "") : []), [index, open, qq]);
  const recentRows = useMemo(
    () => (index ? recent.filter((k) => index.byKey[k]?.real).slice(0, 6) : []),
    [index, recent],
  );

  const create = () => {
    if (!res?.create) return;
    const c = res.create;
    setSel((cur) => (cur.some((s) => s.key === c.key) ? cur : [...cur, { key: c.key, name: c.name }]));
    setQ("");
    searchRef.current?.focus();
  };

  const finish = () => {
    if (done.current) return;
    done.current = true;
    const names = sel.map((s) => s.name);
    closePicker();
    if (picker.mode === "insert") {
      picker.onInsert?.(names);
      return;
    }
    if (picker.entityType && picker.entityId) void setTags(picker.entityType, picker.entityId, names);
  };

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing || e.keyCode === 229 || composing.current) return;
    e.preventDefault();
    if (res?.create) create();
    else if (res?.items[0]) toggle(res.items[0].key);
  };

  /* 長按（樹的一列）：500ms 不放、手指沒移動 ⇒ 出「在這底下建立…」；長按後的那一下 click 不算勾選 */
  const pressStart = (key: string) => (e: PointerEvent) => {
    window.clearTimeout(press.current?.t);
    const p = { key, x: e.clientX, y: e.clientY, fired: false, t: 0 };
    p.t = window.setTimeout(() => {
      p.fired = true;
      setLp(key);
    }, LONG_PRESS_MS);
    press.current = p;
  };
  const pressMove = (e: PointerEvent) => {
    const p = press.current;
    if (!p || p.fired) return;
    if (Math.abs(e.clientX - p.x) > LONG_PRESS_SLOP || Math.abs(e.clientY - p.y) > LONG_PRESS_SLOP) window.clearTimeout(p.t);
  };
  const pressEnd = () => window.clearTimeout(press.current?.t);
  /** 長按剛觸發：吃掉接著來的 click */
  const swallow = () => {
    const p = press.current;
    if (p?.fired) {
      press.current = null;
      return true;
    }
    return false;
  };

  const createUnder = (key: string) => {
    setLp(null);
    setQ(nameOf(key) + "/");
    window.setTimeout(() => searchRef.current?.focus(), 0);
  };

  const title = picker.mode === "insert" ? "插入荷札" : `荷札・${picker.name}`;

  return createPortal(
    <div
      className="ns-notes-mveil is-top"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) finish();
      }}
    >
      <div className="ns-notes-mpicker" role="dialog" aria-modal="true" aria-label={title}>
        <div className="ns-notes-grip" aria-hidden />
        <div className="ns-notes-mpkhead">
          <h3>{title}</h3>
          <button type="button" className="ns-notes-mbtn primary" onClick={finish}>
            完成
          </button>
        </div>

        <div className="ns-notes-mpkchips" aria-live="polite">
          {sel.length === 0 ? (
            <span className="empty">{picker.mode === "insert" ? "勾選要插入的荷札" : "還沒掛荷札"}</span>
          ) : (
            sel.map((s) => <MTag key={s.key} name={s.name} onRemove={() => toggle(s.key)} />)
          )}
        </div>

        <label className="ns-notes-mpksearch">
          <IconSearch />
          <input
            ref={searchRef}
            className="ns-notes-minput"
            type="search"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setLp(null);
            }}
            onKeyDown={onSearchKey}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            placeholder="搜尋或建立荷札（不用打 #）"
            aria-label="搜尋或建立荷札"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="done"
          />
        </label>

        <div className="ns-notes-mpkbody">
          {res ? (
            <>
              {res.create && (
                <button type="button" className="ns-notes-mpkrow create" onClick={create}>
                  <IconPlus size={14} />
                  <span className="nm">
                    建立 <b>{res.create.name}</b>
                  </span>
                </button>
              )}
              {res.browse && res.items.length > 0 && <p className="ns-notes-mpkhint head">#{nameOf(res.browse)} 底下</p>}
              {res.hint && <p className="ns-notes-mpkhint">{res.hint}{res.browse ? "——接著打子荷札的名稱就能建立" : ""}</p>}
              {res.items.map((it) => (
                <button
                  key={it.key}
                  type="button"
                  className="ns-notes-mpkrow"
                  role="checkbox"
                  aria-checked={has(it.key)}
                  onClick={() => toggle(it.key, it.name)}
                >
                  <CheckBox on={has(it.key)} />
                  <span className="nm">
                    <TagName name={it.name} hl={it.hl} />
                  </span>
                  <span className="n">{it.count}</span>
                </button>
              ))}
              {!res.items.length && !res.create && !res.hint && <p className="ns-notes-mpkhint">沒有對到的荷札</p>}
            </>
          ) : (
            <>
              {recentRows.length > 0 && (
                <>
                  <p className="ns-notes-mpklabel">最近用過</p>
                  <div className="ns-notes-mpkrecent">
                    {recentRows.map((k) => (
                      <button
                        key={k}
                        type="button"
                        className={"ns-notes-mpkrc" + (has(k) ? " on" : "")}
                        aria-pressed={has(k)}
                        onClick={() => toggle(k)}
                      >
                        {has(k) && <IconCheck size={11} />}
                        <TagName name={nameOf(k)} />
                      </button>
                    ))}
                  </div>
                </>
              )}
              <p className="ns-notes-mpklabel">
                全部荷札<span>長按一列：在這底下建立…</span>
              </p>
              {!index ? (
                <p className="ns-notes-mpkhint">載入中…</p>
              ) : rows.length === 0 ? (
                <p className="ns-notes-mpkhint">還沒有荷札——上面搜尋框打個名稱就能建立</p>
              ) : (
                <div className="ns-notes-mpktree" role="tree" aria-label="全部荷札">
                  {rows.map((r) => {
                    const x = r.node;
                    const toggleOpen = () => {
                      setLp(null);
                      setOpen((cur) => {
                        const next = { ...cur };
                        if (next[x.key]) delete next[x.key];
                        else next[x.key] = 1;
                        return next;
                      });
                    };
                    return (
                      <div key={x.key} role="none">
                        <div
                          className={"ns-notes-mpktrow" + (x.real ? "" : " virtual") + (lp === x.key ? " is-lp" : "")}
                          style={{ ["--d" as string]: x.depth - 1 }}
                          role="treeitem"
                          aria-expanded={r.hasKids ? r.open : undefined}
                          aria-selected={x.real ? has(x.key) : undefined}
                          onPointerDown={pressStart(x.key)}
                          onPointerMove={pressMove}
                          onPointerUp={pressEnd}
                          onPointerLeave={pressEnd}
                          onPointerCancel={pressEnd}
                          onContextMenu={(e) => e.preventDefault()}
                        >
                          {r.hasKids ? (
                            <button
                              type="button"
                              className={"cr" + (r.open ? " open" : "")}
                              aria-label={r.open ? `收合 #${x.name}` : `展開 #${x.name}`}
                              onClick={() => {
                                if (!swallow()) toggleOpen();
                              }}
                            >
                              <IconCaretRight />
                            </button>
                          ) : (
                            <span className="cr" aria-hidden />
                          )}
                          <button
                            type="button"
                            className="ln"
                            onClick={() => {
                              if (swallow()) return;
                              if (x.real) toggle(x.key, x.name);
                              else toggleOpen();
                            }}
                          >
                            {x.real ? <CheckBox on={has(x.key)} /> : <TagGlyph real={false} />}
                            <span className="nm">{x.seg}</span>
                            {!x.real && <span className="vf">虛資料夾</span>}
                          </button>
                          <span className="n">{x.total}</span>
                        </div>
                        {lp === x.key && (
                          <div className="ns-notes-mpklp" style={{ ["--d" as string]: x.depth }}>
                            <button type="button" className="ns-notes-mbtn" onClick={() => createUnder(x.key)}>
                              <IconPlus />在 #{x.name} 底下建立…
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              <p className="ns-notes-mtreelegend">
                <TagGlyph real={false} />
                虛資料夾：只能展開、不能勾（沒人直接掛它）
              </p>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function CheckBox({ on }: { on: boolean }) {
  return <span className={"ns-notes-mcheck" + (on ? " on" : "")}>{on && <IconCheck />}</span>;
}
