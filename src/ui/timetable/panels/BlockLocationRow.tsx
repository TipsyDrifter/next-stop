/**
 * BlockLocationRow——補記／改一塊／改這一班（BlockPanel）的「地點」列（v1.39 4A）。
 *
 * - 複用 `RecallInput`（`minChars={0}`）：聚焦即列出最常去且最近使用的地點，輸入字元時即時過濾；
 *   候選在第一次聚焦時向 `timetableRepo.listBlockLocations(60)` 讀取。
 * - 受控：值與草稿由 `BlockPanel` 管（`locationDraft === null` 代表未改動，跟著遠端更新）。
 */
import { useMemo, useState, type KeyboardEvent } from "react";
import { timetableRepo } from "../../../data/timetableRepository";
import { MAX_BLOCK_LOCATION_CHARS } from "../../../domain/timetable";
import type { RecallItem } from "../../../domain/recall";
import { RecallInput } from "../../common/RecallInput";
import "../blockNote.css";

export const BLOCK_LOCATION_TEXT = {
  row: "地點",
  placeholder: "咖啡館、教室、圖書館（選填）",
};

export function BlockLocationRow({
  value,
  onChange,
  shell,
}: {
  value: string;
  onChange(next: string): void;
  shell: "desktop" | "mobile";
}) {
  const [locations, setLocations] = useState<string[] | null>(null);

  const items = useMemo<RecallItem[] | null>(() => {
    if (!locations) return null;
    // listBlockLocations 已依頻率與最近使用排序，用遞減 count 讓 rankRecall 維持該順位
    const total = locations.length;
    return locations.map((text, idx) => ({
      text,
      count: total - idx,
    }));
  }, [locations]);

  const load = (): void => {
    void timetableRepo
      .listBlockLocations(60)
      .then(setLocations)
      .catch((e: unknown) => {
        console.warn("時刻表：讀不到常用地點（候選先不出）", e);
        setLocations([]);
      });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    if (shell === "mobile") e.currentTarget.blur();
  };

  const handleChange = (next: string): void => {
    const chars = Array.from(next);
    onChange(chars.length > MAX_BLOCK_LOCATION_CHARS ? chars.slice(0, MAX_BLOCK_LOCATION_CHARS).join("") : next);
  };

  return (
    <div className="ns-tt-row is-top ns-tt-locrow">
      <span className="ns-tt-row-k">{BLOCK_LOCATION_TEXT.row}</span>
      <span className="ns-tt-row-v">
        <RecallInput
          value={value}
          onChange={handleChange}
          items={items}
          onNeedItems={load}
          ariaLabel={BLOCK_LOCATION_TEXT.row}
          placeholder={BLOCK_LOCATION_TEXT.placeholder}
          className="ns-tt-note-in"
          shell={shell}
          minChars={0}
          limit={8}
          onKeyDown={onKeyDown}
        />
      </span>
    </div>
  );
}
