/**
 * PriorityMark——票名前的優先記號（回饋甲 D-主-133；契約 §一 G）。
 * 只有「高」畫一顆赭色小點（--late）；中／低不畫（三級都標太吵）。今日列、大綱列、行程表列（DayRow）、手機票卡共用。
 * 讀屏念「優先：高」；滑過同一句。它不是控件，點到它＝點票面（照樣開詳情）。
 */
import type { Priority } from "../../domain";
import "./prioritymark.css";

export function PriorityMark({ priority }: { priority: Priority | null | undefined }) {
  if (priority !== "high") return null;
  return <span className="ns-prio" role="img" aria-label="優先：高" title="優先：高" />;
}
