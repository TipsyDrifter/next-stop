/**
 * Footprints——當天足跡欄（桌機；車次②契約 §5.1、§5.5；D-筆-11／22；原型 app.js fpNavHtml／fpBodyHtml）。
 *
 * 只顯示、不寫入日記內文；沒寫日記的日子也看得到。可獨立翻日（不動本文），「回到 M 月 D 日」拉回本文那天。
 *   蓋了章的：済章（本線縮小版 .ns-notes-sumi，朱只給這一枚）＋票名＋路線色點；定期券班次 title「班次 M/D」
 *   寫下的：時刻＋手寫體內文＋票名（節點已刪＝「（原車票已刪除）」，repository 填好）
 *   心情：跟著済章讀的燈號（綠＝路線松葉色、黃＝金／粉彩用 --arc、紅＝赭 --late；不用朱）
 *   時間：時刻表通車後才有（blocks !== null）；本車次恆 null ⇒ 欄底一行說明
 * 足跡翻日不必先存日記（本文沒換），所以直接呼叫 store、不經 flushThen。
 */
import { useNotesStore } from "../../store/notesStore";
import { useNodeStore } from "../../store/nodeStore";
import { fmtMonthDay, hasFootprint, weekdayZh } from "../../domain/notes";
import { IconLeft, IconRight, RouteDot, fmtShort, fmtTime } from "./notesBits";

const MOOD_NAME = { green: "順暢", yellow: "還行", red: "吃力" } as const;

export function Footprints({ today }: { today: string }) {
  const fpDay = useNotesStore((s) => s.fpDay);
  const diaryDay = useNotesStore((s) => s.diaryDay);
  const f = useNotesStore((s) => s.footprint);
  const routes = useNodeStore((s) => s.routes);
  const st = useNotesStore.getState;

  // 還沒載到這一天（剛翻日）就先不畫內容，免得上一天的足跡閃一下
  const cur = f && f.day === fpDay ? f : null;
  const ready = cur !== null;

  let body;
  if (!cur) body = null;
  else if (!hasFootprint(cur)) body = <div className="ns-notes-fpempty">這天沒有留下足跡</div>;
  else
    body = (
      <>
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
                <span key={i} className={`ns-notes-mood ${m}`} title={MOOD_NAME[m]} aria-label={MOOD_NAME[m]} />
              ))}
            </div>
          </section>
        )}
        {cur.blocks !== null && (
          <section className="ns-notes-fpsec">
            <h4>
              時間
              <span className="rule" />
            </h4>
          </section>
        )}
      </>
    );

  return (
    <aside className="ns-notes-fpcol" aria-label="當天足跡">
      <div className="ns-notes-fphead">
        <h3>當天足跡</h3>
        <div className="ns-notes-fpnav">
          <button
            type="button"
            className="ns-notes-arrow sm"
            aria-label="足跡：前一天"
            title="足跡：前一天"
            onClick={() => st().stepFpDay(-1)}
          >
            <IconLeft size={13} />
          </button>
          <span className="d">
            {fmtShort(fpDay)}（{weekdayZh(fpDay)}）
          </span>
          <button
            type="button"
            className="ns-notes-arrow sm"
            aria-label="足跡：後一天"
            title="足跡：後一天"
            disabled={fpDay >= today}
            onClick={() => st().stepFpDay(1)}
          >
            <IconRight size={13} />
          </button>
          {fpDay !== diaryDay && (
            <button type="button" className="ns-notes-fpback" onClick={() => st().fpBackToDiaryDay()}>
              回到 {fmtMonthDay(diaryDay)}
            </button>
          )}
        </div>
      </div>
      <div className="ns-notes-fpbody techo-scroll" aria-busy={!ready}>
        {body}
      </div>
      <div className="ns-notes-fpfoot">
        {f?.blocks == null ? "時刻表通車後，這裡會多出當天的時間" : null}
      </div>
    </aside>
  );
}
