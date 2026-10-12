/**
 * RunDock——運行列（車次①a 契約 §5.1；D-時-22 甲案；乙席）。兩殼共用 DOM（手機固定在頁面與 tab bar 之間、桌機在左欄頂端），
 * 差異只在 CSS。＝原型 `mountDock`（shared.js:607-648）。自己讀 store。
 *
 * 運行中：div.ns-tt-dock[.is-long] > Badge ＋ div.ns-tt-dock-main（
 *   div.ns-tt-dock-name：分類名＋長時間運行未確認時 button.ns-tt-chip.is-late「⚠ 其實到幾點？」／已確認時 span.ns-tt-chip「長時間運行」；
 *   div.ns-tt-dock-meta：span.ns-tt-live-dot＋button.ns-tt-dock-start「HH:MM 発」（點了開改出發時間）＋b.ns-tt-dock-el（fmtHMS，每秒））
 *   ＋ button.ns-btn.btn-ghost「換車」＋ button.ns-btn.btn-seal「到着」。
 * 停車中：分類圓牌位置空、「目前沒有列車在跑」／「沒記到的時間，之後可以在軸上補」＋ button.btn-seal「発車」。
 * 桌機鈕上加 kbd.ns-tt-kbd（N／Enter）——鍵帽字一律 `formatChord(hotkeyById(id)!.chords[0])`（契約 §1-9，不手抄）。
 */
import { fmtClock, fmtHMS, msOf } from "../../../domain/timetable";
import { blockIsLongRun, useTimetableStore } from "../../../store/timetableStore";
import { formatChord, hotkeyById } from "../../shell/hotkeys";
import { CategoryBadge } from "../CategoryBadge";
import { useNow } from "../useNow";

export interface RunDockProps {
  variant: "mobile" | "desktop";
}

/** 桌機鈕上的鍵帽（一顆鍵一枚 kbd） */
function Kbd({ id }: { id: string }) {
  const h = hotkeyById(id);
  if (!h) return null;
  return (
    <kbd className="ns-tt-kbd" aria-hidden="true">
      {formatChord(h.chords[0]).join("+")}
    </kbd>
  );
}

export function RunDock({ variant }: RunDockProps) {
  const running = useTimetableStore((s) => s.running);
  const catById = useTimetableStore((s) => s.catById);
  const longRunMaxMin = useTimetableStore((s) => s.longRunMaxMin);
  const requestDepart = useTimetableStore((s) => s.requestDepart);
  const requestArrive = useTimetableStore((s) => s.requestArrive);
  const openSheet = useTimetableStore((s) => s.openSheet);
  const now = useNow(1000);
  const desk = variant === "desktop";

  if (!running) {
    return (
      <div className={"ns-tt-dock is-idle is-" + variant}>
        <div className="ns-tt-dock-main">
          <div className="ns-tt-dock-name">目前沒有列車在跑</div>
          <div className="ns-tt-dock-meta">沒記到的時間，之後可以在軸上補</div>
        </div>
        <button type="button" className="ns-btn btn-seal ns-tt-dock-go" onClick={requestDepart}>
          発車{desk && <Kbd id="timetable.depart" />}
        </button>
      </div>
    );
  }

  const cat = catById[running.category_id] ?? null;
  const start = msOf(running.started_at);
  const acked = running.long_run_ack === 1;
  const long = !acked && blockIsLongRun(running, catById, longRunMaxMin, now);
  const blockId = running.id;

  return (
    <div className={"ns-tt-dock is-" + variant + (long ? " is-long" : "")}>
      <CategoryBadge cat={cat} />
      <div className="ns-tt-dock-main">
        <div className="ns-tt-dock-name">
          <span className="ns-tt-dock-cat">{cat?.name ?? "？"}</span>
          {long && (
            <button
              type="button"
              className="ns-tt-chip is-late"
              onClick={() => openSheet({ kind: "longRun", blockId, then: null })}
            >
              ⚠ 其實到幾點？
            </button>
          )}
          {acked && <span className="ns-tt-chip">長時間運行</span>}
        </div>
        <div className="ns-tt-dock-meta ns-tt-num">
          <span className="ns-tt-live-dot" aria-hidden="true" />
          <button
            type="button"
            className="ns-tt-dock-start"
            title="改出發時間"
            onClick={() => openSheet({ kind: "restart", blockId })}
          >
            {fmtClock(start)} 発
          </button>
          <b className="ns-tt-dock-el">{fmtHMS(now - start)}</b>
        </div>
      </div>
      <button type="button" className="ns-btn btn-ghost" onClick={requestDepart}>
        換車{desk && <Kbd id="timetable.depart" />}
      </button>
      <button type="button" className="ns-btn btn-seal" onClick={requestArrive}>
        到着{desk && <Kbd id="timetable.arrive" />}
      </button>
    </div>
  );
}
