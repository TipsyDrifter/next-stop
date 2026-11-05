/**
 * DataExportBlock——資料匯出（失物招領 §4；D-主-322、323）。桌機〈備份與還原〉籤一段、手機備份與還原子頁一塊。
 * 範圍分段鈕＋格式分段鈕＋一顆「匯出…」。流程：問存到哪（取消不出聲）→ 讀、組、寫；成功 toast、失敗行內報錯。
 * 組資料與寫檔都在 `data/dataExport.ts`；`useDataExport` 也給手機同步頁未加入那段的「匯出到手機」（整份 JSON，同一個動作）。
 */
import { useCallback, useState } from "react";
import { exportData, pickExportTarget } from "../../data/dataExport";
import { EXPORT_SCOPES, type ExportFormat, type ExportScope } from "../../domain/dataExport";
import { useUiStore } from "../../store/uiStore";
import { Segmented, type SegmentedOption } from "../common/Segmented";
import "./lostFound.css";

const SCOPE_OPTIONS: SegmentedOption<ExportScope>[] = EXPORT_SCOPES.map((s) => ({ value: s.id, label: s.label }));
const FORMAT_OPTIONS: SegmentedOption<ExportFormat>[] = [
  { value: "json", label: "JSON" },
  { value: "csv", label: "CSV" },
];

export const EXPORT_NOTE = "只含現在還在的資料，不能匯回 App；要完整存底請用備份。";

export function useDataExport() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (scope: ExportScope, format: ExportFormat) => {
    setError(null);
    setBusy(true);
    try {
      const target = await pickExportTarget(scope, format);
      if (!target) return; // 取消＝零動作、不吵
      const res = await exportData(scope, format, target);
      // 「筆」算東西本身：掛荷札那張表是關聯，不是一筆資料
      const n = Object.entries(res.counts).reduce((sum, [t, c]) => (t === "taggings" ? sum : sum + c), 0);
      useUiStore.getState().showToast({ message: `已匯出 ${n.toLocaleString("en-US")} 筆` });
    } catch (e) {
      setError(`匯出失敗：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run };
}

export function DataExportBlock({ mobile = false }: { mobile?: boolean }) {
  const [scope, setScope] = useState<ExportScope>("all");
  const [format, setFormat] = useState<ExportFormat>("json");
  const { busy, error, run } = useDataExport();

  const scopeSeg = <Segmented options={SCOPE_OPTIONS} value={scope} onChange={setScope} aria-label="匯出範圍" />;
  const formatSeg = <Segmented options={FORMAT_OPTIONS} value={format} onChange={setFormat} aria-label="匯出格式" />;

  if (mobile) {
    return (
      <div className="m2-block m2-export">
        <span className="m2-block-label">匯出資料</span>
        <div className="m2-export-rows">
          {scopeSeg}
          {formatSeg}
          <div className="m2-sy-actions">
            <button type="button" className="ns-btn btn-ghost m2-sy-go" disabled={busy} onClick={() => void run(scope, format)}>
              {busy ? "匯出中…" : "匯出…"}
            </button>
          </div>
        </div>
        {error && (
          <p className="m2-note is-fail" role="alert">
            {error}
          </p>
        )}
        <p className="m2-note">{EXPORT_NOTE}</p>
      </div>
    );
  }
  return (
    <section className="ns-bk-cloud ns-bk-export" aria-label="匯出資料">
      <span className="techo-label block mb-1">匯出資料</span>
      <div className="lf-export-row">
        {scopeSeg}
        {formatSeg}
        <button type="button" className="btn-ghost ns-btn" disabled={busy} onClick={() => void run(scope, format)}>
          {busy ? "匯出中…" : "匯出…"}
        </button>
      </div>
      {error && (
        <p className="ns-note is-fail mt-2" role="alert">
          {error}
        </p>
      )}
      <p className="ns-note mt-2">{EXPORT_NOTE}</p>
    </section>
  );
}
