/**
 * AimsRibbon——方案一那一行（方針擴充 辛 ☎1、§7）：今日告示最下面露出另外兩層。
 * 段落＝本週／本月／今年扣掉正在看的那一期。有句子＝「本月 句・句・句」（單行省略），點了切過去；沒句子＝「＋ 寫本月方針」開寫方針框。
 * 告示收合而且兩段都沒句子就不畫（不佔版面）。不放數字（D-主-376）。
 */
import { useEffect } from "react";
import { aimsBrief, periodOfKey, ribbonSegments, type ReviewPeriod, type WeekAimRow } from "../../domain/weekAims";
import { useUiStore } from "../../store/uiStore";
import { useWeekAimStore } from "../../store/weekAimStore";
import { IconPlus } from "../common/icons";

const EMPTY: WeekAimRow[] = [];

export function AimsRibbon({
  current,
  today,
  folded,
  onPick,
}: {
  /** 告示正在看的那一期（期間鍵） */
  current: string;
  today: string;
  folded: boolean;
  onPick(period: ReviewPeriod): void;
}) {
  const weekStart = useUiStore((s) => s.weekStart);
  const segments = ribbonSegments(current, today, weekStart);
  const lists = useWeekAimStore((s) => s.weeks);

  useEffect(() => {
    const st = useWeekAimStore.getState();
    for (const { key } of segments) if (st.weeks[key] === undefined) void st.loadWeek(key);
    // 段落的鍵只跟 current、today、weekStart 有關
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, today, weekStart]);

  const briefs = segments.map(({ key, label }) => ({ key, label, brief: aimsBrief(lists[key] ?? EMPTY) }));
  if (folded && briefs.every((b) => !b.brief)) return null;

  return (
    <div className="wa-ribbon">
      {briefs.map(({ key, label, brief }) =>
        brief ? (
          <button
            key={key}
            type="button"
            className="wa-rib"
            title={`看${label}方針`}
            onClick={() => onPick(periodOfKey(key) as ReviewPeriod)}
          >
            <span className="k">{label}</span>
            <span className="v">{brief}</span>
          </button>
        ) : (
          <button
            key={key}
            type="button"
            className="wa-rib is-add"
            aria-haspopup="dialog"
            onClick={() => useWeekAimStore.getState().openEditor(key)}
          >
            <span className="v">
              <IconPlus size={12} />
              寫{label}方針
            </span>
          </button>
        ),
      )}
    </div>
  );
}
