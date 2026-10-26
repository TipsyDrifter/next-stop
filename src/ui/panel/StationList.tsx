/**
 * 車站清單（UI Flow 2.1 路線版 · 里程碑管理）：列出 parent_id＝路線 的車站——行內改名、預定到站日、到站紀念章切換、刪除；底部一行新增。
 * 到站＝arrived_on 寫今天（依日界線 todayKey(dayStartHour)）；再按一次取消（null）。刪除走 soft delete＋復原 toast（與大綱同語彙）。
 * 視覺＝原型語彙 1:1：每站一列＝名稱（原型 .title）＋ .meta（預定日・着 日期）＋ 到站章（原型 .late-seal 形制、seal 色、寫「着」；
 * 未到站的章不可見，列 hover 才以虛線空章現身、剛蓋的播 arrIn）；刪除叉 hover 現身；新增車站＝底線輸入、Enter 建立。
 * 已知取捨：車站排序沿 position，不提供拖曳（v0.2 不做）；車站不在大綱樹裡，沒有子孫數問題、刪除不二次確認。
 * UI 丙-3 C4（規範 §3.1-1／-6：「新增 X」在 X 旁邊、車站 × 常駐淡態）：
 *   - 新增列＝底線輸入＋「＋ 新增」次鈕，兩條路同一支 add()（不用知道要按 Enter）；輸入空著按鈕＝把焦點交給輸入框。
 *   - 沒有車站＝`EmptyState inline`（區段級一行；不另給鈕——新增列就在下面，同一動作同一處一個入口）。
 *   - × 常駐淡態（--dim），列 hover／聚焦轉實（panel.css `.panel .x`）。
 *   - 預定日換共用 `DateChip`（allowPast：預定日本來就能挑過去，舊 DateField 也沒有 min）。
 * 手機殼班第四輪（D-主-84）：新增、到站章、刪除＋復原的寫入搬到 ./routeFlows（手機路線詳情頁的車站段同一支）；改名、預定日照舊直接 updateNode。
 */
import { useMemo, useRef, useState } from "react";
import type { NodeRow } from "../../domain";
import { useNodeStore } from "../../store/nodeStore";
import { DateChip } from "../common/DateChip";
import { EmptyState } from "../common/EmptyState";
import { IconPlus } from "../common/icons";
import { CommitInput, SectionRule, XIcon } from "./fields";
import { fmtDateKey } from "./format";
import { addStation, removeStation, toggleStationArrived } from "./routeFlows";

export function StationList({ routeId }: { routeId: string }) {
  const stations = useNodeStore((s) => s.stations);
  const updateNode = useNodeStore((s) => s.updateNode);

  const list = useMemo(() => stations.filter((s) => s.parent_id === routeId), [stations, routeId]);
  const arrivedCount = list.filter((s) => s.arrived_on).length;

  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // 剛蓋章的那一站才播蓋印動畫（純視覺）
  const [freshId, setFreshId] = useState<string | null>(null);

  const add = async () => {
    const name = draft.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      const row = await addStation(routeId, name);
      if (row) setDraft("");
    } finally {
      setBusy(false);
    }
  };

  const toggleArrived = (st: NodeRow) => {
    const next = toggleStationArrived(st);
    setFreshId(next ? st.id : null);
  };

  const remove = (st: NodeRow) => void removeStation(st);

  return (
    <section>
      <SectionRule title="車站" aside={list.length ? `${arrivedCount}/${list.length} 到站` : undefined} />
      {list.length === 0 ? (
        <EmptyState inline tone="first" title="還沒有車站。" desc="加幾個階段目標，會顯示在路線底下。" className="st-empty" />
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
      <div className="st-add">
        <input
          ref={inputRef}
          type="text"
          aria-label="新增車站"
          placeholder="新增車站"
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
        <button
          type="button"
          className="ns-btn ns-btn--sm btn-ghost"
          title="新增車站（輸入框裡按 Enter 也可以）"
          disabled={busy}
          onClick={() => {
            if (draft.trim()) void add();
            else inputRef.current?.focus();
          }}
        >
          <IconPlus />
          新增
        </button>
      </div>
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
        <DateChip date={station.expected_on} onPick={onDate} allowPast clearable label="預定到站日" emptyText="未定" />
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
