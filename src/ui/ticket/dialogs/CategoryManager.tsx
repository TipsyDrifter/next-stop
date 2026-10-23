/**
 * CategoryManager——「分類管理」對話框本體（車次①契約 §5.1、§2.5-4；兩殼共用；丙席）。
 * props `{ onDone(): void }`；自己讀 store。標題由 host 依 `store.dialog.kind` 給。
 *
 * 頂部「支出｜收入」兩籤；兩層樹（domain `categoryTree`）：
 *   主分類行＝行內改名（失焦／Enter 才送）・「＋子」・↑↓ 排序（鍵盤 Alt+↑↓）・「封存」
 *   子分類縮排一層，同樣改名／排序／封存
 *   「未分類」固定在最後、不可改名不可封存（只顯示）
 *   底部「封存 N」折疊：封存的主分類（子分類跟著它）與「主分類還在、自己被封存」的子分類，各一個「取消封存」
 *   最下面一列新增主分類。
 * 沒有「刪除」：鐵則＝封存不刪（有帳指向的分類刪了舊帳會變孤兒）。
 */
import { useState, type KeyboardEvent } from "react";
import { useTicketStore } from "../../../store/ticketStore";
import { UNCAT_EXPENSE_ID, UNCAT_INCOME_ID, categoryTree, type CategoryKind, type CategoryRow } from "../../../domain/ticket";
import { useImeGuard } from "./dialogBits";

const isUncat = (id: string) => id === UNCAT_INCOME_ID || id === UNCAT_EXPENSE_ID;

// 即時存（改名失焦送、排序與封存按一下就寫）⇒ 沒有「完成」鈕：關閉走 ×／暗幕／返回鍵（UI 丙-1，視覺規範 §6）；onDone 留作宿主介面。
export function CategoryManager(_props: { onDone(): void }) {
  const categories = useTicketStore((s) => s.categories);
  const catById = useTicketStore((s) => s.catById);
  const createCategory = useTicketStore((s) => s.createCategory);
  const setCategoryArchived = useTicketStore((s) => s.setCategoryArchived);
  const [kind, setKind] = useState<CategoryKind>("expense");
  const [addingFor, setAddingFor] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const tree = categoryTree(categories, kind, { includeArchived: false });
  // 封存區：封存的主分類＋「父還活著、自己被封存」的子分類（父被封存的子分類跟著父一起回來，不另列）
  const archived = categories.filter((c) => {
    if (c.deleted_at !== null || c.kind !== kind || c.archived_at === null) return false;
    if (!c.parent_id) return true;
    const p = catById[c.parent_id];
    return !p || p.archived_at === null;
  });

  return (
    <div className="ns-tk-dialog ns-tk-dcats">
      <div className="ns-tk-dtabs" role="tablist" aria-label="收支類型">
        {(["expense", "income"] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={kind === k}
            onClick={() => {
              setKind(k);
              setAddingFor(null);
            }}
          >
            {k === "expense" ? "支出" : "收入"}
          </button>
        ))}
      </div>

      <ul className="ns-tk-dtree" aria-label={kind === "expense" ? "支出分類" : "收入分類"}>
        {tree.map(({ parent, children }) => (
          <li key={parent.id} className="ns-tk-dmain">
            <CatRow
              cat={parent}
              onAddSub={isUncat(parent.id) ? undefined : () => setAddingFor(addingFor === parent.id ? null : parent.id)}
              adding={addingFor === parent.id}
            />
            {(children.length > 0 || addingFor === parent.id) && (
              <ul className="ns-tk-dsubs">
                {children.map((c) => (
                  <li key={c.id}>
                    <CatRow cat={c} />
                  </li>
                ))}
                {addingFor === parent.id && (
                  <li>
                    <AddRow
                      placeholder={`「${parent.name}」下的子分類`}
                      autoFocus
                      onAdd={(name) => createCategory({ kind, name, parentId: parent.id })}
                      onCancel={() => setAddingFor(null)}
                    />
                  </li>
                )}
              </ul>
            )}
          </li>
        ))}
      </ul>

      <AddRow placeholder={kind === "expense" ? "新增支出主分類" : "新增收入主分類"} onAdd={(name) => createCategory({ kind, name, parentId: null })} />

      {archived.length > 0 && (
        <div className="ns-tk-darch">
          <button type="button" className="ns-tk-darch-tog" aria-expanded={showArchived} onClick={() => setShowArchived(!showArchived)}>
            封存 {archived.length}
          </button>
          {showArchived && (
            <ul>
              {archived.map((c) => {
                const p = c.parent_id ? catById[c.parent_id] : undefined;
                return (
                  <li key={c.id} className="ns-tk-drow is-archived">
                    <span className="nm">
                      {p ? `${p.name} › ` : ""}
                      {c.name}
                    </span>
                    <button type="button" className="ns-btn ns-btn--sm btn-ghost ns-tk-dmini" onClick={() => void setCategoryArchived(c.id, false)}>
                      取消封存
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/* ───────── 一行分類 ───────── */

function CatRow({ cat, onAddSub, adding }: { cat: CategoryRow; onAddSub?: () => void; adding?: boolean }) {
  const renameCategory = useTicketStore((s) => s.renameCategory);
  const moveCategory = useTicketStore((s) => s.moveCategory);
  const setCategoryArchived = useTicketStore((s) => s.setCategoryArchived);
  const [text, setText] = useState(cat.name);
  const [seen, setSeen] = useState(cat.name);
  if (seen !== cat.name) {
    // 外面改了名（同步／另一個殼）⇒ 跟著換（render 中同步 state，React 文件的「依 props 調整 state」作法）
    setSeen(cat.name);
    setText(cat.name);
  }
  const ime = useImeGuard((e) => (e.currentTarget as HTMLInputElement).blur());

  if (isUncat(cat.id)) {
    return (
      <div className="ns-tk-drow is-fixed">
        <span className="nm">{cat.name}</span>
        <small>固定在最後</small>
      </div>
    );
  }

  const commit = () => {
    const v = text.trim();
    if (!v) {
      setText(cat.name);
      return;
    }
    if (v !== cat.name) void renameCategory(cat.id, v);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      void moveCategory(cat.id, e.key === "ArrowUp" ? -1 : 1);
      return;
    }
    if (e.key === "Escape") {
      setText(cat.name);
      return;
    }
    ime.onKeyDown(e);
  };

  return (
    <div className={"ns-tk-drow" + (cat.parent_id ? " is-sub" : "")}>
      <input
        className="ns-tk-dname"
        value={text}
        aria-label={`分類名稱：${cat.name}`}
        autoComplete="off"
        enterKeyHint="done"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
        onCompositionStart={ime.onCompositionStart}
        onCompositionEnd={ime.onCompositionEnd}
      />
      {onAddSub && (
        <button type="button" className="ns-btn ns-btn--sm btn-ghost ns-tk-dmini" aria-expanded={adding} onClick={onAddSub}>
          ＋子
        </button>
      )}
      <button type="button" className="ns-iconbtn ns-tk-dmini sq" aria-label={`上移：${cat.name}`} title="上移（Alt+↑）" onClick={() => void moveCategory(cat.id, -1)}>
        ↑
      </button>
      <button type="button" className="ns-iconbtn ns-tk-dmini sq" aria-label={`下移：${cat.name}`} title="下移（Alt+↓）" onClick={() => void moveCategory(cat.id, 1)}>
        ↓
      </button>
      <button type="button" className="ns-btn ns-btn--sm btn-ghost ns-btn-danger ns-tk-dmini" onClick={() => void setCategoryArchived(cat.id, true)}>
        封存
      </button>
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
  onAdd(name: string): Promise<boolean>;
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
