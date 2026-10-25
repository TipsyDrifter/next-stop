/**
 * Footprints——當天足跡欄（桌機；車次②契約 §5.1、§5.5；D-筆-11／22；原型 app.js fpNavHtml／fpBodyHtml）。
 *
 * 只顯示、不寫入日記內文；沒寫日記的日子也看得到。可獨立翻日（不動本文），「回到 M 月 D 日」拉回本文那天。
 *   蓋了章的：済章（本線縮小版 .ns-notes-sumi，朱只給這一枚）＋票名＋路線色點；定期券班次 title「班次 M/D」
 *   寫下的：時刻＋手寫體內文＋票名（節點已刪＝「（原車票已刪除）」，repository 填好）
 *   心情：跟著済章讀的燈號；字與色同完成卡（complete/moods.ts：順暢／還行／吃力；色 --mood-good／-ok／-hard，不用朱）
 *   時間（日記足跡班 D-筆-69 C 案，FootprintTime.tsx）：最上一條日軸（時間塊色塊＋済章朱點＋手記空心點），最後一段分類合計；
 *     済章列尾補「這天花在這張票上的時間」。時刻表一寫入就重讀（useTimetableWriteReload）
 * 足跡翻日不必先存日記（本文沒換），所以直接呼叫 store、不經 flushThen。
 * 版面（UI 丙-6 K5）：本文右側一張區塊卡（紙材、--radius-card、--shadow-card；不全高、卡內捲）。翻日箭頭＝共用 `.ns-iconbtn`
 *   （跟 DateNav 同一種箭頭；不用 DateNav 本身：它常駐「今天」chip，足跡要的是「回到本文那天」）；「回到 M 月 D 日」＝文字鈕（D5）。
 */
import { useNotesStore } from "../../store/notesStore";
import { useNodeStore } from "../../store/nodeStore";
import { useUiStore } from "../../store/uiStore";
import { fmtMonthDay, hasFootprint, weekdayZh } from "../../domain/notes";
import { MOODS } from "../complete/moods";
import { EmptyState } from "../common/EmptyState";
import { IconBack, IconChevron } from "../common/icons";
import { RouteDot, fmtShort, fmtTime } from "./notesBits";
import { FootprintAxis, FootprintTimeSec, SealTime } from "./FootprintTime";
import { useTimetableWriteReload } from "./useTimetableWriteReload";

/** 心情字（F1：讀完成卡那一份，不各自一張表） */
const moodName = (m: string) => MOODS.find((o) => o.value === m)?.label ?? "";

export function Footprints({ today }: { today: string }) {
  const fpDay = useNotesStore((s) => s.fpDay);
  const diaryDay = useNotesStore((s) => s.diaryDay);
  const f = useNotesStore((s) => s.footprint);
  const routes = useNodeStore((s) => s.routes);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const st = useNotesStore.getState;
  useTimetableWriteReload();

  // 還沒載到這一天（剛翻日）就先不畫內容，免得上一天的足跡閃一下
  const cur = f && f.day === fpDay ? f : null;
  const ready = cur !== null;

  let body;
  if (!cur) body = null;
  else if (!hasFootprint(cur)) body = <EmptyState inline tone="first" className="ns-notes-fpempty" title="這天沒有留下足跡" />;
  else
    body = (
      <>
        <FootprintAxis f={cur} dayStartHour={dayStartHour} />
        {cur.seals.length > 0 && (
          <section className="ns-notes-fpsec">
            <h4>
              蓋了章的<span className="n">{cur.seals.length}</span>
              <span className="rule" />
            </h4>
            <ul className="ns-notes-fplist">
              {cur.seals.map((s, i) => {
                const route = s.routeId ? (routes.find((r) => r.id === s.routeId) ?? null) : null;
                return (
                  <li key={s.id} title={s.dueOn ? `班次 ${fmtShort(s.dueOn)}` : undefined}>
                    <span className={`ns-notes-sumi${i % 2 ? " alt" : ""}`} aria-label="済">
                      済
                    </span>
                    <span className="nm">{s.name}</span>
                    <SealTime blocks={cur.blocks} nodeId={s.nodeId} />
                    <RouteDot route={route} />
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        {cur.logs.length > 0 && (
          <section className="ns-notes-fpsec">
            <h4>
              寫下的<span className="n">{cur.logs.length}</span>
              <span className="rule" />
            </h4>
            <ul className="ns-notes-fplist ns-notes-fplog">
              {cur.logs.map((l) => (
                <li key={l.id}>
                  <span className="tm">{fmtTime(l.at)}</span>
                  <span className="hw">{l.body}</span>
                  <span className={`of${l.nodeMissing ? " gone" : ""}`}>{l.nodeName}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {cur.moods.length > 0 && (
          <section className="ns-notes-fpsec">
            <h4>
              心情
              <span className="rule" />
            </h4>
            <div className="ns-notes-moods">
              {cur.moods.map((m, i) => (
                <span key={i} className={`ns-notes-mood ${m}`} title={moodName(m)} aria-label={moodName(m)} />
              ))}
            </div>
          </section>
        )}
        <FootprintTimeSec f={cur} sectionClass="ns-notes-fpsec" />
      </>
    );

  return (
    <aside className="ns-notes-fpcol" aria-label="當天足跡">
      <div className="ns-notes-fphead">
        <h3>當天足跡</h3>
        <div className="ns-notes-fpnav">
          <button
            type="button"
            className="ns-iconbtn"
            aria-label="足跡：前一天"
            title="足跡：前一天"
            onClick={() => st().stepFpDay(-1)}
          >
            <IconBack />
          </button>
          <span className="d">
            {fmtShort(fpDay)}（{weekdayZh(fpDay)}）
          </span>
          <button
            type="button"
            className="ns-iconbtn"
            aria-label="足跡：後一天"
            title="足跡：後一天"
            disabled={fpDay >= today}
            onClick={() => st().stepFpDay(1)}
          >
            <IconChevron />
          </button>
          {fpDay !== diaryDay && (
            <button type="button" className="ns-btn ns-btn--sm btn-text ns-notes-fpback" onClick={() => st().fpBackToDiaryDay()}>
              回到 {fmtMonthDay(diaryDay)}
            </button>
          )}
        </div>
      </div>
      <div className="ns-notes-fpbody techo-scroll" aria-busy={!ready}>
        {body}
      </div>
    </aside>
  );
}
