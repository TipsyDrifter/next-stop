/**
 * MobileQuickAdd——手機建票列＝底部輸入列（回饋甲 D-主-127、128；原型 q1-A mobile `.m-newticket.nsq-mnew`）。
 *
 * 長相：沿既有 `.m-newticket`（tab bar 之上那一條）：輸入框（認出的片段反白）＋「発券」；
 *   聚焦後才在輸入框上方出一排 chips（可橫捲、末段露半格）：［掛到］［乘車日］［幾點］［締切］［優先］［#荷札］。
 *   舊的「無日期」切換併進「乘車日」chip（清除＝無日期，進收件匣）。
 * 挑選器全用既有手機元件：掛到＝MobileAttachPicker、乘車日／締切＝MobileDatePicker、幾點＝MSheet＋ClockInput（mobile）＋長度分段鈕、
 *   優先＝MSheet 動作清單、荷札＝旅客筆記的荷札點選器（tagStore.openPicker 插入模式）。
 * 送出、連打、toast 規則同桌機（useQuickAdd）；IME 三重守門同 MobileNewTicket。不在失焦時送出（手機收鍵盤很常見，不是「點去別處」）。
 *
 * 接法（手機席）：今日／路線第二層／行程表把原本的 MobileNewTicket 換成
 *   <MobileQuickAdd defaults={...} here={...} routeKind? placeholder? onCreated? />
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { NodeRow, Priority } from "../../../domain";
import { applyDurationMin, applyEndClock, applyStartClock, deriveClockSpan } from "../../../domain/clockSpan";
import { useSelectionStore } from "../../../store/selectionStore";
import { useTagStore } from "../../../store/tagStore";
import { useBackLayer } from "../../mobile/backStack";
import { ClockInput } from "../ClockInput";
import { dateQuickSet } from "../DateChip";
import { DurationPicker } from "../DurationPicker";
import { MSheet, MSheetItem } from "../MSheet";
import { MobileAttachPicker } from "../MobileAttachPicker";
import { MobileDatePicker } from "../MobileDatePicker";
import { Segmented } from "../Segmented";
import { clockBounds, clockSeed, clockToMs, msToClock } from "../../panel/clockValue";
import { QuickChips, QuickField } from "./QuickAddParts";
import { NO_DEST, PRIORITY_TEXT, type QuickChipKey, type QuickDefaults, type QuickHere, type RouteKind } from "./quickAddModel";
import { useQuickAdd, type QuickAddApi } from "./useQuickAdd";
import "./quickadd.css";

export interface MobileQuickAddProps {
  defaults: QuickDefaults;
  here: QuickHere;
  /** 掛到路線時預設建成什麼（路線第二層可切「車票｜支線」） */
  routeKind?: RouteKind;
  /** 強制隱藏「車票｜支線」切換段（如看板欄內新增車票） */
  hideRouteKind?: boolean;
  placeholder?: string;
  onCreated?(row: NodeRow, stays: boolean): void;
  /** 加在根上（頁面自己的位置微調） */
  className?: string;
  /** 行內版（行程表那一天底下）：Esc 或空白 Enter＝收起（同舊草稿列）；常駐的底部列不給 */
  onClose?(): void;
}

export function MobileQuickAdd({ defaults, here, routeKind, hideRouteKind, placeholder, onCreated, className, onClose }: MobileQuickAddProps) {
  const api = useQuickAdd({ defaults, here, routeKind, hideRouteKind, onCreated });
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [active, setActive] = useState(false);
  const [open, setOpen] = useState<QuickChipKey | null>(null);
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    if (api.target.kind === "branch" && open && open !== "dest" && open !== "station") {
      setOpen(null);
    }
  }, [api.target.kind, open]);

  const refocus = useCallback(() => {
    window.setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 0);
  }, []);
  const close = useCallback(() => setOpen(null), []);
  const picked = useCallback(() => {
    setOpen(null);
    refocus();
  }, [refocus]);

  // 日期面板的返回層（MobileDatePicker 要呼叫端先登記；同 DateChip）
  const dateLayer = "common.quickadd.date." + useId();
  useBackLayer(dateLayer, open === "date" || open === "due", close, "sheet");

  const submit = async (cont = false) => {
    if (!api.canSubmit) return;
    const row = await api.submit();
    if (!row) return;
    if (!cont) {
      if (onClose) onClose();
      else inputRef.current?.blur();
    }
  };

  const apiRef = useRef(api);
  apiRef.current = api;
  /**
   * 點「発券」。組字中（Gboard 打英文，最後一個字要按空白才確定）也要一下就送：
   * 先讓輸入框失焦＝輸入法把字定下來（compositionend），下一拍拿定下來的字送出，再把焦點還回來接著打。
   */
  const tapGo = () => {
    if (!api.composing) {
      void submit();
      return;
    }
    inputRef.current?.blur();
    window.setTimeout(() => {
      // 保險：失焦了卻沒收到 compositionend
      if (apiRef.current.composing) apiRef.current.compositionProps.onCompositionEnd();
      window.setTimeout(() => {
        const a = apiRef.current;
        if (!a.canSubmit) return;
        void a.submit().then(() => inputRef.current?.focus({ preventScroll: true }));
      }, 0);
    }, 0);
  };

  const openChip = (key: QuickChipKey) => {
    if (key === "tags" && !api.values.tags.length) {
      openTagPicker(api, refocus);
      return;
    }
    setOpen(key);
  };

  return (
    <div
      ref={rootRef}
      className={`m-newticket ns-qa-mnew${active || open ? " is-active" : ""}${className ? " " + className : ""}`}
      onFocus={() => {
        if (useSelectionStore.getState().ids.length) useSelectionStore.getState().clear();
        setActive(true);
      }}
      onBlur={() => {
        window.setTimeout(() => {
          const a = document.activeElement;
          if (openRef.current || (a && rootRef.current?.contains(a))) return;
          setActive(false);
        }, 60);
      }}
    >
      {(active || open) && (
        <QuickChips
          api={api}
          hideRouteKind={hideRouteKind}
          className="ns-qa-mchips"
          noDateLabel={!!defaults.noDateLabel}
          open={open}
          onOpen={(key) => openChip(key)}
        />
      )}
      <QuickField
        api={api}
        inputRef={inputRef}
        className="ns-qa-mfield"
        placeholder={placeholder ?? defaultPlaceholder(api)}
        ariaLabel="建票列：名稱與設定"
        enterKeyHint="done"
        onKeyDown={(e) => {
          if (onClose && e.key === "Escape" && !(e.nativeEvent.isComposing || e.keyCode === 229 || api.composing)) {
            e.preventDefault();
            onClose();
            return;
          }
          if (!api.isSubmitKey(e)) return;
          e.preventDefault();
          const cont = e.ctrlKey || e.metaKey;
          if (!api.text.trim() && !api.canSubmit) {
            if (onClose) onClose();
            else inputRef.current?.blur();
            return;
          }
          void submit(cont);
        }}
      />
      <button
        type="button"
        className="m-nt-go ns-btn btn-seal"
        disabled={!api.canSubmit && !(api.composing && api.text.trim())}
        onMouseDown={(e) => e.preventDefault()}
        onClick={tapGo}
      >
        {api.target.kind === "branch" ? "建立支線" : api.values.isPlaceholder ? "建預留席" : "発券"}
      </button>

      {open === "dest" && (
        <MobileAttachPicker
          title="掛到"
          depth="node"
          value={{ routeId: api.values.dest.routeId, nodeId: api.values.dest.nodeId, nodeKind: api.values.dest.nodeKind === "ticket" ? "car" : api.values.dest.nodeKind }}
          onPick={(t) => {
            api.setDest(t);
            picked();
          }}
          onClear={() => {
            api.setDest(NO_DEST);
            picked();
          }}
          clearLabel="無路線（臨時車票）"
          onClose={close}
        />
      )}
      {open === "station" && (
        <MSheet title="車站" list onClose={close}>
          {api.stations.map((s) => (
            <MSheetItem
              key={s.id}
              onClick={() => {
                api.setStation(s.id);
                picked();
              }}
              className={api.values.stationId === s.id ? "is-cur" : undefined}
            >
              {s.name}
              {api.values.stationId === s.id && <span className="m-tks-aside">✓</span>}
            </MSheetItem>
          ))}
          <MSheetItem
            cut={api.stations.length > 0}
            onClick={() => {
              api.setStation(null);
              picked();
            }}
            className={!api.values.stationId ? "is-cur" : undefined}
          >
            還沒排站
            {!api.values.stationId && <span className="m-tks-aside">✓</span>}
          </MSheetItem>
        </MSheet>
      )}
      {(open === "date" || open === "due") && (
        <MobileDatePicker
          title={open === "date" ? "乘車日" : "締切日"}
          value={open === "date" ? api.values.scheduledOn : api.values.dueOn}
          endValue={open === "date" ? api.values.scheduledEnd : null}
          allowRange={open === "date"}
          min={open === "date" ? api.today : undefined}
          today={api.today}
          quick={
            open === "due" && api.values.scheduledOn
              ? [{ label: "＝同乘車日", day: api.values.scheduledOn }, ...dateQuickSet("forward", api.today)]
              : dateQuickSet("forward", api.today)
          }
          backId={dateLayer}
          onPick={(d) => {
            if (open === "date") api.setDate(d);
            else if (api.values.scheduledOn && d === api.values.scheduledOn) api.setSyncDueWithScheduled(true);
            else api.setDue(d);
            picked();
          }}
          onPickRange={
            open === "date"
              ? (s, e) => {
                  api.setDateRange(s, e);
                  picked();
                }
              : undefined
          }
          onClear={
            open === "date" || api.values.dueOn || api.syncDueWithScheduled
              ? () => {
                  if (open === "date") api.setDateRange(null, null);
                  else api.setDue(null);
                  picked();
                }
              : undefined
          }
          clearLabel={open === "date" ? "無日期" : "清除"}
          onClose={close}
        />
      )}
      {open === "time" && <MobileTimeSheet api={api} onDone={picked} onClose={close} />}
      {open === "priority" && (
        <MSheet title="優先順序" list onClose={close}>
          {(["high", "mid", "low"] as Priority[]).map((p) => (
            <MSheetItem
              key={p}
              onClick={() => {
                api.setPriority(p);
                picked();
              }}
              className={api.values.priority === p ? "is-cur" : undefined}
            >
              {PRIORITY_TEXT[p]}
            </MSheetItem>
          ))}
          {api.values.priority && (
            <MSheetItem
              cut
              onClick={() => {
                api.setPriority(null);
                picked();
              }}
            >
              不設
            </MSheetItem>
          )}
        </MSheet>
      )}
      {open === "tags" && (
        <MSheet title="荷札" list onClose={close}>
          {api.values.tags.map((t) => (
            <MSheetItem key={t} ariaLabel={`拿掉 #${t}`} onClick={() => api.setTags(api.values.tags.filter((x) => x !== t))}>
              #{t}　<span className="ns-qa-msub">拿掉</span>
            </MSheetItem>
          ))}
          <MSheetItem
            cut
            onClick={() => {
              setOpen(null);
              openTagPicker(api, refocus);
            }}
          >
            ＋ 加荷札…
          </MSheetItem>
        </MSheet>
      )}
    </div>
  );
}

/** 沒給 placeholder 時：支線＝「新增支線…」，其餘照建成的種類 */
function defaultPlaceholder(api: QuickAddApi): string {
  if (api.target.kind === "branch") {
    const d = api.values.dest;
    const name = !d.nodeId ? api.routeName(d.routeId) : null;
    return name ? `新增支線到「${name}」…` : "新增支線…";
  }
  if (api.target.kind !== "train") return "新增車票…（@路線 #荷札 =）";
  const d = api.values.dest;
  const name = !d.nodeId ? api.routeName(d.routeId) : null;
  return name ? `新增列車到「${name}」…` : "新增列車…";
}

/** 荷札點選器（旅客筆記那支，插入模式）：選好的名稱併進建票列的荷札 */
function openTagPicker(api: QuickAddApi, refocus: () => void): void {
  useTagStore.getState().openPicker({
    mode: "insert",
    entityType: null,
    entityId: null,
    name: "",
    title: "荷札（建好之後一起掛）",
    onInsert: (names) => {
      if (names.length) api.setTags([...new Set([...api.values.tags, ...names])]);
      refocus();
    },
  });
}

const MOBILE_DIAL_OPTS = [
  { value: "start" as const, label: "撥開始" },
  { value: "end" as const, label: "撥結束" },
];

/** 幾點（開始 ⇄ 結束）＋ 持續時長（MSheet；透過 clockSpan.ts 雙向即時連動） */
function MobileTimeSheet({ api, onDone, onClose }: { api: QuickAddApi; onDone(): void; onClose(): void }) {
  const v = api.values;
  const refDay = v.scheduledOn ?? api.today;
  const { lo, hi } = useMemo(() => clockBounds(refDay, api.dayStartHour), [refDay, api.dayStartHour]);
  const [seed] = useState(() => clockSeed(refDay, api.today, api.dayStartHour));
  const [startHm, setStartHm] = useState<string | null>(() => {
    if (v.scheduledTime) return v.scheduledTime;
    if (v.estimateMin !== null) return null;
    return msToClock(seed, refDay);
  });
  const [len, setLen] = useState<number | null>(v.estimateMin);
  const [activeDial, setActiveDial] = useState<"start" | "end">("start");
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const span = useMemo(() => deriveClockSpan(startHm, len), [startHm, len]);
  const startShownMs = (span.startHm ? clockToMs(span.startHm, refDay) : null) ?? seed;
  const effectiveStartHm = span.startHm ?? msToClock(startShownMs, refDay) ?? "09:00";
  const startMsForEnd = clockToMs(effectiveStartHm, refDay) ?? lo;
  const endCurrentMs = span.endHm ? clockToMs(span.endHm, refDay) : null;
  const endLo = startMsForEnd + 60_000;
  const endHi = Math.max(hi, startMsForEnd + 12 * 3_600_000, endCurrentMs ?? 0);
  const endShownMs = endCurrentMs ?? Math.min(startMsForEnd + (span.durationMin ?? 60) * 60_000, endHi);

  const onStartChange = (ms: number) => {
    const next = msToClock(ms, refDay);
    if (!next) return;
    const res = applyStartClock({ startHm: span.startHm, durationMin: span.durationMin }, next, api.dayStartHour);
    if (!res.ok) {
      setErrMsg(res.error ?? null);
      return;
    }
    setErrMsg(null);
    setStartHm(res.startHm);
    setLen(res.durationMin);
  };

  const onEndChange = (ms: number) => {
    const next = msToClock(ms, refDay);
    if (!next) return;
    const res = applyEndClock({ startHm: effectiveStartHm, durationMin: span.durationMin }, next, api.dayStartHour);
    if (!res.ok) {
      setErrMsg(res.error ?? null);
      return;
    }
    setErrMsg(null);
    setStartHm(res.startHm);
    setLen(res.durationMin);
  };

  const onLenChange = (nextMin: number | null) => {
    const res = applyDurationMin({ startHm: span.startHm, durationMin: span.durationMin }, nextMin);
    if (!res.ok) {
      setErrMsg(res.error ?? null);
      return;
    }
    setErrMsg(null);
    setStartHm(res.startHm);
    setLen(res.durationMin);
  };

  const save = () => {
    api.setTime(span.startHm, span.durationMin);
    onDone();
  };

  return (
    <MSheet
      title="幾點與長度"
      height="full"
      onClose={onClose}
      foot={
        <>
          <button
            type="button"
            className="ns-btn btn-ghost"
            onClick={() => {
              api.setTime(null, null);
              onDone();
            }}
          >
            清除
          </button>
          <button type="button" className="ns-btn btn-seal" onClick={save}>
            好
          </button>
        </>
      }
    >
      <div className="ns-qa-msheet">
        <div className="ns-qa-timehead">
          <span className="ns-qa-cardlabel">開始與結束時刻</span>
          <Segmented<"start" | "end">
            compact
            options={MOBILE_DIAL_OPTS}
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
                  onClick={() => {
                    setErrMsg(null);
                    setStartHm(null);
                  }}
                >
                  不排時刻
                </button>
              )}
            </div>
            <ClockInput
              variant="mobile"
              picker={activeDial === "start" ? "inline" : false}
              quick={[]}
              value={startShownMs}
              lo={lo}
              hi={hi}
              refDay={refDay}
              label="開始時刻"
              dateLabel="other"
              onChange={onStartChange}
              onEnter={save}
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
              variant="mobile"
              picker={activeDial === "end" ? "inline" : false}
              quick={[]}
              value={endShownMs}
              lo={endLo}
              hi={endHi}
              refDay={refDay}
              label="結束時刻"
              dateLabel="other"
              onChange={onEndChange}
              onEnter={save}
            />
          </div>
        </div>

        {errMsg && (
          <p className="ns-qa-timeerr" role="status">
            {errMsg}
          </p>
        )}

        <div className="ns-qa-cardlabel">持續時長</div>
        <DurationPicker liveCommit value={span.durationMin} onChange={onLenChange} onEnter={save} ariaLabel="持續時長" />
      </div>
    </MSheet>
  );
}
