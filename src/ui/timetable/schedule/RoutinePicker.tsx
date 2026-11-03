/**
 * RoutinePicker——日程頂端「作息：工作日 ▾」（⑦ 契約 §3〈畫面〉；原型回報 2；原型 rtPick／rtMenu／menuSheet；C 席）。
 * 位置：桌機在日程頂列最右（ScheduleView）、手機在總結第二行開頭（ScheduleSummary）。選單：桌機 PopMenu、手機 MSheet 動作清單。
 *
 *   button.ns-tt-rtpick[.is-off|.is-empty]   〔作息　工作日 ▾〕／〔作息　不套 ▾〕／虛線〔＋作息範本〕（一套範本都沒有＝直接開編輯器）
 *   選單：換成「週末」…（四套以內直接列；再多收成一層「換成別套…」）
 *        ─ 重新套用（同一套 applyRoutine 同 id）／這天不套（applyRoutine null）
 *        ─ ＋加一段（addRoutineItem：下一個整點起 1 小時、分類＝最近用的）／編輯範本…（分類與設定「作息」頁那一套）
 *   「這天不套」之後沒有套哪一套 ⇒ 列「套用「X」」。
 *
 * 虛擬（還沒落地）與已落地看起來一樣（原型回報 2）。過去的日子只能看：鈕停用（照樣寫出那天照哪一套）；那天什麼都沒有就不畫。
 */
import { useMemo, useRef, useState } from "react";
import { groupedCategories } from "../../../domain/timetable";
import { routineHasItems } from "../../../domain/timetableRoutine";
import { clockRange, clockText, nowClockMinutes, type ClockText } from "../../../lib/date";
import { useTimetableStore } from "../../../store/timetableStore";
import { useTimetablePlanStore } from "../../../store/timetablePlanStore";
import { useUiStore } from "../../../store/uiStore";
import { PopMenu, type PopMenuItem } from "../../common/PopMenu";
import { MSheet, MSheetItem } from "../../common/MSheet";
import { RT_UI } from "./routineModel";
import { mdw } from "./scheduleModel";
import type { SchedulePage } from "./useSchedulePage";
import "./schedule7.css";

/** 直接列在選單上的套數上限（原型回報 2「四套以內直接列」） */
const INLINE_MAX = 4;

const toast = (message: string): void => useUiStore.getState().showToast({ message });

/** 「＋加一段」的預設：今天＝下一個整點起 1 小時；別天＝09:00 起（夾在這一天之內） */
function defaultSlot(date: string, today: string, h: number, now: number): { s: ClockText; e: ClockText } | null {
  const r = clockRange(h);
  let s = 9 * 60;
  if (date === today) {
    const m = nowClockMinutes(date, h, now);
    if (m !== null) s = (Math.floor(m / 60) + 1) * 60;
  }
  if (s < r.min) s += 1440;
  s = Math.max(r.min, Math.min(s, r.max + 1 - 60));
  const a = clockText(s);
  const b = clockText(s + 60);
  return a && b ? { s: a, e: b } : null;
}

export function RoutinePicker({ page }: { page: SchedulePage }) {
  const routines = useTimetablePlanStore((s) => s.routines);
  const loaded = useTimetablePlanStore((s) => s.routinesLoaded);
  const busy = useTimetablePlanStore((s) => s.busy);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState<"root" | "switch">("root");
  const { date, routineDay, shell, todayKey, dayStartHour } = page;
  const desk = shell === "desktop";
  const active = useMemo(() => routines.filter((r) => r.archived_at === null && r.deleted_at === null), [routines]);
  if (!loaded) return null;

  const segs = routineDay?.segs.length ?? 0;
  const curId = routineDay?.routineId ?? null;
  const cur = curId ? (routines.find((r) => r.id === curId) ?? null) : null;
  const past = date < todayKey;
  const md = mdw(date);

  const openEditor = (focusId?: string): void => {
    useTimetableStore.getState().openSheet({ kind: "categories", focus: "routine", ...(focusId ? { focusId } : {}) });
  };

  // 一套範本都沒有：虛線「＋作息範本」＝直接開編輯器（那天也沒有手動段時；有手動段照樣給選單）
  if (!active.length && !segs) {
    if (past) return null;
    return (
      <button type="button" className="ns-tt-rtpick is-empty" onClick={() => openEditor()}>
        {RT_UI.empty}
      </button>
    );
  }
  if (past && !segs) return null;

  const close = (): void => {
    setOpen(false);
    setLevel("root");
  };
  const ps = (): ReturnType<typeof useTimetablePlanStore.getState> => useTimetablePlanStore.getState();
  const apply = (id: string | null, msg: string): void => {
    void ps()
      .applyRoutine(date, id)
      .then((ok) => ok && toast(msg));
  };
  const addSeg = (): void => {
    const tt = useTimetableStore.getState();
    // 只選子分類（D-時-168）：最近用的裡第一個還活著的子分類，沒有就分類格的第一格
    const live = groupedCategories(tt.categories).flatMap((g) => g.children);
    const cat = tt.recentCategoryIds.map((id) => live.find((c) => c.id === id)).find((c) => c !== undefined) ?? live[0];
    if (!cat) {
      toast("先到「分類與設定」建一個分類");
      return;
    }
    const slot = defaultSlot(date, todayKey, dayStartHour, Date.now());
    if (!slot) return;
    void ps()
      .addRoutineItem(date, { cat: cat.id, s: slot.s, e: slot.e })
      .then((ok) => ok && toast(RT_UI.added(slot.s, slot.e)));
  };

  const others = active.filter((r) => r.id !== curId);
  const switchLabel = (name: string): string => (cur ? RT_UI.switchTo(name) : RT_UI.applyTo(name));
  type Item = { key: string; label: string; cut?: boolean; onSelect: () => void; keep?: boolean; disabled?: boolean };
  // 還沒有段的那套（0 段、讀不懂）套上去那天什麼都不會出現 ⇒ 停用、字面直接寫原因（手機沒有滑過提示；反方評審 #4）
  const toItem = (r: (typeof others)[number]): Item =>
    routineHasItems(r)
      ? { key: "to-" + r.id, label: switchLabel(r.name), onSelect: () => apply(r.id, `已${cur ? "換成" : "套用"}「${r.name}」`) }
      : { key: "to-" + r.id, label: `${switchLabel(r.name)}（${RT_UI.noSegs}）`, disabled: true, onSelect: () => undefined };
  const items: Item[] = [];
  if (level === "switch") {
    for (const r of others) items.push(toItem(r));
    items.push({ key: "back", label: RT_UI.back, cut: true, keep: true, onSelect: () => setLevel("root") });
  } else {
    if (others.length <= INLINE_MAX) {
      for (const r of others) items.push(toItem(r));
    } else {
      items.push({ key: "more", label: RT_UI.switchMore, keep: true, onSelect: () => setLevel("switch") });
    }
    if (cur) {
      const ok = routineHasItems(cur);
      items.push({
        key: "reapply",
        label: ok ? RT_UI.reapply : `${RT_UI.reapply}（${RT_UI.noSegs}）`,
        cut: items.length > 0,
        disabled: !ok,
        onSelect: () => (ok ? apply(cur.id, `已重新套用「${cur.name}」`) : undefined),
      });
    }
    if (cur || segs) items.push({ key: "skip", label: RT_UI.skipDay, cut: !cur && items.length > 0, onSelect: () => apply(null, `${md}不套作息`) });
    items.push({ key: "add", label: RT_UI.addSeg, cut: true, onSelect: addSeg });
    items.push({ key: "edit", label: RT_UI.editTpl, onSelect: () => openEditor(cur?.id ?? undefined) });
  }

  const label = cur ? cur.name : RT_UI.off;
  const head = RT_UI.menuHead(md, cur?.name ?? null);
  const btn = (
    <button
      ref={btnRef}
      type="button"
      className={"ns-tt-rtpick" + (cur ? "" : " is-off")}
      aria-haspopup={past ? undefined : "menu"}
      aria-expanded={past ? undefined : open}
      disabled={past || busy}
      title={past ? RT_UI.pastWhy : undefined}
      onClick={() => (open ? close() : setOpen(true))}
    >
      <small>{RT_UI.pickWord}</small>
      <span className="ns-tt-rtpick-name">{label}</span>
      <span className="car" aria-hidden="true" />
    </button>
  );

  return (
    <>
      {btn}
      {open && desk && (
        <PopMenu
          anchor={btnRef.current}
          overline={head}
          label={RT_UI.menuLabel}
          items={items.map(
            (it): PopMenuItem => ({
              key: it.key,
              label: it.label,
              cut: it.cut,
              disabled: it.disabled,
              onSelect: () => {
                // PopMenu 點了一項就收卡；「換成別套…」／返回要留著 ⇒ 下一格再打開
                it.onSelect();
                if (it.keep) window.setTimeout(() => setOpen(true), 0);
                else setLevel("root");
              },
            }),
          )}
          onClose={close}
        />
      )}
      {open && !desk && (
        <MSheet list title={head} ariaLabel={RT_UI.menuLabel} onClose={close}>
          {items.map((it) => (
            <MSheetItem
              key={it.key}
              cut={it.cut}
              disabled={it.disabled}
              onClick={() => {
                if (it.keep) {
                  it.onSelect();
                  return;
                }
                close();
                it.onSelect();
              }}
            >
              {it.label}
            </MSheetItem>
          ))}
        </MSheet>
      )}
    </>
  );
}
