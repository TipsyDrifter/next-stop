/**
 * 印章家族（M3 ② 主題換裝移植・E4）——済／途中下車／運休／延着／繰越／入鋏／紀念章／日付印＋時刻戳／領収（⑥ 補）。
 *
 * 造形真相來源＝prototypes/m3-mood-a-stamps.html 檔頭「造形規則（印章規範草案）」逐章表，逐字移植：
 *   ■ 形狀＝語意：圓印（丸印）＝定案／受理；橫長方（角印）＝運行狀態告示；鋏痕＝入鋏（是痕不是印）
 *   ■ 墨色＝性質（四色，不新增）：朱 --seal＝決済／墨 --stamp-ink＝事務／赭 --late＝時刻注意／金 --arc＝里程弧
 *   ■ 筆畫：済 60px 圓・框 2.5px・字 27px（小號 34px／2px／16px）；角印 1.6px 框・圓角 2px・
 *          字 12.5px 字距 .3em（四字章 12px／.16em）；日付印雙圈 1.6／.8＋上下橫線；鋏痕 13×22
 *   ■ 旋轉（手蓋的自然左傾，絕不 0°）：済 -8°／日付印 -4°／延着 -6°／途中下車 -5°／運休 -7°
 *          ＋正角例外：繰越 +3°／紀念章 +5°（同畫面相鄰兩枚方向錯開）
 *   ■ 動畫：全家共用 stampIn（1.75→.9→1、rot 從 --ns-rot-18° 落到 --ns-rot，.4s；reduced-motion 直接出現）
 * 朱肉：#inkbleed（済與角印）／#inkbleed-fine（日付印・時刻戳等細字）；defs 見 ./defs.ts。
 * 樣式全在 src/styles/stamps.css（本檔只給結構與資料）。
 *
 * 已知取捨：
 * - 受付／無効兩枚未實作——收件匣移 M4、無効屬 undo 期間，照原型「不提前塞進頁面」的紀律；
 *   領収已於 M3 ⑥ WP3 補上（`SealReceipt`，落點＝設定頁「上次成功備份」旁的備份回執，
 *   原型 A :843-845 指定；D-⑥-7 拍板：失敗時不蓋）。
 * - 大綱／完成卡既有的済章走 techo.css 的 .stamp／.seal（class 相容保留），本檔元件是「印章放到別處」時的用法；
 *   兩者朱肉由 stamps.css 統一補上，形制數值一致。
 */
import { useId, type CSSProperties, type ReactNode } from "react";

const cx = (...parts: Array<string | false | undefined>) => parts.filter(Boolean).join(" ");

/** 墨色＝性質：朱（決済）／墨（事務）／赭（時刻注意） */
export type StampTone = "seal" | "ink" | "warn";

const toneClass = (tone: StampTone) => (tone === "ink" ? "ns-ink" : tone === "warn" ? "ns-warn" : undefined);

/** 旋轉角（deg）寫進 --ns-rot，stampIn 動畫也吃同一個變數 */
const rotStyle = (deg: number, extra?: CSSProperties): CSSProperties =>
  ({ "--ns-rot": `${deg}deg`, ...extra }) as CSSProperties;

interface StampBaseProps {
  /** 剛蓋下去：跑 stampIn 回彈動畫（reduced-motion 自動關） */
  fresh?: boolean;
  /** 覆蓋預設旋轉角（deg）；同畫面相鄰兩枚要錯開方向 */
  rotate?: number;
  className?: string;
  title?: string;
}

/* ══════════ 圓印・主章：済 ══════════ */

export interface SealDoneProps extends StampBaseProps {
  /** 小號（34px）——側板等窄處；預設 60px */
  small?: boolean;
}

/** 済（すみ）＝完成。朱、-8°、60px 圓（小號 34px）。 */
export function SealDone({ small, fresh, rotate = -8, className, title }: SealDoneProps) {
  return (
    <span
      aria-hidden
      title={title}
      style={rotStyle(rotate)}
      className={cx("ns-imp", "ns-round-main", small && "ns-sm", fresh && "is-fresh", className)}
    >
      済
    </span>
  );
}

/* ══════════ 角印：運行狀態告示 ══════════ */

export interface RectSealProps extends StampBaseProps {
  tone?: StampTone;
  /** 四字章（字距收到 .16em） */
  four?: boolean;
  children: ReactNode;
}

/** 角印通用形制（1.6px 框／圓角 2px／12.5px 字距 .3em）——五枚狀態章都由它長出來。 */
export function RectSeal({ tone = "ink", four, fresh, rotate = -5, className, title, children }: RectSealProps) {
  return (
    <span
      aria-hidden
      title={title}
      style={rotStyle(rotate)}
      className={cx("ns-imp", "ns-rect", four && "ns-four", toneClass(tone), fresh && "is-fresh", className)}
    >
      {children}
    </span>
  );
}

/** 途中下車（ちゅうとげしゃ）＝暫停。墨、-5°、四字章。 */
export function SealStopover({ rotate = -5, ...rest }: StampBaseProps) {
  return (
    <RectSeal tone="ink" four rotate={rotate} {...rest}>
      途中下車
    </RectSeal>
  );
}

/** 運休（うんきゅう）＝跳過本次班次／移出今日。墨、-7°。 */
export function SealSuspended({ rotate = -7, ...rest }: StampBaseProps) {
  return (
    <RectSeal tone="ink" rotate={rotate} {...rest}>
      運休
    </RectSeal>
  );
}

/** 延着（えんちゃく）＝誤點。赭、-6°。 */
export function SealLate({ rotate = -6, ...rest }: StampBaseProps) {
  return (
    <RectSeal tone="warn" rotate={rotate} {...rest}>
      延着
    </RectSeal>
  );
}

/** 繰越（くりこし）＝順延（來歷，不是結局）。赭、**+3°（正角例外）**；済蓋下後由消費端淡化到 .38。 */
export function SealCarryOver({ rotate = 3, ...rest }: StampBaseProps) {
  return (
    <RectSeal tone="warn" rotate={rotate} {...rest}>
      繰越
    </RectSeal>
  );
}

/* ══════════ 鋏痕：入鋏 ══════════ */

/**
 * 入鋏（にゅうきょう）＝開始的痕跡。不是印、不佔顏色：票根左緣上 1/3 剪下 13×22 三角缺口。
 * 用法：放在 position:relative 的票根（.stub）內，絕對定位由 stamps.css 給（left:-1px／top:26px）。
 */
export function PunchNick({ className, title }: { className?: string; title?: string }) {
  return (
    <svg
      className={cx("ns-punch", className)}
      width="13"
      height="22"
      viewBox="0 0 13 22"
      role="img"
      aria-label="入鋏"
    >
      {title ? <title>{title}</title> : null}
      <path d="M0 1 L11 11 L0 21" />
    </svg>
  );
}

/* ══════════ 圓印：日付印 ══════════ */

const WEEKDAY = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;

export interface DateSealProps extends StampBaseProps {
  /** 要蓋的日期（Date 或可被 Date 解析的字串）；預設今天 */
  date?: Date | string;
  /** 圖鑑基準 76／頁首檔位 92（① 比稿拍板 Q8） */
  size?: 76 | 92 | number;
}

/**
 * 日付印（ひづけいん）＝日戳。墨、-4°、郵局式雙圈（外 1.6／內 .8）＋上下兩道橫線夾日期。
 * 尺寸：圖鑑基準 76px、頁首檔位 92px（拍板 Q8「頁首可放大至 92px」）。
 */
export function DateSeal({ date, size = 76, fresh, rotate = -4, className, title }: DateSealProps) {
  const uid = useId().replace(/:/g, "");
  const topId = `ds-top-${uid}`;
  const botId = `ds-bot-${uid}`;
  const d = date instanceof Date ? date : date ? new Date(date) : new Date();
  const ok = !Number.isNaN(d.getTime());
  const day = ok ? d : new Date();
  const year = day.getFullYear();
  const md = `${day.getMonth() + 1}.${day.getDate()}`;
  const wd = WEEKDAY[day.getDay()];

  return (
    <svg
      className={cx("ns-date-seal", fresh && "is-fresh", className)}
      style={rotStyle(rotate)}
      width={size}
      height={size}
      viewBox="0 0 72 72"
      role="img"
      aria-label={title ?? `日付印 ${year}.${md}`}
    >
      <defs>
        <path id={topId} d="M8.5 36 A27.5 27.5 0 0 1 63.5 36" />
        <path id={botId} d="M3.4 36 A32.6 32.6 0 0 0 68.6 36" />
      </defs>
      <circle cx="36" cy="36" r="34" strokeWidth="1.6" />
      <circle cx="36" cy="36" r="25.5" strokeWidth=".8" />
      <text fontFamily="'Noto Serif TC',serif" fontWeight="700" fontSize="6.2" letterSpacing="2">
        <textPath href={`#${topId}`} startOffset="50%" textAnchor="middle">
          私鐵手帳
        </textPath>
      </text>
      <text fontFamily="Fraunces,serif" fontWeight="500" fontSize="5.6" letterSpacing="1.8">
        <textPath href={`#${botId}`} startOffset="50%" textAnchor="middle">
          NEXT STOP
        </textPath>
      </text>
      <line x1="13" y1="26" x2="59" y2="26" strokeWidth=".9" />
      <line x1="13" y1="47" x2="59" y2="47" strokeWidth=".9" />
      <text x="36" y="33.2" textAnchor="middle" fontFamily="Fraunces,serif" fontSize="6" letterSpacing="1.3">
        {year}
      </text>
      <text x="36" y="44" textAnchor="middle" fontFamily="Fraunces,serif" fontWeight="600" fontSize="12">
        {md}
      </text>
      <text x="36" y="55" textAnchor="middle" fontFamily="Fraunces,serif" fontSize="5.8" letterSpacing="1.8">
        {wd}
      </text>
    </svg>
  );
}

/* ══════════ 小戳：時刻戳（乘務記錄用） ══════════ */

export interface TimeSealProps extends StampBaseProps {
  /** 顯示的時刻（HH:mm）；給 Date／ISO 則自行取本地時分 */
  at: string | Date;
}

/**
 * 時刻戳＝乘務記錄裡旅程兩端（入鋏・済）的小號日付印（42px 雙圈）。墨、-3°／+2° 交錯。
 * 原件＝git show 6a1b98c:prototypes/m3-mood-a-stamps.html 的 .time-seal 段。
 */
export function TimeSeal({ at, fresh, rotate = -3, className, title }: TimeSealProps) {
  const text = typeof at === "string" && /^\d{1,2}:\d{2}$/.test(at) ? at : fmtHm(at);
  return (
    <svg
      className={cx("ns-time-seal", fresh && "is-fresh", className)}
      style={rotStyle(rotate)}
      width="42"
      height="42"
      viewBox="0 0 40 40"
      role="img"
      aria-label={title ?? `時刻戳 ${text}`}
    >
      <circle cx="20" cy="20" r="18.4" strokeWidth="1.3" />
      <circle cx="20" cy="20" r="14.6" strokeWidth=".6" />
      <line x1="9" y1="14.6" x2="31" y2="14.6" strokeWidth=".7" />
      <line x1="9" y1="25.4" x2="31" y2="25.4" strokeWidth=".7" />
      <text x="20" y="22.6" textAnchor="middle" fontFamily="Fraunces,serif" fontWeight="600" fontSize="8" letterSpacing=".3">
        {text}
      </text>
    </svg>
  );
}

function fmtHm(v: string | Date): string {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return typeof v === "string" ? v : "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/* ══════════ 圓印：紀念章 ══════════ */

const ARC_R = 57;
const ARC_C = 2 * Math.PI * ARC_R;

export interface StationStampProps extends StampBaseProps {
  /** 外弧拉丁小字（例：「E1 LINE · NEXT STATION」） */
  arcLabel: string;
  /** 章內上排小字（例：「下一站」） */
  caption?: string;
  /** 站名（章的主字） */
  name: string;
  /** 進度 0–100：外圈金線走滿一圈＝到站 */
  percent: number;
  /** 章內下排小字（例：「進行中」） */
  statusText?: string;
  /** 邊長 px（原型印譜 104／場景 128） */
  size?: number;
}

/**
 * 紀念章（えきスタンプ）＝里程碑。**+5°（正角例外）**；外圈金線＝進度弧——金不做任何狀態章（四色墨紀律）。
 */
export function StationStamp({
  arcLabel,
  caption,
  name,
  percent,
  statusText,
  size = 128,
  fresh,
  rotate = 5,
  className,
  title,
}: StationStampProps) {
  const uid = useId().replace(/:/g, "");
  const arcId = `arc-top-${uid}`;
  const pct = Math.max(0, Math.min(100, percent));
  const dash = (ARC_C * pct) / 100;

  return (
    <svg
      className={cx("ns-station-stamp", fresh && "is-fresh", className)}
      style={rotStyle(rotate)}
      width={size}
      height={size}
      viewBox="0 0 128 128"
      role="img"
      aria-label={title ?? `紀念章 ${name} ${Math.round(pct)}%`}
    >
      <defs>
        <path id={arcId} d="M16 64 A48 48 0 0 1 112 64" />
      </defs>
      <circle className="ring-base" cx="64" cy="64" r={ARC_R} fill="none" strokeWidth="1.5" opacity=".3" />
      <circle
        className="arc"
        cx="64"
        cy="64"
        r={ARC_R}
        fill="none"
        strokeWidth="2.5"
        strokeDasharray={`${dash.toFixed(1)} ${(ARC_C - dash).toFixed(1)}`}
        strokeLinecap="round"
        transform="rotate(-90 64 64)"
      />
      <circle className="dots" cx="64" cy="64" r="46" fill="none" strokeWidth="1" strokeDasharray="2 4" opacity=".5" />
      <text className="arc-label" fontFamily="Fraunces,serif" fontSize="8" letterSpacing="2.6">
        <textPath href={`#${arcId}`} startOffset="50%" textAnchor="middle">
          {arcLabel}
        </textPath>
      </text>
      {caption ? (
        <text className="caption" x="64" y="53" textAnchor="middle" fontSize="9" letterSpacing="3">
          {caption}
        </text>
      ) : null}
      <text className="name" x="64" y="72" textAnchor="middle" fontSize="16" fontWeight="700" letterSpacing="2">
        {name}
      </text>
      <text className="pct" x="64" y="90" textAnchor="middle" fontSize="12" fontFamily="Fraunces,serif">
        {Math.round(pct)}%
      </text>
      {statusText ? (
        <text className="state" x="64" y="102" textAnchor="middle" fontSize="7.5" letterSpacing="2">
          {statusText}
        </text>
      ) : null}
    </svg>
  );
}

/* ══════════ 圓印：領収（M3 ⑥ WP3） ══════════ */

export interface SealReceiptProps extends StampBaseProps {
  /** 邊長 px（小號圓印檔位，預設 34＝済的 .ns-sm 同檔） */
  size?: number;
}

/**
 * 領収（りょうしゅう）＝受領回執。朱、**-5°**、小號圓印（34px／框 2px）。
 * 落點＝設定頁「上次成功備份」旁的備份回執——原型 A :843-845 明指「出現：設定頁備份完成回執」，
 * D-⑥-7 拍板蓋在「上次成功備份」旁，**失敗時不蓋**（改顯示赭字時間戳＋原因）。
 * 形制與済同族（同一顆 .ns-round-main，只換尺寸與字級）；兩個全形字要進小號圓印，
 * 走**縦書き**（hanko 的正寫法：領在上、収在下），字級 size×0.36（34→12.2px）並收掉繼承來的字距——
 * 橫排兩字擠在 30px 內徑裡會糊成一團（驗過），縦書則每字獨立可讀。
 * 這些都是「隨 size 變動的幾何」，照 DateSeal／StationStamp 的慣例走行內樣式，
 * 不新增 stamps.css 規則（本席不 own 該檔）。
 */
export function SealReceipt({ size = 34, fresh, rotate = -5, className, title }: SealReceiptProps) {
  return (
    <span
      aria-hidden
      title={title}
      style={rotStyle(rotate, {
        width: size,
        height: size,
        borderWidth: 2,
        fontSize: Math.round(size * 3.6) / 10,
        letterSpacing: 0,
        writingMode: "vertical-rl",
        textOrientation: "upright",
      })}
      className={cx("ns-imp", "ns-round-main", "ns-receipt", fresh && "is-fresh", className)}
    >
      領収
    </span>
  );
}
