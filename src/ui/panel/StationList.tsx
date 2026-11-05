/**
 * 車站清單（UI Flow 2.1 路線版 · 里程碑管理）：列出 parent_id＝路線 的車站——行內改名、預定到站日、到站紀念章切換、刪除；底部一行新增。
 * 到站＝arrived_on 寫今天（依日界線 todayKey(dayStartHour)）；再按一次取消（null）。刪除走 soft delete＋復原 toast（與大綱同語彙）。
 * 視覺＝原型語彙 1:1：每站一列＝名稱（原型 .title）＋ .meta（預定日・着 日期）＋ 到站章（原型 .late-seal 形制、seal 色、寫「着」；
 * 未到站的章不可見，列 hover 才以虛線空章現身、剛蓋的播 arrIn）；刪除叉 hover 現身；新增車站＝底線輸入、Enter 建立。
 * 已知取捨：車站不在大綱樹裡，沒有子孫數問題、刪除不二次確認。
 * 回饋乙（契約 §1「同性質一併」、§3）：同路線內拖曳排序（共用 useDragReorder 的 list 模式；名稱是輸入框、從列的其他地方按住拖）
 *   → moveToAnchor 一筆寫入、toast 附「復原」；可點的替代＝每站 ⋯ 的「上移／下移」（拖曳是加速）。不跨路線（維持現況）。
 * UI 丙-3 C4（規範 §3.1-1／-6：「新增 X」在 X 旁邊、車站 × 常駐淡態）：
 *   - 新增列＝底線輸入＋「＋ 新增」次鈕，兩條路同一支 add()（不用知道要按 Enter）；輸入空著按鈕＝把焦點交給輸入框。
 *   - 沒有車站＝`EmptyState inline`（區段級一行；不另給鈕——新增列就在下面，同一動作同一處一個入口）。
 *   - × 常駐淡態（--dim），列 hover／聚焦轉實（panel.css `.panel .x`）。
 *   - 預定日換共用 `DateChip`（allowPast：預定日本來就能挑過去，舊 DateField 也沒有 min）。
 * 手機殼班第四輪（D-主-84）：新增、到站章、刪除＋復原的寫入搬到 ./routeFlows（手機路線詳情頁的車站段同一支）；改名、預定日照舊直接 updateNode。
 * 方針擴充（辛 §3 #7）：站名旁「方針 N」（沒寫＝淡淡的「方針」）開車站小卡；蓋章時那站有方針 ⇒ 提示附「回顧」（D-主-374）。
 */
import { useCallback, useMemo, useRef, useState } from "react";
import type { NodeRow } from "../../domain";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { moveWithUndo } from "../../store/batchActions";
import { useDragReorder } from "../common/dragReorder";
import { IconDots } from "../common/icons";
import { PopMenu, type PopMenuItem } from "../common/PopMenu";
import { DateChip } from "../common/DateChip";
import { EmptyState } from "../common/EmptyState";
import { IconPlus } from "../common/icons";
import { CommitInput, SectionRule, XIcon } from "./fields";
import { fmtDateKey } from "./format";
import { addStation, removeStation, toggleStationArrived } from "./routeFlows";
import { StationAimButton, useStationAimLists, useStationCard } from "../weekAims/StationCard";

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

  const card = useStationCard();
  const aimsOf = useStationAimLists(list.map((s) => s.id));

  const toggleArrived = (st: NodeRow, seal: HTMLElement) => {
    const next = toggleStationArrived(st, { onReview: () => card.openReview(st.id, seal) });
    setFreshId(next ? st.id : null);
  };

  const remove = (st: NodeRow) => void removeStation(st);

  // 回饋乙：同路線內拖曳排序
  const [listEl, setListEl] = useState<HTMLUListElement | null>(null);
  const order = list.map((s) => s.id);
  useDragReorder({
    root: listEl,
    items: order.map((id) => ({ id })),
    onDrop: (ids, place) => {
      if (place.kind !== "slot") return;
      void moveWithUndo(ids, routeId, { after: place.after, before: place.before }, "已移動");
    },
  });
  /** ⋯ 的上移／下移：放到鄰居的另一邊（一筆寫入） */
  const shift = (id: string, delta: -1 | 1) => {
    const i = order.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= order.length) return;
    const anchor = delta < 0 ? { after: order[j - 1] ?? null, before: order[j] } : { after: order[j], before: order[j + 1] ?? null };
    void useNodeStore
      .getState()
      .moveToAnchor([id], routeId, anchor)
      .then((r) => {
        if (!r.ok) useUiStore.getState().showToast({ message: r.reason ?? "沒有搬成功——請再試一次" }, 3600);
      });
  };
  const menuOf = (id: string): PopMenuItem[] => {
    const i = order.indexOf(id);
    return [
      { key: "up", label: "上移", disabled: i <= 0, why: "已經在最上面", onSelect: () => shift(id, -1) },
      { key: "down", label: "下移", disabled: i >= order.length - 1, why: "已經在最下面", onSelect: () => shift(id, 1) },
    ];
  };

  return (
    <section>
      <SectionRule title="車站" aside={list.length ? `${arrivedCount}/${list.length} 到站` : undefined} />
      {list.length === 0 ? (
        <EmptyState inline tone="first" title="還沒有車站。" desc="加幾個階段目標，會顯示在路線底下。" className="st-empty" />
      ) : (
        <ul ref={setListEl} className="stations">
          {list.map((st) => (
            <StationRow
              key={st.id}
              station={st}
              fresh={freshId === st.id}
              onToggle={(seal) => toggleArrived(st, seal)}
              aimCount={aimsOf(st.id).length}
              onAims={(anchor) => card.open(st.id, anchor)}
              onRename={(name) => void updateNode(st.id, { name })}
              onDate={(v) => void updateNode(st.id, { expected_on: v })}
              onRemove={() => remove(st)}
              menu={() => menuOf(st.id)}
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
      {card.node}
    </section>
  );
}

interface StationRowProps {
  station: NodeRow;
  fresh: boolean;
  onToggle: (seal: HTMLElement) => void;
  /** 這站方針幾句（0＝淡淡的「方針」） */
  aimCount: number;
  onAims: (anchor: HTMLElement) => void;
  onRename: (name: string) => void;
  onDate: (v: string | null) => void;
  onRemove: () => void;
  /** ⋯ 的項目（上移／下移；回饋乙） */
  menu: () => PopMenuItem[];
}

/** 每站常駐淡態的 ⋯（規範法則 05）：上移／下移＝拖曳排序的可點入口 */
function StationMore({ name, menu }: { name: string; menu: () => PopMenuItem[] }) {
  const btn = useRef<HTMLButtonElement>(null);
  const [items, setItems] = useState<PopMenuItem[] | null>(null);
  const close = useCallback(() => setItems(null), []);
  return (
    <>
      <button
        ref={btn}
        type="button"
        className="st-more"
        aria-haspopup="menu"
        aria-expanded={items !== null}
        aria-label={`車站「${name}」的更多動作`}
        title="更多動作"
        onClick={() => setItems((cur) => (cur ? null : menu()))}
      >
        <IconDots size={14} />
      </button>
      {items && <PopMenu anchor={btn.current} overline={{ zh: "這一站", latin: "Station" }} label={`車站「${name}」的更多動作`} items={items} onClose={close} />}
    </>
  );
}

function StationRow({ station, fresh, onToggle, aimCount, onAims, onRename, onDate, onRemove, menu }: StationRowProps) {
  const arrived = Boolean(station.arrived_on);
  return (
    <li className={`st ${arrived ? "arrived" : ""} ${fresh ? "fresh" : ""}`} data-drag-id={station.id}>
      {/* 第一列：名稱（原型 .title）＋到站章＋刪除叉；第二列：.meta 預定日・着 日期 */}
      <CommitInput value={station.name} onCommit={onRename} required ariaLabel="車站名稱" className="title" />
      <StationAimButton station={station} count={aimCount} onOpen={onAims} />
      {/* 到站章：到站＝朱色「着」（.late-seal 形制）；未到站＝不可見，hover 列才現身成虛線空章 */}
      <button
        type="button"
        aria-label={arrived ? "取消到站" : "標記到站"}
        aria-pressed={arrived}
        title={arrived ? "取消到站" : "標記到站（今天）"}
        onClick={(e) => onToggle(e.currentTarget)}
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
        <StationMore name={station.name} menu={menu} />
      </div>
    </li>
  );
}
