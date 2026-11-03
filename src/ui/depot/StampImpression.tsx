/**
 * StampImpression——一枚駅スタンプ（車庫與回顧 D-主-209；造形照原型 `prototypes/design-stats-review-車庫.html` 的 `stampInner`／`stampEl`）。
 *
 * viewBox 100 的 SVG，逐 kind 一種造形（原型 open／station／route／trunk／sumi／ledger／diary／hours 一一對應）：
 *   紀念章家族（金外圈）＝station 車站到着、route 路線到站、line 幹線到站、route_year 開業一年（原型沒畫，照同家族補一枚）
 *   日付印＝opening 開業（第一張票）
 *   済＝seals 第 N 枚済（**朱只給這一種**）
 *   累計章（珠狀外圈＋小圖樣）＝diary 日記累計、ledger_year 記帳滿一年、time_cat 時刻表分類累計
 * 墨色：seals＝朱（.is-seal）、其餘＝墨（.is-ink）＋金外圈（--arc）。朱肉：済且 ≥50px 用 #inkbleed，其餘 #inkbleed-fine
 *   （defs 由 `ensureStampDefs()` 掛；頁 mount 時呼叫）。
 * 旋轉（手蓋的自然歪斜，絕不 0°）：紀念章 +4～+6°、日付印 -4°、其他 -4～-9°；給 `index`＝照位置輪（相鄰錯開），沒給＝照 id 雜湊。
 * 可點（`onOpen`）＝role=button＋tabIndex＋Enter／Space；不可點＝role=img。title／aria-label＝`stampTitle(...)`。
 * `fresh`＝剛蓋下：stampIn 回彈（reduced-motion 關，CSS 處理）。
 */
import { useId, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { fmtMD } from "../../domain/depot";
import { stampTitle, type StampKind, type StampRow } from "../../domain/stamps";
import "./depot.css";

export interface StampImpressionProps {
  stamp: Pick<StampRow, "id" | "kind" | "label" | "value" | "stamped_on">;
  /** 外框邊長（px） */
  size: number;
  /** 車站章外弧寫「代碼・路線名」、路線章下弧寫代碼；查不到就省略 */
  routeCode?: string | null;
  routeName?: string | null;
  /** 路線章／幹線章／開業一年章的「開業 — 到站」 */
  openedOn?: string | null;
  /** 在一排裡的位置（旋轉照位置輪，相鄰錯開）；沒給＝照 id 雜湊 */
  index?: number;
  /** 可點＝開記錄簿 */
  onOpen?: () => void;
  /** 剛蓋下（stampIn 動畫） */
  fresh?: boolean;
  className?: string;
}

const MEMORIAL: readonly StampKind[] = ["station", "route", "line", "route_year"];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** 旋轉角（deg）：紀念章 +4～+6、日付印 -4、其他 -4～-9 */
export function stampRot(stamp: Pick<StampRow, "id" | "kind">, index?: number): number {
  const n = index ?? hash(stamp.id);
  if (MEMORIAL.includes(stamp.kind)) return [5, 4, 6][n % 3];
  if (stamp.kind === "opening") return -4;
  return [-8, -5, -7, -9, -6, -4][n % 6];
}

/** 原型 fitSize：字多就縮，最大 max */
const fit = (txt: string, max: number, room: number) => Math.min(max, +(room / Math.max(1, [...txt].length)).toFixed(2));
const dateFull = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return `${y}.${m}.${d}`;
};

/** 沿圓弧排字（上弧順時針、下弧逆時針；起點在左） */
function ArcText({ uid, k, txt, r, top, cls, size, ls }: { uid: string; k: string; txt: string; r: number; top: boolean; cls: string; size: number; ls: number }) {
  const id = `${uid}-${k}`;
  const d = top ? `M${50 - r} 50 A${r} ${r} 0 0 1 ${50 + r} 50` : `M${50 - r} 50 A${r} ${r} 0 0 0 ${50 + r} 50`;
  return (
    <>
      <defs>
        <path id={id} d={d} />
      </defs>
      <text className={cls} fontSize={size} letterSpacing={ls}>
        <textPath href={`#${id}`} startOffset="50%" textAnchor="middle">
          {txt}
        </textPath>
      </text>
    </>
  );
}

function inner(p: StampImpressionProps, uid: string): ReactNode {
  const s = p.stamp;
  const A = (k: string, txt: string, r: number, top: boolean, cls: string, size: number, ls: number) => (
    <ArcText uid={uid} k={k} txt={txt} r={r} top={top} cls={cls} size={size} ls={ls} />
  );
  const span = p.openedOn ? `${fmtMD(p.openedOn)} — ${fmtMD(s.stamped_on)}` : dateFull(s.stamped_on);
  switch (s.kind) {
    case "station": {
      const head = p.routeCode && p.routeName ? `${p.routeCode}・${p.routeName}` : (p.routeName ?? p.routeCode ?? "");
      return (
        <>
          <circle className="ns-i-gold" cx="50" cy="50" r="46" strokeWidth="3.2" />
          <circle cx="50" cy="50" r="40.5" strokeWidth=".9" strokeDasharray="1.6 2.6" />
          {head && A("top", head, 30.5, true, "ns-i-f", [...head].length > 8 ? 6 : 7, 0.7)}
          <circle cx="50" cy="39.5" r="4.6" strokeWidth="1.4" />
          <circle className="ns-i-fill" cx="50" cy="39.5" r="1.7" />
          <text className="ns-i-t" x="50" y="58.5" fontSize={fit(s.label, 16, 58)} letterSpacing=".4">
            {s.label}
          </text>
          <text className="ns-i-s" x="50" y="68.5" fontSize="6.6" letterSpacing="2.4">
            到着
          </text>
          {A("bot", dateFull(s.stamped_on), 38, false, "ns-i-l", 7, 0.6)}
        </>
      );
    }
    case "route":
      return (
        <>
          <circle className="ns-i-gold" cx="50" cy="50" r="46.5" strokeWidth="3.4" />
          <circle cx="50" cy="50" r="42.2" strokeWidth=".9" />
          <circle cx="50" cy="50" r="38.6" strokeWidth=".8" strokeDasharray="1.4 2.4" />
          {A("top", "終點到着", 29.5, true, "ns-i-f", 7.4, 3)}
          <path d="M35 37.5h27M35 41.5h27" strokeWidth="1.1" />
          <path d="M38.5 35.4v8.2M44.5 35.4v8.2M50.5 35.4v8.2M56.5 35.4v8.2" strokeWidth=".8" />
          <path d="M64 33v13" strokeWidth="2.6" strokeLinecap="round" />
          <text className="ns-i-t" x="50" y="58.5" fontSize={fit(s.label, 14, 56)} letterSpacing=".4">
            {s.label}
          </text>
          <text className="ns-i-l" x="50" y="69.5" fontSize="7.2" letterSpacing=".4">
            {span}
          </text>
          {p.routeCode && A("bot", p.routeCode, 36, false, "ns-i-l", 7.4, 2)}
        </>
      );
    case "line":
      // 幹線到站：雙金圈＋分岐的軌道（同屬一條幹線的路線在這裡合流）
      return (
        <>
          <circle className="ns-i-gold" cx="50" cy="50" r="46.5" strokeWidth="3.4" />
          <circle className="ns-i-gold" cx="50" cy="50" r="42.6" strokeWidth="1" />
          <circle cx="50" cy="50" r="38.8" strokeWidth=".8" strokeDasharray="1.4 2.4" />
          {A("top", "幹線到站", 29.5, true, "ns-i-f", 7.4, 3)}
          <path d="M34 42.5h14c5 0 8-2.5 12-6.5h6M48 42.5h18" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          <circle className="ns-i-fill" cx="48" cy="42.5" r="1.8" />
          <text className="ns-i-t" x="50" y="59" fontSize={fit(s.label, 14, 58)} letterSpacing=".4">
            {s.label}
          </text>
          <text className="ns-i-l" x="50" y="69.5" fontSize="7.2" letterSpacing=".4">
            {span}
          </text>
          {A("bot", "幹線", 36, false, "ns-i-f", 7, 3)}
        </>
      );
    case "route_year":
      // 開業一年（原型沒畫）：紀念章家族——金外圈＋虛線內圈；中間一個繞滿一圈的箭頭（走滿一年），路線名、日期
      return (
        <>
          <circle className="ns-i-gold" cx="50" cy="50" r="46" strokeWidth="3.2" />
          <circle cx="50" cy="50" r="40.5" strokeWidth=".9" strokeDasharray="1.6 2.6" />
          {A("top", "開業一年", 30, true, "ns-i-f", 7.4, 3)}
          <path d="M55.2 35.6a5.6 5.6 0 1 1-2.2-3.9" strokeWidth="1.3" strokeLinecap="round" />
          <path d="M53.6 29.4l-.4 2.6 2.6.5" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          <text className="ns-i-t" x="50" y="58.5" fontSize={fit(s.label, 14, 56)} letterSpacing=".4">
            {s.label}
          </text>
          <text className="ns-i-l" x="50" y="69.5" fontSize="7.2" letterSpacing=".4">
            {p.openedOn ? span : ""}
          </text>
          {A("bot", dateFull(s.stamped_on), 37, false, "ns-i-l", 7, 0.6)}
        </>
      );
    case "seals":
      return (
        <>
          <circle className="ns-i-wash" cx="50" cy="50" r="44" />
          <circle cx="50" cy="50" r="45" strokeWidth="3.6" />
          <circle cx="50" cy="50" r="39.8" strokeWidth=".9" />
          {A("top", `第 ${s.value ?? ""} 枚`, 28.5, true, "ns-i-f", 8.2, 1.2)}
          <text className="ns-i-t" x="50" y="62" fontSize="30">
            済
          </text>
          {A("bot", dateFull(s.stamped_on), 36.5, false, "ns-i-l", 7, 0.5)}
        </>
      );
    case "opening":
      return (
        <>
          <circle cx="50" cy="50" r="46" strokeWidth="1.9" />
          <circle cx="50" cy="50" r="35" strokeWidth=".9" />
          {A("top", "私鐵手帳", 37.4, true, "ns-i-f", 7.6, 3)}
          {A("bot", "第一張票", 44.2, false, "ns-i-s", 6, 2.6)}
          <line x1="20" y1="38.5" x2="80" y2="38.5" strokeWidth=".9" />
          <line x1="20" y1="61.5" x2="80" y2="61.5" strokeWidth=".9" />
          <text className="ns-i-l" x="50" y="33.5" fontSize="7.4" letterSpacing="1">
            {s.stamped_on.slice(0, 4)}
          </text>
          <text className="ns-i-t" x="50" y="56" fontSize="15" letterSpacing="2">
            開業
          </text>
          <text className="ns-i-l" x="50" y="74" fontSize="10.5" fontWeight="600">
            {fmtMD(s.stamped_on)}
          </text>
        </>
      );
    default: {
      // 累計類：time_cat／diary／ledger_year——珠狀外圈＋小圖樣
      const pic =
        s.kind === "time_cat" ? (
          <>
            <circle cx="50" cy="32.5" r="6.2" strokeWidth="1.3" />
            <path d="M50 29v3.6l2.6 1.7" strokeWidth="1.2" strokeLinecap="round" />
          </>
        ) : s.kind === "diary" ? (
          <path
            d="M50 30c-2.6-1.5-5.6-1.7-8.6-1v9.4c3-.7 6-.5 8.6 1 2.6-1.5 5.6-1.7 8.6-1V29c-3-.7-6-.5-8.6 1zM50 30v9.4"
            strokeWidth="1.1"
            strokeLinejoin="round"
          />
        ) : (
          <path
            d="M41.6 31.6 50 28l8.4 3.6M43.4 31.6v8.4h13.2v-8.4M47 40v-2.3a3 3 0 0 1 6 0V40"
            strokeWidth="1.1"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        );
      const main = s.kind === "time_cat" ? s.label : s.kind === "diary" ? "日記" : "記帳";
      const sub =
        s.kind === "ledger_year" ? (
          <tspan className="ns-i-s" fontSize="8" letterSpacing="1.6">
            滿一年
          </tspan>
        ) : (
          <>
            <tspan className="ns-i-l" fontSize="11.5">
              {s.value ?? ""}
            </tspan>
            <tspan className="ns-i-s" fontSize="7" dx="1.5">
              {s.kind === "time_cat" ? "小時" : "篇"}
            </tspan>
          </>
        );
      return (
        <>
          <circle cx="50" cy="50" r="46" strokeWidth="2.6" strokeDasharray=".01 4.32" strokeLinecap="round" />
          <circle cx="50" cy="50" r="41.5" strokeWidth="1.3" />
          <circle cx="50" cy="50" r="38" strokeWidth=".6" />
          {pic}
          <text className="ns-i-t" x="50" y="55" fontSize={fit(main, 12.5, 44)} letterSpacing="2">
            {main}
          </text>
          <text x="50" y="67.5">
            {sub}
          </text>
          {A("bot", dateFull(s.stamped_on), 34.5, false, "ns-i-l", 6.6, 0.5)}
        </>
      );
    }
  }
}

export function StampImpression(p: StampImpressionProps) {
  const rawId = useId();
  const uid = "ns-st" + rawId.replace(/[^a-zA-Z0-9_-]/g, "");
  const s = p.stamp;
  const seal = s.kind === "seals";
  const fine = !seal || p.size < 50;
  const title = stampTitle(s, { routeName: p.routeName ?? null });
  const style = { "--rot": `${stampRot(s, p.index)}deg` } as CSSProperties;
  const cls = "ns-depot-imp " + (seal ? "is-seal" : "is-ink") + (p.fresh ? " is-fresh" : "") + (p.className ? " " + p.className : "");
  const onOpen = p.onOpen;
  const act = onOpen
    ? {
        role: "button" as const,
        tabIndex: 0,
        onClick: onOpen,
        onKeyDown: (e: KeyboardEvent<HTMLSpanElement>) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen();
          }
        },
      }
    : { role: "img" as const };
  return (
    <span className={cls} style={style} title={title} aria-label={title} {...act}>
      <svg
        viewBox="0 0 100 100"
        width={p.size}
        height={p.size}
        style={{ filter: `url(#${fine ? "inkbleed-fine" : "inkbleed"})` }}
        aria-hidden="true"
        focusable="false"
      >
        {inner(p, uid)}
      </svg>
    </span>
  );
}
