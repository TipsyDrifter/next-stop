/**
 * TopicCards——時刻表統計頁頂端的「釘選自訂統計專題卡」區塊（v1.33 功能 2 ＋ G1 專題獨立切日線）。
 * - 每個專題卡直接呈現：當期總時數 · 執行次數（N 次）· 日均時數 · 上期環比 · 迷你趨勢條。
 * - 若設定了獨立切日線（如 `18:00 切日` 的睡眠觀察），右上顯示切日小籤，並以專屬切日營業日完整彙整跨午夜與跨 06:00 的時間塊。
 * - 點擊專題卡主體可原地展開／收合每日明細（逐日顯示 M/D（週X）、時數長條與 `Xh Ym · N 次`）。
 * - 支援新增、編輯、上下排序、封存與刪除（均帶復原 Toast），以及已封存專題摺疊還原。
 */
import { useState, useRef, type CSSProperties } from "react";
import { fmtDur } from "../../../domain/timetable";
import type { StatTopicView } from "../../../domain/timetableStats";
import { TT_TEXT, useTimetableStore } from "../../../store/timetableStore";
import { useTimetableStatsStore } from "../../../store/timetableStatsStore";
import { EmptyState } from "../../common/EmptyState";
import { IconDots, IconPlus } from "../../common/icons";
import { PopMenu, type PopMenuItem } from "../../common/PopMenu";
import { mdw, periodName, scopeText, useCatById, useTagNameOf } from "./format";
import { Delta } from "./parts";

const pad2 = (h: number): string => String(h).padStart(2, "0");

function TopicMore({
  id,
  name,
  index,
  total,
}: {
  id: string;
  name: string;
  index: number;
  total: number;
}) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const openSheet = useTimetableStore((s) => s.openSheet);
  const archiveStatTopic = useTimetableStore((s) => s.archiveStatTopic);
  const deleteStatTopic = useTimetableStore((s) => s.deleteStatTopic);
  const reorderStatTopics = useTimetableStore((s) => s.reorderStatTopics);
  const topicList = useTimetableStatsStore((s) => s.topicList);
  const T = TT_TEXT.statsUi;

  const move = (delta: -1 | 1): void => {
    const ids = topicList.map((t) => t.id);
    const i = ids.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= ids.length) return;
    const next = ids.slice();
    next[i] = ids[j];
    next[j] = ids[i];
    void reorderStatTopics(next);
  };

  const items: PopMenuItem[] = [
    { key: "edit", label: "編輯…", onSelect: () => openSheet({ kind: "topic", topicId: id }) },
    ...(index > 0 ? [{ key: "up", label: "往前移", onSelect: () => move(-1) }] : []),
    ...(index < total - 1 ? [{ key: "down", label: "往後移", onSelect: () => move(1) }] : []),
    { key: "archive", label: T.archive, cut: true, onSelect: () => void archiveStatTopic(id, true) },
    { key: "delete", label: T.remove, danger: true, onSelect: () => void deleteStatTopic(id) },
  ];

  return (
    <>
      <button
        ref={btn}
        type="button"
        className="ns-iconbtn ns-tt-goal-more"
        aria-label={`更多動作：${name}`}
        title={items.map((it) => it.label).join("、")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((x) => !x)}
      >
        <IconDots />
      </button>
      {open && (
        <PopMenu
          anchor={btn.current}
          overline={{ zh: "統計專題", latin: "Topic" }}
          label={`「${name}」的動作`}
          items={items}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function TopicCard({
  v,
  index,
  total,
  desktop,
  ws,
}: {
  v: StatTopicView;
  index: number;
  total: number;
  desktop: boolean;
  ws: 0 | 1;
}) {
  const [expanded, setExpanded] = useState(false);
  const catById = useCatById();
  const tagNameOf = useTagNameOf();
  const routeNames = useTimetableStatsStore((s) => s.routeNames);
  const goalNodeNames = useTimetableStatsStore((s) => s.goalNodeNames);
  const openSheet = useTimetableStore((s) => s.openSheet);
  const T = TT_TEXT.statsUi;
  const topic = v.topic;

  const displayTags = topic.tagKeys.map((k, idx) => {
    const fromIdx = tagNameOf(k);
    return fromIdx !== k ? fromIdx : (topic.tagNames[idx] ?? k);
  });
  const extraLabels = [
    ...topic.routeIds.map((rid) => routeNames[rid]?.name ?? "路線"),
    ...topic.nodeIds.map((nid) => goalNodeNames[nid]?.name ?? "項目"),
  ];
  const scopeSummary = scopeText(
    v.liveCategoryIds.length ? v.liveCategoryIds : topic.categoryIds,
    catById,
    displayTags,
    extraLabels,
  );

  const topicTodayRow = v.days.find((d) => d.isToday);
  const pn = periodName(
    v.period,
    v.key,
    topicTodayRow?.dateKey ?? v.key,
    v.effectiveDayStartHour,
    ws,
  );

  const avgLabel = v.period === "day" ? "近7日均" : "日均";
  const avgVal = v.period === "day" ? v.trendAvgDayMs : v.avgDayMs;
  const maxDayMs = Math.max(1, ...v.days.map((d) => d.ms));
  const detailRows = v.period === "month" ? v.days.filter((d) => !d.future || d.ms > 0) : v.days;

  if (v.emptyScope && topic.categoryIds.length === 0) {
    return (
      <article className="ns-tt-goal ns-tt-topic is-dim is-lost" data-topic-id={topic.id}>
        <div className="ns-tt-goal-h">
          <b className="ns-tt-goal-name">{topic.name}</b>
          {topic.dayStartHour !== null && (
            <span className="ns-tt-topic-cut">{pad2(topic.dayStartHour)}:00 切日</span>
          )}
          <TopicMore id={topic.id} name={topic.name} index={index} total={total} />
        </div>
        <p className="ns-tt-goal-lost">
          {TT_TEXT.tags.goalTagsGone}
          <button type="button" onClick={() => openSheet({ kind: "topic", topicId: topic.id })}>
            {TT_TEXT.tags.goalRescope}
          </button>
        </p>
      </article>
    );
  }

  return (
    <article className={"ns-tt-goal ns-tt-topic" + (expanded ? " is-expanded" : "")} data-topic-id={topic.id}>
      <div className="ns-tt-goal-h">
        <b className="ns-tt-goal-name">{topic.name}</b>
        {topic.dayStartHour !== null && (
          <span
            className="ns-tt-topic-cut"
            title={`專屬切日線：每日 ${pad2(topic.dayStartHour)}:00 起算至隔日 ${pad2(topic.dayStartHour)}:00`}
          >
            {pad2(topic.dayStartHour)}:00 切日
          </span>
        )}
        <TopicMore id={topic.id} name={topic.name} index={index} total={total} />
      </div>

      <p className="ns-tt-goal-sub ns-tt-topic-sub">
        {topic.dayStartHour !== null && <span className="ns-tt-goal-per">{pn.name}</span>}
        <span>{scopeSummary}</span>
      </p>

      <button
        type="button"
        className="ns-tt-topic-main"
        aria-expanded={expanded}
        aria-label={`${topic.name}：${fmtDur(v.totalMs)}，${T.countTimes(v.count)}，${avgLabel} ${fmtDur(avgVal)}；點擊${expanded ? "收合" : "展開"}每日明細`}
        onClick={() => setExpanded((x) => !x)}
      >
        <div className="ns-tt-topic-metrics">
          <div className="ns-tt-topic-primary">
            <b className="ns-tt-topic-total ns-tt-num">{fmtDur(v.totalMs)}</b>
            <span className="ns-tt-topic-cnt ns-tt-num">· {T.countTimes(v.count)}</span>
          </div>
          <div className="ns-tt-topic-secondary">
            <span className="ns-tt-topic-avg ns-tt-num">
              {avgLabel} {fmtDur(avgVal)}
            </span>
            <span className="ns-tt-topic-dl ns-tt-num">
              <Delta ms={v.totalMs - v.prevMs} prevMs={v.prevMs} showTitle={desktop} inert />
            </span>
          </div>
        </div>

        <div className="ns-tt-topic-spark-wrap" aria-hidden="true">
          <div className="ns-tt-topic-spark">
            {v.days.map((d) => {
              const ratio = d.ms > 0 ? Math.max(0.12, d.ms / maxDayMs) : 0;
              return (
                <span
                  key={d.dateKey}
                  className={
                    "ns-tt-topic-bar" +
                    (d.isToday ? " is-today" : "") +
                    (d.future ? " is-future" : "") +
                    (d.ms > 0 ? " has-val" : "")
                  }
                >
                  <i style={{ height: `${Math.round(ratio * 100)}%` }} />
                </span>
              );
            })}
          </div>
          <span className="ns-tt-topic-expcaret">{expanded ? "▴" : "▾"}</span>
        </div>
      </button>

      {expanded && (
        <div className="ns-tt-topic-days">
          {topic.dayStartHour !== null && (
            <p className="ns-tt-topic-cutnote">
              每日以 {pad2(topic.dayStartHour)}:00 為界（例：{mdw(detailRows[0]?.dateKey ?? v.key)}{" "}
              {pad2(topic.dayStartHour)}:00 ～ 隔日 {pad2(topic.dayStartHour)}:00）
            </p>
          )}
          <div className="ns-tt-topic-dlist" role="list">
            {detailRows.map((d) => {
              const pct = d.ms > 0 ? Math.max(3, (d.ms / maxDayMs) * 100) : 0;
              return (
                <div
                  key={d.dateKey}
                  role="listitem"
                  className={
                    "ns-tt-topic-drow" +
                    (d.isToday ? " is-today" : "") +
                    (d.future ? " is-future" : "")
                  }
                >
                  <span className="ns-tt-topic-ddate ns-tt-num">{mdw(d.dateKey)}</span>
                  <span className="ns-tt-topic-dtrack" aria-hidden="true">
                    {pct > 0 && <i style={{ width: `${pct.toFixed(1)}%` } as CSSProperties} />}
                  </span>
                  <span className="ns-tt-topic-dval ns-tt-num">
                    {d.ms > 0 ? fmtDur(d.ms) : "—"}
                    {d.count > 0 && <em className="ns-tt-stats-rc">· {T.countTimes(d.count)}</em>}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </article>
  );
}

export function TopicCards({ desktop, ws }: { desktop: boolean; ws: 0 | 1 }) {
  const topics = useTimetableStatsStore((s) => s.topics);
  const archivedTopics = useTimetableStatsStore((s) => s.archivedTopics);
  const openSheet = useTimetableStore((s) => s.openSheet);
  const archiveStatTopic = useTimetableStore((s) => s.archiveStatTopic);
  const deleteStatTopic = useTimetableStore((s) => s.deleteStatTopic);
  const [archOpen, setArchOpen] = useState(false);
  const T = TT_TEXT.statsUi;
  const hasAny = topics.length > 0;

  return (
    <section className="ns-tt-topics">
      <div className="ns-tt-goals-h ns-tt-topics-h">
        <h3>{T.topicsTitle}</h3>
        <span className="rule" />
        {hasAny && (
          <button
            type="button"
            className="ns-btn btn-ghost"
            onClick={() => openSheet({ kind: "topic", topicId: null })}
          >
            <IconPlus />
            {T.topicAdd}
          </button>
        )}
      </div>

      {!hasAny ? (
        <section className="ns-tt-stats-card ns-tt-topics-empty">
          <EmptyState
            inline
            tone="first"
            title="還沒有釘選統計專題。"
            desc="例如「🌙 睡眠觀察（18:00 切日）」或「📚 畢業專題」，跨分類、路線與 #荷札追蹤時數、次數與每日明細。"
            action={{
              label: T.topicAdd,
              icon: <IconPlus />,
              onClick: () => openSheet({ kind: "topic", topicId: null }),
            }}
          />
        </section>
      ) : (
        <div className={"ns-tt-topics-grid" + (desktop ? "" : " is-one")}>
          {topics.map((v, i) => (
            <TopicCard key={v.topic.id} v={v} index={i} total={topics.length} desktop={desktop} ws={ws} />
          ))}
        </div>
      )}

      {archivedTopics.length > 0 && (
        <details
          className="ns-tt-mgr-archived ns-tt-topics-arch"
          open={archOpen}
          onToggle={(e) => setArchOpen(e.currentTarget.open)}
        >
          <summary>
            {T.archivedTopicList(archivedTopics.length)}
            <i aria-hidden="true">›</i>
          </summary>
          <div className="ns-tt-mgr-archived-list">
            {archivedTopics.map((t) => (
              <div key={t.id} className="ns-tt-mgr-row is-archived">
                <span className="ns-tt-mgr-archived-name">
                  {t.name}
                  {t.dayStartHour !== null && <small> · {pad2(t.dayStartHour)}:00 切日</small>}
                </span>
                <button
                  type="button"
                  className="ns-btn btn-ghost ns-btn--sm"
                  onClick={() => void archiveStatTopic(t.id, false)}
                >
                  {T.restore}
                </button>
                <button
                  type="button"
                  className="ns-btn btn-ghost ns-btn--sm ns-btn-danger"
                  onClick={() => void deleteStatTopic(t.id)}
                >
                  {T.remove}
                </button>
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
