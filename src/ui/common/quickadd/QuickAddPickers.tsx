/**
 * 建票列的挑選器（桌機；回饋甲 契約 §一 A「chips 點了開挑選器，全用既有元件」）：
 *   掛到＝AttachPicker（階層：路線／支線／列車／車廂；「清除」＝無路線）
 *   乘車日＝DatePicker 快選 今天／明天／後天／下週一（「清除」＝無日期，進收件匣）
 *   幾點＝ClockInput＋長度分段鈕 15／30／60／90／120＋自訂
 *   締切＝DatePicker 往後快選（含「＝同乘車日」）
 *   優先＝PopMenu 高／中／低
 *   荷札＝EntityTagField 受控模式（建好之後一起掛）
 * 全部掛到 body、貼著 chip 開（列在清單中間時也不會被下面的票蓋住）；根節點帶 `.ns-qa-pop`——
 * 建票列的失焦判斷認這個 class（焦點進了挑選器不算離開）。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { applyDurationMin, applyEndClock, applyStartClock, deriveClockSpan } from "../../../domain/clockSpan";
import { AttachPicker } from "../AttachPicker";
import { ClockInput } from "../ClockInput";
import { DatePicker } from "../DatePicker";
import { dateQuickSet } from "../DateChip";
import { DurationPicker } from "../DurationPicker";
import { EntityTagField } from "../EntityTagField";
import { PopMenu } from "../PopMenu";
import { Segmented } from "../Segmented";
import { clockBounds, clockSeed, clockToMs, msToClock } from "../../panel/clockValue";
import type { QuickAddApi } from "./useQuickAdd";
import { NO_DEST, PRIORITY_TEXT, type QuickChipKey } from "./quickAddModel";
import "../../notes/notes.css";

export interface QuickPickersProps {
  api: QuickAddApi;
  open: QuickChipKey | null;
  anchor: HTMLElement | null;
  onClose(): void;
  /** 沒挑直接收起（Esc 或點外面）時由父層判斷是否拉回焦點或觸發失焦收起 */
  onDismiss?(): void;
  /** 收起後焦點還給誰（建票列的輸入框） */
  refocus(): void;
}

export function QuickPickers({ api, open, anchor, onClose, onDismiss, refocus }: QuickPickersProps) {
  if (!open || !anchor) return null;
  /** 挑好了：收起、焦點回輸入框（接著打字） */
  const done = () => {
    onClose();
    window.setTimeout(refocus, 0);
  };
  /** 沒挑就收（Esc、點外面）：交給父層分辨「Esc／點卡內 → 回輸入框」與「點整個建票列外 → 讓建票列失焦收起」 */
  const dismiss = () => {
    if (onDismiss) {
      onDismiss();
      return;
    }
    onClose();
    window.setTimeout(() => {
      const a = document.activeElement;
      if (!a || a === document.body) refocus();
    }, 0);
  };
  const v = api.values;
  switch (open) {
    case "dest":
      return (
        <AnchoredLayer anchor={anchor} onClose={dismiss} selfDismiss>
          <AttachPicker
            depth="node"
            float
            label="掛到"
            value={{ routeId: v.dest.routeId, nodeId: v.dest.nodeId, nodeKind: v.dest.nodeKind === "ticket" ? "car" : v.dest.nodeKind }}
            onPick={(t) => {
              api.setDest(t);
              done();
            }}
            onClear={() => {
              api.setDest(NO_DEST);
              done();
            }}
            clearLabel="無路線（臨時車票）"
            onClose={dismiss}
          />
        </AnchoredLayer>
      );
    case "station":
      return (
        <PopMenu
          anchor={anchor}
          overline={{ zh: "車站", latin: "Station" }}
          label="指派車站"
          returnFocus={() => null}
          items={[
            ...api.stations.map((s) => ({
              key: s.id,
              label: s.name,
              caps: v.stationId === s.id ? "✓" : undefined,
              onSelect: () => {
                api.setStation(s.id);
                done();
              },
            })),
            {
              key: "none",
              label: "還沒排站",
              cut: api.stations.length > 0,
              caps: !v.stationId ? "✓" : undefined,
              onSelect: () => {
                api.setStation(null);
                done();
              },
            },
          ]}
          onClose={dismiss}
        />
      );
    case "date":
      return (
        <DatePicker
          anchor={anchor}
          className="ns-qa-pop"
          label="乘車日"
          value={v.scheduledOn}
          endValue={v.scheduledEnd}
          allowRange
          markValue
          min={api.today}
          today={api.today}
          quick={dateQuickSet("forward", api.today)}
          onPick={(d) => {
            api.setDate(d);
            done();
          }}
          onPickRange={(s, e) => {
            api.setDateRange(s, e);
            done();
          }}
          onClear={() => {
            api.setDateRange(null, null);
            done();
          }}
          clearLabel="無日期"
          onClose={dismiss}
        />
      );
    case "due": {
      const dueQuick = [
        ...(v.scheduledOn ? [{ label: "＝同乘車日", day: v.scheduledOn }] : []),
        ...dateQuickSet("forward", api.today),
      ];
      return (
        <DatePicker
          anchor={anchor}
          className="ns-qa-pop"
          label="締切日"
          value={v.dueOn}
          markValue
          today={api.today}
          quick={dueQuick}
          onPick={(d) => {
            if (v.scheduledOn && d === v.scheduledOn) api.setSyncDueWithScheduled(true);
            else api.setDue(d);
            done();
          }}
          onClear={
            v.dueOn || api.syncDueWithScheduled
              ? () => {
                  api.setDue(null);
                  done();
                }
              : undefined
          }
          onClose={dismiss}
        />
      );
    }
    case "priority":
      // PopMenu 自己 portal（.ns-popmenu）；建票列的失焦判斷也認它
      return (
        <PopMenu
          anchor={anchor}
          overline={{ zh: "優先順序", latin: "Priority" }}
          label="優先順序"
          returnFocus={() => null}
          items={[
            ...(["high", "mid", "low"] as const).map((p) => ({
              key: p,
              label: `${PRIORITY_TEXT[p]}${v.priority === p ? "（目前）" : ""}`,
              onSelect: () => {
                api.setPriority(p);
                done();
              },
            })),
            {
              key: "none",
              label: "不設",
              cut: true,
              disabled: !v.priority,
              onSelect: () => {
                api.setPriority(null);
                done();
              },
            },
          ]}
          onClose={dismiss}
        />
      );
    case "time":
      return (
        <AnchoredLayer anchor={anchor} onClose={dismiss}>
          <TimeCard api={api} onDone={done} />
        </AnchoredLayer>
      );
    case "tags":
      return (
        <AnchoredLayer anchor={anchor} onClose={dismiss}>
          <TagCard api={api} />
        </AnchoredLayer>
      );
  }
}

/* ───────── 幾點（開始 ⇄ 結束）＋ 持續時長 ───────── */

const DIAL_EDGE_OPTS = [
  { value: "start" as const, label: "撥開始" },
  { value: "end" as const, label: "撥結束" },
];

function TimeCard({ api, onDone }: { api: QuickAddApi; onDone(): void }) {
  const v = api.values;
  const refDay = v.scheduledOn ?? api.today;
  const { lo, hi } = useMemo(() => clockBounds(refDay, api.dayStartHour), [refDay, api.dayStartHour]);
  const [seed] = useState(() => clockSeed(refDay, api.today, api.dayStartHour));
  const [activeDial, setActiveDial] = useState<"start" | "end">("start");
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const span = useMemo(() => deriveClockSpan(v.scheduledTime, v.estimateMin), [v.scheduledTime, v.estimateMin]);
  const startShownMs = (span.startHm ? clockToMs(span.startHm, refDay) : null) ?? seed;
  const effectiveStartHm = span.startHm ?? msToClock(startShownMs, refDay) ?? "09:00";
  const startMsForEnd = clockToMs(effectiveStartHm, refDay) ?? lo;
  const endCurrentMs = span.endHm ? clockToMs(span.endHm, refDay) : null;
  const endLo = startMsForEnd + 60_000;
  const endHi = Math.max(hi, startMsForEnd + 12 * 3_600_000, endCurrentMs ?? 0);
  const endShownMs = endCurrentMs ?? Math.min(startMsForEnd + (span.durationMin ?? 60) * 60_000, endHi);

  const touchedStart = useRef(false);
  const touchedDur = useRef(false);

  const setStart = (ms: number) => {
    const t = msToClock(ms, refDay);
    if (!t) return;
    const res = applyStartClock({ startHm: span.startHm, durationMin: span.durationMin }, t, api.dayStartHour);
    if (!res.ok) {
      setErrMsg(res.error ?? null);
      return;
    }
    touchedStart.current = true;
    setErrMsg(null);
    api.setTime(res.startHm, res.durationMin);
  };

  const setEnd = (ms: number) => {
    const t = msToClock(ms, refDay);
    if (!t) return;
    const res = applyEndClock({ startHm: effectiveStartHm, durationMin: span.durationMin }, t, api.dayStartHour);
    if (!res.ok) {
      setErrMsg(res.error ?? null);
      return;
    }
    touchedStart.current = true;
    touchedDur.current = true;
    setErrMsg(null);
    api.setTime(res.startHm, res.durationMin);
  };

  const setLen = (min: number | null) => {
    const res = applyDurationMin({ startHm: span.startHm, durationMin: span.durationMin }, min);
    if (!res.ok) {
      setErrMsg(res.error ?? null);
      return;
    }
    touchedDur.current = true;
    setErrMsg(null);
    api.setTime(res.startHm, res.durationMin);
  };

  const applySeedIfUntouched = (forceStart = false) => {
    if (forceStart && !v.scheduledTime) {
      setStart(startShownMs);
      return;
    }
    if (!touchedStart.current && !touchedDur.current && !v.scheduledTime && v.estimateMin === null) {
      setStart(startShownMs);
    }
  };

  return (
    <div className="ns-qa-card is-time techo-card" role="dialog" aria-label="幾點與持續時長">
      <div className="ns-qa-timehead">
        <span className="ns-qa-cardlabel">開始與結束時刻</span>
        <Segmented<"start" | "end">
          compact
          options={DIAL_EDGE_OPTS}
          value={activeDial}
          onChange={setActiveDial}
          aria-label="站鐘錶盤對象"
        />
      </div>

      <div className="ns-qa-spanbox">
        <div className="ns-qa-spanrow" onFocusCapture={() => setActiveDial("start")}>
          <div className="ns-qa-spanlbl">
            <span>開始時刻</span>
            {span.startHm && (
              <button
                type="button"
                className="ns-qa-clearlink"
                title="只清除時刻、保留持續時長"
                onClick={() => {
                  touchedStart.current = true;
                  setErrMsg(null);
                  api.setTime(null, span.durationMin);
                }}
              >
                不排時刻
              </button>
            )}
          </div>
          <ClockInput
            variant="compact"
            picker={activeDial === "start" ? "inline" : false}
            value={startShownMs}
            lo={lo}
            hi={hi}
            refDay={refDay}
            label="開始時刻"
            dateLabel="other"
            autoFocus
            onChange={setStart}
            onEnter={() => {
              applySeedIfUntouched(true);
              onDone();
            }}
          />
        </div>

        <div className="ns-qa-spanrow" onFocusCapture={() => setActiveDial("end")}>
          <div className="ns-qa-spanlbl">
            <span>結束時刻</span>
            <span className="ns-qa-spansub">
              {span.endHm ? "改結束自動反推時長" : "點選或輸入即反推時長"}
            </span>
          </div>
          <ClockInput
            variant="compact"
            picker={activeDial === "end" ? "inline" : false}
            value={endShownMs}
            lo={endLo}
            hi={endHi}
            refDay={refDay}
            label="結束時刻"
            dateLabel="other"
            onChange={setEnd}
            onEnter={() => {
              if (span.durationMin === null) setEnd(endShownMs);
              onDone();
            }}
          />
        </div>
      </div>

      {errMsg && (
        <p className="ns-qa-timeerr" role="status">
          {errMsg}
        </p>
      )}

      <div className="ns-qa-cardlabel">持續時長</div>
      <DurationPicker
        compact
        liveCommit
        value={span.durationMin}
        onChange={setLen}
        onEnter={() => {
          onDone();
        }}
        ariaLabel="持續時長"
      />
      <div className="ns-qa-cardfoot">
        <button
          type="button"
          className="ns-btn ns-btn--sm btn-text"
          disabled={!v.scheduledTime && v.estimateMin === null}
          onClick={() => {
            api.setTime(null, null);
            onDone();
          }}
        >
          清除
        </button>
        <button
          type="button"
          className="ns-btn ns-btn--sm btn-ghost"
          onClick={() => {
            applySeedIfUntouched(false);
            onDone();
          }}
        >
          好
        </button>
      </div>
    </div>
  );
}

/* ───────── 荷札 ───────── */

function TagCard({ api }: { api: QuickAddApi }) {
  const ref = useRef<HTMLDivElement>(null);
  // 一打開就是輸入態（EntityTagField 平常先畫「＋ 掛荷札」鈕）
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>(".ns-notes-tagadd")?.click();
  }, []);
  return (
    <div ref={ref} className="ns-qa-card techo-card" role="dialog" aria-label="荷札">
      <div className="ns-qa-cardlabel">荷札（建好之後一起掛）</div>
      <EntityTagField value={api.values.tags} onChange={api.setTags} suggestInline />
    </div>
  );
}

/* ───────── 貼著 chip 的浮層殼 ───────── */

/**
 * 掛到 body、`position: fixed` 貼在 anchor 下方 6px（放不下翻上去；夾進視窗，同 DatePicker 的 placeBelow）。
 * 點外面收（anchor 與 `data-pop-toggle` 的鈕除外）、Esc 收（不往外冒）。`selfDismiss`＝內容自己會收（AttachPicker），這裡只管位置。
 */
export function AnchoredLayer({
  anchor,
  onClose,
  selfDismiss = false,
  children,
}: {
  anchor: HTMLElement;
  onClose(): void;
  selfDismiss?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const live = useRef(onClose);
  live.current = onClose;

  useLayoutEffect(() => {
    const place = () => {
      const el = ref.current;
      const box = el?.firstElementChild as HTMLElement | null;
      if (!el || !box) return;
      const r = anchor.getBoundingClientRect();
      const vw = document.documentElement.clientWidth || window.innerWidth;
      const vh = document.documentElement.clientHeight || window.innerHeight;
      const M = 12;
      const w = box.offsetWidth;
      const h = box.offsetHeight;
      let top = r.bottom + 6;
      if (top + h > vh - M) top = Math.max(M, r.top - h - 6);
      setPos({ top: Math.round(top), left: Math.round(Math.max(M, Math.min(r.left, vw - w - M))) });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    // 內容會長高（掛到點進路線、荷札打字出建議）：跟著重算，不然翻上去的那張會往下長出視窗
    const box = ref.current?.firstElementChild;
    const ro = typeof ResizeObserver !== "undefined" && box ? new ResizeObserver(place) : null;
    if (ro && box) ro.observe(box);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      ro?.disconnect();
    };
  }, [anchor]);

  useEffect(() => {
    if (selfDismiss) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (ref.current?.contains(t) || anchor.contains(t)) return;
      if (t instanceof Element && t.closest("[data-pop-toggle]")) return;
      live.current();
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [anchor, selfDismiss]);

  return createPortal(
    <div
      ref={ref}
      className="ns-qa-pop ns-qa-layer"
      style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: "hidden" }}
      onKeyDown={(e) => {
        if (selfDismiss || e.key !== "Escape" || e.nativeEvent.isComposing) return;
        e.preventDefault();
        e.stopPropagation();
        live.current();
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
