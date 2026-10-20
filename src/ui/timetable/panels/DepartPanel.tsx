/**
 * DepartPanel——発車／換車面板（車次①a 契約 §5.4；丙席；＝原型 `shared.js` openDepartSheet，拿掉「綁車票」）。
 * 副標（運行中：「『X』會在出發時間自動到站，中間不留空白」／停車中：「點分類就開始計時」）；
 * 「出發」chips：現在／5 分前／10 分前／20 分前／停車中且上一塊尾 < 現在時加「接上一塊 HH:MM」；右側「＝ HH:MM」；
 * 選的時間會蓋掉紀錄時多一行赭字（W1）；分類格 compact，點了即 `store.depart(cat, at)`。
 * 標題由 host 給（運行中：「換車——接下來做什麼？」／停車中：「発車——接下來做什麼？」）。
 *
 * 「現在」以**點下分類那一刻**為準（契約 §5.4；原型 openDepartSheet 每次 draw() 重算 now）：面板開著停幾分鐘再點，
 * 「現在」仍是現在，store.depart 的「出發＝現在 ⇒ 帶『改 10 分前』」判定才對。畫面上的「＝ HH:MM」與 W1 預演用
 * 分鐘級的 now（每秒跟著跳、但一分鐘才換一次值，避免每秒重問 previewCover）。
 *
 * 車次①b（①b①c 契約 §5.3；乙席；長相＝原型 `v-e.js` 情境 5 departBody）：「出發」那一列之後放「預估」，預設收起：
 *   收起＝button.ns-tt-opt.ns-tt-est-open「＋預估」＋一行小字；
 *   展開＝Row k="預估"：30 分｜1h｜1h30｜2h｜3h（單選、再點一次＝取消）＋「收起」（選了之後叫「不預估」，按了清掉並收起）。
 * 選了預估時「＝ HH:MM」後面多「預計 HH:MM 到着」。點分類＝`depart(id, at, estimateMin)`；收起／沒選＝null；面板關掉不記住。
 *
 * 車次②（② 契約 §5.5、〈原型拍板〉4；乙席；長相＝原型 `v-f.js` departBody）：「預估」之後一列「連到」（LinkRow，預設沒連），
 * 點了面板換成 LinkPicker 子頁（‹ 回來；選了就回來）。連到的票（或路線）有上次的分類 ⇒ 下面多一顆主鈕「用『X』発車」
 * （Enter 也行），分類格那一格描金寫「上次」；沒有 ⇒ 一行金字提示「點一個分類，下次就直接用」。
 * 點分類或主鈕＝`depart(cat, at, est, link)`。運行中那班「同分類、同連結」才吐「已經在跑」（換了連結＝換一件事，照發）。
 */
import { useEffect, useRef, useState } from "react";
import { MIN, fmtClock, msOf, type BlockLink } from "../../../domain/timetable";
import { linkLabelOf, linkOfRow } from "../../../domain/timetableLink";
import { TT_TEXT, useTimetableStore } from "../../../store/timetableStore";
import { useUiStore } from "../../../store/uiStore";
import { formatChord, isEditableTarget } from "../../shell/hotkeys";
import { CategoryGrid } from "../parts/CategoryGrid";
import { LinkPicker, LinkRow, useLastCategory } from "../parts/LinkPicker";
import { useNow } from "../useNow";
import { useBackLayer } from "../../mobile/backStack";
import { ESTIMATE_OPTIONS, Expand, Opt, Opts, Row, Sub, useCoverWarn, type PanelProps } from "./controls";

export type { PanelProps } from "./controls";

type Back = 0 | 5 | 10 | 20 | "prev";
const BACKS: readonly [Exclude<Back, "prev">, string][] = [
  [0, "現在"],
  [5, "5 分前"],
  [10, "10 分前"],
  [20, "20 分前"],
];

export function DepartPanel({ onDone }: PanelProps) {
  const tick = useNow(1000);
  const now = Math.floor(tick / MIN) * MIN; // 分鐘級：顯示與 W1 預演用
  const running = useTimetableStore((s) => s.running);
  const catById = useTimetableStore((s) => s.catById);
  const todayBlocks = useTimetableStore((s) => s.todayBlocks);
  const depart = useTimetableStore((s) => s.depart);
  const linkInfo = useTimetableStore((s) => s.linkInfo);
  const [back, setBack] = useState<Back>(0);
  const [link, setLink] = useState<BlockLink | null>(null);
  const [picking, setPicking] = useState(false);
  const mem = useLastCategory(link);
  const memCat = mem ? (catById[mem.categoryId] ?? null) : null;
  const [estOpen, setEstOpen] = useState(false);
  const [est, setEst] = useState<number | null>(null);

  // 上一塊的尾巴（停車中的「接上一塊」）：今天已結束的塊裡結束最晚的那一塊
  let prevEnd: number | null = null;
  if (!running) {
    for (const b of todayBlocks) {
      if (b.ended_at === null) continue;
      const e = msOf(b.ended_at);
      if (e < tick && (prevEnd === null || e > prevEnd)) prevEnd = e;
    }
  }
  const effectiveBack: Back = back === "prev" && prevEnd === null ? 0 : back;
  const atOf = (base: number): number => (effectiveBack === "prev" ? (prevEnd as number) : base - effectiveBack * MIN);
  const at = atOf(now);
  // 運行中那班「在出發時間自動到站」是預期行為（副標已說），不算 W1 的「切短」；出發早於它的開始時它會被收掉，仍要算
  const runningStart = running ? msOf(running.started_at) : null;
  const exceptId = running && runningStart !== null && at >= runningStart ? running.id : null;
  const warn = useCoverWarn(at, null, exceptId, at < tick - MIN / 2);

  const pick = (id: string): void => {
    const rl = running ? linkOfRow(running) : null;
    const sameLink = rl !== null && (link?.nodeId ?? null) === rl.nodeId && (link?.routeId ?? null) === rl.routeId;
    if (running && running.category_id === id && sameLink) {
      useUiStore.getState().showToast({ message: TT_TEXT.alreadyRunning });
      return;
    }
    const atNow = atOf(Date.now()); // 以點下的這一刻為準
    onDone();
    void depart(id, atNow, estOpen ? est : null, link);
  };
  const estOn = estOpen && est !== null;

  // 〈原型拍板〉4：主鈕＝Enter（焦點在按鈕或輸入框上時交給它們自己；IME 組字中不吃）
  const pickRef = useRef(pick);
  pickRef.current = pick;
  const memId = memCat && !picking ? memCat.id : null;
  useEffect(() => {
    if (!memId) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key !== "Enter" || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      if (isEditableTarget(e.target) || (e.target instanceof HTMLElement && e.target.closest("button"))) return;
      e.preventDefault();
      pickRef.current(memId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [memId]);

  // 磨光①：手機返回鍵＝連結挑選的「‹」（疊在 timetable.sheet 上；桌機 no-op）
  useBackLayer("timetable.departLink", picking, () => setPicking(false));

  if (picking) {
    return (
      <div className="ns-tt-panel ns-tt-panel-depart is-picking">
        <LinkPicker
          value={link}
          onBack={() => setPicking(false)}
          onPick={(l) => {
            setLink(l);
            setPicking(false);
          }}
        />
      </div>
    );
  }
  const runLabelText = running ? linkLabelOf(running, linkInfo) : null;

  return (
    <div className="ns-tt-panel ns-tt-panel-depart">
      <Sub>
        {running
          ? `「${catById[running.category_id]?.name ?? "？"}${runLabelText ? "・" + runLabelText : ""}」會在出發時間自動到站，中間不留空白`
          : "點分類就開始計時"}
      </Sub>
      <Row k="出發" top>
        <Opts>
          {BACKS.map(([v, t]) => (
            <Opt key={v} on={effectiveBack === v} onClick={() => setBack(v)}>
              {t}
            </Opt>
          ))}
          {prevEnd !== null && (
            <Opt on={effectiveBack === "prev"} onClick={() => setBack("prev")}>
              接上一塊 {fmtClock(prevEnd)}
            </Opt>
          )}
          <span className="ns-tt-opt is-solid is-num is-static" aria-live="polite">
            ＝ {fmtClock(at)}
            {estOn && <span className="ns-tt-est-eta">　預計 {fmtClock(at + (est as number) * MIN)} 到着</span>}
          </span>
        </Opts>
      </Row>
      {estOpen ? (
        <Expand className="ns-tt-est-wrap">
          <Row k="預估" top>
            <Opts>
              {ESTIMATE_OPTIONS.map(([v, t]) => (
                <Opt key={v} on={est === v} onClick={() => setEst(est === v ? null : v)}>
                  {t}
                </Opt>
              ))}
              <button
                type="button"
                className="ns-tt-opt is-link"
                onClick={() => {
                  setEst(null);
                  setEstOpen(false);
                }}
              >
                {est !== null ? "不預估" : "收起"}
              </button>
            </Opts>
          </Row>
        </Expand>
      ) : (
        <div className="ns-tt-row is-fold">
          <span className="ns-tt-row-k" />
          <span className="ns-tt-row-v">
            <button type="button" className="ns-tt-opt ns-tt-est-open" onClick={() => setEstOpen(true)}>
              ＋預估
            </button>
            <span className="ns-tt-est-hint">想給這一班一個長度再點；超過了會提醒</span>
          </span>
        </div>
      )}
      <LinkRow value={link} onOpen={() => setPicking(true)} />
      {memCat ? (
        <>
          <button type="button" className="ns-btn btn-seal ns-tt-link-memgo" onClick={() => pick(memCat.id)}>
            <svg width="10" height="10" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M5 3.5v9l7-4.5z" fill="currentColor" />
            </svg>
            <span>用「{memCat.name}」発車</span>
            <em>上次的分類</em>
            <kbd className="ns-tt-kbd ns-tt-link-memkbd" aria-hidden="true">
              {formatChord({ key: "Enter" }).join("+")}
            </kbd>
          </button>
          <p className="ns-tt-panel-sub ns-tt-link-memsub">點下方可換分類</p>
        </>
      ) : link && mem === null ? (
        <p className="ns-tt-panel-sub ns-tt-link-hint">先選個分類，下次從這裡発車就會自動套用</p>
      ) : null}
      {warn && <Sub warn>{warn}</Sub>}
      <CategoryGrid selected={null} onPick={pick} compact runningId={running?.category_id ?? null} memId={memCat?.id ?? null} />
    </div>
  );
}
