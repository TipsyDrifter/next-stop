/**
 * TopicPanel——釘選自訂統計專題的新增／編輯面板（v1.33 功能 2 ＋ G1 專題獨立切日線）。
 * 雙殼共用（桌機 DialogShell size M ＋ 黏底 foot；手機 MSheet ＋ useBackLayer("timetable.sheet")）。
 * 欄位：
 *   1. 名稱（必填 ≤ 24 字，附快捷範例 chip 如「🌙 睡眠觀察」「📚 畢業專題」）
 *   2. 篩選範圍：分類兩層樹 ∪ 路線／支線／任務節點搜尋 ∪ `#荷札`（複用 GoalPanel 同款挑選器）
 *   3. 專屬切日時間（日界線）：預設「跟隨手帳全域（如 06:00）」｜「自訂專屬切日線」（00:00～23:00，例如睡眠觀察設 18:00）
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { KIND_LABEL, type NodeRow } from "../../../domain/node";
import type { TimeCategoryRow } from "../../../domain/timetable";
import { LINKABLE_KINDS } from "../../../domain/timetableLink";
import {
  TOPIC_NAME_MAX,
  TOPIC_SCOPE_EMPTY,
  parseStatTopic,
  type StatTopic,
  type StatTopicInput,
} from "../../../domain/timetableStats";
import { timetableRepo } from "../../../data/timetableRepository";
import { useNodeStore } from "../../../store/nodeStore";
import { TT_TEXT, useTimetableStore } from "../../../store/timetableStore";
import { useTimetableStatsStore } from "../../../store/timetableStatsStore";
import { useUiStore } from "../../../store/uiStore";
import { useTagStore } from "../../../store/tagStore";
import { EntityTagField } from "../../common/EntityTagField";
import { Segmented } from "../../common/Segmented";
import { Select } from "../../common/Select";
import { useShell } from "../../mobile/useShell";
import { RouteRoundel, useLiveBranches, useRouteById } from "../parts/LinkPicker";
import { MobileTagDraft, tagNameOf } from "../parts/TimetableTagChips";
import { catColor, scopeText } from "../stats/format";
import { Actions, Row, Sub, type PanelProps } from "./controls";

interface TopicForm {
  name: string;
  cats: string[];
  routes: string[];
  nodes: string[];
  dayStartHour: number | null;
}

const pad2 = (h: number): string => String(h).padStart(2, "0");

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => ({
  value: String(h),
  label: `${pad2(h)}:00${h === 18 ? "（夜間睡眠推薦）" : h === 0 ? "（午夜切日）" : h === 6 ? "（清晨 6 點）" : ""}`,
}));

const PRESETS: readonly { label: string; name: string; hour: number | null }[] = [
  { label: "🌙 睡眠觀察（18:00 切日）", name: "🌙 睡眠觀察", hour: 18 },
  { label: "📚 畢業專題", name: "📚 畢業專題", hour: null },
  { label: "🗾 日文自學", name: "🗾 日文自學", hour: null },
];

function problemOf(f: TopicForm, tagCount: number): string {
  if (!f.name.trim()) return "請輸入專題名稱";
  if (!f.cats.length && !f.routes.length && !f.nodes.length && !tagCount) return TOPIC_SCOPE_EMPTY;
  return "";
}

export function TopicPanel({ onDone }: PanelProps) {
  const sheet = useTimetableStore((s) => s.sheet);
  const categories = useTimetableStore((s) => s.categories);
  const catById = useTimetableStore((s) => s.catById);
  const createStatTopic = useTimetableStore((s) => s.createStatTopic);
  const updateStatTopic = useTimetableStore((s) => s.updateStatTopic);
  const archiveStatTopic = useTimetableStore((s) => s.archiveStatTopic);
  const deleteStatTopic = useTimetableStore((s) => s.deleteStatTopic);
  const openSheet = useTimetableStore((s) => s.openSheet);

  const topicList = useTimetableStatsStore((s) => s.topicList);
  const statRouteNames = useTimetableStatsStore((s) => s.routeNames);
  const statNodeNames = useTimetableStatsStore((s) => s.goalNodeNames);
  const liveRoutes = useNodeStore((s) => s.liveRoutes);
  const treeById = useNodeStore((s) => s.tree.byId);
  const routeById = useRouteById();
  const liveBranches = useLiveBranches(liveRoutes);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const T = TT_TEXT.statsUi;

  const topicId = sheet?.kind === "topic" ? sheet.topicId : null;
  const fromTopicsTab = sheet?.kind === "topic" && sheet.back === "topics";
  const finish = fromTopicsTab ? () => openSheet({ kind: "categories", tab: "topics" }) : onDone;

  const listTopic = topicId ? (topicList.find((t) => t.id === topicId) ?? null) : null;
  const [fetched, setFetched] = useState<StatTopic | "loading" | "gone" | null>(null);

  useEffect(() => {
    if (!topicId || listTopic) return;
    let alive = true;
    setFetched("loading");
    timetableRepo
      .getStatTopic(topicId, { withDeleted: true })
      .then((r) => {
        if (!alive) return;
        const parsed = r && r.deleted_at === null ? parseStatTopic(r) : null;
        setFetched(parsed ?? "gone");
      })
      .catch(() => alive && setFetched("gone"));
    return () => {
      alive = false;
    };
  }, [topicId, listTopic]);

  const topic = listTopic ?? (fetched !== null && typeof fetched === "object" ? fetched : null);

  const blank = (): TopicForm => ({
    name: "",
    cats: [],
    routes: [],
    nodes: [],
    dayStartHour: null,
  });

  const formOf = (t: StatTopic): TopicForm => ({
    name: t.name,
    cats: t.categoryIds.slice(),
    routes: t.routeIds.slice(),
    nodes: t.nodeIds.slice(),
    dayStartHour: t.dayStartHour,
  });

  const openOf = (cats: readonly string[]): Record<string, boolean> => {
    const o: Record<string, boolean> = {};
    for (const c of cats) {
      const p = catById[c]?.parent_id;
      if (p) o[p] = true;
    }
    return o;
  };

  const [f, setFRaw] = useState<TopicForm>(() => (topic ? formOf(topic) : blank()));
  const [filledFor, setFilledFor] = useState<string | null>(topic?.id ?? null);
  const dirty = useRef(false);
  const setF: typeof setFRaw = (v) => {
    dirty.current = true;
    setFRaw(v);
  };
  const set = (patch: Partial<TopicForm>): void => setF((x) => ({ ...x, ...patch }));
  const [busy, setBusy] = useState(false);
  const [openTops, setOpenTops] = useState<Record<string, boolean>>(() => openOf(f.cats));

  const desk = useShell() === "desktop";
  const tagIndex = useTagStore((s) => s.index);
  useEffect(() => {
    const st = useTagStore.getState();
    if (!st.index && !st.loading) void st.loadIndex();
  }, []);

  const initialTags = useMemo(() => {
    if (!topic) return [];
    return topic.tagKeys.map((k, idx) => {
      const resolved = tagIndex ? tagNameOf(k) : k;
      return resolved !== k ? resolved : (topic.tagNames[idx] ?? k);
    });
  }, [topic, tagIndex]);

  const [tagDraft, setTagDraftRaw] = useState<string[] | null>(null);
  const setTagDraft = (names: string[]): void => {
    dirty.current = true;
    setTagDraftRaw(names);
  };
  const tagNames: string[] = tagDraft ?? initialTags;

  useEffect(() => {
    if (!topic || filledFor === topic.id || dirty.current) return;
    const next = formOf(topic);
    setFRaw(next);
    setOpenTops(openOf(next.cats));
    setFilledFor(topic.id);
  }, [topic, filledFor]);

  const tree = useMemo(() => {
    const alive = (c: TimeCategoryRow): boolean =>
      c.deleted_at === null && (c.archived_at === null || f.cats.includes(c.id));
    const byPos = (a: TimeCategoryRow, b: TimeCategoryRow): number => a.position - b.position;
    const tops = categories.filter((c) => c.parent_id === null && alive(c)).sort(byPos);
    return tops.map((t) => ({
      top: t,
      kids: categories.filter((c) => c.parent_id === t.id && alive(c)).sort(byPos),
    }));
  }, [categories, filledFor]);

  const [nodeQuery, setNodeQuery] = useState("");
  const [nodeResults, setNodeResults] = useState<NodeRow[]>([]);
  const [pickedNodes, setPickedNodes] = useState<
    Record<string, { name: string; kind: string; routeId: string | null }>
  >({});

  useEffect(() => {
    const q = nodeQuery.trim();
    if (!q) {
      setNodeResults([]);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      void useNodeStore
        .getState()
        .searchNodes(q)
        .then((ns) => {
          if (!alive) return;
          setNodeResults(ns.filter((n) => LINKABLE_KINDS.includes(n.kind) && n.deleted_at === null).slice(0, 12));
        });
    }, 150);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [nodeQuery]);

  if (topicId && !topic) {
    const loading = fetched === "loading" || fetched === null;
    return (
      <div className="ns-tt-panel">
        <Sub>{loading ? T.loading : T.topicGone}</Sub>
      </div>
    );
  }

  const toggleCat = (id: string, on: boolean): void => {
    const isTop = (catById[id]?.parent_id ?? null) === null;
    setF((x) => {
      let cats = x.cats.filter((c) => c !== id);
      if (on) {
        if (isTop) cats = cats.filter((c) => catById[c]?.parent_id !== id);
        cats.push(id);
      }
      return { ...x, cats };
    });
  };

  const toggleRoute = (rid: string): void => {
    setF((x) => ({
      ...x,
      routes: x.routes.includes(rid) ? x.routes.filter((id) => id !== rid) : [...x.routes, rid],
    }));
  };

  const toggleNode = (n: { id: string; name?: string; kind?: string; route_id?: string | null }): void => {
    if (n.name) {
      setPickedNodes((prev) => ({
        ...prev,
        [n.id]: { name: n.name!, kind: n.kind ?? "ticket", routeId: n.route_id ?? null },
      }));
    }
    setF((x) => ({
      ...x,
      nodes: x.nodes.includes(n.id) ? x.nodes.filter((id) => id !== n.id) : [...x.nodes, n.id],
    }));
  };

  const branchIds = new Set(liveBranches.map((b) => b.id));
  const resolveNodeLabel = (nid: string): { name: string; kind: string; routeId: string | null } => {
    const b = liveBranches.find((x) => x.id === nid);
    if (b) return { name: b.name, kind: b.kind, routeId: b.route_id };
    if (pickedNodes[nid]) return pickedNodes[nid];
    if (treeById[nid]) return { name: treeById[nid].name, kind: treeById[nid].kind, routeId: treeById[nid].route_id };
    if (statNodeNames[nid]) {
      return { name: statNodeNames[nid].name, kind: statNodeNames[nid].kind, routeId: statNodeNames[nid].routeId };
    }
    return { name: "任務項目", kind: "ticket", routeId: null };
  };

  const extraLabels = [
    ...f.routes.map((rid) => routeById[rid]?.name ?? statRouteNames[rid]?.name ?? "路線"),
    ...f.nodes.map((nid) => resolveNodeLabel(nid).name),
  ];
  const nonBranchNodes = f.nodes.filter((nid) => !branchIds.has(nid));

  const applyPreset = (p: (typeof PRESETS)[number]): void => {
    setF((prev) => {
      const nextCats = prev.cats.slice();
      if (p.hour === 18 && nextCats.length === 0) {
        const sleepCat = categories.find(
          (c) => c.deleted_at === null && c.parent_id !== null && /睡|眠|sleep/i.test(c.name),
        );
        if (sleepCat) {
          nextCats.push(sleepCat.id);
          if (sleepCat.parent_id) setOpenTops((o) => ({ ...o, [sleepCat.parent_id!]: true }));
        }
      }
      return {
        ...prev,
        name: prev.name.trim() ? prev.name : p.name,
        dayStartHour: p.hour,
        cats: nextCats,
      };
    });
  };

  const bad = problemOf(f, tagNames.length);
  const save = async (): Promise<void> => {
    if (bad || busy) return;
    setBusy(true);
    const input: StatTopicInput = {
      name: f.name.trim(),
      categoryIds: f.cats.slice(),
      routeIds: f.routes.slice(),
      nodeIds: f.nodes.slice(),
      tagNames: tagNames.slice(),
      dayStartHour: f.dayStartHour,
    };
    const ok = topic ? await updateStatTopic(topic.id, input) : await createStatTopic(input);
    setBusy(false);
    if (ok) finish();
  };

  const runAux = async (fn: () => Promise<boolean>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    const ok = await fn();
    setBusy(false);
    if (ok) finish();
  };

  const cutSummary =
    f.dayStartHour === null ? `跟隨全域（${pad2(dayStartHour)}:00 切日）` : `專屬 ${pad2(f.dayStartHour)}:00 切日`;

  return (
    <div className="ns-tt-panel ns-tt-goal-form ns-tt-topic-form">
      <Row k={T.fName} top={!topic}>
        <div className="ns-tt-topic-namewrap">
          <div className="ns-tt-topic-namerow">
            <input
              className="ns-tt-input ns-tt-goal-name-in"
              value={f.name}
              maxLength={TOPIC_NAME_MAX}
              placeholder="例：🌙 睡眠觀察、📚 畢業專題"
              onChange={(e) => set({ name: e.target.value })}
              aria-label={T.fName}
            />
            <span className="ns-tt-goal-count ns-tt-num">
              {Array.from(f.name).length}/{TOPIC_NAME_MAX}
            </span>
          </div>
          {!topic && (
            <div className="ns-tt-topic-presets" role="group" aria-label="快速範本">
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  className="ns-tt-link-rk"
                  onClick={() => applyPreset(p)}
                >
                  <span>{p.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </Row>

      <Row k="切日時間" top>
        <div className="ns-tt-topic-cutcfg">
          <Segmented
            aria-label="專屬切日時間模式"
            options={[
              { value: "global", label: `跟隨全域（${pad2(dayStartHour)}:00）` },
              { value: "custom", label: "自訂獨立切日線" },
            ]}
            value={f.dayStartHour === null ? "global" : "custom"}
            onChange={(mode) => set({ dayStartHour: mode === "global" ? null : 18 })}
          />
          {f.dayStartHour !== null && (
            <div className="ns-tt-topic-cutrow">
              <Select
                aria-label="專屬切日整點"
                value={String(f.dayStartHour)}
                options={HOUR_OPTIONS}
                onChange={(v) => set({ dayStartHour: Number(v) })}
              />
              <div className="ns-tt-topic-cutchips" role="group" aria-label="常用切日整點">
                {[18, 0, 4].map((h) => (
                  <button
                    key={h}
                    type="button"
                    className={"ns-tt-link-rk" + (f.dayStartHour === h ? " is-on" : "")}
                    aria-pressed={f.dayStartHour === h}
                    onClick={() => set({ dayStartHour: h })}
                  >
                    <span>{pad2(h)}:00</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <span className="ns-tt-tag-hint">
            {f.dayStartHour === null
              ? `依手帳全域日界線（${pad2(dayStartHour)}:00）計算每日平均與明細。`
              : `每日自 ${pad2(f.dayStartHour)}:00 起算至隔日 ${pad2(f.dayStartHour)}:00。例如睡眠觀察設為 18:00，昨晚 23:30 到今早 07:30（或凌晨入睡）皆完整歸入同一睡眠日，不因 06:00 切斷！`}
          </span>
        </div>
      </Row>

      <Row k={T.fCats} top>
        <div className="ns-tt-goal-tree">
          {tree.map(({ top, kids }) => {
            const topOn = f.cats.includes(top.id);
            const picked = kids.filter((k) => f.cats.includes(k.id)).length;
            const isOpen = !!openTops[top.id];
            return (
              <div key={top.id} className={"ns-tt-goal-tg" + (isOpen ? " is-open" : "")}>
                <div className="ns-tt-goal-tgh">
                  <label className="ns-tt-goal-ck is-grp">
                    <input type="checkbox" checked={topOn} onChange={(e) => toggleCat(top.id, e.target.checked)} />
                    <span className="ns-tt-goal-ckbox" aria-hidden="true" />
                    <b>{top.name}</b>
                    <small>{topOn ? T.groupWhole : picked ? T.groupPicked(picked) : ""}</small>
                  </label>
                  {kids.length > 0 && (
                    <button
                      type="button"
                      className="ns-tt-goal-tgx"
                      aria-expanded={isOpen}
                      aria-label={isOpen ? T.collapseKids : T.expandKids}
                      onClick={() => setOpenTops((o) => ({ ...o, [top.id]: !o[top.id] }))}
                    >
                      <i>›</i>
                    </button>
                  )}
                </div>
                {isOpen && (
                  <div className="ns-tt-goal-kids">
                    {kids.map((k) => (
                      <label key={k.id} className={"ns-tt-goal-ck" + (topOn ? " is-dis" : "")}>
                        <input
                          type="checkbox"
                          checked={topOn || f.cats.includes(k.id)}
                          disabled={topOn}
                          onChange={(e) => toggleCat(k.id, e.target.checked)}
                        />
                        <span className="ns-tt-goal-ckbox" aria-hidden="true" />
                        <i className="ns-tt-stats-dot" style={{ "--c": catColor(k) } as CSSProperties} aria-hidden="true" />
                        {k.name}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Row>

      {(liveRoutes.length > 0 || f.routes.length > 0 || f.nodes.length > 0) && (
        <Row k="路線／任務" top>
          <div className="ns-tt-goal-links">
            {liveRoutes.length > 0 && (
              <div className="ns-tt-link-routes">
                {liveRoutes.map((r) => {
                  const on = f.routes.includes(r.id);
                  return (
                    <button
                      type="button"
                      key={r.id}
                      className={"ns-tt-link-rk" + (on ? " is-on" : "")}
                      aria-pressed={on}
                      onClick={() => toggleRoute(r.id)}
                    >
                      <RouteRoundel route={r} />
                      <span>{r.name}</span>
                    </button>
                  );
                })}
                {liveBranches.map((b) => {
                  const on = f.nodes.includes(b.id);
                  const r = b.route_id ? (routeById[b.route_id] ?? null) : null;
                  return (
                    <button
                      type="button"
                      key={b.id}
                      className={"ns-tt-link-rk" + (on ? " is-on" : "")}
                      aria-pressed={on}
                      onClick={() => toggleNode(b)}
                    >
                      <RouteRoundel route={r} />
                      <span>{r ? `${r.name} › ${b.name}` : b.name}</span>
                    </button>
                  );
                })}
              </div>
            )}
            {nonBranchNodes.length > 0 && (
              <div className="ns-tt-link-routes ns-tt-topic-picked">
                {nonBranchNodes.map((nid) => {
                  const info = resolveNodeLabel(nid);
                  const r = info.routeId ? (routeById[info.routeId] ?? null) : null;
                  return (
                    <button
                      type="button"
                      key={nid}
                      className="ns-tt-link-rk is-on"
                      aria-pressed={true}
                      onClick={() => toggleNode({ id: nid })}
                      title="點擊移除"
                    >
                      <RouteRoundel route={r} />
                      <span>{info.name}</span>
                      <small className="ns-tt-topic-rm">×</small>
                    </button>
                  );
                })}
              </div>
            )}
            <div className="ns-tt-topic-search">
              <input
                type="search"
                className="ns-tt-input"
                value={nodeQuery}
                placeholder="搜尋列車、車廂、車票加入專題…"
                aria-label="搜尋任務加入專題"
                onChange={(e) => setNodeQuery(e.target.value)}
              />
              {nodeResults.length > 0 && (
                <div className="ns-tt-link-list ns-tt-topic-results">
                  {nodeResults.map((n) => {
                    const on = f.nodes.includes(n.id);
                    const r = n.route_id ? (routeById[n.route_id] ?? null) : null;
                    return (
                      <button
                        type="button"
                        key={n.id}
                        className={"ns-tt-link-pk" + (on ? " is-on" : "")}
                        onClick={() => {
                          toggleNode(n);
                          setNodeQuery("");
                        }}
                      >
                        <RouteRoundel route={r} />
                        <span className="ns-tt-link-pk-main">
                          <span className="ns-tt-link-pk-t">{n.name}</span>
                          <span className="ns-tt-link-pk-s">
                            {KIND_LABEL[n.kind]}・{r?.name ?? "臨時車票"}
                          </span>
                        </span>
                        {on && <span className="ns-tt-link-pk-on">✓</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <span className="ns-tt-tag-hint">選路線／支線／列車／車廂時，底下所有子項目的時間塊都會自動向上匯總計入。</span>
          </div>
        </Row>
      )}

      <div className="ns-tt-row is-top ns-tt-tagrow ns-tt-goal-tagrow">
        <span className="ns-tt-row-k">{TT_TEXT.tags.goalSection}</span>
        <span className="ns-tt-row-v">
          {desk ? (
            <div className="ns-tt-tagfield">
              <EntityTagField value={tagNames} onChange={setTagDraft} suggestInline resetKey={topicId ?? "new-topic"} />
            </div>
          ) : (
            <MobileTagDraft fixed={[]} value={tagNames} onChange={setTagDraft} title="荷札・統計專題" />
          )}
          <span className="ns-tt-tag-hint">{TT_TEXT.tags.goalTagHint}</span>
        </span>
      </div>

      <p className="ns-tt-goal-preview">
        {bad ? (
          <span className="ns-tt-goal-warn">{bad}</span>
        ) : (
          `${cutSummary}・${scopeText(f.cats, catById, tagNames, extraLabels)}`
        )}
      </p>

      <Actions>
        {topic && (
          <>
            <button
              type="button"
              className="ns-btn btn-ghost is-aux"
              disabled={busy}
              onClick={() => void runAux(() => archiveStatTopic(topic.id, true))}
            >
              {T.archive}
            </button>
            <button
              type="button"
              className="ns-btn btn-ghost ns-btn-danger is-aux"
              disabled={busy}
              onClick={() => void runAux(() => deleteStatTopic(topic.id))}
            >
              {T.remove}
            </button>
          </>
        )}
        <button type="button" className="ns-btn btn-ghost" disabled={busy} onClick={finish}>
          取消
        </button>
        <button type="button" className="ns-btn btn-seal" disabled={!!bad || busy} onClick={() => void save()}>
          {T.save}
        </button>
      </Actions>
    </div>
  );
}
