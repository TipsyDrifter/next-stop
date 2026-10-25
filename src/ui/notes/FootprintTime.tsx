/**
 * 當天足跡的時間塊兩件（日記足跡班 D-筆-69 C 案「日軸＋原段落」；原型 `prototypes/旅客筆記-日記足跡時間塊.html` bodyC）。
 * 桌機足跡卡與手機足跡區共用；手機只差字階（`[data-shell="mobile"]` 在 notes-mobile.css 微調）。
 *
 *   FootprintAxis：最上一條按時刻比例的日軸——分類色塊（時刻表同一組 --ns-tt-cat-N）、済章＝朱點、手記＝空心點、整點刻度；
 *     正在跑的那塊＝赭框＋呼吸點（同 RunMark）。範圍預設 06–24，事件超出才往外擴（footprintAxisRange）。只讀、不可點（D-筆-71）。
 *   FootprintTimeSec：最後一段「時間」＝當天總時長＋分類合計兩欄（圓牌用時刻表的 CategoryBadge）。
 *   SealTime：済章列尾「這天花在這張票上的時間」（掛那張票的塊合計；掛路線的不算）。
 * 時長寫法＝時刻表的 fmtDur（1h20m），兩頁同一把尺。
 */
import type { CSSProperties } from "react";
import { blockCatTotals, blocksTotalMs, footprintAxisRange, nodeMsOf, type FootprintBlock, type FootprintDay } from "../../domain/notes";
import { colorSlot, fmtDur, type TimeCategoryRow } from "../../domain/timetable";
import { dayWindow } from "../../lib/date";
import { CategoryBadge } from "../timetable/CategoryBadge";

const H = 3600_000;
/** 不到半分鐘（fmtDur 會寫成「0m」）就不列：分類合計與済章列尾同一條線（正在跑的分類照列） */
const MIN_SHOWN_MS = 30_000;
const pad2 = (n: number) => (n < 10 ? "0" + n : String(n));
const clock = (ms: number) => {
  const d = new Date(ms);
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
};

/** CategoryBadge 只讀 name／glyph／color_idx；分類已刪（時刻表填「？」）＝null，畫灰圈「？」 */
const badgeCat = (b: Pick<FootprintBlock, "catName" | "glyph" | "colorIdx">): TimeCategoryRow | null =>
  b.catName === "？" && b.glyph === null ? null : ({ name: b.catName, glyph: b.glyph, color_idx: b.colorIdx } as TimeCategoryRow);

export function FootprintAxis({ f, dayStartHour }: { f: FootprintDay; dayStartHour: number }) {
  const blocks = f.blocks ?? [];
  if (blocks.length === 0) return null;
  const [y, m, d] = f.day.split("-").map(Number);
  const dayZero = new Date(y, m - 1, d).getTime();
  const w = dayWindow(f.day, dayStartHour);
  const events = [
    ...blocks.flatMap((b) => [Date.parse(b.from), Date.parse(b.to)]),
    ...f.seals.map((s) => Date.parse(s.at)),
    ...f.logs.map((l) => Date.parse(l.at)),
  ];
  const r = footprintAxisRange(events, dayZero, Date.parse(w.start), Date.parse(w.end));
  if (!r) return null;
  const pct = (ms: number) => ((Math.min(r.to, Math.max(r.from, ms)) - r.from) / (r.to - r.from)) * 100;

  const ticks = [];
  for (let t = r.from; t <= r.to; t += H) {
    const h = Math.round((t - dayZero) / H);
    const maj = h % 3 === 0;
    ticks.push(<i key={"t" + h} className={maj ? "maj" : undefined} style={{ left: pct(t) + "%" }} />);
    if (maj)
      ticks.push(
        <span key={"l" + h} style={{ left: pct(t) + "%" }}>
          {pad2(h > 24 ? h - 24 : h)}
        </span>,
      );
  }
  const run = blocks.find((b) => b.running);

  return (
    <div className="ns-notes-fpaxis" aria-hidden="true">
      <div className="mk">
        {f.seals.map((s) => (
          <i key={"s" + s.id} className="seal" style={{ left: pct(Date.parse(s.at)) + "%" }} title={`済 ${clock(Date.parse(s.at))} ${s.name}`} />
        ))}
        {f.logs.map((l) => (
          <i key={"l" + l.id} className="log" style={{ left: pct(Date.parse(l.at)) + "%" }} title={`${clock(Date.parse(l.at))} ${l.body}`} />
        ))}
      </div>
      <div className="bar">
        {blocks.map((b) => {
          const a = Date.parse(b.from);
          const z = Date.parse(b.to);
          const style = { "--c": `var(--ns-tt-cat-${colorSlot(b.colorIdx)})`, left: pct(a) + "%", width: pct(z) - pct(a) + "%" } as CSSProperties;
          // 跨日界線的塊只帶切過的時間（時刻表的唯讀查詢就是這樣給的）⇒ 照實寫「接前一天／延到隔天」，不假裝是實際起訖
          const from = clock(a) + (b.contFromPrev ? "（接前一天）" : "");
          const to = b.running ? "正在跑" : clock(z) + (b.contToNext ? "（延到隔天）" : "");
          const tip = `${b.catName}${b.link ? "・" + b.link : ""}　${from}–${to}`;
          return <b key={b.id} className={b.running ? "is-live" : undefined} style={style} title={tip} />;
        })}
        {run && <i className="ns-tt-live-dot" style={{ left: pct(Date.parse(run.to)) + "%" }} />}
      </div>
      <div className="tk">{ticks}</div>
    </div>
  );
}

export function FootprintTimeSec({ f, sectionClass }: { f: FootprintDay; sectionClass: string }) {
  if (!f.blocks || f.blocks.length === 0) return null;
  return (
    <section className={sectionClass}>
      <h4>
        時間<span className="n">{fmtDur(blocksTotalMs(f.blocks))}</span>
        <span className="rule" />
      </h4>
      <div className="ns-notes-fpcats">
        {blockCatTotals(f.blocks)
          .filter((c) => c.running || c.ms >= MIN_SHOWN_MS)
          .map((c) => (
            <div key={c.catId}>
              <CategoryBadge cat={badgeCat(c)} size="sm" live={c.running} />
              <span className="nm">{c.catName}</span>
              <span className={"ns-notes-fpdur" + (c.running ? " is-live" : "")}>{fmtDur(c.ms)}</span>
            </div>
          ))}
      </div>
    </section>
  );
}

/** 済章列尾：這天花在這張票上的時間；不到半分鐘＝不畫 */
export function SealTime({ blocks, nodeId }: { blocks: FootprintDay["blocks"]; nodeId: string }) {
  const ms = nodeMsOf(blocks, nodeId);
  return ms >= MIN_SHOWN_MS ? <span className="ns-notes-fptt">{fmtDur(ms)}</span> : null;
}

/** 手機收合摘要的尾巴：「記錄 7h40m」；沒有塊＝"" */
export function blocksSummaryTail(f: FootprintDay | null): string {
  return f && f.blocks && f.blocks.length ? "記錄 " + fmtDur(blocksTotalMs(f.blocks)) : "";
}
