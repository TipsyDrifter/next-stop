/**
 * MobileCompleteCard——手機的完成卡（手機殼班 D-主-73／77；原型 `prototypes/主線-手機殼班.html` Q3）。
 *
 * 同桌機 CompleteCard 的槽與存法：唯一來源＝`uiStore.completeCardFor`（今日頁 useMobileToday.complete、行程表 scheduleActions
 *   蓋下列車／車廂時寫進去）；「存入」＝有選心情 → updateNode({ mood })、有字 → addWorkLog；「跳過」＝整卡不落。
 *   觸發與取消的規則在呼叫端（同桌機），本檔只畫與存。
 *
 * 跟桌機刻意不同的三處（D-主-77）：
 *   1. 輸入框**不自動聚焦**——手機一聚焦就彈軟鍵盤蓋掉半個畫面，連蓋幾張很煩；要記才點。
 *   2. **壓在建票列的位置**——MobileShell 把本元件掛在 tab bar 之後，`complete-card.css` 用 flex `order` 把它排到 tab bar 上面、
 *      在直欄裡佔一段高（清單底部自然讓出來，最後一張票捲得到），今日頁的建票列在卡開著時收起（同時只留一條底部輸入列；
 *      收的是 CSS display，打到一半的字不會丟）。
 *   3. **不計時消失**——「想一下再記」很常見，消失了就找不回來。
 *
 * 不阻擋：沒有暗幕，清單照樣能捲、能蓋別張（蓋別張＝同一個槽換成那張的內容）。
 * 節點不見了（刪除、同步收到刪除）卡自己收起；找節點同 MobileDetailHost（切片＞repository），見元件內註解。
 * 返回層：登記 "page" 種類——返回鍵＝跳過；它不是面板，不該把 toast 搬到頂端（`data-m-layer` 只寫 page 以外的種類）；
 *   卡開著時再開 ⋯ sheet，sheet 權重較高、先關 sheet。Esc（外接鍵盤）＝跳過，只在返回堆疊最上面是本卡時吃（同 MSheet）。
 * 高度量了寫進 `<html>` 的 `--m-cc-h`（同 SyncBanner 的 `--m-banner-h`）：toast 與各線浮鈕靠它讓位，見 css 檔頭。
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { KIND_LABEL, type Mood, type NodeRow } from "../../../domain";
import { nodeRepo } from "../../../data";
import { useNodeStore } from "../../../store/nodeStore";
import { useUiStore } from "../../../store/uiStore";
import { MOODS } from "../../complete/moods";
import { backStack, useBackLayer } from "../backStack";
import "./complete-card.css";

const LAYER_ID = "core.completeCard";

export function MobileCompleteCard() {
  const id = useUiStore((s) => s.completeCardFor);
  if (!id) return null;
  return <MobileCompleteCardInner key={id} id={id} />;
}

function MobileCompleteCardInner({ id }: { id: string }) {
  // 今日頁蓋章時節點不在 tree 裡、行程表蓋章時可能只在 calendar 切片裡——三處都找
  const sliced = useNodeStore((s) => s.tree.byId[id] ?? s.today.byId[id] ?? s.calendar.nodes[id]);
  const tree = useNodeStore((s) => s.tree);
  const today = useNodeStore((s) => s.today);
  const calendar = useNodeStore((s) => s.calendar);
  const setCompleteCardFor = useUiStore((s) => s.setCompleteCardFor);

  // 三個切片都沒有（搬到別條路線、切片換了）就問 repository——同 MobileDetailHost 的找法；切片每換一次重問。
  // 問到「沒有／已刪」＝節點不見了（刪除、同步收到別台刪除）：卡自己收起（第二輪，反方評審 correctness minor）——
  //   卡不計時消失（D-主-77），不收就一直停在通稱，「存入」還會把心情與記錄寫到已刪的節點上。
  //   搬走的節點還在：名字照樣問得到，卡留著（剛到站這件事沒變）。
  const [fetched, setFetched] = useState<{ row: NodeRow | null } | null>(null);
  useEffect(() => {
    if (sliced) return;
    let alive = true;
    void nodeRepo
      .getNode(id)
      .then((n) => {
        if (alive) setFetched({ row: n && !n.deleted_at ? n : null });
      })
      .catch(() => {
        if (alive) setFetched({ row: null });
      });
    return () => {
      alive = false;
    };
  }, [id, sliced, tree, today, calendar]);
  const gone = !sliced && fetched !== null && fetched.row === null;
  useEffect(() => {
    if (gone) setCompleteCardFor(null);
  }, [gone, setCompleteCardFor]);
  const node = sliced ?? fetched?.row ?? undefined;

  const [mood, setMood] = useState<Mood | null>(null);
  const [text, setText] = useState("");
  const savingRef = useRef(false);
  const composing = useRef(false);
  const dockRef = useRef<HTMLDivElement>(null);

  const close = () => setCompleteCardFor(null);

  useBackLayer(LAYER_ID, true, close, "page");

  // Esc：只在返回堆疊最上面是本卡時吃（上面疊著 sheet／確認框就讓它們先處理）
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing || e.keyCode === 229 || e.defaultPrevented) return;
      if (backStack.top()?.id !== LAYER_ID) return;
      e.preventDefault();
      setCompleteCardFor(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setCompleteCardFor]);

  // 卡高寫進 <html>（toast／浮鈕讓位用）；字級、折行會變高，用 ResizeObserver 跟著量
  useEffect(() => {
    const el = dockRef.current;
    if (!el) return;
    const root = document.documentElement;
    const write = () => root.style.setProperty("--m-cc-h", `${Math.round(el.getBoundingClientRect().height)}px`);
    write();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(write) : null;
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      root.style.removeProperty("--m-cc-h");
    };
  }, []);

  const save = async () => {
    if (savingRef.current || gone) return;
    savingRef.current = true;
    const body = text.trim();
    try {
      if (mood) await useNodeStore.getState().updateNode(id, { mood });
      if (body) {
        const ok = await useNodeStore.getState().addWorkLog(id, body);
        // 沒寫進去（store 已寫 error 列）：卡留著、字也留著，可以再按一次；心情已存的那半不重來也無妨（同值覆寫）
        if (!ok) return;
      }
      close();
    } finally {
      savingRef.current = false;
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    // IME 守門（同建票列：部分 Android IME 的 keydown 既不帶 isComposing 也不是 229）
    if (e.nativeEvent.isComposing || e.keyCode === 229 || composing.current) return;
    e.preventDefault();
    void save();
  };

  const name = node?.name ?? "這班列車";
  const kindLabel = node ? KIND_LABEL[node.kind] : "列車";

  return (
    <div className="m-cc-dock" ref={dockRef}>
      <div role="dialog" aria-label={`完成卡：${name}`} className="complete-card m-cc">
        {/* 済章：原型検印欄（章已蓋上；靜態） */}
        <div className="stamp-zone is-done" aria-hidden>
          <span className="stamp">
            <span className="hint">検印</span>
            <span className="seal">済</span>
          </span>
        </div>

        <div className="m-cc-body">
          <p className="m-cc-head">
            <span className="m-cc-kind">{kindLabel}到站</span>
            <span className="m-cc-title">{name}</span>
          </p>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            placeholder="這一趟做了什麼？（選填）"
            aria-label="一行乘務記錄"
            enterKeyHint="done"
            spellCheck={false}
            autoComplete="off"
            className="techo-input m-cc-input"
          />
          <div className="m-cc-row">
            {/* 心情三燈（可不選；再點一次＝取消） */}
            <span role="radiogroup" aria-label="心情" className="m-cc-moods">
              {MOODS.map((m) => {
                const on = mood === m.value;
                return (
                  <button
                    key={m.value}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    aria-label={`心情：${m.label}`}
                    onClick={() => setMood(on ? null : m.value)}
                    className={"m-cc-mood" + (on ? " on" : "")}
                    style={{ color: m.color }}
                  >
                    <span className="badge dashed" aria-hidden>
                      {m.glyph}
                    </span>
                  </button>
                );
              })}
            </span>
            <button type="button" onClick={close} aria-label="跳過完成卡" className="ns-btn btn-ghost m-cc-btn">
              跳過
            </button>
            <button type="button" onClick={() => void save()} className="ns-btn btn-seal m-cc-btn">
              存入
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
