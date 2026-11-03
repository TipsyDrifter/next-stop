/**
 * CategoryManager——「分類管理」對話框本體（車次①契約 §5.1、§2.5-4；兩殼共用；丙席）。
 * props `{ onDone(): void }`；自己讀 store。標題由 host 依 `store.dialog.kind` 給。
 *
 * 頂部「支出｜收入」分段鈕（Segmented，表單內的單選；UI 丙-5 E1，原本自畫兩籤）；分類樹（domain `categoryForest`）
 * 一張 ManagerList 畫完——列是共用 ManagerRow（時刻表分類管理同一種列，視覺規範 §2.5）：
 *   每一列：行內改名（失焦／Enter 才送）・↑↓（同層；鍵盤 Alt+↑↓；邊界禁用）・⋯（新增子分類…、移到…、封存）
 *   「新增子分類…」＝在那個分類底下（它整棵的最後）開一列新增（Esc 收回）
 *   「未分類」固定在最後：不可改名、沒有 ⋯、不排序（↑↓ 不畫，換成「固定在最後」小字，樣式在 ticket.css 丙-5 T3 區）
 *   底部「封存 N」折疊：自己封存、上層都還在的分類（封存的上層連底下整棵一起回來，不另列），各一個「取消封存」
 *   清單下面一列新增最上層的分類。
 * ↑↓ 的邊界照 repository.moveCategory 的兄弟算法（同一層、沒封存、不含未分類）＝畫面上看到的同層順序，所以用索引判。
 * 沒有「刪除」：鐵則＝封存不刪（有帳指向的分類刪了舊帳會變孤兒）。
 * 售票口④（契約 §5；桌機席）：共用拖曳（common/dragReorder 樹模式）。↑↓ 與 Alt+↑↓ 照留。
 *
 * 售票口④ 第二輪（D-票-78：不限層數；原型 prototypes/design-structure-分類多層.html 場景 a）：
 *   - 樹可展開收合（長相借荷札樹：列頭 › 轉 90°、每層縮一格；ManagerRow 的 `lead` 放縮排＋展開鈕）；收著的列尾淡字「N 個」。
 *     展開狀態在這個模組裡記著（關掉對話框再開還是同一個樣子；App 重開才回到全收）。
 *   - ⋯「移到…」：對話框換成「挑上層」清單（最上層＋整棵樹；自己與子孫不出現；不能放的畫灰、滑過說原因＝domain `moveUnderError`）；
 *     挑了＝`moveCategoryUnder`，回到樹、展開到看得見它、那一列閃一下。浮層不浮：手機與桌機同一份，不怕被對話框內捲裁掉。
 *     回到樹時焦點放回那一列的 ⋯；手機返回鍵＝回到樹（不關整張分類管理）；新增子分類那一列同理，返回＝收回。
 *   - 展開鈕進 Tab 順序（列上能聚焦的只有名稱輸入框，→／← 在那裡是移游標；鍵盤要靠這顆打開收著的分類）。
 *   - 拖曳 tree 模式：拖到兩列中間＝同層換位（`moveCategoryTo`）；往右拖進某一列底下＝成為它的子分類（`moveCategoryUnder`，
 *     index＝放下的位置）；停在收著的列上 600ms 自動展開。放不下的位置寫一句理由（`moveUnderError`：自己的子孫、封存的…）。
 *     手機長按拖曳由共用元件處理（列上非按鈕、非輸入框的地方：縮排、「N 個」淡字、列尾空白）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useTicketStore } from "../../../store/ticketStore";
import { indexOfAnchor, useDragReorder } from "../../common/dragReorder";
import {
  UNCAT_EXPENSE_ID,
  UNCAT_INCOME_ID,
  categoryForest,
  categoryLabel,
  categoryPath,
  effectiveParentId,
  moveUnderError,
  type CategoryKind,
  type CategoryNode,
  type CategoryRow,
} from "../../../domain/ticket";
import { ManagerList, ManagerRow, type PopMenuItem } from "../../common/ManagerRow";
import { Segmented } from "../../common/Segmented";
import { useImeGuard } from "./dialogBits";
import { useBackLayer } from "../../mobile/backStack";
import { CatCaret, CatTreeRow, ancestorIds, findNode, useCatOpen, visibleNodes } from "../view/catTree";
import "../ticket-4b.css";

const isUncat = (id: string) => id === UNCAT_INCOME_ID || id === UNCAT_EXPENSE_ID;

/** 每一層縮多少（px）：ManagerRow 的縮排與拖曳落點線同一個數（ticket-4b.css 的 --tk-ind） */
const INDENT = 18;

const KIND_OPTIONS = [
  { value: "expense", label: "支出" },
  { value: "income", label: "收入" },
] as const;

/** 展開著的分類（模組層記著：對話框關掉再開不重收） */
const openMemo = new Set<string>();

/** 同一層的兄弟（畫面上的順序；頂層不含未分類） */
function siblingsOf(tree: readonly CategoryNode[], parentId: string | null): CategoryNode[] {
  if (parentId === null) return tree.filter((n) => !isUncat(n.cat.id));
  return findNode(tree, parentId)?.children ?? [];
}

// 即時存（改名失焦送、排序與封存按一下就寫）⇒ 沒有「完成」鈕：關閉走 ×／暗幕／返回鍵（UI 丙-1，視覺規範 §6）；onDone 留作宿主介面。
export function CategoryManager(_props: { onDone(): void }) {
  const categories = useTicketStore((s) => s.categories);
  const catById = useTicketStore((s) => s.catById);
  const createCategory = useTicketStore((s) => s.createCategory);
  const renameCategory = useTicketStore((s) => s.renameCategory);
  const moveCategory = useTicketStore((s) => s.moveCategory);
  const moveCategoryTo = useTicketStore((s) => s.moveCategoryTo);
  const moveCategoryUnder = useTicketStore((s) => s.moveCategoryUnder);
  const setCategoryArchived = useTicketStore((s) => s.setCategoryArchived);
  const [kind, setKind] = useState<CategoryKind>("expense");
  const [addingFor, setAddingFor] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [moving, setMoving] = useState<string | null>(null); // 「移到…」正在挑上層的分類
  const [flash, setFlash] = useState<string | null>(null);
  // 手機返回鍵一層一層退：挑上層中＝回到樹；新增子分類列開著＝收回（桌機 no-op，Esc 各自處理）
  useBackLayer("ticket.cat.move", moving !== null, () => setMoving(null), "dialog");
  useBackLayer("ticket.cat.addsub", addingFor !== null && moving === null, () => setAddingFor(null), "dialog");
  const [open, toggleRaw] = useCatOpen(() => openMemo);
  const toggle = (id: string, want?: boolean) => {
    const on = want ?? !open.has(id);
    if (on) openMemo.add(id);
    else openMemo.delete(id);
    toggleRaw(id, on);
  };
  const openPath = (id: string | null) => {
    if (id === null) return;
    const c = useTicketStore.getState().catById[id];
    for (const a of [...ancestorIds(c, useTicketStore.getState().catById), id]) toggle(a, true);
  };

  const forest = categoryForest(categories, kind, { includeArchived: false });
  const tree = forest.filter((n) => !isUncat(n.cat.id));
  const uncat = forest.find((n) => isUncat(n.cat.id))?.cat ?? null;
  const rows = visibleNodes(tree, open);
  // 封存區：自己封存、上層都還在的（封存的上層連底下整棵一起回來，不另列）
  const archived = categories.filter(
    (c) =>
      c.deleted_at === null &&
      c.kind === kind &&
      c.archived_at !== null &&
      !categoryPath(c, catById)
        .slice(0, -1)
        .some((p) => p.archived_at !== null),
  );

  // 剛移好的那一列閃一下、捲進視野
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [dragRoot, setDragRoot] = useState<HTMLDivElement | null>(null);
  const setBox = useCallback((el: HTMLDivElement | null) => {
    boxRef.current = el;
    setDragRoot(el);
  }, []);
  useEffect(() => {
    if (!flash) return;
    boxRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(flash)}"]`)?.scrollIntoView({ block: "nearest" });
    const t = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(t);
  }, [flash]);

  // 「移到…」回到樹（挑好、取消、Esc、返回鍵）：整份清單重掛，焦點放回那一列的 ⋯（不然掉到 body，鍵盤要從頭 Tab）
  const backTo = useRef<string | null>(null);
  useEffect(() => {
    if (moving) {
      backTo.current = moving;
      return;
    }
    const id = backTo.current;
    backTo.current = null;
    if (!id) return;
    const row = boxRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
    (row?.querySelector<HTMLElement>("button[aria-haspopup]") ?? row?.querySelector<HTMLElement>(".ns-mgr-name"))?.focus({ preventScroll: true });
  }, [moving]);

  // 一列分類的共用 props：改名回 store 的結果（false＝沒改成，ManagerRow 退回原名）；↑↓ 在邊界不給＝禁用
  const rowProps = (n: CategoryNode) => {
    const sibs = siblingsOf(tree, effectiveParentId(n.cat, catById));
    const i = sibs.findIndex((x) => x.cat.id === n.cat.id);
    const hasKids = n.children.length > 0;
    return {
      name: n.cat.name,
      onRename: (next: string) => renameCategory(n.cat.id, next),
      onUp: i > 0 ? () => void moveCategory(n.cat.id, -1) : undefined,
      onDown: i >= 0 && i < sibs.length - 1 ? () => void moveCategory(n.cat.id, 1) : undefined,
      dataId: n.cat.id,
      dragId: n.cat.id,
      className: [n.depth > 0 ? "is-deep" : "", flash === n.cat.id ? "is-flash" : ""].filter(Boolean).join(" ") || undefined,
      lead: (
        <span className="ns-tk-dcat-lead" style={{ "--d": n.depth } as CSSProperties}>
          <CatCaret node={n} open={open.has(n.cat.id)} onToggle={(id) => toggle(id)} focusable />
        </span>
      ),
      note: hasKids && !open.has(n.cat.id) ? `${n.children.length} 個` : undefined,
      menu: [
        {
          key: "addsub",
          label: "新增子分類…",
          onSelect: () => {
            toggle(n.cat.id, true);
            setAddingFor(n.cat.id);
          },
        },
        { key: "move", label: "移到…", onSelect: () => setMoving(n.cat.id) },
        { key: "archive", label: "封存", cut: true, onSelect: () => void setCategoryArchived(n.cat.id, true) },
      ] satisfies PopMenuItem[],
    };
  };

  // 拖曳（樹模式）：畫面上看得到的分類列（未分類、新增列、封存區不算）
  useDragReorder({
    root: dragRoot,
    items: rows.map((n) => ({ id: n.cat.id, depth: n.depth })),
    disabled: moving !== null,
    tree: {
      indent: INDENT,
      carried: (ids) => {
        const out: string[] = [];
        for (const id of ids) {
          const i = rows.findIndex((r) => r.cat.id === id);
          if (i < 0) continue;
          for (let j = i + 1; j < rows.length && rows[j].depth > rows[i].depth; j++) out.push(rows[j].cat.id);
        }
        return out;
      },
      collapsed: (id) => {
        const n = rows.find((r) => r.cat.id === id);
        return !!n && n.children.length > 0 && !open.has(id);
      },
      expand: (id) => toggle(id, true),
    },
    resolve: (ids, place) => {
      if (place.kind !== "slot") return "這裡放不下";
      return moveUnderError(ids[0], place.parent, useTicketStore.getState().catById) ?? true;
    },
    onDrop: (ids, place) => {
      if (place.kind !== "slot") return;
      const id = ids[0];
      const s = useTicketStore.getState();
      const c = s.catById[id];
      if (!c || moveUnderError(id, place.parent, s.catById)) return;
      // 對最新的那一層換算位置（拖曳中被同步重載也不會落錯格）
      const latest = categoryForest(s.categories, kind, { includeArchived: false });
      const layer = siblingsOf(latest, place.parent).map((n) => n.cat.id);
      const at = indexOfAnchor(layer, id, place);
      if (at === null) return;
      if (place.parent === effectiveParentId(c, s.catById)) void moveCategoryTo(id, at);
      else {
        if (place.parent) toggle(place.parent, true); // 放進收著的分類：打開它，看得到落在哪
        void moveCategoryUnder(id, place.parent, at);
      }
    },
  });

  // 新增子分類那一列：接在那個分類整棵（畫面上看得到的）最後面
  let addAfter: { at: string; parent: CategoryNode } | null = null;
  const ai = addingFor ? rows.findIndex((r) => r.cat.id === addingFor) : -1;
  if (ai >= 0) {
    let j = ai;
    while (j + 1 < rows.length && rows[j + 1].depth > rows[ai].depth) j++;
    addAfter = { at: rows[j].cat.id, parent: rows[ai] };
  }

  if (moving) {
    const cat = catById[moving];
    if (cat) {
      return (
        <div ref={setBox} className="ns-tk-dialog ns-tk-dcats">
          <MovePicker
            cat={cat}
            forest={tree}
            onCancel={() => setMoving(null)}
            onPick={async (parentId) => {
              if (!(await moveCategoryUnder(cat.id, parentId))) return;
              setMoving(null);
              openPath(parentId);
              setFlash(cat.id);
            }}
          />
        </div>
      );
    }
  }

  return (
    <div ref={setBox} className="ns-tk-dialog ns-tk-dcats" style={{ "--tk-ind": `${INDENT}px` } as CSSProperties}>
      <Segmented
        className="ns-tk-dkind"
        aria-label="收支類型"
        options={KIND_OPTIONS}
        value={kind}
        onChange={(k) => {
          setKind(k);
          setAddingFor(null);
        }}
      />

      <ManagerList label={kind === "expense" ? "支出分類" : "收入分類"} className="ns-tk-dcatlist">
        {rows.flatMap((n) => {
          const out = [<ManagerRow key={n.cat.id} {...rowProps(n)} />];
          if (addAfter && addAfter.at === n.cat.id) {
            const p = addAfter.parent;
            out.push(
              <li key="add" className="ns-tk-dcat-addli" style={{ "--d": p.depth + 1 } as CSSProperties}>
                <AddRow
                  placeholder={`「${p.cat.name}」下的子分類`}
                  autoFocus
                  onAdd={(name) => createCategory({ kind, name, parentId: p.cat.id })}
                  onCancel={() => setAddingFor(null)}
                />
              </li>,
            );
          }
          return out;
        })}
        {uncat && <ManagerRow name={uncat.name} menu={[]} className="ns-tk-dcat-fixed" dataId={uncat.id} />}
      </ManagerList>

      <AddRow placeholder={kind === "expense" ? "新增支出主分類" : "新增收入主分類"} onAdd={(name) => createCategory({ kind, name, parentId: null })} />

      {archived.length > 0 && (
        <div className="ns-tk-darch">
          <button type="button" className="ns-tk-darch-tog" aria-expanded={showArchived} onClick={() => setShowArchived(!showArchived)}>
            封存 {archived.length}
          </button>
          {showArchived && (
            <ul>
              {archived.map((c) => (
                <li key={c.id} className="ns-tk-drow is-archived">
                  <span className="nm" title={categoryLabel(c, catById)}>
                    {categoryLabel(c, catById, { short: true })}
                  </span>
                  <button type="button" className="ns-btn ns-btn--sm btn-ghost ns-tk-dmini" onClick={() => void setCategoryArchived(c.id, false)}>
                    取消封存
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/* ───────── 移到…：挑上層 ───────── */

/**
 * 「X 要移到哪裡？」：最上層＋整棵樹（自己與子孫不列）；目前所在的那一層標「目前在這裡」、不能選；
 * 不能放的（封存的、未分類…）畫灰、滑過說原因。↑↓ 在可選的項目間移、→／← 展開收起、Esc 回分類樹（不關對話框）。
 */
function MovePicker({
  cat,
  forest,
  onPick,
  onCancel,
}: {
  cat: CategoryRow;
  forest: readonly CategoryNode[];
  onPick(parentId: string | null): void;
  onCancel(): void;
}) {
  const catById = useTicketStore((s) => s.catById);
  const cur = effectiveParentId(cat, catById);
  // 先展開到看得見現在的上層
  const [open, toggle] = useCatOpen(() => (cur ? [...ancestorIds(catById[cur], catById), cur] : []));
  // 自己整棵不列
  const pruned = useMemo(() => {
    const cut = (list: readonly CategoryNode[]): CategoryNode[] =>
      list.filter((n) => n.cat.id !== cat.id).map((n) => ({ ...n, children: cut(n.children) }));
    return cut(forest);
  }, [forest, cat.id]);
  const rows = visibleNodes(pruned, open);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(".opt:not([disabled])")?.focus({ preventScroll: true });
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const opts = Array.from(ref.current?.querySelectorAll<HTMLElement>(".opt:not([disabled])") ?? []);
    const i = opts.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!opts.length) return;
      const n = opts.length;
      opts[i < 0 ? 0 : (i + (e.key === "ArrowDown" ? 1 : n - 1)) % n].focus();
    } else if (e.key === "Escape") onCancel();
    else return;
    e.preventDefault();
    e.stopPropagation(); // Esc 只收回挑選，不關對話框
  };

  const opt = (parentId: string | null, label: string, title?: string) => {
    const here = parentId === cur;
    const why = here ? null : moveUnderError(cat.id, parentId, catById);
    return (
      <button
        type="button"
        className={"opt" + (here ? " is-here" : "")}
        disabled={here || why !== null}
        title={why ?? title}
        onClick={() => onPick(parentId)}
      >
        <span className="t">{label}</span>
        {here && <span className="r">目前在這裡</span>}
      </button>
    );
  };

  return (
    <div ref={ref} className="ns-tk-dmove" role="group" aria-label={`把「${cat.name}」移到哪裡`} onKeyDown={onKeyDown}>
      <div className="ns-tk-dmove-h">
        <p>
          「<b>{cat.name}</b>」要移到哪裡？
        </p>
        <button type="button" className="ns-btn ns-btn--sm btn-ghost" onClick={onCancel}>
          取消
        </button>
      </div>
      <p className="ns-tk-dhint">底下的子分類會一起移過去。</p>
      <div className="ns-tk-dmove-list">
        <div className="ns-tk-ctree is-root" data-depth={-1}>
          <span className="cr" aria-hidden />
          {opt(null, "最上層")}
        </div>
        {rows.map((n) => (
          <CatTreeRow key={n.cat.id} node={n} open={open.has(n.cat.id)} onToggle={toggle}>
            {opt(n.cat.id, n.cat.name, categoryLabel(n.cat, catById))}
          </CatTreeRow>
        ))}
      </div>
    </div>
  );
}

/* ───────── 新增一列 ───────── */

function AddRow({
  placeholder,
  autoFocus,
  onAdd,
  onCancel,
}: {
  placeholder: string;
  autoFocus?: boolean;
  /** 建好回真值（store.createCategory 回新分類列、失敗回 null；UI 丙-5） */
  onAdd(name: string): Promise<unknown>;
  onCancel?: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (busy || !text.trim()) return;
    setBusy(true);
    try {
      if (await onAdd(text)) setText("");
    } finally {
      setBusy(false);
    }
  };
  const ime = useImeGuard((e) => {
    e.preventDefault();
    void add();
  });
  return (
    <div className="ns-tk-dadd">
      <input
        className="techo-input ns-tk-din"
        value={text}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete="off"
        enterKeyHint="done"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && onCancel) {
            // 收回子分類新增列，不讓這一下 Esc 冒到對話框關窗
            e.preventDefault();
            e.stopPropagation();
            onCancel();
            return;
          }
          ime.onKeyDown(e);
        }}
        onCompositionStart={ime.onCompositionStart}
        onCompositionEnd={ime.onCompositionEnd}
      />
      <button type="button" className="ns-btn btn-ghost ns-tk-dbtn" disabled={busy || !text.trim()} onClick={() => void add()}>
        加入
      </button>
    </div>
  );
}
