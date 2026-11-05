/**
 * MobileQuickAdd——手機建票列＝底部輸入列（回饋甲 D-主-127、128；原型 q1-A mobile `.m-newticket.nsq-mnew`）。
 *
 * 長相：沿既有 `.m-newticket`（tab bar 之上那一條）：輸入框（認出的片段反白）＋「発券」；
 *   聚焦後才在輸入框上方出一排 chips（可橫捲、末段露半格）：［掛到］［執行日］［幾點］［締切］［優先］［#荷札］。
 *   舊的「無日期」切換併進「執行日」chip（清除＝無日期，進收件匣）。
 * 挑選器全用既有手機元件：掛到＝MobileAttachPicker、執行日／締切＝MobileDatePicker、幾點＝MSheet＋ClockInput（mobile）＋長度分段鈕、
 *   優先＝MSheet 動作清單、荷札＝旅客筆記的荷札點選器（tagStore.openPicker 插入模式）。
 * 送出、連打、toast 規則同桌機（useQuickAdd）；IME 三重守門同 MobileNewTicket。不在失焦時送出（手機收鍵盤很常見，不是「點去別處」）。
 *
 * 接法（手機席）：今日／路線第二層／行程表把原本的 MobileNewTicket 換成
 *   <MobileQuickAdd defaults={...} here={...} routeKind? placeholder? onCreated? />
 */
import { useCallback, useId, useRef, useState } from "react";
import type { NodeRow, Priority } from "../../../domain";
import { useTagStore } from "../../../store/tagStore";
import { useBackLayer } from "../../mobile/backStack";
import { ClockInput } from "../ClockInput";
import { dateQuickSet } from "../DateChip";
import { MSheet, MSheetItem } from "../MSheet";
import { MobileAttachPicker } from "../MobileAttachPicker";
import { MobileDatePicker } from "../MobileDatePicker";
import { Segmented } from "../Segmented";
import { clockBounds, clockSeed, clockToMs, msToClock } from "../../panel/clockValue";
import { QuickChips, QuickField } from "./QuickAddParts";
import { LENGTH_PRESETS, NO_DEST, PRIORITY_TEXT, lengthText, type QuickChipKey, type QuickDefaults, type QuickHere, type RouteKind } from "./quickAddModel";
import { useQuickAdd, type QuickAddApi } from "./useQuickAdd";
import "./quickadd.css";

export interface MobileQuickAddProps {
  defaults: QuickDefaults;
  here: QuickHere;
  /** 掛到路線時預設建成什麼（路線第二層＝列車） */
  routeKind?: RouteKind;
  placeholder?: string;
  onCreated?(row: NodeRow, stays: boolean): void;
  /** 加在根上（頁面自己的位置微調） */
  className?: string;
  /** 行內版（行程表那一天底下）：Esc 或空白 Enter＝收起（同舊草稿列）；常駐的底部列不給 */
  onClose?(): void;
}

export function MobileQuickAdd({ defaults, here, routeKind, placeholder, onCreated, className, onClose }: MobileQuickAddProps) {
  const api = useQuickAdd({ defaults, here, routeKind, onCreated });
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [active, setActive] = useState(false);
  const [open, setOpen] = useState<QuickChipKey | null>(null);
  const openRef = useRef(open);
  openRef.current = open;

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

  const submit = async () => {
    if (!api.canSubmit) return;
    await api.submit(); // 成功清空；不主動 blur：連打是預期用法
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
      onFocus={() => setActive(true)}
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
          if (onClose && !api.text.trim()) {
            onClose();
            return;
          }
          void submit();
        }}
      />
      <button
        type="button"
        className="m-nt-go ns-btn btn-seal"
        disabled={!api.canSubmit && !(api.composing && api.text.trim())}
        onMouseDown={(e) => e.preventDefault()}
        onClick={tapGo}
      >
        発券
      </button>

      {open === "dest" && (
        <MobileAttachPicker
          title="掛到"
          depth="node"
          value={api.values.dest}
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
      {(open === "date" || open === "due") && (
        <MobileDatePicker
          title={open === "date" ? "執行日" : "締切日"}
          value={open === "date" ? api.values.scheduledOn : api.values.dueOn}
          min={open === "date" ? api.today : undefined}
          today={api.today}
          quick={dateQuickSet("forward", api.today)}
          backId={dateLayer}
          onPick={(d) => {
            if (open === "date") api.setDate(d);
            else api.setDue(d);
            picked();
          }}
          onClear={
            open === "date" || api.values.dueOn
              ? () => {
                  if (open === "date") api.setDate(null);
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

/** 沒給 placeholder 時：掛到路線本身建列車＝「新增列車到「X」…」（原型 q2-A 路線第二層），其餘照建成的種類 */
function defaultPlaceholder(api: QuickAddApi): string {
  if (api.target.kind !== "train") return "新增車票…";
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

type LenValue = `${number}` | "custom";

/** 幾點＋長度（MSheet；ClockInput 手機變體＝±15＋常用時刻） */
function MobileTimeSheet({ api, onDone, onClose }: { api: QuickAddApi; onDone(): void; onClose(): void }) {
  const v = api.values;
  const refDay = v.scheduledOn ?? api.today;
  const { lo, hi } = clockBounds(refDay, api.dayStartHour);
  const [seed] = useState(() => clockSeed(refDay, api.today, api.dayStartHour));
  const [ms, setMs] = useState(() => (v.scheduledTime ? clockToMs(v.scheduledTime, refDay) : null) ?? seed);
  const [len, setLen] = useState<number | null>(v.estimateMin);
  const [custom, setCustom] = useState(v.estimateMin !== null && !LENGTH_PRESETS.includes(v.estimateMin));
  const lenValue: LenValue | null = custom ? "custom" : len !== null ? (`${len}` as LenValue) : null;

  const save = () => {
    api.setTime(msToClock(ms, refDay), len);
    onDone();
  };

  return (
    <MSheet
      title="幾點"
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
            不排時刻
          </button>
          <button type="button" className="ns-btn btn-seal" onClick={save}>
            好
          </button>
        </>
      }
    >
      <div className="ns-qa-msheet">
        <ClockInput variant="mobile" picker="inline" quick={[]} value={ms} lo={lo} hi={hi} refDay={refDay} label="開始時刻" onChange={setMs} onEnter={save} />
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
                defaultValue={len ?? ""}
                onChange={(e) => {
                  const n = Number(e.target.value.replace(/[^\d]/g, ""));
                  setLen(Number.isFinite(n) && n > 0 ? Math.min(n, 24 * 60) : null);
                }}
              />
              分
            </label>
          )}
        </div>
      </div>
    </MSheet>
  );
}
