/**
 * TagField——任務側板的「荷札」欄（桌機；旅客筆記車次③契約 0-2 的 `NodeFieldSpec.Desktop`、§5.3；原型 app.js tagFieldHtml／onFieldKey）。
 *
 * 渲染在核心 `FieldRow label="荷札"` 裡（插槽 `nodeFields`；渲染點在 `TaskFields.tsx`，整合席接）。本元件不 import 側板任何東西。
 *
 *   `div.ns-notes-tagfield`＝牌子一排（點牌＝進荷札頁並記「回到剛才」；hover 出 × 摘）
 *     ＋ 末尾 `button.ns-notes-tagadd`「＋ 掛荷札」⇒ 就地變 `span.ns-notes-taginput`（`i`「#」＋ input）＋ 下方建議清單
 *   輸入框鍵（先判 IME，契約 §1-8）：
 *     ↑↓ 選列・Enter 掛選中列（沒有列＝照打的字）・Tab 補完到下一個 /・**空白鍵＝照打的字掛上**（組字中不攔）・
 *     Esc 收起（不漏給側板，否則側板也關）・輸入框空著按 Backspace：第一下最後一個牌 `.is-armed`、第二下摘掉
 *   掛上後輸入框清空、保持開著；新建的才跳 toast（store 做）；摘下 toast＋復原（store 做）。
 * 資料：`tagStore.index` 的 ents 找這張票的 keys（不另查）；index 還沒載就載一次。
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { NodeRow } from "../../../domain";
import { completeTab, keysOfEntity } from "../../../domain/tags";
import { useTagStore } from "../../../store/tagStore";
import { useUiStore } from "../../../store/uiStore";
import { IconPlus } from "../notesBits";
import { TagChip } from "./TagChip";
import { TagSuggestRows, moveAct, suggestCount, suggestPick } from "./TagSuggest";
import { panelBackRef } from "./backRefs";

const NO_KEYS: readonly string[] = [];

export function TagField({ node }: { node: NodeRow }) {
  const index = useTagStore((s) => s.index);
  const keys = useMemo(() => (index ? keysOfEntity(index, "node", node.id) : NO_KEYS), [index, node.id]);

  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [q, setQ] = useState("");
  const [act, setAct] = useState(0);
  const [armed, setArmed] = useState(false);
  const inRef = useRef<HTMLInputElement>(null);
  const busy = useRef(false);

  useEffect(() => {
    if (!useTagStore.getState().index) void useTagStore.getState().loadIndex();
  }, []);
  // 換了一張票：收起、清空
  useEffect(() => {
    setOpen(false);
    setQ("");
    setAct(0);
    setArmed(false);
  }, [node.id]);
  useEffect(() => {
    if (open) inRef.current?.focus({ preventScroll: true });
  }, [open]);

  const res = useMemo(
    () => (open ? useTagStore.getState().suggest(q, { exclude: keys }) : null),
    // index 換了（掛上、別處改名）要重算
    [open, q, keys, index],
  );
  const n = res ? suggestCount(res) : 0;
  const curAct = Math.min(act, Math.max(0, n - 1));

  const attach = async (raw: string | null) => {
    const name = (raw ?? "").trim();
    if (!name || busy.current) return;
    busy.current = true;
    try {
      const r = await useTagStore.getState().attach("node", node.id, name);
      if (r) {
        setQ("");
        setAct(0);
      }
    } finally {
      busy.current = false;
      inRef.current?.focus({ preventScroll: true });
    }
  };

  const detach = (key: string) => {
    setArmed(false);
    void useTagStore.getState().detach("node", node.id, key);
  };

  const openTag = (key: string) => {
    const back = panelBackRef(node.id);
    void useTagStore
      .getState()
      .openTagPage(key, back)
      .then(() => useUiStore.getState().setPanelOpen(false));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key !== "Backspace") setArmed(false);
    if (!res) return;
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp":
        e.preventDefault();
        setAct(moveAct(curAct, e.key === "ArrowDown" ? 1 : -1, n));
        return;
      case "Enter":
        e.preventDefault();
        void attach(n ? suggestPick(res, curAct) : q);
        return;
      case "Tab": {
        const it = res.items[curAct];
        if (it) {
          e.preventDefault();
          setQ(completeTab(it, res.browse));
          setAct(0);
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
        setOpen(false);
        setQ("");
        return;
      case "Backspace":
        if (q || !keys.length) return;
        e.preventDefault();
        if (armed) detach(keys[keys.length - 1]);
        else setArmed(true);
        return;
    }
  };

  const nameOf = (k: string) => useTagStore.getState().nameOf(k);

  return (
    <div className="ns-notes-tagfield">
      {keys.map((k, i) => (
        <TagChip
          key={k}
          name={nameOf(k)}
          armed={armed && i === keys.length - 1}
          onOpen={() => openTag(k)}
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
                setArmed(false);
              }}
              onKeyDown={onKeyDown}
              onFocus={() => setFocused(true)}
              onBlur={() => {
                setFocused(false);
                setArmed(false);
                if (!q.trim()) setOpen(false);
              }}
            />
          </span>
          {focused && res && (
            <div className="ns-notes-sug" role="listbox" aria-label="荷札建議">
              <TagSuggestRows res={res} act={curAct} onPick={(i) => void attach(suggestPick(res, i))} onHover={setAct} nameOf={nameOf} />
            </div>
          )}
        </>
      ) : (
        <button
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
