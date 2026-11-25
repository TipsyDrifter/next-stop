/**
 * LegacySplitModal——舊帳隨筆分流小幫手（v1.38 · 3A；雙端共用本體）。
 * 桌機由 DesktopDialogHost（DialogShell）包裹，手機由 MobileSheetHost（MSheet）包裹；
 * 底部操作列透過 <DialogFoot> 自動在桌機黏底、手機置底。
 */
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { useTicketStore } from "../../../store/ticketStore";
import { useUiStore } from "../../../store/uiStore";
import type { LegacySplitCandidate } from "../../../domain/ticketSplit";
import { DialogFoot } from "./DialogFoot";
import "../ticket-v138.css";

interface EditableRow {
  candidate: LegacySplitCandidate;
  selected: boolean;
  item: string;
  note: string;
}

export function LegacySplitBody({ onClose }: { onClose: () => void }): JSX.Element {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<EditableRow[]>([]);
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);
  const reqGenRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(() => {
    const gen = ++reqGenRef.current;
    setLoading(true);
    setError(null);
    useTicketStore
      .getState()
      .findLegacySplits()
      .then((list) => {
        if (!mountedRef.current || gen !== reqGenRef.current) return;
        setRows(
          list.map((c) => ({
            candidate: c,
            selected: true,
            item: c.suggestedItem,
            note: c.suggestedNote,
          })),
        );
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!mountedRef.current || gen !== reqGenRef.current) return;
        setError(err instanceof Error ? err.message : "掃描舊帳失敗，請稍後再試");
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const totalCount = rows.length;
  const selectedCount = rows.reduce((n, r) => n + (r.selected ? 1 : 0), 0);
  const allSelected = totalCount > 0 && selectedCount === totalCount;
  const someSelected = selectedCount > 0 && selectedCount < totalCount;

  const toggleAll = () => {
    const next = !allSelected;
    setRows((prev) => prev.map((r) => ({ ...r, selected: next })));
  };

  const toggleOne = (entryId: string) => {
    setRows((prev) => prev.map((r) => (r.candidate.entryId === entryId ? { ...r, selected: !r.selected } : r)));
  };

  const patchRow = (entryId: string, patch: { item?: string; note?: string }) => {
    setRows((prev) => prev.map((r) => (r.candidate.entryId === entryId ? { ...r, ...patch } : r)));
  };

  const apply = async () => {
    if (busy || selectedCount === 0) return;
    const picked = rows.filter((r) => r.selected);
    const updates = picked
      .map((r) => ({
        id: r.candidate.entryId,
        item: r.item.trim(),
        note: r.note.trim(),
        origItem: r.candidate.originalItem,
        origNote: r.candidate.originalNote,
      }))
      .filter((u) => u.item !== u.origItem || u.note !== u.origNote)
      .map(({ id, item, note }) => ({ id, item, note }));

    if (updates.length === 0) {
      useUiStore.getState().showToast({ message: "所選帳目內容沒有變動" });
      onClose();
      return;
    }

    setBusy(true);
    try {
      const applied = await useTicketStore.getState().applyLegacySplits(updates);
      if (applied > 0) onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ns-tk-dialog tk-v38-split">
      <p className="tk-v38-split-lead">
        已將升級前的舊帳無損移入「品項／來源」。以下篩出含分隔符或長句的舊帳，勾選並微調後可一鍵切分為品項與隨筆，讓歷史補完更乾淨。
      </p>

      {loading ? (
        <div className="tk-v38-split-state" role="status" aria-live="polite">
          <span>正在掃描舊帳紀錄…</span>
        </div>
      ) : error ? (
        <div className="tk-v38-split-state is-err" role="alert">
          <span>{error}</span>
          <button type="button" className="ns-btn ns-btn--sm btn-ghost" onClick={() => void load()}>
            重新掃描
          </button>
        </div>
      ) : totalCount === 0 ? (
        <div className="tk-v38-split-state">
          <strong>一切整潔</strong>
          <span>所有舊帳都很乾淨，沒有需要分流的長句紀錄</span>
        </div>
      ) : (
        <>
          <div className="tk-v38-split-bar">
            <button
              type="button"
              className="tk-v38-split-all"
              role="checkbox"
              aria-checked={allSelected ? true : someSelected ? "mixed" : false}
              onClick={toggleAll}
            >
              <span
                className={"tk-v38-ck" + (allSelected ? " is-on" : someSelected ? " is-partial" : "")}
                aria-hidden="true"
              />
              <span>{allSelected ? "全不選" : "全選"}</span>
            </button>
            <span className="tk-v38-split-cnt">
              已選 <b>{selectedCount}</b> / {totalCount} 筆
            </span>
          </div>

          <ul className="tk-v38-split-list" aria-label="可分流的舊帳清單">
            {rows.map((r) => {
              const c = r.candidate;
              const isWarn = c.reason === "duplicate";
              return (
                <li key={c.entryId} className={"tk-v38-split-row" + (r.selected ? " is-on" : " is-off")}>
                  <div className="tk-v38-split-head">
                    <button
                      type="button"
                      className="tk-v38-split-tog"
                      role="checkbox"
                      aria-checked={r.selected}
                      aria-label={`${r.selected ? "取消選取" : "選取"} ${c.occurredOn} ${c.originalItem}`}
                      onClick={() => toggleOne(c.entryId)}
                    >
                      <span className={"tk-v38-ck" + (r.selected ? " is-on" : "")} aria-hidden="true" />
                      <span className="tk-v38-split-day">{c.occurredOn}</span>
                      <span className="tk-v38-split-orig" title={c.originalItem}>
                        {c.originalItem}
                      </span>
                    </button>
                    <span className={"tk-v38-badge" + (isWarn ? " is-warn" : " is-accent")}>{c.reasonLabel}</span>
                  </div>

                  <div className="tk-v38-split-inputs">
                    <label className="tk-v38-split-field">
                      <span>品項／來源</span>
                      <input
                        className="techo-input tk-v38-split-in"
                        value={r.item}
                        autoComplete="off"
                        placeholder="留空則只留隨筆"
                        aria-label={`${c.occurredOn} 品項／來源`}
                        onChange={(e) => patchRow(c.entryId, { item: e.target.value })}
                      />
                    </label>
                    <label className="tk-v38-split-field">
                      <span>隨筆備註</span>
                      <input
                        className="techo-input tk-v38-split-in"
                        value={r.note}
                        autoComplete="off"
                        placeholder="可空"
                        aria-label={`${c.occurredOn} 隨筆備註`}
                        onChange={(e) => patchRow(c.entryId, { note: e.target.value })}
                      />
                    </label>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <DialogFoot>
        <button type="button" className="ns-btn btn-ghost ns-tk-dbtn" disabled={busy} onClick={onClose}>
          {totalCount === 0 && !loading ? "關閉" : "略過關閉"}
        </button>
        {totalCount > 0 && (
          <button
            type="button"
            className="ns-btn btn-seal ns-tk-dbtn"
            disabled={busy || selectedCount === 0}
            onClick={() => void apply()}
          >
            {busy ? "分流中…" : `套用所選分流（${selectedCount} 筆）`}
          </button>
        )}
      </DialogFoot>
    </div>
  );
}
