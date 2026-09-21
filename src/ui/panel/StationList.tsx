/**
 * 車站清單（UI Flow 2.1 路線版 · 里程碑管理）：列出 parent_id＝路線 的車站——行內改名、預定到站日、到站紀念章切換、刪除；底部一行新增。
 * 到站＝arrived_on 寫今天（依日界線 todayKey(dayStartHour)）；再按一次取消（null）。刪除走 soft delete＋復原 toast（與大綱同語彙）。
 * 視覺＝原型語彙 1:1：每站一列＝名稱（原型 .title）＋ .meta（預定日・着 日期）＋ 到站章（原型 .late-seal 形制、seal 色、寫「着」；
 * 未到站的章不可見，列 hover 才以虛線空章現身、剛蓋的播 arrIn）；刪除叉 hover 現身；新增車站＝底線輸入、Enter 建立。
 * 已知取捨：車站排序沿 position，不提供拖曳（v0.2 不做）；車站不在大綱樹裡，沒有子孫數問題、刪除不二次確認。
 */
import { useMemo, useState } from "react";
import type { NodeRow } from "../../domain";
import { todayKey } from "../../lib/date";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { CommitInput, DateField, SectionRule, XIcon } from "./fields";
import { fmtDateKey } from "./format";

export function StationList({ routeId }: { routeId: string }) {
  const stations = useNodeStore((s) => s.stations);
  const createNode = useNodeStore((s) => s.createNode);
  const updateNode = useNodeStore((s) => s.updateNode);
  const deleteNode = useNodeStore((s) => s.deleteNode);
  const undoDelete = useNodeStore((s) => s.undoDelete);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const showToast = useUiStore((s) => s.showToast);

  const list = useMemo(() => stations.filter((s) => s.parent_id === routeId), [stations, routeId]);
  const arrivedCount = list.filter((s) => s.arrived_on).length;

  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  // 剛蓋章的那一站才播蓋印動畫（純視覺）
  const [freshId, setFreshId] = useState<string | null>(null);

  const add = async () => {
    const name = draft.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      const row = await createNode({ kind: "station", name, parentId: routeId });
      if (row) setDraft("");
    } finally {
      setBusy(false);
    }
  };

  const toggleArrived = (st: NodeRow) => {
    const next = !st.arrived_on;
    setFreshId(next ? st.id : null);
    void updateNode(st.id, { arrived_on: next ? todayKey(dayStartHour) : null });
  };

  const remove = (st: NodeRow) => {
    void (async () => {
      const ids = await deleteNode(st.id);
      if (!ids.length) return;
      showToast({
        message: `已刪除車站「${st.name}」`,
        actionLabel: "復原",
        onAction: () => void undoDelete(),
      });
    })();
  };

  return (
    <section>
      <SectionRule title="車站" aside={list.length ? `${arrivedCount}/${list.length} 到站` : undefined} />
      {list.length === 0 ? (
        <p className="empty">還沒有車站——里程碑會以小注記掛在側欄路線底下。</p>
      ) : (
        <ul className="stations">
          {list.map((st) => (
            <StationRow
              key={st.id}
              station={st}
              fresh={freshId === st.id}
              onToggle={() => toggleArrived(st)}
              onRename={(name) => void updateNode(st.id, { name })}
              onDate={(v) => void updateNode(st.id, { expected_on: v })}
              onRemove={() => remove(st)}
            />
          ))}
        </ul>
      )}
      <input
        type="text"
        aria-label="新增車站"
        placeholder="新增車站，Enter 建立"
        value={draft}
        disabled={busy}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter") {
            e.preventDefault();
            void add();
          } else if (e.key === "Escape" && draft) {
            e.preventDefault();
            e.stopPropagation();
            setDraft("");
          }
        }}
      />
    </section>
  );
}

interface StationRowProps {
  station: NodeRow;
  fresh: boolean;
  onToggle: () => void;
  onRename: (name: string) => void;
  onDate: (v: string | null) => void;
  onRemove: () => void;
}

function StationRow({ station, fresh, onToggle, onRename, onDate, onRemove }: StationRowProps) {
  const arrived = Boolean(station.arrived_on);
  return (
    <li className={`st ${arrived ? "arrived" : ""} ${fresh ? "fresh" : ""}`}>
      {/* 第一列：名稱（原型 .title）＋到站章＋刪除叉；第二列：.meta 預定日・着 日期 */}
      <CommitInput value={station.name} onCommit={onRename} required ariaLabel="車站名稱" className="title" />
      {/* 到站章：到站＝朱色「着」（.late-seal 形制）；未到站＝不可見，hover 列才現身成虛線空章 */}
      <button
        type="button"
        aria-label={arrived ? "取消到站" : "標記到站"}
        aria-pressed={arrived}
        title={arrived ? "取消到站" : "標記到站（今天）"}
        onClick={onToggle}
        className="arr-seal"
      >
        着
      </button>
      <button type="button" aria-label="刪除車站" title="刪除車站" onClick={onRemove} className="x">
        <XIcon />
      </button>
      <div className="meta">
        <span>預定</span>
        <DateField value={station.expected_on} onCommit={onDate} ariaLabel="預定到站日" />
        {station.arrived_on && (
          <>
            <span className="sep">・</span>
            <span className="arr-note">着 {fmtDateKey(station.arrived_on)}</span>
          </>
        )}
      </div>
    </li>
  );
}
