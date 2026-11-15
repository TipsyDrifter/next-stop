/**
 * 車窓・理想手札——扉頁主體（桌機與手機共用互動核心；第六本第四梯 v1.30；D-主-560～564）。
 *
 * 五段結構：
 *   1. 置頂「✦ 心之所向」題詞橫幅（有釘選時顯示）
 *   2. 「🪟 車窓の問い」零壓力每日車窗問答盒（換一題、自訂題目、同步記進今日日記）
 *   3. 「終點站的風景」三大主題風景卡格線（內建 12 幅鐵道車窗線畫＋自選壓縮相片）
 *   4. 「行路對照」三尺度方針橫向並排卡（今年 · 本月 · 本週）
 *   5. 「車窗問答拾光 · 跨時空回顧」同題多年／跨季並排對照卡（支援「再答一次」、原地編輯、跳轉當日日記）
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  IDEAL_THEMES,
  IDEAL_THEME_LABEL,
  WINDOW_CATEGORY_LABEL,
  aliveIdealCards,
  formatPastPromptCue,
  groupReflectionsByPrompt,
  pastReflectionsForPrompt,
  resolvePinnedMotto,
  type IdealCardRow,
  type IdealReflectionRow,
} from "../../domain/idealTecho";
import { todayKey } from "../../lib/date";
import { lineById } from "../../lines";
import {
  resolveCurrentWindowPrompt,
  useIdealStore,
} from "../../store/idealStore";
import { useNotesStore } from "../../store/notesStore";
import { useUiStore } from "../../store/uiStore";
import { EmptyState } from "../common/EmptyState";
import { IconDots, IconPlus } from "../common/icons";
import { MSheet, MSheetItem } from "../common/MSheet";
import { PopMenu, type PopMenuItem } from "../common/PopMenu";
import { useBackLayer } from "../mobile/backStack";
import { IdealAimsMatrix } from "./IdealAimsMatrix";
import { IdealArtSvg } from "./IdealArtSvg";
import { IdealCardDialog } from "./IdealCardDialog";
import "./ideal.css";

interface IdealTechoBodyProps {
  shell: "desktop" | "mobile";
}

type MenuState =
  | { kind: "card"; item: IdealCardRow; anchor: HTMLElement }
  | { kind: "reflection"; item: IdealReflectionRow; anchor: HTMLElement };

export function IdealTechoBody({ shell }: IdealTechoBodyProps) {
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const day = todayKey(dayStartHour);

  const cards = useIdealStore((s) => s.cards);
  const reflections = useIdealStore((s) => s.reflections);
  const loaded = useIdealStore((s) => s.loaded);
  const loading = useIdealStore((s) => s.loading);
  const shuffleDay = useIdealStore((s) => s.shuffleDay);
  const shuffleOffset = useIdealStore((s) => s.shuffleOffset);
  const promptOverride = useIdealStore((s) => s.promptOverride);
  const syncDiaryPref = useIdealStore((s) => s.syncDiaryPref);
  const themeFilter = useIdealStore((s) => s.themeFilter);
  const cardDialog = useIdealStore((s) => s.cardDialog);

  const ensureLoaded = useIdealStore((s) => s.ensureLoaded);
  const shufflePrompt = useIdealStore((s) => s.shufflePrompt);
  const startCustomPrompt = useIdealStore((s) => s.startCustomPrompt);
  const setCustomPromptQuestion = useIdealStore((s) => s.setCustomPromptQuestion);
  const startReanswer = useIdealStore((s) => s.startReanswer);
  const clearPromptOverride = useIdealStore((s) => s.clearPromptOverride);
  const setSyncDiaryPref = useIdealStore((s) => s.setSyncDiaryPref);
  const setThemeFilter = useIdealStore((s) => s.setThemeFilter);
  const openCreateCard = useIdealStore((s) => s.openCreateCard);
  const openEditCard = useIdealStore((s) => s.openEditCard);
  const closeCardDialog = useIdealStore((s) => s.closeCardDialog);
  const deleteCard = useIdealStore((s) => s.deleteCard);
  const togglePin = useIdealStore((s) => s.togglePin);
  const submitReflection = useIdealStore((s) => s.submitReflection);
  const updateReflection = useIdealStore((s) => s.updateReflection);
  const deleteReflection = useIdealStore((s) => s.deleteReflection);

  const [answerText, setAnswerText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [editingRefId, setEditingRefId] = useState<string | null>(null);
  const [editingRefAnswer, setEditingRefAnswer] = useState("");
  const windowBoxRef = useRef<HTMLDivElement>(null);
  const answerInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void ensureLoaded();
  }, [ensureLoaded]);

  useBackLayer("core.ideal.menu", shell === "mobile" && menu !== null, () => setMenu(null), "sheet");

  const aliveCards = useMemo(() => aliveIdealCards(cards), [cards]);
  const filteredCards = useMemo(
    () => (themeFilter === "all" ? aliveCards : aliveCards.filter((c) => c.theme === themeFilter)),
    [aliveCards, themeFilter],
  );
  const themeCounts = useMemo(() => {
    const map = { person: 0, scenery: 0, horizon: 0 };
    for (const c of aliveCards) map[c.theme] = (map[c.theme] ?? 0) + 1;
    return map;
  }, [aliveCards]);

  const pinnedMotto = useMemo(() => resolvePinnedMotto(cards, reflections), [cards, reflections]);
  const promptGroups = useMemo(() => groupReflectionsByPrompt(reflections), [reflections]);

  const currentPrompt = useMemo(
    () => resolveCurrentWindowPrompt(day, shuffleDay, shuffleOffset, promptOverride),
    [day, shuffleDay, shuffleOffset, promptOverride],
  );

  const pastForCurrent = useMemo(
    () =>
      currentPrompt.promptKey && currentPrompt.promptKey !== "custom:"
        ? pastReflectionsForPrompt(reflections, currentPrompt.promptKey)
        : [],
    [reflections, currentPrompt.promptKey],
  );
  const pastCue = useMemo(() => formatPastPromptCue(pastForCurrent), [pastForCurrent]);

  const notesManifest = lineById("notes");
  const notesEnabled =
    (shell === "mobile" ? notesManifest.mobile.status : notesManifest.page.status) === "open";

  const handleSubmitAnswer = async () => {
    if (submitting) return;
    setSubmitting(true);
    const created = await submitReflection({
      promptKey: currentPrompt.promptKey,
      category: currentPrompt.category,
      question: currentPrompt.question,
      answer: answerText,
      answeredOn: day,
      syncDiary: syncDiaryPref,
    });
    setSubmitting(false);
    if (created) {
      setAnswerText("");
    }
  };

  const handleJumpToDiary = (entryDate: string, diaryNoteId: string | null) => {
    if (!notesEnabled) return;
    const ui = useUiStore.getState();
    if (shell === "desktop") {
      ui.setSettingsOpen(false);
      ui.setPage("notes");
    } else {
      ui.setMobileTab("notes");
    }
    const ns = useNotesStore.getState();
    ns.openDiaryAt(entryDate);
    if (diaryNoteId) ns.selectDiaryEntry(diaryNoteId);
  };

  const handleReanswerClick = (g: { promptKey: string; category: IdealReflectionRow["category"]; question: string }) => {
    startReanswer(g);
    windowBoxRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => answerInputRef.current?.focus(), 180);
  };

  const menuItemsFor = (m: MenuState): PopMenuItem[] => {
    if (m.kind === "card") {
      const isPinned = pinnedMotto?.kind === "card" && pinnedMotto.id === m.item.id;
      return [
        {
          key: "edit",
          label: "編輯風景卡",
          onSelect: () => {
            setMenu(null);
            openEditCard(m.item);
          },
        },
        {
          key: "pin",
          label: isPinned ? "收起「心之所向」釘選" : "釘選為今日「心之所向」",
          onSelect: () => {
            setMenu(null);
            void togglePin({ kind: "card", id: m.item.id });
          },
        },
        {
          key: "delete",
          label: "移除風景卡",
          cut: true,
          danger: true,
          onSelect: () => {
            setMenu(null);
            void deleteCard(m.item.id);
          },
        },
      ];
    }

    const isPinned = pinnedMotto?.kind === "reflection" && pinnedMotto.id === m.item.id;
    const items: PopMenuItem[] = [
      {
        key: "edit",
        label: "編輯回答",
        onSelect: () => {
          setMenu(null);
          setEditingRefId(m.item.id);
          setEditingRefAnswer(m.item.answer);
        },
      },
      {
        key: "pin",
        label: isPinned ? "收起「心之所向」釘選" : "釘選這句為「心之所向」",
        onSelect: () => {
          setMenu(null);
          void togglePin({ kind: "reflection", id: m.item.id });
        },
      },
    ];
    if (m.item.diary_note_id && notesEnabled) {
      items.push({
        key: "diary",
        label: "前往當日《旅客筆記・日記》",
        onSelect: () => {
          setMenu(null);
          handleJumpToDiary(m.item.answered_on, m.item.diary_note_id);
        },
      });
    }
    items.push({
      key: "delete",
      label: "移除這則回答",
      cut: true,
      danger: true,
      onSelect: () => {
        setMenu(null);
        void deleteReflection(m.item.id);
      },
    });
    return items;
  };

  if (!loaded && loading) {
    return <div className="ns-ideal-stack" aria-busy="true" />;
  }

  return (
    <div className="ns-ideal-stack">
      {/* 1. 置頂「心之所向」常駐橫幅 */}
      {pinnedMotto && (
        <div className="ns-ideal-motto-banner" role="region" aria-label="心之所向">
          <div className="ns-ideal-motto-main">
            <span className="ns-ideal-motto-kicker">✦ 心之所向 · 已釘選於今日頁頂端</span>
            <p className="ns-ideal-motto-quote">「{pinnedMotto.motto}」</p>
            <span className="ns-ideal-motto-source">
              出自：{pinnedMotto.subtitle} · {pinnedMotto.title}
            </span>
          </div>
          <button
            type="button"
            className="ns-btn btn-text"
            onClick={() => void togglePin({ kind: pinnedMotto.kind, id: pinnedMotto.id })}
          >
            收起釘選
          </button>
        </div>
      )}

      {/* 2. 車窓の問い（每日零壓力問答盒） */}
      <section
        ref={windowBoxRef}
        className="techo-card ns-ideal-window"
        aria-label="車窓の問い"
      >
        <div className="ns-ideal-window-head">
          <div className="ns-ideal-window-badges">
            <span className="ns-ideal-window-tag">🪟 車窓の問い</span>
            <span className="ns-ideal-window-cat">
              {WINDOW_CATEGORY_LABEL[currentPrompt.category]}
              {currentPrompt.isReanswer ? " · 跨時空重訪" : " · 不計連勝，想寫再寫"}
            </span>
          </div>
          <div className="ns-ideal-window-tools">
            {promptOverride ? (
              <button
                type="button"
                className="ns-btn btn-ghost"
                onClick={clearPromptOverride}
              >
                回今日題目
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="ns-btn btn-ghost"
                  onClick={() => shufflePrompt(day)}
                >
                  換一題
                </button>
                <button
                  type="button"
                  className="ns-btn btn-ghost"
                  onClick={() => startCustomPrompt("")}
                >
                  ＋ 自訂題目
                </button>
              </>
            )}
          </div>
        </div>

        {currentPrompt.isCustomEditing ? (
          <input
            type="text"
            className="ns-ideal-input"
            value={currentPrompt.question}
            onChange={(e) => setCustomPromptQuestion(e.target.value)}
            placeholder="寫下今天想問自己、或留給未來自己再答一次的問題…"
            maxLength={120}
            autoFocus
          />
        ) : (
          <h3 className="ns-ideal-question">{currentPrompt.question}</h3>
        )}

        {pastCue && <div className="ns-ideal-past-cue">✦ {pastCue}</div>}

        <textarea
          ref={answerInputRef}
          className="ns-ideal-answer-box"
          rows={3}
          value={answerText}
          onChange={(e) => setAnswerText(e.target.value)}
          placeholder="看著車窗外的風景，寫下此刻心裡的真實感受與描繪…"
        />

        <div className="ns-ideal-window-foot">
          <label className="ns-ideal-diary-check">
            <input
              type="checkbox"
              checked={syncDiaryPref}
              onChange={(e) => setSyncDiaryPref(e.target.checked)}
            />
            <span>同時記進今日《旅客筆記・日記》（自動掛上 #車窓の問い）</span>
          </label>
          <button
            type="button"
            className="ns-btn btn-seal"
            disabled={submitting || !answerText.trim()}
            onClick={() => void handleSubmitAnswer()}
          >
            {submitting ? "收錄中…" : "收進手札"}
          </button>
        </div>
      </section>

      {/* 3. 終點站的風景（三大主題風景卡） */}
      <section className="ns-ideal-sec" aria-label="終點站的風景">
        <div className="ns-ideal-sec-head">
          <h2 className="ns-ideal-sec-title">終點站的風景</h2>
          <span className="ns-ideal-sec-note">
            不設期限、不打勾——收藏想成為的人與嚮往的生活模樣
          </span>
        </div>

        <div className="ns-ideal-filter-bar">
          <div className="ns-ideal-chips" role="tablist" aria-label="風景主題篩選">
            <button
              type="button"
              role="tab"
              aria-selected={themeFilter === "all"}
              className={`ns-ideal-chip${themeFilter === "all" ? " is-on" : ""}`}
              onClick={() => setThemeFilter("all")}
            >
              <span>全部</span>
              <span className="ns-ideal-chip-count">{aliveCards.length}</span>
            </button>
            {IDEAL_THEMES.map((t) => {
              const on = themeFilter === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  className={`ns-ideal-chip${on ? " is-on" : ""}`}
                  onClick={() => setThemeFilter(t.id)}
                >
                  <span>{t.label}</span>
                  <span className="ns-ideal-chip-count">{themeCounts[t.id]}</span>
                </button>
              );
            })}
          </div>

          <button
            type="button"
            className="ns-btn btn-ghost"
            onClick={() => openCreateCard()}
          >
            <IconPlus size={14} /> 風景卡
          </button>
        </div>

        {filteredCards.length === 0 ? (
          <EmptyState
            tone="first"
            title="還沒有收錄這類風景"
            desc="寫下你想成為的人、理想的生活畫面或遠方的目的地，隨時翻開回望初心。"
            action={{
              label: "＋ 收藏第一幅風景",
              onClick: () => openCreateCard(),
            }}
          />
        ) : (
          <div className="ns-ideal-card-grid">
            {filteredCards.map((card) => {
              const isPinned = pinnedMotto?.kind === "card" && pinnedMotto.id === card.id;
              return (
                <article
                  key={card.id}
                  className={`techo-card ns-ideal-card${isPinned ? " is-pinned" : ""}`}
                >
                  <div className="ns-ideal-card-visual">
                    {card.photo_data ? (
                      <img
                        src={card.photo_data}
                        alt={card.title}
                        className="ns-ideal-card-photo"
                      />
                    ) : (
                      <IdealArtSvg preset={card.art_preset} />
                    )}
                    {isPinned && <span className="ns-ideal-pin-pill">✦ 心之所向</span>}
                  </div>
                  <div className="ns-ideal-card-body">
                    <div className="ns-ideal-card-top">
                      <span className="ns-ideal-card-theme">
                        {IDEAL_THEME_LABEL[card.theme]}
                      </span>
                      <button
                        type="button"
                        className="ns-iconbtn"
                        aria-label={`「${card.title}」的更多動作`}
                        title="更多動作"
                        onClick={(e) =>
                          setMenu({ kind: "card", item: card, anchor: e.currentTarget })
                        }
                      >
                        <IconDots />
                      </button>
                    </div>
                    <h3 className="ns-ideal-card-title">{card.title}</h3>
                    {card.body && <p className="ns-ideal-card-prose">{card.body}</p>}
                    {card.motto && (
                      <div className="ns-ideal-card-motto">✦ {card.motto}</div>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {/* 3.5 行路對照（今年 · 本月 · 本週 三欄橫向並排） */}
      <IdealAimsMatrix shell={shell} />

      {/* 4. 車窗問答拾光 · 跨時空並排回顧 */}
      <section className="ns-ideal-sec" aria-label="車窗問答拾光">
        <div className="ns-ideal-sec-head">
          <h2 className="ns-ideal-sec-title">車窗問答拾光 · 跨時空回顧</h2>
          <span className="ns-ideal-sec-note">
            同一道題目在不同季節與年份再答一次，會自動並排對照心境的演進
          </span>
        </div>

        {promptGroups.length === 0 ? (
          <EmptyState
            tone="first"
            title="還沒有留存的車窗問答"
            desc="在上方「車窓の問い」寫下幾句當下的想法，未來的你回來再答同一題時就能並排回顧。"
          />
        ) : (
          <div className="ns-ideal-timelapse-list">
            {promptGroups.map((group) => (
              <article
                key={group.promptKey}
                className="techo-card ns-ideal-prompt-group"
              >
                <div className="ns-ideal-prompt-head">
                  <div className="ns-ideal-prompt-titlewrap">
                    <div className="ns-ideal-prompt-meta">
                      <span>{WINDOW_CATEGORY_LABEL[group.category]}</span>
                      {group.isMultiEra && (
                        <span className="ns-ideal-era-badge">
                          跨時空 · {group.entries.length} 次作答
                        </span>
                      )}
                    </div>
                    <h3 className="ns-ideal-prompt-q">{group.question}</h3>
                  </div>
                  <button
                    type="button"
                    className="ns-btn btn-ghost"
                    onClick={() => handleReanswerClick(group)}
                  >
                    再答一次
                  </button>
                </div>

                <div
                  className={`ns-ideal-eras-grid${group.isMultiEra ? " is-multi" : ""}`}
                >
                  {group.entries.map((entry) => {
                    const isPinned =
                      pinnedMotto?.kind === "reflection" && pinnedMotto.id === entry.id;
                    const isEditing = editingRefId === entry.id;
                    return (
                      <div
                        key={entry.id}
                        className={`ns-ideal-era-entry${isPinned ? " is-pinned" : ""}`}
                      >
                        <div className="ns-ideal-era-top">
                          <span className="ns-ideal-era-date">
                            {entry.answered_on.replace(/-/g, ".")}
                            {isPinned ? " · ✦ 心之所向" : ""}
                          </span>
                          <div className="ns-ideal-window-tools">
                            {entry.diary_note_id && notesEnabled && (
                              <button
                                type="button"
                                className="ns-btn btn-text ns-ideal-era-diary-mark"
                                onClick={() =>
                                  handleJumpToDiary(entry.answered_on, entry.diary_note_id)
                                }
                              >
                                已記日記 ›
                              </button>
                            )}
                            <button
                              type="button"
                              className="ns-iconbtn"
                              aria-label={`${entry.answered_on} 回答的更多動作`}
                              title="更多動作"
                              onClick={(e) =>
                                setMenu({
                                  kind: "reflection",
                                  item: entry,
                                  anchor: e.currentTarget,
                                })
                              }
                            >
                              <IconDots />
                            </button>
                          </div>
                        </div>

                        {isEditing ? (
                          <>
                            <textarea
                              className="ns-ideal-textarea"
                              rows={3}
                              value={editingRefAnswer}
                              onChange={(e) => setEditingRefAnswer(e.target.value)}
                              autoFocus
                            />
                            <div className="ns-ideal-era-edit-actions">
                              <button
                                type="button"
                                className="ns-btn btn-ghost"
                                onClick={() => setEditingRefId(null)}
                              >
                                取消
                              </button>
                              <button
                                type="button"
                                className="ns-btn btn-seal"
                                onClick={() => {
                                  void updateReflection(entry.id, {
                                    answer: editingRefAnswer,
                                  }).then((ok) => {
                                    if (ok) setEditingRefId(null);
                                  });
                                }}
                              >
                                存檔
                              </button>
                            </div>
                          </>
                        ) : (
                          <p className="ns-ideal-era-answer">{entry.answer}</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {/* ⋯ 動作選單：桌機 PopMenu／手機 MSheet list */}
      {menu && shell === "desktop" && (
        <PopMenu
          anchor={menu.anchor}
          overline={
            menu.kind === "card"
              ? { zh: "風景卡", latin: "Scenery" }
              : { zh: "車窓の問い", latin: "Reflection" }
          }
          label="更多動作"
          items={menuItemsFor(menu)}
          onClose={() => setMenu(null)}
        />
      )}

      {menu && shell === "mobile" && (
        <MSheet
          backId="core.ideal.menu"
          list
          title={menu.kind === "card" ? menu.item.title : menu.item.answered_on.replace(/-/g, ".")}
          onClose={() => setMenu(null)}
        >
          {menuItemsFor(menu).map((it) => (
            <MSheetItem
              key={it.key}
              cut={it.cut}
              danger={it.danger}
              onClick={it.onSelect}
            >
              {it.label}
            </MSheetItem>
          ))}
        </MSheet>
      )}

      {/* 新增／編輯風景卡對話框 */}
      {cardDialog && (
        <IdealCardDialog
          dialog={cardDialog}
          shell={shell}
          onClose={closeCardDialog}
        />
      )}
    </div>
  );
}
