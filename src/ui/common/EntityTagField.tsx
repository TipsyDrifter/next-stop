/**
 * EntityTagField——桌機的荷札欄，不綁實體種類（時刻表⑥ 契約 0-7；從 `TagField` 抽出、零行為插槽）。
 *
 * 長相、class、鍵盤規則逐字是原本的 `TagField`（車次③契約 §5.3；說明見 `TagField.tsx` 檔頭）：
 *   牌子一排（點牌＝進荷札頁；hover 出 × 摘）＋「＋ 掛荷札」⇒ 輸入框＋建議清單；
 *   ↑↓ 選列・Enter 掛・Tab 補完・空白鍵＝照打的字掛上・Esc 收起（不漏給外層；焦點回「掛荷札」鈕）・空著按 Backspace 兩下摘最後一個。
 *   選中列（售票口④ P1，2026-11-03；規則在 `entityTagKeys.ts`）：打了字或用 ↑↓ 動過才有。欄位空著、沒動過 ⇒ 清單照列常用荷札但
 *   不反白任何一列，Enter／Tab 不攔、交給外層（例：售票口新的一筆＝存檔；以前會悄悄掛上第一個建議）。
 *
 * 兩種用法：
 *   - **實體模式**（`entityType`＋`entityId`）：掛／摘立刻寫（`tagStore.attach／detach`，toast＋復原）——原本 TagField 的行為。
 *   - **受控模式**（`value`＋`onChange`）：只改草稿（名稱陣列），不寫資料；給「按『改好了』才存」的面板用。
 *     牌子不能點（點了會離開面板、草稿就丟了）：TagChip 不給 onOpen ⇒ 名字畫成 span。
 * 選填：`exclude`＝建議清單多排除的 key；`suggestInline`＝建議清單往下推開（`.ns-notes-sug.static`）而不是浮層
 *         （按著滑鼠點到別處造成的失焦，等放開才收清單——先收的話下面的列往上跳，那一下會點空；售票口④ O1）；
 *       `backRef`＋`afterOpen`＝點牌進荷札頁時的「回到剛才」與之後要做的事。都不給＝原本 TagField 的樣子。
 *
 * ── UI 丙-2 搬家（契約 §1 #18；2026-10-22）──
 * 用途：荷札欄（掛／摘荷札），任務側板 TagField、時刻表面板的受控草稿共用。
 * 規範：視覺規範 §2.5（表單控件）、§1.1 荷札牌 --tag-*；聚焦底線＝--accent（§2.5）。
 * ARIA：輸入框 role=combobox＋aria-expanded（有焦點才展開）＋aria-label「掛荷札」；建議清單 role=listbox＋aria-label「荷札建議」。
 * 鍵盤：見上（↑↓／Enter／Tab 補完／空白鍵／Esc 收起焦點回「掛荷札」鈕／空字 Backspace 兩下摘最後一個）。
 * 樣式：.ns-notes-tagfield／tagadd／taginput／sug 仍在 notes/notes-tags.css（荷札頁、捕捉框、時刻表共用），由 TagChip 帶入。
 *   原路徑 notes/tags/EntityTagField.tsx 的 re-export 殼在 UI 丙-7 T5 刪掉（呼叫端都改 import 本檔）。
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { TagEntityType } from "../../data/tagRepository";
import { completeTab, keyOf, keysOfEntity, normalizeName } from "../../domain/tags";
import { useTagStore, type TagBackRef } from "../../store/tagStore";
import { useUiStore } from "../../store/uiStore";
import { IconPlus } from "../notes/notesBits";
import { TagChip } from "../notes/tags/TagChip";
import { TagSuggestRows, suggestCount, suggestPick } from "../notes/tags/TagSuggest";
import { arrowAct, enterAction, hasPick } from "./entityTagKeys";

const NO_KEYS: readonly string[] = [];

interface CommonProps {
  /** 建議清單多排除的 key（例：已經由別處帶上的） */
  exclude?: readonly string[];
  /** 建議清單往下推開、不是浮層（放在會裁切的捲動區裡用） */
  suggestInline?: boolean;
}
export type EntityTagFieldProps =
  | (CommonProps & {
      entityType: TagEntityType;
      entityId: string;
      /** 點牌進荷札頁時「回到剛才」（點的當下才組） */
      backRef?: () => TagBackRef;
      /** 進荷札頁之後（例：收起側板） */
      afterOpen?: () => void;
      value?: undefined;
    })
  | (CommonProps & {
      /** 草稿：荷札名稱 */
      value: readonly string[];
      onChange(names: string[]): void;
      /** 換了一個對象就收起輸入框、清空（受控模式沒有 entityId 可比） */
      resetKey?: string;
      entityType?: undefined;
    });

export function EntityTagField(props: EntityTagFieldProps) {
  const index = useTagStore((s) => s.index);
  const controlled = props.value !== undefined;
  const entityType = props.entityType;
  const entityId = props.entityType !== undefined ? props.entityId : null;
  const value = props.value;
  const resetKey = props.entityType !== undefined ? props.entityId : props.resetKey;

  /** 受控模式：key → 顯示名（荷札已存在用它的名，否則用正規化後的打字） */
  const draft = useMemo(() => {
    if (!value) return null;
    const out: { key: string; name: string }[] = [];
    for (const raw of value) {
      const n = normalizeName(raw);
      if (n.ok && !out.some((x) => x.key === n.key)) out.push({ key: n.key, name: n.name });
    }
    return out;
  }, [value]);
  const keys = useMemo(() => {
    if (draft) return draft.map((x) => x.key);
    return index && entityType !== undefined && entityId !== null ? keysOfEntity(index, entityType, entityId) : NO_KEYS;
  }, [draft, index, entityType, entityId]);

  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [q, setQ] = useState("");
  const [act, setAct] = useState(0);
  /** 這次打字之後用 ↑↓ 動過選列沒（選中列的規則見檔頭） */
  const [moved, setMoved] = useState(false);
  const [armed, setArmed] = useState(false);
  const inRef = useRef<HTMLInputElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  /** Esc 收起後焦點回「掛荷札」鈕（磨光③ 2-9）；空字失焦收起不搶（使用者是點去別處） */
  const focusAddAfterClose = useRef(false);
  const busy = useRef(false);
  /** 正按著滑鼠（suggestInline 的失焦看它：見 onBlur） */
  const pressing = useRef(false);

  useEffect(() => {
    if (!useTagStore.getState().index) void useTagStore.getState().loadIndex();
  }, []);
  // 換了一個對象：收起、清空
  useEffect(() => {
    setOpen(false);
    setQ("");
    setAct(0);
    setMoved(false);
    setArmed(false);
  }, [resetKey]);
  useEffect(() => {
    if (open) inRef.current?.focus({ preventScroll: true });
    else if (focusAddAfterClose.current) {
      focusAddAfterClose.current = false;
      addRef.current?.focus({ preventScroll: true });
    }
  }, [open]);
  const inline = !!props.suggestInline;
  useEffect(() => {
    if (!open || !inline) return;
    const down = () => (pressing.current = true);
    const up = () => (pressing.current = false);
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      pressing.current = false;
    };
  }, [open, inline]);

  const exclude = props.exclude;
  const res = useMemo(
    () => (open ? useTagStore.getState().suggest(q, { exclude: exclude?.length ? [...keys, ...exclude] : keys }) : null),
    // index 換了（掛上、別處改名）要重算
    [open, q, keys, index, exclude],
  );
  const n = res ? suggestCount(res) : 0;
  const curAct = Math.min(act, Math.max(0, n - 1));
  const picked = hasPick(q, moved);

  const attach = async (raw: string | null) => {
    const name = (raw ?? "").trim();
    if (!name || busy.current) return;
    if (props.value !== undefined) {
      const nn = normalizeName(name);
      if (!nn.ok) {
        useUiStore.getState().showToast({ message: nn.reason });
        return;
      }
      if (!keys.includes(nn.key)) props.onChange([...(draft ?? []).map((x) => x.name), nn.name]);
      setQ("");
      setAct(0);
      setMoved(false);
      inRef.current?.focus({ preventScroll: true });
      return;
    }
    busy.current = true;
    try {
      const r = await useTagStore.getState().attach(props.entityType, props.entityId, name);
      if (r) {
        setQ("");
        setAct(0);
        setMoved(false);
      }
    } finally {
      busy.current = false;
      inRef.current?.focus({ preventScroll: true });
    }
  };

  const detach = (key: string) => {
    setArmed(false);
    if (props.value !== undefined) {
      props.onChange((draft ?? []).filter((x) => x.key !== key).map((x) => x.name));
      return;
    }
    void useTagStore.getState().detach(props.entityType, props.entityId, key);
  };

  const openTag = (key: string) => {
    if (props.value !== undefined) return;
    const back = props.backRef?.();
    const after = props.afterOpen;
    void useTagStore
      .getState()
      .openTagPage(key, back)
      .then(() => after?.());
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key !== "Backspace") setArmed(false);
    if (!res) return;
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
        e.preventDefault();
        setAct(arrowAct(curAct, e.key === "ArrowDown" ? 1 : -1, n, picked));
        setMoved(true);
        return;
      case "Enter": {
        const how = enterAction(q, moved, n);
        if (how === "pass") return; // 空著、沒選列：不攔，交給外層
        e.preventDefault();
        void attach(how === "pick" ? suggestPick(res, curAct) : q);
        return;
      }
      case "Tab": {
        const it = picked ? res.items[curAct] : undefined;
        if (it) {
          e.preventDefault();
          setQ(completeTab(it, res.browse));
          setAct(0);
          setMoved(false);
        }
        return;
      }
      case " ":
        e.preventDefault();
        if (q.trim()) void attach(q);
        return;
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        focusAddAfterClose.current = true;
        setOpen(false);
        setQ("");
        setMoved(false);
        return;
      case "Backspace":
        if (q || !keys.length) return;
        e.preventDefault();
        if (armed) detach(keys[keys.length - 1]);
        else setArmed(true);
        return;
    }
  };

  const nameOf = (k: string) => draft?.find((x) => x.key === k)?.name ?? useTagStore.getState().nameOf(k);

  return (
    <div className="ns-notes-tagfield">
      {keys.map((k, i) => (
        <TagChip
          key={k}
          name={nameOf(k)}
          armed={armed && i === keys.length - 1}
          onOpen={controlled ? undefined : () => openTag(k)}
          onRemove={() => detach(k)}
        />
      ))}
      {open ? (
        <>
          <span className="ns-notes-taginput">
            <i aria-hidden>#</i>
            <input
              ref={inRef}
              value={q}
              placeholder="打名稱，/ 分層"
              aria-label="掛荷札"
              autoComplete="off"
              spellCheck={false}
              role="combobox"
              aria-expanded={focused}
              onChange={(e) => {
                setQ(e.target.value);
                setAct(0);
                setMoved(false);
                setArmed(false);
              }}
              onKeyDown={onKeyDown}
              onFocus={() => setFocused(true)}
              onBlur={() => {
                const settle = () => {
                  if (document.activeElement === inRef.current) return; // 又回到這一格了
                  setFocused(false);
                  setArmed(false);
                  setMoved(false);
                  if (!q.trim()) setOpen(false);
                };
                if (!inline || !pressing.current) {
                  settle();
                  return;
                }
                // 往下推開的清單：按下去就收，下面的列會往上跳、放開時已經不在指標底下（click 落空）。
                // 等放開——mouseup 與 click 同一輪派送，排到下一個 task 才收
                const after = () => {
                  window.removeEventListener("pointerup", after, true);
                  window.removeEventListener("pointercancel", after, true);
                  window.setTimeout(settle, 0);
                };
                window.addEventListener("pointerup", after, true);
                window.addEventListener("pointercancel", after, true);
              }}
            />
          </span>
          {focused && res && (
            <div className={"ns-notes-sug" + (props.suggestInline ? " static" : "")} role="listbox" aria-label="荷札建議">
              <TagSuggestRows
                res={res}
                act={picked ? curAct : -1}
                onPick={(i) => void attach(suggestPick(res, i))}
                // 還沒有選中列時，滑過只有 :hover 的底色、不變成選中列（不然 Enter 會掛上滑鼠剛好停著的那一列）
                onHover={picked ? setAct : undefined}
                nameOf={nameOf}
              />
            </div>
          )}
        </>
      ) : (
        <button
          ref={addRef}
          type="button"
          className="ns-notes-tagadd"
          onClick={() => {
            setOpen(true);
            setFocused(true); // 打開就聚焦（effect）；不等 focus 事件
          }}
        >
          <IconPlus size={11} />
          掛荷札
        </button>
      )}
    </div>
  );
}

/** 受控模式的草稿裡有沒有某個 key（給面板判斷「分類已帶」那顆要不要畫） */
export function draftHasKey(names: readonly string[], key: string): boolean {
  return names.some((n) => keyOf(n) === key);
}
