/**
 * 寫方針（戊 D-主-261；方針擴充 辛 §7；原型場景 a-edit）。store 的 `editor` 不是 null 就畫；桌機 DialogShell M 520、手機 MSheet full。吃任何期間鍵。
 *
 * 一次存檔（取消＝不寫）。上方 ‹ 期 › 換期（有沒存的改動時不換、toast 說；車站沒有 ‹ ›，改寫站名）；最多五列輸入（兩台合起來已經超過的照實列出）、
 * 每列「＋ 掛路線」chip（D-主-255 起只有路線；D-主-281 起也能掛路線裡的支線）與刪除；下段「上週沒済的」（字隨期間）每句一顆「帶到這週」，帶了變「已帶到這週」、
 * 新那句輸入框尾寫「上週帶來」。回顧頁腳開的時候，沒済的已經帶進草稿（`preCarry`）。
 * 寫下層看得到上一層（D-主-375）：週框列本月、月框列今年，只讀，一句一顆「帶進來」；沿用帶過來那條路（carried_from＋決定性 id），不存上下層關聯。
 * 框可能開很久，期間同步會進來：`base` 記著起草稿當下的列，存檔時跟現況比（別處刪的不復活、別處新寫的不被刪，`planSaveWeek`），撞到了 toast 說。
 * 鍵盤：輸入框 Enter＝下一列（最後一列＝存檔）；Esc 由殼關（AttachPicker 開著時它自己吃）。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  MAX_AIMS,
  adjacentKey,
  aimLimitMessage,
  aimNumeral,
  carryCandidates,
  normalizeAimText,
  periodNavText,
  periodOfKey,
  periodOverline,
  periodShortLabel,
  periodStepText,
  periodTitle,
  stationHeadText,
  stationIdOfKey,
  upperKeyOf,
  type AimDraft,
  type WeekAimRow,
} from "../../domain/weekAims";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { useWeekAimStore } from "../../store/weekAimStore";
import { DialogShell } from "../common/DialogShell";
import { MSheet } from "../common/MSheet";
import { AttachPicker } from "../common/AttachPicker";
import { MobileAttachPicker } from "../common/MobileAttachPicker";
import { IconBack, IconChevron, IconClose, IconPlus } from "../common/icons";
import { useShell } from "../mobile/useShell";
import { nodeRepo } from "../../data";
import type { AttachTarget } from "../../domain/notes";
import { IconCheckMini, RouteMark, RouteTag, aimPlaceName, aimPlacePath, useAimPlaceOf } from "./parts";

const EMPTY: WeekAimRow[] = [];

function draftsOf(aims: readonly WeekAimRow[]): AimDraft[] {
  return aims.map((a) => ({ id: a.id, text: a.text, nodeId: a.node_id, carriedFrom: a.carried_from }));
}

function sameDrafts(a: readonly AimDraft[], b: readonly AimDraft[]): boolean {
  const norm = (d: readonly AimDraft[]) =>
    JSON.stringify(d.filter((x) => normalizeAimText(x.text) !== "").map((x) => [x.id, normalizeAimText(x.text), x.nodeId]));
  return norm(a) === norm(b);
}

/** 掛著的 host，照掛上的先後排：只有排第一的那個畫（同頁可能有告示又有車站小卡，寫方針框任何時候只能有一個） */
const hostQueue: object[] = [];
const hostListeners = new Set<() => void>();

function useIsFirstHost(): boolean {
  const [me] = useState(() => ({}));
  useLayoutEffect(() => {
    hostQueue.push(me);
    hostListeners.forEach((fn) => fn());
    return () => {
      hostQueue.splice(hostQueue.indexOf(me), 1);
      hostListeners.forEach((fn) => fn());
    };
  }, [me]);
  return useSyncExternalStore(
    (fn) => {
      hostListeners.add(fn);
      return () => hostListeners.delete(fn);
    },
    () => hostQueue[0] === me,
  );
}

/**
 * 掛在帶子裡、畫到 body（帶子是 z-index 疊放脈絡，fixed 的對話框困在裡面會被別的東西壓住）。
 * portal 的 React 事件仍會冒到頁面（今日頁的鍵盤表）：Esc 以外的鍵在這裡截住——Esc 要留給殼掛在 window 的關窗。
 * 要用的地方自己掛一個就好（告示、手機一行、車站小卡），同頁掛幾個都只有排第一的那個畫。
 */
export function WeekAimsEditorHost({ today, weekStart }: { today: string; weekStart: 0 | 1 }) {
  const editor = useWeekAimStore((s) => s.editor);
  const first = useIsFirstHost();
  // 框開著時車站被刪（同步收到刪除）：小卡的 host 先卸載，editor 還留在 store，下一個 host 不能冒出沒站名的框（§3 #16）
  const stationId = editor ? stationIdOfKey(editor.weekOn) : null;
  const stationGone = useNodeStore((s) => stationId !== null && !s.stations.some((x) => x.id === stationId));
  useEffect(() => {
    if (stationGone) useWeekAimStore.getState().closeEditor();
  }, [stationGone]);
  if (!editor || !first || stationGone) return null;
  return createPortal(
    <div
      className="wa-ed-host"
      onKeyDown={(e) => {
        if (e.key !== "Escape") e.stopPropagation();
      }}
    >
      <WeekAimsEditor key={editor.weekOn} aimKey={editor.weekOn} preCarry={editor.preCarry} today={today} weekStart={weekStart} />
    </div>,
    document.body,
  );
}

function WeekAimsEditor({
  aimKey: initialKey,
  preCarry,
  today,
  weekStart,
}: {
  aimKey: string;
  preCarry: readonly WeekAimRow[];
  today: string;
  weekStart: 0 | 1;
}) {
  const mobile = useShell() === "mobile";
  const [aimKey, setAimKey] = useState(initialKey);
  const isStation = periodOfKey(aimKey) === "station";
  const prevKey = isStation ? null : adjacentKey(aimKey, -1);
  const upperKey = upperKeyOf(aimKey, today);
  const aims = useWeekAimStore((s) => s.weeks[aimKey]);
  const prevAims = useWeekAimStore((s) => (prevKey ? s.weeks[prevKey] : undefined)) ?? EMPTY;
  const upperAims = useWeekAimStore((s) => (upperKey ? s.weeks[upperKey] : undefined)) ?? EMPTY;
  const stationId = stationIdOfKey(aimKey);
  const station = useNodeStore((s) => (stationId ? (s.stations.find((x) => x.id === stationId) ?? null) : null));
  const placeOf = useAimPlaceOf();
  /** 挑選器的目前值：掛路線＝路線本身那一列；掛支線＝那條支線 */
  const pickValue = (nodeId: string | null): AttachTarget => {
    const p = placeOf(nodeId);
    if (!p) return { routeId: null, nodeId: null, nodeKind: null };
    return p.node.id === p.route.id
      ? { routeId: p.route.id, nodeId: null, nodeKind: "route" }
      : { routeId: p.route.id, nodeId: p.node.id, nodeKind: "branch" };
  };
  /** 挑到了：支線先讀一次記進 store（chip 馬上有名字），再寫進草稿 */
  const pick = async (i: number, t: AttachTarget) => {
    setPicking(null);
    if (t.nodeId) {
      const n = await nodeRepo.getNode(t.nodeId).catch(() => null);
      if (n) useWeekAimStore.getState().rememberAimNodes([n]);
      patch(i, { nodeId: t.nodeId });
    } else patch(i, { nodeId: t.routeId });
  };

  const [drafts, setDrafts] = useState<AimDraft[] | null>(null);
  const [base, setBase] = useState<AimDraft[]>([]);
  const [picking, setPicking] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const pendingCarry = useRef<readonly WeekAimRow[]>(preCarry);
  const inputs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    void useWeekAimStore.getState().loadWeek(aimKey);
  }, [aimKey]);
  useEffect(() => {
    if (upperKey) void useWeekAimStore.getState().loadWeek(upperKey);
  }, [upperKey]);

  // 那一期載到了才起草稿（換期＝重起）；回顧頁腳帶來的那幾句在第一次起草稿時接在後面
  useEffect(() => {
    if (aims === undefined || drafts !== null) return;
    const start = draftsOf(aims);
    setBase(start);
    const carry = pendingCarry.current;
    pendingCarry.current = [];
    if (!carry.length) {
      setDrafts(start);
      return;
    }
    void (async () => {
      const st = useWeekAimStore.getState();
      const have = new Set(start.map((d) => d.carriedFrom).filter(Boolean));
      const add: AimDraft[] = [];
      for (const src of carry) {
        if (have.has(src.id) || start.length + add.length >= MAX_AIMS) continue;
        add.push(await st.carryDraft(src, aimKey));
      }
      setDrafts([...start, ...add]);
    })();
  }, [aims, drafts, aimKey]);

  const rows = drafts ?? [];
  const dirty = drafts !== null && !sameDrafts(drafts, base);
  const rel = periodTitle(aimKey, today, weekStart).rel;
  const prevRel = prevKey ? periodTitle(prevKey, today, weekStart).rel : "";
  const upperTitle = upperKey ? periodTitle(upperKey, today, weekStart).title : "";
  const upperLabel = upperKey ? periodShortLabel(upperKey, today, weekStart) : "";
  const candidates = useMemo(() => carryCandidates(prevAims), [prevAims]);
  const carried = new Set(rows.map((d) => d.carriedFrom).filter(Boolean) as string[]);
  const full = rows.filter((d) => normalizeAimText(d.text) !== "").length >= MAX_AIMS;

  const close = () => useWeekAimStore.getState().closeEditor();
  const save = async () => {
    if (!drafts || saving) return;
    setSaving(true);
    const ok = await useWeekAimStore.getState().saveWeek(aimKey, drafts, base);
    setSaving(false);
    if (ok) close();
  };
  const step = periodStepText(aimKey);
  const shiftPeriod = (dir: -1 | 1) => {
    if (dirty) {
      useUiStore.getState().showToast({ message: `先存檔或取消，再換${step.unit}` });
      return;
    }
    setDrafts(null);
    setPicking(null);
    setAimKey(adjacentKey(aimKey, dir));
  };
  const patch = (i: number, p: Partial<AimDraft>) =>
    setDrafts((cur) => {
      const next = [...(cur ?? [])];
      if (i >= next.length) next.push({ id: null, text: "", nodeId: null, carriedFrom: null, ...p });
      else next[i] = { ...next[i], ...p };
      return next;
    });
  const remove = (i: number) => setDrafts((cur) => (cur ?? []).filter((_, j) => j !== i));
  const carry = async (src: WeekAimRow) => {
    if (full) {
      useUiStore.getState().showToast({ message: aimLimitMessage(aimKey) });
      return;
    }
    const d = await useWeekAimStore.getState().carryDraft(src, aimKey);
    setDrafts((cur) => {
      const list = (cur ?? []).filter((x) => normalizeAimText(x.text) !== "" || x.id !== null);
      return list.some((x) => x.carriedFrom === src.id) ? list : [...list, d];
    });
  };

  /** 輸入框尾的「…帶來」：上一期、上一層；車站帶來的來源不在這裡，一律「上一站」 */
  const carryFrom = (id: string | null): string | null => {
    if (id === null) return null;
    if (prevAims.some((a) => a.id === id)) return prevRel;
    if (upperAims.some((a) => a.id === id)) return upperLabel;
    return isStation ? "上一站" : null;
  };

  /** 畫的列：草稿＋（沒滿就）一列空白 */
  const shown: AimDraft[] = rows.length < MAX_AIMS ? [...rows, { id: null, text: "", nodeId: null, carriedFrom: null }] : rows;
  const onEnter = (i: number) => {
    const nextEl = inputs.current[i + 1];
    if (nextEl) nextEl.focus();
    else void save();
  };

  const body = (
    <>
      <div className="wa-ed-week">
        {isStation ? (
          <span className="t is-station">{stationHeadText(station)}</span>
        ) : (
          <>
            <button type="button" className="ns-iconbtn" aria-label={step.prev} title={step.prev} onClick={() => shiftPeriod(-1)}>
              <IconBack />
            </button>
            <span className="t">{periodNavText(aimKey)}</span>
            <button type="button" className="ns-iconbtn" aria-label={step.next} title={step.next} onClick={() => shiftPeriod(1)}>
              <IconChevron />
            </button>
          </>
        )}
      </div>
      {drafts === null ? (
        <p className="wa-ed-cap">載入中…</p>
      ) : (
        <ol className="wa-ed-list">
          {shown.map((d, i) => {
            const place = placeOf(d.nodeId);
            const from = carryFrom(d.carriedFrom);
            return (
              <li key={d.id ?? `new-${i}`} className="wa-ed-row">
                <span className="wa-num" aria-hidden>
                  {aimNumeral(i)}
                </span>
                <span className="inp">
                  <input
                    ref={(el) => {
                      inputs.current[i] = el;
                    }}
                    className="techo-input"
                    value={d.text}
                    placeholder={i === 0 ? `${rel}大致要完成的事` : "再一句（可不寫）"}
                    aria-label={`第${aimNumeral(i).replace("、", "")}句`}
                    maxLength={80}
                    autoFocus={i === 0 && !mobile}
                    onChange={(e) => patch(i, { text: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                      if (e.key === "Enter") {
                        e.preventDefault();
                        onEnter(i);
                      }
                    }}
                  />
                  {from && <span className="carry">{from}帶來</span>}
                </span>
                {place ? (
                  <button
                    type="button"
                    className={"chip ns-chip wa-chip" + (picking === i ? " is-open" : "")}
                    title={`掛在「${aimPlacePath(place)}」——換一個地方`}
                    aria-haspopup="dialog"
                    aria-expanded={picking === i}
                    onClick={() => setPicking(picking === i ? null : i)}
                  >
                    <RouteMark route={place.route} />
                    <span className="nm">{aimPlaceName(place)}</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    className={"chip ns-chip wa-chip is-empty" + (picking === i ? " is-open" : "")}
                    aria-haspopup="dialog"
                    aria-expanded={picking === i}
                    onClick={() => setPicking(picking === i ? null : i)}
                  >
                    <IconPlus size={12} />
                    掛路線
                  </button>
                )}
                {i < rows.length ? (
                  <button type="button" className="ns-iconbtn" aria-label="刪掉這句" title="刪掉這句" onClick={() => remove(i)}>
                    <IconClose />
                  </button>
                ) : (
                  <span />
                )}
                {picking === i && !mobile && (
                  <AttachPicker
                    depth="node"
                    kinds={["branch"]}
                    routeSelectable
                    float
                    label="掛到哪條路線或支線"
                    value={pickValue(d.nodeId)}
                    onPick={(t) => void pick(i, t)}
                    onClear={() => {
                      setPicking(null);
                      patch(i, { nodeId: null });
                    }}
                    clearLabel="不掛路線"
                    onClose={() => setPicking(null)}
                  />
                )}
              </li>
            );
          })}
        </ol>
      )}
      <p className="wa-ed-cap">最多 {MAX_AIMS} 句</p>
      {candidates.length > 0 && (
        <div className="wa-ed-sec">
          <h4>{prevRel}沒済的</h4>
          {candidates.map((c) => {
            const place = placeOf(c.node_id);
            const done = carried.has(c.id);
            return (
              <div key={c.id} className={"wa-ed-carry" + (done ? " is-carried" : "")}>
                <span className="t">{c.text}</span>
                {place && <RouteTag place={place} shell={mobile ? "mobile" : "desktop"} onGo={close} />}
                {done ? (
                  <span className="done">
                    <IconCheckMini />
                    已帶到{rel}
                  </span>
                ) : (
                  <button type="button" className="ns-btn btn-ghost ns-btn--sm" disabled={drafts === null} onClick={() => void carry(c)}>
                    帶到{rel}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {upperAims.length > 0 && (
        <div className="wa-ed-sec">
          <h4>{upperTitle}</h4>
          {upperAims.map((c) => {
            const place = placeOf(c.node_id);
            const done = carried.has(c.id);
            return (
              <div key={c.id} className={"wa-ed-carry" + (done ? " is-carried" : "")}>
                <span className="t">{c.text}</span>
                {place && <RouteTag place={place} shell={mobile ? "mobile" : "desktop"} onGo={close} />}
                {done ? (
                  <span className="done">
                    <IconCheckMini />
                    已帶進來
                  </span>
                ) : c.done_at !== null ? (
                  <span className="done">已済</span>
                ) : (
                  <button type="button" className="ns-btn btn-ghost ns-btn--sm" disabled={drafts === null} onClick={() => void carry(c)}>
                    帶進來
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {mobile && picking !== null && (
        <MobileAttachPicker
          title="掛到哪條路線或支線"
          depth="node"
          kinds={["branch"]}
          routeSelectable
          backKind="dialog"
          value={pickValue(shown[picking]?.nodeId ?? null)}
          onPick={(t) => void pick(picking, t)}
          onClear={() => {
            const i = picking;
            setPicking(null);
            patch(i, { nodeId: null });
          }}
          clearLabel="不掛路線"
          onClose={() => setPicking(null)}
        />
      )}
    </>
  );

  const foot = (
    <>
      <button type="button" className="ns-btn btn-ghost" onClick={close}>
        取消
      </button>
      <button type="button" className="ns-btn btn-seal" disabled={drafts === null || saving} onClick={() => void save()}>
        存檔
      </button>
    </>
  );
  const title = `${rel}的方針`;
  const overline = periodOverline(aimKey);

  if (mobile) {
    return (
      <MSheet title={title} overline={overline.zh} height="full" onClose={close} foot={foot} className="wa-ms">
        {body}
      </MSheet>
    );
  }
  return (
    <DialogShell title={title} overline={overline} size="M" onClose={close} foot={foot}>
      {body}
    </DialogShell>
  );
}
