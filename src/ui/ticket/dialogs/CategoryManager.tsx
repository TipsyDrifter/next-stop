/**
 * CategoryManager——「分類管理」對話框本體（車次①契約 §5.1、§2.5-4；兩殼共用；丙席）。
 * props `{ onDone(): void }`；自己讀 store。標題由 host 依 `store.dialog.kind` 給。
 *
 * 頂部「支出｜收入」分段鈕（Segmented，表單內的單選；UI 丙-5 E1，原本自畫兩籤）；兩層樹（domain `categoryTree`）
 * 一張 ManagerList 畫完——列是共用 ManagerRow（時刻表分類管理同一種列，視覺規範 §2.5）：
 *   主分類＝depth 0：行內改名（失焦／Enter 才送）・↑↓（鍵盤 Alt+↑↓；邊界禁用）・⋯（新增子分類…、封存）
 *   子分類＝depth 1，緊接在它的主分類後面：同樣改名／↑↓／⋯（封存）
 *   「新增子分類…」＝在那組子分類最後開一列新增（Esc 收回）
 *   「未分類」固定在最後：不可改名、沒有 ⋯、不排序（↑↓ 不畫，換成「固定在最後」小字，樣式在 ticket.css 丙-5 T3 區）
 *   底部「封存 N」折疊：封存的主分類（子分類跟著它）與「主分類還在、自己被封存」的子分類，各一個「取消封存」
 *   清單下面一列新增主分類。
 * ↑↓ 的邊界照 repository.moveCategory 的兄弟算法（同一層、沒封存、不含未分類）＝畫面上看到的同層順序，所以用索引判。
 * 沒有「刪除」：鐵則＝封存不刪（有帳指向的分類刪了舊帳會變孤兒）。
 */
import { Fragment, useState } from "react";
import { useTicketStore } from "../../../store/ticketStore";
import { UNCAT_EXPENSE_ID, UNCAT_INCOME_ID, categoryTree, type CategoryKind, type CategoryRow } from "../../../domain/ticket";
import { ManagerList, ManagerRow, type PopMenuItem } from "../../common/ManagerRow";
import { Segmented } from "../../common/Segmented";
import { useImeGuard } from "./dialogBits";

const isUncat = (id: string) => id === UNCAT_INCOME_ID || id === UNCAT_EXPENSE_ID;

const KIND_OPTIONS = [
  { value: "expense", label: "支出" },
  { value: "income", label: "收入" },
] as const;

// 即時存（改名失焦送、排序與封存按一下就寫）⇒ 沒有「完成」鈕：關閉走 ×／暗幕／返回鍵（UI 丙-1，視覺規範 §6）；onDone 留作宿主介面。
export function CategoryManager(_props: { onDone(): void }) {
  const categories = useTicketStore((s) => s.categories);
  const catById = useTicketStore((s) => s.catById);
  const createCategory = useTicketStore((s) => s.createCategory);
  const renameCategory = useTicketStore((s) => s.renameCategory);
  const moveCategory = useTicketStore((s) => s.moveCategory);
  const setCategoryArchived = useTicketStore((s) => s.setCategoryArchived);
  const [kind, setKind] = useState<CategoryKind>("expense");
  const [addingFor, setAddingFor] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const tree = categoryTree(categories, kind, { includeArchived: false });
  // 可排序的主分類（未分類固定在最後、不算在同層兄弟裡）
  const mains = tree.filter((t) => !isUncat(t.parent.id));
  const uncat = tree.find((t) => isUncat(t.parent.id))?.parent ?? null;
  // 封存區：封存的主分類＋「父還活著、自己被封存」的子分類（父被封存的子分類跟著父一起回來，不另列）
  const archived = categories.filter((c) => {
    if (c.deleted_at !== null || c.kind !== kind || c.archived_at === null) return false;
    if (!c.parent_id) return true;
    const p = catById[c.parent_id];
    return !p || p.archived_at === null;
  });

  // 一列分類的共用 props：改名回 store 的結果（false＝沒改成，ManagerRow 退回原名）；↑↓ 在邊界不給＝禁用
  const rowProps = (cat: CategoryRow, i: number, n: number) => ({
    name: cat.name,
    onRename: (next: string) => renameCategory(cat.id, next),
    onUp: i > 0 ? () => void moveCategory(cat.id, -1) : undefined,
    onDown: i < n - 1 ? () => void moveCategory(cat.id, 1) : undefined,
    dataId: cat.id,
  });
  const archiveItem = (cat: CategoryRow): PopMenuItem => ({ key: "archive", label: "封存", onSelect: () => void setCategoryArchived(cat.id, true) });

  return (
    <div className="ns-tk-dialog ns-tk-dcats">
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
        {mains.map(({ parent, children }, pi) => (
          <Fragment key={parent.id}>
            <ManagerRow
              {...rowProps(parent, pi, mains.length)}
              menu={[
                { key: "addsub", label: "新增子分類…", onSelect: () => setAddingFor(parent.id) },
                archiveItem(parent),
              ]}
            />
            {children.map((c, ci) => (
              <ManagerRow key={c.id} depth={1} {...rowProps(c, ci, children.length)} menu={[archiveItem(c)]} />
            ))}
            {addingFor === parent.id && (
              <li className="ns-tk-dcat-addli">
                <AddRow
                  placeholder={`「${parent.name}」下的子分類`}
                  autoFocus
                  onAdd={(name) => createCategory({ kind, name, parentId: parent.id })}
                  onCancel={() => setAddingFor(null)}
                />
              </li>
            )}
          </Fragment>
        ))}
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
