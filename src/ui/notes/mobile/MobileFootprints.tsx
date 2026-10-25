/**
 * MobileFootprints——手機日記頁本文下方的「當天足跡」區塊（車次②契約 §5.3；D-筆-11／22；原型 app.js mobDiary 的 .ns-notes-mfp）。
 *
 * 桌機是右側常駐欄，手機改成本文下方一塊可收合的區塊（契約 §7.0 雙端對照）：
 *   標頭整列是一顆鈕（≥44px）：「當天足跡」＋（收合時）摘要「10/8・2 枚済章・1 則手記」＋ 箭頭。
 *   展開＝足跡翻日列（箭頭 44px、「10/8（四）」、與本文不同天時多一顆「回到 M 月 D 日」）＋ 三段。
 * 展開狀態由 MobileDiary 的 useState 管（契約：切 tab 回來重設為展開），本元件只收 open／onToggle。
 *
 * 三段（只顯示、不寫入；不增不減 D-筆-11）：
 *   蓋了章的 N：迷你済章（朱，唯一的朱）＋票名＋路線色點；定期券班次的 title 寫「班次 M/D」
 *   寫下的 N：時刻＋手寫體內文＋票名（節點已刪＝「（原車票已刪除）」，repository 已填好）
 *   心情：燈號一排（綠＝松葉 route-preset-3、黃＝--arc、紅＝赭 --late，不用朱）
 * 時間塊（日記足跡班 D-筆-69 C 案，跟桌機同一套 FootprintTime.tsx）：翻日列下一條日軸、最後一段分類合計、済章列尾補票上時間；
 *   收合摘要接「記錄 7h40m」。時刻表一寫入就重讀（useTimetableWriteReload）。
 *
 * UI 丙-6：心情字改讀核心 `complete/moods.ts`（F1：完成卡、側板、足跡同一張表）；顏色走 --mood-*（F2，CSS）；
 *   「這天沒有留下足跡」換共用 EmptyState 區段級（inline，E19）。
 */
import { useNodeStore } from "../../../store/nodeStore";
import { useUiStore } from "../../../store/uiStore";
import { useBackLayer } from "../../mobile/backStack";
import { footprintSummary, fmtMonthDay, fmtShortDay, hasFootprint, weekdayZh, type FootprintDay } from "../../../domain/notes";
import { RouteDot } from "../../common/MobileAttachPicker";
import { MOODS } from "../../complete/moods";
import { EmptyState } from "../../common/EmptyState";
import { IconCaret, IconLeft, IconRight, hhmm } from "./mobileDiaryBits";
import { FootprintAxis, FootprintTimeSec, SealTime, blocksSummaryTail } from "../FootprintTime";
import { useTimetableWriteReload } from "../useTimetableWriteReload";

/** 心情燈號的讀名（順暢／還行／吃力）＝核心那一張表 */
const moodName = (m: string) => MOODS.find((x) => x.value === m)?.label ?? m;

export interface MobileFootprintsProps {
  open: boolean;
  onToggle(): void;
  fpDay: string;
  diaryDay: string;
  today: string;
  footprint: FootprintDay | null;
  onStep(dir: 1 | -1): void;
  onBack(): void;
}

export function MobileFootprints({ open, onToggle, fpDay, diaryDay, today, footprint, onStep, onBack }: MobileFootprintsProps) {
  const routes = useNodeStore((s) => s.routes);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  useTimetableWriteReload();
  // store 換日時舊的那一份還在：日子對不上的先當沒有（避免摘要寫成前一天的數字）
  const f = footprint && footprint.day === fpDay ? footprint : null;
  const routeOf = (id: string | null) => (id ? (routes.find((r) => r.id === id) ?? null) : null);
  // 磨光① 返回層：足跡翻到別天＝子頁，返回＝「回到 M 月 D 日」。只在那顆鈕看得到時（展開著）才登記——
  //   收合時沒有退路可對應，返回不該悄悄改掉看不到的東西
  useBackLayer("notes.footprintDay", open && fpDay !== diaryDay, onBack, "page");

  return (
    <section className="ns-notes-mfp" aria-label="當天足跡">
      <button type="button" className="ns-notes-mfphead" aria-expanded={open} onClick={onToggle}>
        <h3>當天足跡</h3>
        {!open && (
          <span className="sum">
            {fmtShortDay(fpDay)}・{footprintSummary(f, blocksSummaryTail(f))}
          </span>
        )}
        <span className="caret" aria-hidden>
          <IconCaret />
        </span>
      </button>

      {open && (
        <div className="ns-notes-mfpbody">
          <div className="ns-notes-mfpnav">
            <button type="button" className="ns-notes-marrow sm" aria-label="足跡：前一天" onClick={() => onStep(-1)}>
              <IconLeft size={14} />
            </button>
            <span className="d">
              {fmtShortDay(fpDay)}（{weekdayZh(fpDay)}）
            </span>
            <button
              type="button"
              className="ns-notes-marrow sm"
              aria-label="足跡：後一天"
              disabled={fpDay >= today}
              onClick={() => onStep(1)}
            >
              <IconRight size={14} />
            </button>
            {fpDay !== diaryDay && (
              <button type="button" className="ns-notes-mfpback" onClick={onBack}>
                回到 {fmtMonthDay(diaryDay)}
              </button>
            )}
          </div>

          {f && <FootprintAxis f={f} dayStartHour={dayStartHour} />}

          {f && !hasFootprint(f) && <EmptyState inline tone="first" className="ns-notes-mfpempty" title="這天沒有留下足跡" />}

          {f && f.seals.length > 0 && (
            <div className="ns-notes-mfpsec">
              <h4>
                蓋了章的<span className="n">{f.seals.length}</span>
                <span className="rule" />
              </h4>
              <ul className="ns-notes-mfplist">
                {f.seals.map((s, i) => (
                  <li key={s.id} title={s.dueOn ? `班次 ${fmtShortDay(s.dueOn)}` : undefined}>
                    <span className={"ns-notes-msumi" + (i % 2 ? " alt" : "")} aria-label="済">
                      済
                    </span>
                    <span className="nm">{s.name}</span>
                    {s.dueOn && <span className="due">班次 {fmtShortDay(s.dueOn)}</span>}
                    <SealTime blocks={f.blocks} nodeId={s.nodeId} />
                    <RouteDot route={routeOf(s.routeId)} />
                  </li>
                ))}
              </ul>
            </div>
          )}

          {f && f.logs.length > 0 && (
            <div className="ns-notes-mfpsec">
              <h4>
                寫下的<span className="n">{f.logs.length}</span>
                <span className="rule" />
              </h4>
              <ul className="ns-notes-mfplist ns-notes-mfplog">
                {f.logs.map((l) => (
                  <li key={l.id}>
                    <span className="tm">{hhmm(l.at)}</span>
                    <span className="hw">{l.body}</span>
                    <span className={"of" + (l.nodeMissing ? " gone" : "")}>{l.nodeName}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {f && f.moods.length > 0 && (
            <div className="ns-notes-mfpsec">
              <h4>
                心情
                <span className="rule" />
              </h4>
              <div className="ns-notes-mmoods">
                {f.moods.map((m, i) => (
                  <span key={i} className={"ns-notes-mmood " + m} title={moodName(m)} aria-label={moodName(m)} />
                ))}
              </div>
            </div>
          )}

          {f && <FootprintTimeSec f={f} sectionClass="ns-notes-mfpsec" />}
        </div>
      )}
    </section>
  );
}
