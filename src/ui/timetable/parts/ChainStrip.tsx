/**
 * ChainStrip——發車台行為鏈快選列（v1.39 4B）。
 *
 * - 當有未封存的行為鏈時，渲染橫向可捲動的「行為鏈直通発車帶」（含站點色點預覽、總站數與總預估時長），點一下即啟動。
 * - 尚未建立任何行為鏈時（載入完成後），不塞滿大卡片，只顯示一條極簡柔和的「＋ 建立行為鏈」小入口。
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { categoryColorCss } from "../../../domain/timetable";
import { chainTotalMin, formatChainDuration, resolveStepTitle } from "../../../domain/timetableChain";
import { useTimetableChainStore } from "../../../store/timetableChainStore";
import { useTimetableStore } from "../../../store/timetableStore";
import { IconPlus } from "../../common/icons";
import "../timetable-chains.css";

const MAX_DOTS = 5;

export function ChainStrip() {
  const chains = useTimetableChainStore((s) => s.chains);
  const loaded = useTimetableChainStore((s) => s.loaded);
  const active = useTimetableChainStore((s) => s.active);
  const loadChains = useTimetableChainStore((s) => s.loadChains);
  const startChain = useTimetableChainStore((s) => s.startChain);
  const openChainsManager = useTimetableChainStore((s) => s.openChainsManager);

  const running = useTimetableStore((s) => s.running);
  const catById = useTimetableStore((s) => s.catById);

  useEffect(() => {
    if (!loaded) void loadChains();
  }, [loaded, loadChains]);

  const activeChains = useMemo(() => chains.filter((c) => c.archivedAt === null), [chains]);

  const stripRef = useRef<HTMLDivElement>(null);
  const [atEnd, setAtEnd] = useState(true);

  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const check = (): void => setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 2);
    check();
    el.addEventListener("scroll", check, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(check) : null;
    ro?.observe(el);
    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 0) return;
      if ((e.deltaY < 0 && el.scrollLeft <= 0) || (e.deltaY > 0 && el.scrollLeft >= max - 1)) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("scroll", check);
      el.removeEventListener("wheel", onWheel);
      ro?.disconnect();
    };
  }, [activeChains.length]);

  // 載入前不畫空狀態，防止首屏閃爍（視覺規範 §1.8）
  if (!loaded) return null;

  if (activeChains.length === 0) {
    return (
      <div className="ns-tt-chainempty" aria-label="行為鏈快速入口">
        <span className="ns-tt-chainempty-hint">把連續動作串成直通班次，一站接一站発車</span>
        <button type="button" className="ns-btn btn-text ns-tt-chainempty-btn" onClick={openChainsManager}>
          <IconPlus size={12} />
          建立行為鏈
        </button>
      </div>
    );
  }

  const runningChainId =
    active && running && (active.runningBlockId === null || active.runningBlockId === running.id) ? active.chainId : null;

  return (
    <>
      <div className="ns-tt-sec ns-tt-chainsec ns-washi-strip">
        <h3>行為鏈</h3>
        <span className="ns-tt-sec-rule" />
        <span className="ns-tt-sec-note">
          <b className="ns-tt-num">{activeChains.length}</b> 條・直通発車
        </span>
        <button type="button" className="ns-btn btn-text ns-tt-chainsec-mgr" onClick={openChainsManager}>
          管理
        </button>
      </div>
      <div ref={stripRef} className={"ns-tt-chainstrip" + (atEnd ? " is-end" : "")} role="list" aria-label="行為鏈直通発車列">
        {activeChains.map((c) => {
          const isLive = runningChainId === c.id;
          const total = chainTotalMin(c.steps);
          const preview = c.steps
            .map((s) => resolveStepTitle(s, catById[s.categoryId]?.name))
            .join(" → ");
          const shownSteps = c.steps.slice(0, MAX_DOTS);
          const extraDots = Math.max(0, c.steps.length - MAX_DOTS);

          return (
            <button
              key={c.id}
              type="button"
              role="listitem"
              className={"ns-tt-chaincard" + (isLive ? " is-live" : "")}
              title={
                isLive && active
                  ? `運行中：${c.name}（第 ${active.stepIndex + 1}/${active.steps.length} 站）`
                  : `啟動行為鏈「${c.name}」：${preview}（共 ${formatChainDuration(total)}）`
              }
              onClick={() => void startChain(c.id)}
            >
              <span className="ns-tt-chaincard-top">
                <span className="ns-tt-chaincard-name">{c.name}</span>
                <span className="ns-tt-chaincard-go">
                  {isLive && active ? `運行中 ${active.stepIndex + 1}/${active.steps.length}` : "▶ 発車"}
                </span>
              </span>
              <span className="ns-tt-chaincard-dots" aria-hidden="true">
                {shownSteps.map((s, idx) => {
                  const cat = catById[s.categoryId] ?? null;
                  const dotColor = categoryColorCss(cat, 8);
                  return (
                    <span key={idx} style={{ display: "inline-flex", alignItems: "center", gap: "3px" }}>
                      {idx > 0 && <span className="ns-tt-chaincard-rail" />}
                      <span className="ns-tt-chaincard-dot" style={{ "--c": dotColor } as CSSProperties} />
                    </span>
                  );
                })}
                {extraDots > 0 && <span className="ns-tt-chaincard-more">+{extraDots}</span>}
              </span>
              <span className="ns-tt-chaincard-foot">
                <span className="ns-tt-chaincard-steps">{preview}</span>
                <span className="ns-tt-num" style={{ flex: "none" }}>
                  {c.steps.length}站 {formatChainDuration(total)}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}
