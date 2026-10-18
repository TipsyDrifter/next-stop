/**
 * NavBadge——全 App 的運行中標記（①b①c 契約 §5.8；乙席）：書封 `.gnav-line` 與手機 tab 那一格的分類小圓牌，
 * 桌機 tooltip 的「・創作 14:35 発」由 `timetableNavHint()` 給（純函式、不訂閱；Sidebar 在 hover／focus 時才叫）。
 *
 * 插槽（`LineMount.navBadge`／`navHint`，契約 0-1）由整合席另做；填值在 `timetable.mount.tsx`。
 *
 *   span.ns-tt-navbadge.is-{desktop|mobile}[.is-long][.is-out] > CategoryBadge sm（尺寸、實心、赭圈由 §B 決定；＝原型 `.ve-nb`）
 *
 * - 停車中不畫（回 null）；`.is-long`＝這一班「待確認」（blockMarker：預估 → 分類預設 → 保險上限）。
 * - 到着：不直接拿掉——留著最後那一班、掛 `.is-out` 縮小淡出（＝原型 `.ve-nb.is-out`），`OUT_MS` 後才 unmount。
 *   淡出途中又發車 ⇒ 換成新那班（key 變 ⇒ 重播彈出），淡出取消。
 * - useNow(60_000)：只有「待確認」外圈會隨時間變，分鐘級就夠。key＝那一班的 id ⇒ 換車時重播一次彈出動畫。
 * - 兩殼的書封／tab 都在 store init 之後才有資料（桌機 TimetableDesktopAgent、手機 TimetableMobileAgent 開 App 就 init）。
 *
 * 車次②（② 契約 §5.9、0-13；乙席）：`timetableNavHint()`＝「{分類・任務名} HH:MM 発」，任務名截到 16 字（clipLabel）。
 */
import { useEffect, useState } from "react";
import { fmtClock, msOf, type TimeBlockRow } from "../../domain/timetable";
import { clipLabel, linkLabelOf, runLabel } from "../../domain/timetableLink";
import { blockMarker, useTimetableStore } from "../../store/timetableStore";
import { CategoryBadge } from "./CategoryBadge";
import { useNow } from "./useNow";
import "./timetable.css";

/** 到着時縮小淡出的時間（＝timetable.css §B `ns-tt-nb-out` 的 .2s，多留 20ms 讓最後一格畫完；＝原型 shrinkNav 的 220ms） */
const OUT_MS = 220;

export function NavBadge({ shell }: { shell: "desktop" | "mobile" }) {
  const running = useTimetableStore((s) => s.running);
  const catById = useTimetableStore((s) => s.catById);
  const longRunMaxMin = useTimetableStore((s) => s.longRunMaxMin);
  const linkInfo = useTimetableStore((s) => s.linkInfo);
  const now = useNow(60_000);
  // 最後畫出來的那一班（到着後還要留著淡出）；render 中比對上一輪（React「記住上一次 render 的資訊」寫法，不多一輪 effect）
  const [shown, setShown] = useState<TimeBlockRow | null>(running);
  const [out, setOut] = useState(false);
  if (running && running !== shown) {
    setShown(running);
    if (out) setOut(false);
  } else if (!running && shown && !out) {
    setOut(true);
  }
  useEffect(() => {
    if (!out) return;
    const t = setTimeout(() => {
      setShown(null);
      setOut(false);
    }, OUT_MS);
    return () => clearTimeout(t);
  }, [out]);

  const b = running ?? shown;
  if (!b) return null;
  const leaving = !running;
  const m = blockMarker(b, catById, longRunMaxMin, now, linkInfo);
  const pending = m.kind !== "none" && m.pending;
  return (
    <span
      key={b.id}
      className={"ns-tt-navbadge is-" + shell + (pending ? " is-long" : "") + (leaving ? " is-out" : "")}
      aria-hidden="true"
    >
      <CategoryBadge cat={catById[b.category_id] ?? null} size="sm" />
    </span>
  );
}

/** 桌機 tooltip 的尾巴（Sidebar 組字：原 title＋「・」＋這個）：純函式、不訂閱，hover／focus 當下才叫 */
export function timetableNavHint(): string | null {
  const { running, catById, linkInfo } = useTimetableStore.getState();
  if (!running) return null;
  const label = linkLabelOf(running, linkInfo);
  const name = runLabel(catById[running.category_id]?.name ?? "？", label === null ? null : clipLabel(label));
  return `${name} ${fmtClock(msOf(running.started_at))} 発`;
}
