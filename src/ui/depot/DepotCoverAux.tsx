/**
 * 車庫頁的書封頁務件（設計題丙 定案四「頁務件＝這一頁的目錄，點了留在這一頁」；原型 `design-structure-側欄.html` 的 depotA）：
 *   h2「車庫 DEPOT」→ 一行總數（N 條到站・M 枚済章）→ 照幹線列到站的路線（圓牌＋名字＋到站月）；
 *   點一條＝主欄翻到那條的乘車記錄簿（setPage 不動、留在車庫頁）。沒有到站的路線＝只留一句「還沒有到站的路線」。
 * 長相借書封的 `.lines`／`.trunk`／`.line-item`／`.roundel`（同旅客筆記與售票口的頁務件做法）；只多兩行小字的樣式在 depotBanner.css。
 */
import { roundelStyle } from "../common/roundel";
import { useDepotStore } from "../../store/depotStore";
import { useNodeStore } from "../../store/nodeStore";
import type { NodeRow } from "../../domain";
import "./depotBanner.css";

function Roundel({ route }: { route: NodeRow }) {
  const disc = roundelStyle(route.color);
  return route.code ? (
    <span aria-hidden className="roundel" style={disc}>
      {route.code}
    </span>
  ) : (
    <span aria-hidden className="roundel">
      <i className="dot" style={{ background: disc.background }} />
    </span>
  );
}

export function DepotCoverAux() {
  const lines = useNodeStore((s) => s.lines);
  const routes = useNodeStore((s) => s.routes);
  const bookId = useDepotStore((s) => s.bookId);
  const data = useDepotStore((s) => s.data);
  const openBook = useDepotStore((s) => s.openBook);
  const arrived = routes.filter((r) => r.arrived_on !== null);
  // 済章＝車庫裡這幾條路線的（同頁首補述）
  const seals = data ? arrived.reduce((sum, r) => sum + (data.routeSeals[r.id] ?? 0), 0) : null;
  const groups = lines
    .map((l) => ({ line: l, list: arrived.filter((r) => r.line_id === l.id) }))
    .filter((g) => g.list.length > 0);

  return (
    <div className="lines-scroll">
      <div className="lines ns-depot-aux" aria-label="車庫目錄">
        <h2>車庫 DEPOT</h2>
        <p className="ns-depot-aux-total">
          <span>
            <b>{arrived.length}</b> 條到站
          </span>
          {seals !== null && (
            <span>
              <b>{seals}</b> 枚済章
            </span>
          )}
        </p>
        {groups.length === 0 && <p className="ns-depot-aux-empty">還沒有到站的路線</p>}
        {groups.map((g) => (
          <section key={g.line.id} aria-label={`幹線 ${g.line.name}`}>
            <div className="trunk">幹線・{g.line.name}</div>
            {g.list.map((r) => {
              const on = bookId === r.id;
              return (
                <button
                  key={r.id}
                  type="button"
                  className={`line-item${on ? " active" : ""}`}
                  aria-current={on ? "page" : undefined}
                  title={`${r.name}的乘車記錄簿`}
                  onClick={() => openBook(r.id)}
                >
                  <Roundel route={r} />
                  <span className="line-name">{r.name}</span>
                  <span className="ns-depot-aux-when">{Number(r.arrived_on!.slice(5, 7))}月</span>
                </button>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}
