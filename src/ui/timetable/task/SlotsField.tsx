/**
 * SlotsField——車票的「其他時段」（時刻表⑦ 契約 §4 入口①、D-時-162；原型 `prototypes/時刻表-⑦.html` 題 4 側板）。
 * 第一段＝主線既有的「幾點＋預計」（不在這裡列）；第二段起＝`time_plans` 的車票段（`useTimetablePlanStore.slotsByNode`）。
 * `nodeFields` 插槽的 `Desktop`（標籤「其他時段」由 `LineRows`／`FieldRow` 畫）；手機版 `SlotsFieldMobile` 包同一個 `SlotsBody`。
 *
 *   ul.ns-tt-tplans
 *     li[.is-past]          一段一行：button.ns-tt-tplans-hit（span.d「11/3（一）」＋span.t「14:00–16:00」）＋button.x（刪，toast 可復原）
 *                           過去的段（day < 今天）整行淡字、不能點開改（D-時-79：只能排今天以後），× 照樣能刪
 *     li.is-new[.is-edit]   「＋加一段」或點既有一段展開的那一行：DateChip（最早今天）＋起–訖 ClockInput（compact、拿掉微調鈕）
 *                           ＋span.ns-tt-tplans-acts（取消｜加上／存）
 *   button.ns-tt-tplans-add「＋加一段」（展開時不畫）
 *   p.ns-tt-tplans-teiki    定期券：一行灰字取代「＋加一段」（每班一個時刻；已有的段照列、只能刪）
 *
 * 值的換算同側板「幾點」（`panel/clockValue.ts`）：資料是營業日表記 "HH:MM"（"25:00"＝隔天 01:00），ClockInput 吃毫秒，
 *   都以這一段的日子為基準。範圍守門（日界線、結束晚於開始、過去的日子）在 store，錯了 toast 理由、這一行留著。
 * 鍵盤：起點 Enter＝跳到訖點；訖點 Enter＝加上／存；Esc＝收起這一行（ClockInput 有草稿時自己先攔、DatePicker 浮層自己攔）。
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { NodeRow } from "../../../domain/node";
import { MIN, fmtClock } from "../../../domain/timetable";
import { todayKey, type ClockText } from "../../../lib/date";
import { useTimetablePlanStore, type TimePlanRow } from "../../../store/timetablePlanStore";
import { useUiStore } from "../../../store/uiStore";
import { ClockInput, clockDraftsOkIn, type ClockInputHandle } from "../../common/ClockInput";
import { DateChip, dateChipText } from "../../common/DateChip";
import { IconClose } from "../../common/icons";
import { clockBounds, clockSeed, clockToMs, msToClock } from "../../panel/clockValue";
import "./slots.css";

export const SLOTS_TEXT = {
  label: "其他時段",
  add: "＋加一段",
  addOk: "加上",
  editOk: "存",
  cancel: "取消",
  start: "開始",
  end: "結束",
  day: "日期",
  teiki: "定期券每班一個時刻；要分次做就連時間塊",
  deleted: (day: string) => `刪了 ${dateChipText(day)} 那一段`,
  undo: "復原",
  rowLabel: (text: string) => `改這一段：${text}`,
  delLabel: (text: string) => `刪掉這一段：${text}`,
} as const;

/** 沒填預計時，新的一段多長（契約 §4 入口②同一個數） */
const DEFAULT_LEN_MIN = 60;

interface Draft {
  /** null＝新加的一段 */
  id: string | null;
  day: string;
  s: ClockText;
  e: ClockText;
}

/** 一段的顯示字「11/3（一）」「14:00–16:00」（牆鐘；跨過午夜照牆鐘印） */
export function slotText(r: Pick<TimePlanRow, "day" | "start_hm" | "end_hm">): { d: string; t: string } {
  const a = clockToMs(r.start_hm, r.day);
  const b = clockToMs(r.end_hm, r.day);
  const t = a !== null && b !== null ? `${fmtClock(a)}–${fmtClock(b)}` : `${r.start_hm}–${r.end_hm}`;
  return { d: dateChipText(r.day), t };
}

/** 新加一段的起點：日子＝執行日（早於今天就用今天）；今天＝現在往後取整到 15 分、別天 09:00；長度＝預計（沒填 60 分） */
function seedDraft(node: NodeRow, today: string, dayStartHour: number): Draft {
  const day = node.scheduled_on && node.scheduled_on > today ? node.scheduled_on : today;
  const { hi } = clockBounds(day, dayStartHour);
  const a = clockSeed(day, today, dayStartHour);
  const b = Math.min(a + (node.estimate_min && node.estimate_min > 0 ? node.estimate_min : DEFAULT_LEN_MIN) * MIN, hi + MIN);
  return { id: null, day, s: msToClock(a, day) ?? "09:00", e: msToClock(b, day) ?? "10:00" };
}

/** 兩殼共用的本體（桌機包 div、手機包 dl） */
export function SlotsBody({ node }: { node: NodeRow }) {
  const rows = useTimetablePlanStore((s) => s.slotsByNode[node.id]);
  const busy = useTimetablePlanStore((s) => s.busy);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const today = todayKey(dayStartHour);
  const teiki = node.repeat_rule !== null;
  const [draft, setDraft] = useState<Draft | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const refocusAdd = useRef(false);

  useEffect(() => {
    setDraft(null);
    useTimetablePlanStore
      .getState()
      .loadNode(node.id)
      .catch((e: unknown) => console.warn("時刻表：其他時段沒讀到", e));
  }, [node.id]);

  // 收起那一行之後（鍵盤收、加上了），焦點交還「＋加一段」
  useEffect(() => {
    if (draft !== null || !refocusAdd.current) return;
    refocusAdd.current = false;
    addRef.current?.focus({ preventScroll: true });
  });

  // 正在改的那一段被刪掉了（別台同步、或這台按了 ×）⇒ 收起
  useEffect(() => {
    if (draft?.id && rows && !rows.some((r) => r.id === draft.id)) setDraft(null);
  }, [rows, draft?.id]);

  const close = (byKeyboard: boolean) => {
    if (byKeyboard) refocusAdd.current = true;
    setDraft(null);
  };

  const remove = async (r: TimePlanRow) => {
    const st = useTimetablePlanStore.getState();
    if (!(await st.deleteSlot(r.id))) return;
    useUiStore.getState().showToast({
      message: SLOTS_TEXT.deleted(r.day),
      actionLabel: SLOTS_TEXT.undo,
      onAction: () => void useTimetablePlanStore.getState().restoreSlot(r.id),
    });
  };

  const list = rows ?? [];
  return (
    <>
      <ul className="ns-tt-tplans">
        {list.map((r) => {
          if (draft?.id === r.id) {
            return <SlotEditor key={r.id} draft={draft} setDraft={setDraft} node={node} today={today} busy={busy} onClose={close} />;
          }
          const past = r.day < today;
          const { d, t } = slotText(r);
          const text = `${d} ${t}`;
          return (
            <li key={r.id} className={past ? "is-past" : undefined}>
              {past || teiki ? (
                <span className="ns-tt-tplans-hit">
                  <span className="d">{d}</span>
                  <span className="t">{t}</span>
                </span>
              ) : (
                <button
                  type="button"
                  className="ns-tt-tplans-hit"
                  aria-label={SLOTS_TEXT.rowLabel(text)}
                  onClick={() => setDraft({ id: r.id, day: r.day, s: r.start_hm, e: r.end_hm })}
                >
                  <span className="d">{d}</span>
                  <span className="t">{t}</span>
                </button>
              )}
              <button
                type="button"
                className="ns-iconbtn x"
                aria-label={SLOTS_TEXT.delLabel(text)}
                title="刪這段"
                disabled={busy}
                onClick={() => void remove(r)}
              >
                <IconClose />
              </button>
            </li>
          );
        })}
        {draft?.id === null && (
          <SlotEditor draft={draft} setDraft={setDraft} node={node} today={today} busy={busy} onClose={close} />
        )}
      </ul>
      {teiki ? (
        <p className="ns-tt-tplans-teiki">{SLOTS_TEXT.teiki}</p>
      ) : (
        draft === null && (
          <button
            ref={addRef}
            type="button"
            className="ns-tt-tplans-add"
            onClick={() => setDraft(seedDraft(node, todayKey(dayStartHour), dayStartHour))}
          >
            {SLOTS_TEXT.add}
          </button>
        )
      )}
    </>
  );
}

/** 展開的那一行：日期 chip＋起–訖＋取消／加上（或存） */
function SlotEditor({
  draft,
  setDraft,
  node,
  today,
  busy,
  onClose,
}: {
  draft: Draft;
  setDraft(d: Draft | null): void;
  node: NodeRow;
  today: string;
  busy: boolean;
  onClose(byKeyboard: boolean): void;
}) {
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const rowRef = useRef<HTMLLIElement>(null);
  const startH = useRef<ClockInputHandle>(null);
  const endH = useRef<ClockInputHandle>(null);
  const { lo, hi } = clockBounds(draft.day, dayStartHour);
  const sMs = clockToMs(draft.s, draft.day) ?? lo;
  const eMs = clockToMs(draft.e, draft.day) ?? Math.min(sMs + DEFAULT_LEN_MIN * MIN, hi + MIN);
  const live = useRef(draft);
  live.current = draft;
  const isEdit = draft.id !== null;

  // 改開始＝整段跟著挪（長度不變；結束頂到這一天的終點就停）
  const changeStart = (ms: number) => {
    const d = live.current;
    const s = msToClock(ms, d.day);
    if (s === null) return;
    const a0 = clockToMs(d.s, d.day);
    const b0 = clockToMs(d.e, d.day);
    let e = d.e;
    if (a0 !== null && b0 !== null) {
      const b = Math.min(ms + (b0 - a0), clockBounds(d.day, dayStartHour).hi + MIN);
      e = msToClock(b, d.day) ?? d.e;
    }
    setDraft({ ...d, s, e });
  };
  const changeEnd = (ms: number) => {
    const d = live.current;
    const e = msToClock(ms, d.day);
    if (e !== null) setDraft({ ...d, e });
  };

  const submit = async () => {
    if (busy || !clockDraftsOkIn(rowRef.current)) return;
    const a = startH.current?.flush() ?? sMs;
    const b = endH.current?.flush() ?? eMs;
    if (a === null || b === null) return;
    const d = live.current;
    const s = msToClock(a, d.day);
    const e = msToClock(b, d.day);
    if (s === null || e === null) return;
    const st = useTimetablePlanStore.getState();
    if (d.id === null) {
      if (await st.addSlot(node.id, d.day, s, e)) onClose(true);
      return;
    }
    const cur = st.slotsByNode[node.id]?.find((r) => r.id === d.id);
    const patch = {
      ...(cur?.day !== d.day ? { day: d.day } : {}),
      ...(cur?.start_hm !== s ? { s } : {}),
      ...(cur?.end_hm !== e ? { e } : {}),
    };
    if (!Object.keys(patch).length || (await st.editSlot(d.id, patch))) onClose(true);
  };

  const onKeyDown = (ev: KeyboardEvent<HTMLLIElement>) => {
    if (ev.defaultPrevented || ev.nativeEvent.isComposing || ev.keyCode === 229) return;
    if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      onClose(true);
    }
  };

  return (
    <li ref={rowRef} className={"is-new" + (isEdit ? " is-edit" : "")} onKeyDown={onKeyDown}>
      <DateChip
        date={draft.day}
        onPick={(v) => v && setDraft({ ...live.current, day: v })}
        min={today}
        today={today}
        label={SLOTS_TEXT.day}
      />
      <span className="ns-tt-tplans-range">
        <ClockInput
          variant="compact"
          value={sMs}
          lo={lo}
          hi={hi}
          onChange={changeStart}
          onEnter={() => endH.current?.focus()}
          label={SLOTS_TEXT.start}
          refDay={draft.day}
          dateLabel={false}
          enterKeyHint="next"
          autoFocus
          handleRef={startH}
          left={false}
          right={false}
        />
        <span className="ns-tt-tplans-dash" aria-hidden="true">
          –
        </span>
        <ClockInput
          variant="compact"
          value={eMs}
          lo={lo + MIN}
          hi={hi + MIN}
          onChange={changeEnd}
          onEnter={() => void submit()}
          label={SLOTS_TEXT.end}
          refDay={draft.day}
          dateLabel={false}
          handleRef={endH}
          left={false}
          right={false}
        />
      </span>
      <span className="ns-tt-tplans-acts">
        <button type="button" className="ns-btn btn-ghost ns-btn--sm" onClick={() => onClose(true)}>
          {SLOTS_TEXT.cancel}
        </button>
        <button type="button" className="ns-btn btn-ghost ns-btn--sm" disabled={busy} onClick={() => void submit()}>
          {isEdit ? SLOTS_TEXT.editOk : SLOTS_TEXT.addOk}
        </button>
      </span>
    </li>
  );
}

/** 桌機任務側板「其他時段」列的值（`nodeFields` 的 Desktop） */
export function SlotsField({ node }: { node: NodeRow }) {
  return (
    <div className="ns-tt-slots">
      <SlotsBody node={node} />
    </div>
  );
}
