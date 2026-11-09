/**
 * 建票列兩殼共用的小件（回饋甲；原型 prototypes/回饋甲-入口與建票.html 的 .nsq-field／.nsq-chips）：
 *   QuickField   輸入框＋反白鏡像（原生 input 不能局部上色：鏡像在下、輸入框透明字在上；組字中不疊鏡像）
 *   QuickChips   ［掛到］［乘車日］［幾點］［締切］［＝同乘車日］［優先］［#荷札］一排（＋掛到路線時「列車｜車票」小分段鈕）
 *   destLabel／chipLabels  chip 上的字（兩殼同一份）
 * 樣式在 ./quickadd.css（.ns-qa-*）。
 */
import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode, type Ref } from "react";
import type { NodeRow } from "../../../domain";
import { IconCalendar, IconFlag, TAB_ICONS } from "../icons";
import { Segmented } from "../Segmented";
import { nodeNameOf } from "../../notes/notesBits";
import type { QuickAddApi } from "./useQuickAdd";
import { PRIORITY_TEXT, dateChipText, dayText, lengthText, type QuickChipKey, type RouteKind } from "./quickAddModel";

/* ───────── 圖示（16 格、1.3 線；跟 common/icons 同一種畫法） ───────── */

const TAG_PATH = "M2.6 8.4V3.1c0-.3.2-.5.5-.5h5.3l5 5-5.8 5.8-5-5zM5.6 5.6h.1";

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg className="ns-ico" width={13} height={13} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

/** 用 TAB_ICONS 的形狀（路線圖、時刻表）畫小圖示 */
function TabShape({ k }: { k: "routemap" | "timetable" }) {
  return (
    <Svg>
      {TAB_ICONS[k].map((s, i) => {
        const Tag = s.tag;
        return <Tag key={i} {...(s.attrs as Record<string, string | number>)} />;
      })}
    </Svg>
  );
}

export const QIcon = {
  route: () => <TabShape k="routemap" />,
  clock: () => <TabShape k="timetable" />,
  flag: () => <IconFlag size={13} />,
  cal: () => <IconCalendar size={13} />,
  tag: () => (
    <Svg>
      <path d={TAG_PATH} />
    </Svg>
  ),
  prio: () => <span className="ns-qa-bang" aria-hidden>!!</span>,
};

/* ───────── 小圓牌（路線代碼） ───────── */

export function QRoundel({ route }: { route: Pick<NodeRow, "code" | "color"> | null | undefined }) {
  if (!route) return <QIcon.route />;
  return (
    <span aria-hidden className="ns-qa-rd" style={{ background: route.color ?? "var(--route-none)" }}>
      {route.code ?? ""}
    </span>
  );
}

/* ───────── chip 上的字 ───────── */

/** 掛到的字：無路線／路線名／路線 › 列車 */
export function destLabel(api: QuickAddApi): { text: string; route: NodeRow | null } {
  const d = api.values.dest;
  const route = d.routeId ? (api.routes.find((r) => r.id === d.routeId) ?? null) : null;
  if (!route) return { text: "無路線", route: null };
  if (!d.nodeId) return { text: route.name, route };
  const n = api.nodeName(d.nodeId) ?? nodeNameOf(d.nodeId) ?? "列車";
  return { text: `${route.name} › ${n}`, route };
}

/** 票根下那行小字（會建成什麼掛在哪）：路線名／路線 › 列車；無路線＝空 */
export function intoLabel(api: QuickAddApi): string {
  const d = api.values.dest;
  if (!d.routeId) return "";
  return destLabel(api).text;
}

export interface ChipText {
  /** 有值時的字；null＝空著（畫欄名淡字） */
  value: string | null;
  /** 欄名（空著時畫、也是讀屏名） */
  label: string;
  /** 有預設值（實線淡墨） */
  val: boolean;
  /** 設過（認出來或點過＝選中色） */
  on: boolean;
}

export function chipTexts(api: QuickAddApi, noDateLabel: boolean): Record<Exclude<QuickChipKey, "dest">, ChipText> {
  const v = api.values;
  const on = v.on;
  const dateShown = v.scheduledOn ? dateChipText(v.scheduledOn, api.today) : on.has("date") || noDateLabel ? "無日期" : null;
  const time =
    v.scheduledTime && v.estimateMin ? `${v.scheduledTime}・${lengthText(v.estimateMin)}` : v.scheduledTime ?? (v.estimateMin ? lengthText(v.estimateMin) : null);
  const dueText = api.syncDueWithScheduled
    ? v.dueOn
      ? `〆${dayText(v.dueOn)}＝同乘車日`
      : "〆同乘車日"
    : v.dueOn
      ? `〆${dayText(v.dueOn)}`
      : null;
  return {
    date: { value: dateShown, label: "乘車日", val: dateShown !== null, on: on.has("date") },
    time: { value: time, label: "幾點", val: time !== null, on: on.has("time") },
    due: { value: dueText, label: "締切", val: dueText !== null, on: on.has("due") || api.syncDueWithScheduled },
    priority: { value: v.priority ? `優先 ${PRIORITY_TEXT[v.priority]}` : null, label: "優先", val: v.priority !== null, on: on.has("priority") },
    tags: { value: v.tags.length ? v.tags.map((t) => `#${t}`).join(" ") : null, label: "荷札", val: v.tags.length > 0, on: on.has("tags") },
  };
}

/* ───────── 輸入框＋反白鏡像 ───────── */

export interface QuickFieldProps {
  api: QuickAddApi;
  placeholder: string;
  ariaLabel: string;
  className?: string;
  inputRef?: Ref<HTMLInputElement>;
  onKeyDown?(e: KeyboardEvent<HTMLInputElement>): void;
  onFocus?(): void;
  enterKeyHint?: "done" | "send";
}

export function QuickField({ api, placeholder, ariaLabel, className, inputRef, onKeyDown, onFocus, enterKeyHint }: QuickFieldProps) {
  const mirrorRef = useRef<HTMLDivElement>(null);
  const ownRef = useRef<HTMLInputElement | null>(null);
  const toks = api.tokens;
  const mirror = toks.length > 0;

  // 鏡像跟著輸入框橫捲（字長過框寬時）
  const sync = () => {
    if (mirrorRef.current && ownRef.current) mirrorRef.current.scrollLeft = ownRef.current.scrollLeft;
  };
  useLayoutEffect(sync);

  const parts: ReactNode[] = [];
  if (mirror) {
    let i = 0;
    toks.forEach((t, k) => {
      if (t.start > i) parts.push(api.text.slice(i, t.start));
      parts.push(
        <mark key={k} className="ns-qa-tok" data-k={t.kind}>
          {api.text.slice(t.start, t.end)}
        </mark>,
      );
      i = t.end;
    });
    parts.push(api.text.slice(i) + " ");
  }

  return (
    <div className={`ns-qa-field${mirror ? " has-mirror" : ""}${className ? " " + className : ""}`}>
      {mirror && (
        <div ref={mirrorRef} className="ns-qa-mirror" aria-hidden>
          {parts}
        </div>
      )}
      <input
        ref={(el) => {
          ownRef.current = el;
          if (typeof inputRef === "function") inputRef(el);
          else if (inputRef) (inputRef as { current: HTMLInputElement | null }).current = el;
        }}
        value={api.text}
        onChange={(e) => api.setText(e.target.value)}
        onKeyDown={onKeyDown}
        onKeyUp={sync}
        onScroll={sync}
        onSelect={sync}
        onFocus={() => {
          api.warm();
          onFocus?.();
        }}
        {...api.compositionProps}
        placeholder={placeholder}
        aria-label={ariaLabel}
        enterKeyHint={enterKeyHint}
        spellCheck={false}
        autoComplete="off"
      />
    </div>
  );
}

/* ───────── chips 一排 ───────── */

export interface QuickChipsProps {
  api: QuickAddApi;
  /** 大綱位置型：掛到由位置決定，不出掛到 chip */
  hideDest?: boolean;
  noDateLabel: boolean;
  /** 開著的挑選器 */
  open: QuickChipKey | null;
  onOpen(key: QuickChipKey, anchor: HTMLElement): void;
  className?: string;
  /** 桌機：按下不搶輸入框焦點（挑選器自己接焦點） */
  keepFocus?: boolean;
}

export function QuickChips({ api, hideDest = false, noDateLabel, open, onOpen, className, keepFocus = false }: QuickChipsProps) {
  const t = chipTexts(api, noDateLabel);
  const keep = keepFocus ? { onMouseDown: (e: { preventDefault(): void }) => e.preventDefault() } : {};
  const chip = (key: QuickChipKey, icon: ReactNode, c: ChipText, extraTitle?: string) => (
    <button
      key={key}
      type="button"
      data-pop-toggle
      data-chip={key}
      aria-haspopup="dialog"
      aria-expanded={open === key}
      title={extraTitle ?? c.label}
      aria-label={c.value ? `${c.label}：${c.value}` : c.label}
      className={["ns-qa-chip", c.val ? "is-val" : "", c.on ? "is-on" : "", open === key ? "is-open" : ""].filter(Boolean).join(" ")}
      onClick={(e) => onOpen(key, e.currentTarget)}
      {...keep}
    >
      {icon}
      {c.value ? <span className="v">{c.value}</span> : <span className="k">{c.label}</span>}
    </button>
  );
  const dest = destLabel(api);
  return (
    <div className={`ns-qa-chips${className ? " " + className : ""}`}>
      {!hideDest && (
        <>
          {chip(
            "dest",
            <QRoundel route={dest.route} />,
            { value: dest.text, label: "掛到", val: true, on: api.values.on.has("dest") },
            "掛到哪裡：無路線＝臨時車票、路線＝列車或車票、列車／車廂＝車票",
          )}
          {api.target.canChoose && <RouteKindSeg api={api} keepFocus={keepFocus} />}
        </>
      )}
      {chip("date", <QIcon.flag />, t.date)}
      {chip("time", <QIcon.clock />, t.time)}
      {chip("due", <QIcon.cal />, t.due, "締切日")}
      <button
        type="button"
        className={["ns-qa-chip", "ns-qa-chip--sync", api.syncDueWithScheduled ? "is-on" : ""].filter(Boolean).join(" ")}
        aria-pressed={api.syncDueWithScheduled}
        title="締切日與乘車日同步（同乘車日）"
        onClick={() => api.setSyncDueWithScheduled(!api.syncDueWithScheduled)}
        {...keep}
      >
        <span className="k">＝同乘車日</span>
      </button>
      {chip("priority", <QIcon.prio />, t.priority, "優先順序")}
      {chip("tags", <QIcon.tag />, t.tags)}
    </div>
  );
}

const KIND_OPTIONS = [
  { value: "train" as const, label: "列車", title: "建成這條路線底下的列車" },
  { value: "ticket" as const, label: "車票", title: "建成掛這條路線的臨時車票" },
];

/** 掛到路線（或支線）時：列車｜車票 */
function RouteKindSeg({ api, keepFocus }: { api: QuickAddApi; keepFocus: boolean }) {
  return (
    <span className="ns-qa-kind" onMouseDown={keepFocus ? (e) => e.preventDefault() : undefined}>
      <Segmented<RouteKind> compact options={KIND_OPTIONS} value={api.routeKind} onChange={api.setRouteKind} aria-label="建成什麼" />
    </span>
  );
}
