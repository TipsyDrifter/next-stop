/**
 * 建票列的挑選器（桌機；回饋甲 契約 §一 A「chips 點了開挑選器，全用既有元件」）：
 *   掛到＝AttachPicker（階層：路線／支線／列車／車廂；「清除」＝無路線）
 *   執行日＝DatePicker 快選 今天／明天／後天／下週一（「清除」＝無日期，進收件匣）
 *   幾點＝ClockInput＋長度分段鈕 15／30／60／90／120＋自訂
 *   締切＝DatePicker 往後快選
 *   優先＝PopMenu 高／中／低
 *   荷札＝EntityTagField 受控模式（建好之後一起掛）
 * 全部掛到 body、貼著 chip 開（列在清單中間時也不會被下面的票蓋住）；根節點帶 `.ns-qa-pop`——
 * 建票列的失焦判斷認這個 class（焦點進了挑選器不算離開）。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AttachPicker } from "../AttachPicker";
import { ClockInput } from "../ClockInput";
import { DatePicker } from "../DatePicker";
import { dateQuickSet } from "../DateChip";
import { EntityTagField } from "../EntityTagField";
import { PopMenu } from "../PopMenu";
import { Segmented } from "../Segmented";
import { clockBounds, clockSeed, clockToMs, msToClock } from "../../panel/clockValue";
import type { QuickAddApi } from "./useQuickAdd";
import { LENGTH_PRESETS, NO_DEST, PRIORITY_TEXT, lengthText, type QuickChipKey } from "./quickAddModel";
import "../../notes/notes.css";

export interface QuickPickersProps {
  api: QuickAddApi;
  open: QuickChipKey | null;
  anchor: HTMLElement | null;
  onClose(): void;
  /** 收起後焦點還給誰（建票列的輸入框） */
  refocus(): void;
}

export function QuickPickers({ api, open, anchor, onClose, refocus }: QuickPickersProps) {
  if (!open || !anchor) return null;
  /** 挑好了：收起、焦點回輸入框（接著打字） */
  const done = () => {
    onClose();
    window.setTimeout(refocus, 0);
  };
  /** 沒挑就收（Esc、點外面）：焦點掉到 body 才拉回輸入框；點去別處的焦點留在那裡（建票列的失焦規則接手） */
  const dismiss = () => {
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
        <AnchoredLayer anchor={anchor} onClose={onClose} selfDismiss>
          <AttachPicker
            depth="node"
            float
            label="掛到"
            value={v.dest}
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
    case "date":
      return (
        <DatePicker
          anchor={anchor}
          className="ns-qa-pop"
          label="執行日"
          value={v.scheduledOn}
          markValue
          min={api.today}
          today={api.today}
          quick={dateQuickSet("forward", api.today)}
          onPick={(d) => {
            api.setDate(d);
            done();
          }}
          onClear={() => {
            api.setDate(null);
            done();
          }}
          clearLabel="無日期"
          onClose={dismiss}
        />
      );
    case "due":
      return (
        <DatePicker
          anchor={anchor}
          className="ns-qa-pop"
          label="締切日"
          value={v.dueOn}
          markValue
          today={api.today}
          quick={dateQuickSet("forward", api.today)}
          onPick={(d) => {
            api.setDue(d);
            done();
          }}
          onClear={
            v.dueOn
              ? () => {
                  api.setDue(null);
                  done();
                }
              : undefined
          }
          onClose={dismiss}
        />
      );
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

/* ───────── 幾點＋長度 ───────── */

type LenValue = `${number}` | "custom";

function TimeCard({ api, onDone }: { api: QuickAddApi; onDone(): void }) {
  const v = api.values;
  const refDay = v.scheduledOn ?? api.today;
  const { lo, hi } = useMemo(() => clockBounds(refDay, api.dayStartHour), [refDay, api.dayStartHour]);
  const [seed] = useState(() => clockSeed(refDay, api.today, api.dayStartHour));
  const shown = (v.scheduledTime ? clockToMs(v.scheduledTime, refDay) : null) ?? seed;
  const preset = v.estimateMin !== null && LENGTH_PRESETS.includes(v.estimateMin);
  const [custom, setCustom] = useState(v.estimateMin !== null && !preset);
  const lenValue: LenValue | null = custom ? "custom" : v.estimateMin !== null ? (`${v.estimateMin}` as LenValue) : null;

  /** 這張卡裡動過開始時刻沒（沒動過又按 Enter／好＝就用起點；動過就照動過的，不拿舊 closure 的值蓋回去） */
  const touched = useRef(false);
  const setStart = (ms: number) => {
    const t = msToClock(ms, refDay);
    if (!t) return;
    touched.current = true;
    api.setTime(t, v.estimateMin);
  };
  const applySeed = () => {
    if (!touched.current && !v.scheduledTime) setStart(shown);
  };
  const setLen = (min: number | null) => api.setTime(v.scheduledTime, min);

  return (
    <div className="ns-qa-card techo-card" role="dialog" aria-label="幾點">
      <div className="ns-qa-cardlabel">幾點</div>
      <ClockInput
        variant="compact"
        value={shown}
        lo={lo}
        hi={hi}
        refDay={refDay}
        label="開始時刻"
        autoFocus
        onChange={setStart}
        onEnter={() => {
          // 沒動過就按 Enter＝就用起點（同側板「幾點」）
          applySeed();
          onDone();
        }}
      />
      <div className="ns-qa-cardlabel">長度</div>
      <div className="ns-qa-len">
        <Segmented<LenValue>
          compact
          aria-label="長度"
          value={lenValue}
          options={[
            ...LENGTH_PRESETS.map((m) => ({ value: `${m}` as LenValue, label: String(m), title: lengthText(m) })),
            { value: "custom" as const, label: "自訂…" },
          ]}
          onChange={(x) => {
            if (x === "custom") {
              setCustom(true);
              return;
            }
            setCustom(false);
            setLen(Number(x));
          }}
        />
        {custom && (
          <label className="ns-qa-lencustom">
            <input
              className="techo-input"
              inputMode="numeric"
              aria-label="長度（分）"
              defaultValue={v.estimateMin ?? ""}
              autoFocus
              onChange={(e) => {
                const n = Number(e.target.value.replace(/[^\d]/g, ""));
                setLen(Number.isFinite(n) && n > 0 ? Math.min(n, 24 * 60) : null);
              }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.stopPropagation();
                  onDone();
                }
              }}
            />
            分
          </label>
        )}
      </div>
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
            applySeed();
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
