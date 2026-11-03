/**
 * ProgressRing——有子項的列車／車廂，検印欄位置的進度圈（丁 D-主-248；視覺真相＝prototypes/design-structure-節點種類.html 方案 A ②）。
 * 軌＝虛線圈（同空検印欄）、弧＝`--arc`（同紀念章進度弧）、中間「d/t」。**不自動完成**：子項全済時圈畫滿，
 * 呼叫端在旁邊放淡字「可以蓋済」；列車本身照舊手動蓋（蓋了才跳完成卡、圈換成済章）。
 * 桌機 54（同検印圈）、手機 30（同手機検印鈕裡的圈）。純顯示、不收事件。
 */
export function ProgressRing({ done, total, size = 54, className = "ns-ring" }: { done: number; total: number; size?: number; className?: string }) {
  const r = size === 54 ? 25 : Math.round(size / 2 - 2);
  const c = 2 * Math.PI * r;
  const v = total > 0 ? (c * Math.min(done, total)) / total : 0;
  return (
    <span className={className} role="img" aria-label={`子項 ${done}／${total} 済`} title={`子項 ${done}/${total} 済`} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle className="trk" cx={size / 2} cy={size / 2} r={r} />
        <circle className="val" cx={size / 2} cy={size / 2} r={r} strokeDasharray={`${v.toFixed(1)} ${(c - v).toFixed(1)}`} />
      </svg>
      <span className="rt">
        <b>{done}</b>/{total}
      </span>
    </span>
  );
}
