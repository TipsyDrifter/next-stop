/**
 * waitroomParts——候車室兩殼共用的小件（壬 D-主-514、D-主-518～520；視覺＝prototypes/壬-候車室-對照.html 3A）。
 *
 * 種類是資料列（wr_kinds，D-主-519）：store.wishKinds（position 順序＝番線號，顯示 1 起算）；願望的 kind_id 指向它。
 * - `useKinds`：種類清單＋id 查表＋「這件的實現動作」（wishActionOf：種類查不到時開票）。
 * - `WaitroomStats`：頁首「等車 N 件 ・ 想買合計約 X」（合計只算動作＝記一筆的種類；有沒估價的補「（N 件沒估）」；全都沒估不寫合計；
 *   0 件寫「還沒有等車的事」）。桌機放 PageHeader stats、手機放頁首一行。
 * - `KindChips`：種類籤「全部｜種類…」帶件數（wantByKind；0 件照畫、淡一點）；單選、共用 `.chip.ns-chip`（§2.5 選項 chip）。
 * - `PlatformLabel`：篩到某個種類時清單上方那行「N番線・種類名」（D-主-518；「全部」不分段）。
 * - `KindMark`：列首種類小章（圓圈＝種類名第一個字）。色：起手五列照 D-主-514（買＝朱、去＝靛、學＝赭、做／讀看＝墨）；
 *   自己加的種類看動作（記一筆＝朱、開路線＝靛、其他＝墨）。
 * - `RealizedNote`：實現了那一列右側「11/2 記了一筆 4,280」「開了路線」「開了車票」「寫了日記」「記了時間」。
 * - `useShown`：籤篩過的清單＋「在篩過的清單裡上下移」換算成整份清單的位置（moveWishTo 吃整份等候清單的第 k 個）。
 * - `useRealizeDraft`：開票／開路線／寫日記／記時間的小表單草稿（兩殼共用；桌機畫在列下、手機畫在 MSheet）。
 */
import { useEffect, useMemo, useState } from "react";
import { useTicketStore } from "../../store/ticketStore";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { MAIN_CURRENCY, moneyText, type WishRow } from "../../domain/ticket";
import { WR_KIND_BUY_ID, WR_KIND_SEEDS, wishActionOf, type RealizedWish, type WishAction, type WishKindById, type WishKindRow } from "../../domain/ticketAids";
import { shortDay } from "../../domain/ticketView";
import { clockInstant, dayKeyOf, dayWindow, todayKey } from "../../lib/date";
import type { NodeRow } from "../../domain/node";
import type { TimeCategoryRow } from "../../domain/timetable";
import { timetableRepo } from "../../data/timetableRepository";
import { useTimetableStore } from "../../store/timetableStore";
import { realizeAsDiary, realizeAsRoute, realizeAsTicket, realizeAsTime } from "./waitroomActs";

/** 籤：全部＋種類 id */
export type WaitFilter = "all" | string;

/** 主幣別的小數位（願望金額一律主幣別） */
export function useMainDec(): number {
  return useTicketStore((s) => s.curByCode[MAIN_CURRENCY]?.decimals ?? 2);
}

export function useKinds() {
  const kinds = useTicketStore((s) => s.wishKinds);
  const kindById = useMemo(() => {
    const m: Record<string, WishKindRow | undefined> = {};
    for (const k of kinds) m[k.id] = k;
    return m as WishKindById;
  }, [kinds]);
  const actionOf = (w: Pick<WishRow, "kind_id">): WishAction => wishActionOf(w, kindById);
  return { kinds, kindById, actionOf };
}

/** 新增列的預設種類：篩著某個種類＝它；全部＝「買」那一列（被刪了就第一條番線） */
export function useDefaultKindId(filter: WaitFilter): string | null {
  const { kinds, kindById } = useKinds();
  if (filter !== "all" && kindById[filter]) return filter;
  return kindById[WR_KIND_BUY_ID] ? WR_KIND_BUY_ID : (kinds[0]?.id ?? null);
}

/** 番線號（1 起算；查不到＝0） */
export function platformNo(kinds: readonly WishKindRow[], id: string): number {
  return kinds.findIndex((k) => k.id === id) + 1;
}

export function WaitroomStats() {
  const wish = useTicketStore((s) => s.wish);
  const { actionOf } = useKinds();
  const dec = useMainDec();
  const n = wish.want.length;
  if (n === 0) return <>還沒有等車的事</>;
  const priced = wish.want.filter((w) => actionOf(w) === "entry").length - wish.unpriced;
  return (
    <>
      等車 <b>{n}</b> 件
      {priced > 0 && (
        <>
          {" "}・ 想買合計約 <b>{moneyText(wish.wantTotal, dec, { whole: true })}</b>
        </>
      )}
      {wish.unpriced > 0 && priced > 0 && <span className="ns-wr-unpriced">（{wish.unpriced} 件沒估）</span>}
    </>
  );
}

export function KindChips({ value, onChange }: { value: WaitFilter; onChange(f: WaitFilter): void }) {
  const wish = useTicketStore((s) => s.wish);
  const { kinds } = useKinds();
  const chip = (id: WaitFilter, label: string, n: number) => {
    const on = value === id;
    return (
      <button
        key={id}
        type="button"
        className={"chip ns-chip" + (on ? " is-on" : "") + (n === 0 && !on ? " is-zero" : "")}
        aria-pressed={on}
        onClick={() => onChange(id)}
      >
        {label}
        <span className="n">{n}</span>
      </button>
    );
  };
  return (
    <div className="ns-wr-chips" role="group" aria-label="種類">
      {chip("all", "全部", wish.want.length)}
      {kinds.map((k) => chip(k.id, k.name, wish.wantByKind[k.id] ?? 0))}
    </div>
  );
}

/** 篩到某個種類時清單上方的小標「N番線・種類名」 */
export function PlatformLabel({ filter }: { filter: WaitFilter }) {
  const { kinds, kindById } = useKinds();
  if (filter === "all") return null;
  const k = kindById[filter];
  if (!k) return null;
  return (
    <p className="ns-wr-platform">
      <span className="no">{platformNo(kinds, k.id)}番線</span>
      <span className="nm">{k.name}</span>
    </p>
  );
}

/** 起手五列的章色（D-主-514）；其他看動作 */
const SEED_TONE: Readonly<Record<string, string>> = {
  [WR_KIND_SEEDS[0].id]: "seal",
  [WR_KIND_SEEDS[2].id]: "accent",
  [WR_KIND_SEEDS[4].id]: "late",
};
function kindTone(k: WishKindRow | undefined): string {
  if (!k) return "ink";
  return SEED_TONE[k.id] ?? (k.action === "entry" ? "seal" : k.action === "route" ? "accent" : "ink");
}

export function KindMark({ kind }: { kind: WishKindRow | undefined }) {
  const name = kind?.name ?? "";
  return (
    <span className={`ns-wr-kind is-${kindTone(kind)}`} title={name || "沒有種類"} aria-label={name || "沒有種類"}>
      {Array.from(name)[0] ?? "・"}
    </span>
  );
}

/** 實現了那一列的右側字 */
export function RealizedNote({ r, dec }: { r: RealizedWish; dec: number }) {
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  if (r.entry)
    return (
      <>
        {shortDay(r.entry.occurred_on)} <b>記了一筆 {moneyText(r.entry.main_minor, dec)}</b>
      </>
    );
  const when = r.wish.bought_at ? shortDay(dayKeyOf(r.wish.bought_at, dayStartHour)) : "";
  const k = r.target?.kind;
  const what = k === "route" ? "開了路線" : k === "note" ? "寫了日記" : k === "block" ? "記了時間" : "開了車票";
  return (
    <>
      {when} <b>{what}</b>
    </>
  );
}

/** 「實現了」那一段的名稱按鈕要給讀屏的話 */
export function realizedAria(r: RealizedWish): string {
  if (r.entry) return `看「${r.wish.name}」那一筆帳`;
  const k = r.target?.kind;
  const what = k === "route" ? "開的路線" : k === "note" ? "寫的日記" : k === "block" ? "記的時間" : "開的車票";
  return `看「${r.wish.name}」${what}`;
}
export function realizedTitle(r: RealizedWish): string {
  if (r.entry) return "看這一筆帳";
  const k = r.target?.kind;
  return k === "route" ? "看這條路線" : k === "note" ? "看這篇日記" : k === "block" ? "看這段時間" : "看這張票";
}

/**
 * 籤篩過的清單。上下移：搬到篩過清單裡鄰居的位置（換算成整份等候清單的第 k 個）——
 * 往上＝鄰居現在的位置（自己在後面，拿掉自己不影響它）；往下＝鄰居現在的位置（拿掉自己後它前移一格，自己落在它後面）。
 */
export function useShown(filter: WaitFilter) {
  const want = useTicketStore((s) => s.wish.want);
  const shown = useMemo(() => (filter === "all" ? want : want.filter((w) => w.kind_id === filter)), [want, filter]);
  const move = (id: string, dir: -1 | 1) => {
    const all = useTicketStore.getState().wish.want;
    const list = filter === "all" ? all : all.filter((w) => w.kind_id === filter);
    const i = list.findIndex((w) => w.id === id);
    const to = list[i + dir];
    if (i < 0 || !to) return;
    const at = all.findIndex((w) => w.id === to.id);
    if (at >= 0) void useTicketStore.getState().moveWishTo(id, at);
  };
  return { want, shown, move };
}

/** 時刻表的子分類（記時間要選；封存、刪掉的不列）——store 還沒載就自己讀一次 */
export function useTimeCategories(): { groups: { group: TimeCategoryRow; items: TimeCategoryRow[] }[]; first: string | null } {
  const ready = useTimetableStore((s) => s.ready);
  const storeCats = useTimetableStore((s) => s.categories);
  const [own, setOwn] = useState<TimeCategoryRow[] | null>(null);
  useEffect(() => {
    if (ready) return;
    let alive = true;
    void timetableRepo.listCategories().then(
      (rows) => alive && setOwn(rows),
      () => alive && setOwn([]),
    );
    return () => {
      alive = false;
    };
  }, [ready]);
  const cats = ready ? storeCats : (own ?? []);
  return useMemo(() => {
    const live = cats.filter((c) => c.deleted_at === null && c.archived_at === null);
    const byPos = (a: TimeCategoryRow, b: TimeCategoryRow) => a.position - b.position;
    const groups = live
      .filter((c) => c.parent_id === null)
      .sort(byPos)
      .map((g) => ({ group: g, items: live.filter((c) => c.parent_id === g.id).sort(byPos) }))
      .filter((g) => g.items.length > 0);
    return { groups, first: groups[0]?.items[0]?.id ?? null };
  }, [cats]);
}

/** 記時間的預設起訖：今天＝結束對齊到 5 分、往前 30 分（不早於日界線）；別天＝09:00 起一小時 */
function defaultSpan(day: string, dayStartHour: number): { start: number; end: number } {
  const win = dayWindow(day, dayStartHour);
  const lo = Date.parse(win.start);
  if (day === todayKey(dayStartHour)) {
    const end = Math.floor(Date.now() / 300_000) * 300_000;
    return { start: Math.max(lo, end - 30 * 60_000), end: Math.max(end, lo + 5 * 60_000) };
  }
  const start = clockInstant(day, "09:00") ?? lo;
  return { start, end: start + 60 * 60_000 };
}

/** 實現小表單的草稿（願望名預填；路線清單只列還在跑的，幹線同） */
export function useRealizeDraft(w: WishRow, action: Exclude<WishAction, "entry">, onDone: () => void) {
  const liveRoutes = useNodeStore((s) => s.liveRoutes);
  const liveLines = useNodeStore((s) => s.liveLines);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const today = todayKey(dayStartHour);
  const timeCats = useTimeCategories();
  const [name, setName] = useState(w.name);
  const [routeId, setRouteId] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(action === "diary" || action === "time" ? today : null);
  const [lineId, setLineId] = useState<string | null>(null);
  const [catId, setCatId] = useState<string | null>(null);
  const [span, setSpan] = useState(() => defaultSpan(today, dayStartHour));
  const [busy, setBusy] = useState(false);
  // 選的路線／幹線／分類被收起或刪了（同步）⇒ 落回預設
  const route: NodeRow | null = routeId ? (liveRoutes.find((r) => r.id === routeId) ?? null) : null;
  const line: NodeRow | null = liveLines.find((l) => l.id === lineId) ?? liveLines[0] ?? null;
  const cat = catId && timeCats.groups.some((g) => g.items.some((c) => c.id === catId)) ? catId : timeCats.first;
  const pickDay = (d: string | null) => {
    if (action === "time" && d) setSpan(defaultSpan(d, dayStartHour));
    setDay(d);
  };
  const win = day ? dayWindow(day, dayStartHour) : null;
  const lo = win ? Date.parse(win.start) : 0;
  const hi = win ? Math.min(Date.parse(win.end), Date.now()) : 0;
  const blocked =
    action === "route" ? (line === null ? "noLine" : null) : action === "time" ? (cat === null ? "noCat" : !(span.start < span.end) ? "badSpan" : null) : null;
  const can = !busy && name.trim() !== "" && blocked === null && ((action !== "diary" && action !== "time") || day !== null);
  const submit = async () => {
    if (!can) return;
    setBusy(true);
    try {
      let ok = false;
      if (action === "route") ok = await realizeAsRoute(w, { name, lineId: (line as NodeRow).id });
      else if (action === "ticket") ok = await realizeAsTicket(w, { name, routeId: route?.id ?? null, day });
      else if (action === "diary") ok = await realizeAsDiary(w, { body: name, day: day as string });
      else ok = await realizeAsTime(w, { categoryId: cat as string, startMs: span.start, endMs: span.end, note: name });
      if (ok) onDone();
    } finally {
      setBusy(false);
    }
  };
  return {
    action,
    name,
    setName,
    routeId: route?.id ?? null,
    setRouteId,
    day,
    setDay: pickDay,
    today,
    lineId: line?.id ?? null,
    setLineId,
    liveRoutes,
    liveLines,
    catId: cat,
    setCatId,
    timeCats,
    span,
    setStart: (ms: number) => setSpan((s) => ({ start: ms, end: Math.max(s.end, ms) })),
    setEnd: (ms: number) => setSpan((s) => ({ start: s.start, end: ms })),
    lo,
    hi,
    blocked,
    can,
    busy,
    submit,
  };
}
export type RealizeDraft = ReturnType<typeof useRealizeDraft>;

/** 小表單的標題與送出鈕字 */
export const REALIZE_TEXT: Readonly<Record<Exclude<WishAction, "entry">, { title: string; field: string; submit: string }>> = {
  ticket: { title: "開票", field: "票名", submit: "開票" },
  route: { title: "開路線", field: "路線名", submit: "開路線" },
  diary: { title: "寫日記", field: "內文", submit: "寫進日記" },
  time: { title: "記時間", field: "備註", submit: "記下來" },
};

/** 擋下送出的原因（給一句話） */
export const BLOCKED_TEXT: Readonly<Record<string, string>> = {
  noLine: "還沒有幹線，先到路線圖開一條",
  noCat: "時刻表還沒有分類，先到時刻表加一個",
  badSpan: "結束要晚於開始",
};
