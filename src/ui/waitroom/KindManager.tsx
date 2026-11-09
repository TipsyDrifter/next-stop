/**
 * KindManager——「管番線」：候車室種類的管理清單（壬 D-主-518、D-主-519、D-主-520；比照售票口分類管理、常用票種）。
 * 桌機包 DialogShell（`KindManagerDialog`）、手機包 MSheet（`KindManagerSheet`）；本體同一份。
 *
 * 一張 ManagerList：每列＝「N番線」（position 順位，1 起算）・名稱（行內改名，失焦／Enter 送）・實現動作下拉（五種 WISH_ACTION_LABEL）・⋯
 *   ⋯＝上移／下移（ManagerRow 內建，Alt+↑↓ 同義）、刪除（store 會擋「還有 N 件掛著」並 toast；刪成了 toast 可復原）。
 *   拖曳排序（共用 dragReorder：放開對最新清單換算 indexOfAnchor → moveWishKindTo）。
 * 最下面一列直接加：名稱・動作・「＋ 加入」（Enter 也是；新的排最後＝下一個番線）。即時存，沒有「完成」鈕。
 */
import { useRef, useState } from "react";
import { useTicketStore } from "../../store/ticketStore";
import { WISH_ACTIONS, WISH_ACTION_LABEL } from "../../domain/ticket";
import type { WishAction, WishKindRow } from "../../domain/ticketAids";
import { ManagerList, ManagerRow } from "../common/ManagerRow";
import { indexOfAnchor, useDragReorder } from "../common/dragReorder";
import { DialogShell } from "../common/DialogShell";
import { MSheet } from "../common/MSheet";
import { IconPlus } from "../common/icons";
import { Select } from "../common/Select";
import { useImeGuard } from "../ticket/dialogs/dialogBits";

function ActionSelect({ value, onChange, label }: { value: WishAction; onChange(a: WishAction): void; label: string }) {
  return (
    <span className="ns-select-wrap ns-wr-act">
      <Select className="techo-input" aria-label={label} value={value} onChange={(v) => onChange(v as WishAction)}>
        {WISH_ACTIONS.map((a) => (
          <option key={a} value={a}>
            {WISH_ACTION_LABEL[a]}
          </option>
        ))}
      </Select>
    </span>
  );
}

export function KindManager() {
  const kinds = useTicketStore((s) => s.wishKinds);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const s = useTicketStore.getState;

  useDragReorder({
    root,
    items: kinds.map((k) => ({ id: k.id })),
    onDrop: (ids, place) => {
      if (place.kind !== "slot") return;
      const latest = useTicketStore.getState().wishKinds.map((k) => k.id);
      const at = indexOfAnchor(latest, ids[0], place);
      if (at !== null) void s().moveWishKindTo(ids[0], at);
    },
  });

  return (
    <div ref={setRoot} className="ns-wr-kinds">
      <ManagerList label="番線">
        {kinds.map((k: WishKindRow, i) => (
          <ManagerRow
            key={k.id}
            dragId={k.id}
            dataId={k.id}
            name={k.name}
            lead={<span className="ns-wr-plno">{i + 1}番線</span>}
            onRename={(next) => s().updateWishKind(k.id, { name: next })}
            note={<ActionSelect label={`${k.name}的實現動作`} value={k.action} onChange={(action) => void s().updateWishKind(k.id, { action })} />}
            onUp={i > 0 ? () => void s().moveWishKindTo(k.id, i - 1) : undefined}
            onDown={i < kinds.length - 1 ? () => void s().moveWishKindTo(k.id, i + 1) : undefined}
            menu={[{ key: "delete", label: "刪除", danger: true, cut: true, onSelect: () => void s().deleteWishKind(k.id) }]}
          />
        ))}
      </ManagerList>
      <KindAdd />
    </div>
  );
}

function KindAdd() {
  const [name, setName] = useState("");
  const [action, setAction] = useState<WishAction>("ticket");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const add = async (keepFocus = true) => {
    if (busy || !name.trim()) {
      ref.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const row = await useTicketStore.getState().createWishKind({ name: name.trim(), action });
      if (row) {
        setName("");
        if (keepFocus) ref.current?.focus();
        else ref.current?.blur();
      }
    } finally {
      setBusy(false);
    }
  };
  const ime = useImeGuard((e) => {
    e.preventDefault();
    void add(e.ctrlKey || e.metaKey);
  });
  return (
    <div className="ns-wr-kindadd">
      <input
        ref={ref}
        className="nm"
        placeholder="新的番線…"
        aria-label="新番線的名稱"
        autoComplete="off"
        enterKeyHint="done"
        value={name}
        onChange={(e) => setName(e.target.value)}
        {...ime}
      />
      <ActionSelect label="新番線的實現動作" value={action} onChange={setAction} />
      <button type="button" className="ns-btn ns-btn--sm btn-ghost" disabled={busy || !name.trim()} onClick={() => void add()}>
        <IconPlus size={12} />
        加入
      </button>
    </div>
  );
}

export function KindManagerDialog({ onClose }: { onClose(): void }) {
  return (
    <DialogShell title="管番線" overline={{ zh: "候車室", latin: "Waiting Room" }} size="M" onClose={onClose} topClass="pt-[12vh]">
      <KindManager />
    </DialogShell>
  );
}

export function KindManagerSheet({ onClose }: { onClose(): void }) {
  return (
    <MSheet title="管番線" onClose={onClose} backId="core.waitroom.kinds" className="ns-wr-msheet" height="half">
      <KindManager />
    </MSheet>
  );
}
