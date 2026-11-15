/**
 * IdealPeek——今日頁頂部方針帶內的「心之所向」常駐題詞列與「✦ 理想手札」雙欄車窗抽屜預覽（第六本第四梯 v1.30；D-主-561、562）。
 *
 * 桌機 `AimsBand`（`todayTab` 模式）與手機 `MobileAimsLine`（`upper` 今日模式＋底部面板 `✦ 理想` 分頁）共用同一份資料與互動。
 */
import { useEffect, useMemo } from "react";
import {
  IDEAL_THEME_LABEL,
  WINDOW_CATEGORY_LABEL,
  aliveIdealCards,
  formatPastPromptCue,
  pastReflectionsForPrompt,
  resolvePinnedMotto,
} from "../../domain/idealTecho";
import { resolveCurrentWindowPrompt, useIdealStore } from "../../store/idealStore";
import { useUiStore } from "../../store/uiStore";
import { IconChevron } from "../common/icons";
import "../ideal/ideal.css";

function goFrontispiece(shell: "desktop" | "mobile", afterClose?: () => void, openCreate = false) {
  afterClose?.();
  const ui = useUiStore.getState();
  if (shell === "mobile") ui.setMobileTab("ideal");
  else ui.setPage("ideal");
  if (openCreate) useIdealStore.getState().openCreateCard();
}

/** 今日頂端「✦ 心之所向」常駐題詞列（即使方針收合也溫柔保留；沒有釘選時回 null、不佔版面） */
export function TodayMottoBar({ shell }: { shell: "desktop" | "mobile" }) {
  const cards = useIdealStore((s) => s.cards);
  const reflections = useIdealStore((s) => s.reflections);

  useEffect(() => {
    void useIdealStore.getState().ensureLoaded();
  }, []);

  const pinned = useMemo(() => resolvePinnedMotto(cards, reflections), [cards, reflections]);
  if (!pinned) return null;

  if (shell === "mobile") {
    return (
      <button
        type="button"
        className="wa-mmotto"
        onClick={() => goFrontispiece("mobile")}
        title="翻開車窓・理想手札"
      >
        <span className="wa-motto-tag">✦ 心之所向</span>
        <span className="wa-motto-text">{pinned.motto}</span>
        <IconChevron />
      </button>
    );
  }

  return (
    <button
      type="button"
      className="wa-motto-bar"
      onClick={() => goFrontispiece("desktop")}
      title="翻開車窓・理想手札"
    >
      <span className="wa-motto-bar-left">
        <span className="wa-motto-tag">✦ 心之所向</span>
        <span className="wa-motto-text">{pinned.motto}</span>
      </span>
      <span className="wa-motto-go">翻開扉頁 ›</span>
    </button>
  );
}

/** 點開「✦ 理想手札」頁籤時的精簡雙欄抽屜（左：今日車窓の問い；右：終點站的風景手札卡一瞥） */
export function IdealPeekDrawer({
  today,
  shell,
  onAfterNavigate,
}: {
  today: string;
  shell: "desktop" | "mobile";
  onAfterNavigate?: () => void;
}) {
  const cards = useIdealStore((s) => s.cards);
  const reflections = useIdealStore((s) => s.reflections);
  const shuffleDay = useIdealStore((s) => s.shuffleDay);
  const shuffleOffset = useIdealStore((s) => s.shuffleOffset);
  const promptOverride = useIdealStore((s) => s.promptOverride);

  useEffect(() => {
    void useIdealStore.getState().ensureLoaded();
  }, []);

  const aliveCards = useMemo(() => aliveIdealCards(cards), [cards]);
  const prompt = useMemo(
    () => resolveCurrentWindowPrompt(today, shuffleDay, shuffleOffset, promptOverride),
    [today, shuffleDay, shuffleOffset, promptOverride],
  );
  const pastCue = useMemo(
    () => formatPastPromptCue(pastReflectionsForPrompt(reflections, prompt.promptKey)),
    [reflections, prompt.promptKey],
  );

  return (
    <div className="wa-ideal-peek">
      <div className="wa-ideal-col">
        <div className="wa-ideal-col-head">
          <span className="wa-ideal-col-kicker">
            🪟 今日車窓の問い · {WINDOW_CATEGORY_LABEL[prompt.category]}
          </span>
          <button
            type="button"
            className="ns-btn btn-text ns-btn--sm"
            onClick={() => useIdealStore.getState().shufflePrompt(today)}
          >
            換一題 ↻
          </button>
        </div>
        <p className="wa-ideal-prompt-q">
          {prompt.question.trim() || "今天想自己擬一道問題問問心裡的自己…"}
        </p>
        {pastCue && <p className="wa-sub">{pastCue}</p>}
        <div className="wa-ideal-col-foot">
          <span className="wa-sub">無打卡壓力 · 隨時可寫</span>
          <button
            type="button"
            className="ns-btn btn-ghost ns-btn--sm"
            onClick={() => goFrontispiece(shell, onAfterNavigate, false)}
          >
            在扉頁寫下回答 ›
          </button>
        </div>
      </div>

      <div className="wa-ideal-col">
        <div className="wa-ideal-col-head">
          <span className="wa-ideal-col-kicker">
            終點站的風景 · {aliveCards.length} 幀手札卡
          </span>
          <span className="wa-sub">無期限</span>
        </div>
        {aliveCards.length > 0 ? (
          <div className="wa-ideal-mini-cards">
            {aliveCards.slice(0, 3).map((c) => (
              <div key={c.id} className="wa-ideal-mini-item">
                <span className="wa-ideal-mini-theme">{IDEAL_THEME_LABEL[c.theme]}</span>
                <span className="wa-ideal-mini-title">{c.title}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="wa-ideal-prompt-q">
            還沒寫下風景卡——去扉頁安放「我想成為的人」或「理想的生活風景」吧。
          </p>
        )}
        <div className="wa-ideal-col-foot">
          <button
            type="button"
            className="ns-btn btn-ghost ns-btn--sm"
            onClick={() => goFrontispiece(shell, onAfterNavigate, true)}
          >
            ＋ 添一幀風景
          </button>
          <button
            type="button"
            className="ns-btn btn-text ns-btn--sm"
            onClick={() => goFrontispiece(shell, onAfterNavigate, false)}
          >
            翻開完整理想手札 ›
          </button>
        </div>
      </div>
    </div>
  );
}
