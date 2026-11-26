/**
 * ChainsTab——「分類與設定」第 6 分頁「行為鏈」（v1.39 4B）。
 *
 * - 列表模式：
 *   - 3 組內建範本（「晨間啟動」「專注連班」「睡前收心」），點選後智慧配對現有分類並帶入表單可微調儲存。
 *   - 現有行為鏈以共用 `ManagerList` / `ManagerRow` 呈現（支援行內改名、上移／下移排序、編輯、封存、還原、刪除與一鍵試発車）。
 * - 編輯模式：
 *   - 名稱、動態增刪與排序步驟；每步提供 `<Select>` 分類選取、選填步驟名、快捷分鐘＋展開共用 `<DurationPicker>`、選填備註與地點。
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { groupedCategories, leafCategories } from "../../../domain/timetable";
import {
  CHAIN_DEFAULT_MIN,
  CHAIN_NAME_MAX,
  CHAIN_STARTER_PRESETS,
  CHAIN_STEPS_MAX,
  CHAIN_STEP_MAX,
  CHAIN_STEP_MIN,
  chainTotalMin,
  formatChainDuration,
  getStarterPresetMeta,
  normalizeStepEstimateMin,
  resolveStarterPresetSteps,
  resolveStepTitle,
  validateChainInput,
  type TimeChainRow,
  type TimeChainStep,
} from "../../../domain/timetableChain";
import { useTimetableChainStore } from "../../../store/timetableChainStore";
import { useTimetableStore } from "../../../store/timetableStore";
import { DurationPicker } from "../../common/DurationPicker";
import { EmptyState } from "../../common/EmptyState";
import { ManagerList, ManagerRow, type PopMenuItem } from "../../common/ManagerRow";
import { Select } from "../../common/Select";
import { IconClose, IconPlus } from "../../common/icons";
import { CategoryBadge } from "../CategoryBadge";
import "../timetable-chains.css";

const QUICK_MINS = [10, 15, 25, 45, 60] as const;

interface DraftStep {
  uid: number;
  categoryId: string;
  label: string;
  estimateMin: number;
  note: string;
  location: string;
}

interface EditorState {
  mode: "create" | "edit";
  editingId: string | null;
  name: string;
  steps: DraftStep[];
}

function isImeKey(e: KeyboardEvent<HTMLElement>): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229;
}

export function ChainsTab() {
  const chains = useTimetableChainStore((s) => s.chains);
  const loaded = useTimetableChainStore((s) => s.loaded);
  const loadChains = useTimetableChainStore((s) => s.loadChains);
  const createChain = useTimetableChainStore((s) => s.createChain);
  const updateChain = useTimetableChainStore((s) => s.updateChain);
  const archiveChain = useTimetableChainStore((s) => s.archiveChain);
  const restoreChain = useTimetableChainStore((s) => s.restoreChain);
  const deleteChain = useTimetableChainStore((s) => s.deleteChain);
  const reorderChains = useTimetableChainStore((s) => s.reorderChains);
  const startChain = useTimetableChainStore((s) => s.startChain);

  const categories = useTimetableStore((s) => s.categories);
  const catById = useTimetableStore((s) => s.catById);
  const closeSheet = useTimetableStore((s) => s.closeSheet);

  useEffect(() => {
    if (!loaded) void loadChains();
  }, [loaded, loadChains]);

  const groups = useMemo(() => groupedCategories(categories), [categories]);
  const leaves = useMemo(() => leafCategories(categories), [categories]);
  const defaultCatId = leaves[0]?.id ?? "";

  const uidRef = useRef(1);
  const nextUid = (): number => ++uidRef.current;

  const toDraftSteps = (steps: readonly TimeChainStep[]): DraftStep[] =>
    steps.map((s) => ({
      uid: nextUid(),
      categoryId: s.categoryId || defaultCatId,
      label: s.label ?? "",
      estimateMin: normalizeStepEstimateMin(s.estimateMin),
      note: s.note ?? "",
      location: s.location ?? "",
    }));

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [openDurUid, setOpenDurUid] = useState<number | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [archOpen, setArchOpen] = useState(false);

  const active = useMemo(() => chains.filter((c) => c.archivedAt === null), [chains]);
  const archived = useMemo(() => chains.filter((c) => c.archivedAt !== null), [chains]);
  const activeIds = useMemo(() => active.map((c) => c.id), [active]);

  const openCreateBlank = (): void => {
    setFormErr(null);
    setOpenDurUid(null);
    setEditor({
      mode: "create",
      editingId: null,
      name: "",
      steps: [
        {
          uid: nextUid(),
          categoryId: defaultCatId,
          label: "",
          estimateMin: CHAIN_DEFAULT_MIN,
          note: "",
          location: "",
        },
      ],
    });
  };

  const openFromPreset = (presetId: string): void => {
    const meta = getStarterPresetMeta(presetId);
    if (!meta) return;
    const presetSteps = resolveStarterPresetSteps(
      presetId,
      leaves.map((c) => ({ id: c.id, name: c.name })),
    );
    setFormErr(null);
    setOpenDurUid(null);
    setEditor({
      mode: "create",
      editingId: null,
      name: meta.name,
      steps: presetSteps.length > 0 ? toDraftSteps(presetSteps) : [
        {
          uid: nextUid(),
          categoryId: defaultCatId,
          label: "",
          estimateMin: CHAIN_DEFAULT_MIN,
          note: "",
          location: "",
        },
      ],
    });
  };

  const openEdit = (row: TimeChainRow): void => {
    setFormErr(null);
    setOpenDurUid(null);
    setEditor({
      mode: "edit",
      editingId: row.id,
      name: row.name,
      steps:
        row.steps.length > 0
          ? toDraftSteps(row.steps)
          : [
              {
                uid: nextUid(),
                categoryId: defaultCatId,
                label: "",
                estimateMin: CHAIN_DEFAULT_MIN,
                note: "",
                location: "",
              },
            ],
    });
  };

  const moveChain = (id: string, delta: -1 | 1): void => {
    const idx = activeIds.indexOf(id);
    const to = idx + delta;
    if (idx < 0 || to < 0 || to >= activeIds.length) return;
    const next = activeIds.slice();
    next[idx] = activeIds[to];
    next[to] = activeIds[idx];
    void reorderChains(next);
  };

  const runChain = async (id: string): Promise<void> => {
    const ok = await startChain(id);
    if (ok) closeSheet();
  };

  /* ───────── 編輯模式 ───────── */
  if (editor) {
    const updateStep = (uid: number, patch: Partial<DraftStep>): void => {
      setFormErr(null);
      setEditor((cur) =>
        cur
          ? {
              ...cur,
              steps: cur.steps.map((s) => (s.uid === uid ? { ...s, ...patch } : s)),
            }
          : cur,
      );
    };

    const moveStep = (index: number, delta: -1 | 1): void => {
      setEditor((cur) => {
        if (!cur) return cur;
        const to = index + delta;
        if (to < 0 || to >= cur.steps.length) return cur;
        const next = cur.steps.slice();
        const [picked] = next.splice(index, 1);
        next.splice(to, 0, picked);
        return { ...cur, steps: next };
      });
    };

    const removeStep = (uid: number): void => {
      setEditor((cur) => {
        if (!cur || cur.steps.length <= 1) return cur;
        return { ...cur, steps: cur.steps.filter((s) => s.uid !== uid) };
      });
      if (openDurUid === uid) setOpenDurUid(null);
    };

    const addStep = (): void => {
      if (editor.steps.length >= CHAIN_STEPS_MAX) return;
      const lastCat = editor.steps[editor.steps.length - 1]?.categoryId || defaultCatId;
      setEditor((cur) =>
        cur
          ? {
              ...cur,
              steps: [
                ...cur.steps,
                {
                  uid: nextUid(),
                  categoryId: lastCat,
                  label: "",
                  estimateMin: CHAIN_DEFAULT_MIN,
                  note: "",
                  location: "",
                },
              ],
            }
          : cur,
      );
    };

    const toDomainSteps = (): TimeChainStep[] =>
      editor.steps.map((s) => ({
        categoryId: s.categoryId,
        estimateMin: s.estimateMin,
        ...(s.label.trim() ? { label: s.label.trim() } : {}),
        ...(s.note.trim() ? { note: s.note.trim() } : {}),
        ...(s.location.trim() ? { location: s.location.trim() } : {}),
      }));

    const onSave = async (): Promise<void> => {
      if (saving) return;
      const domainSteps = toDomainSteps();
      const err = validateChainInput(editor.name, domainSteps);
      if (err) {
        setFormErr(err);
        return;
      }
      setSaving(true);
      setFormErr(null);
      try {
        if (editor.mode === "edit" && editor.editingId) {
          const updated = await updateChain(editor.editingId, {
            name: editor.name.trim(),
            steps: domainSteps,
          });
          if (updated) setEditor(null);
        } else {
          const created = await createChain({
            name: editor.name.trim(),
            steps: domainSteps,
          });
          if (created) setEditor(null);
        }
      } finally {
        setSaving(false);
      }
    };

    const totalMin = chainTotalMin(
      editor.steps.map((s) => ({ categoryId: s.categoryId, estimateMin: s.estimateMin })),
    );

    return (
      <div className="ns-tt-chain-editor">
        <div className="ns-tt-chain-edhead">
          <button
            type="button"
            className="ns-btn btn-text ns-tt-chain-back"
            onClick={() => {
              setFormErr(null);
              setEditor(null);
            }}
          >
            ‹ 返回清單
          </button>
          <h4 className="ns-tt-chain-edtitle">{editor.mode === "edit" ? "編輯行為鏈" : "新增行為鏈"}</h4>
        </div>

        <div className="ns-tt-chain-field">
          <label className="techo-label" htmlFor="ns-tt-chain-name">
            行為鏈名稱
          </label>
          <input
            id="ns-tt-chain-name"
            className="techo-input ns-tt-chain-namein"
            value={editor.name}
            maxLength={CHAIN_NAME_MAX}
            placeholder="例：晨間啟動、專注連班"
            autoFocus
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              setFormErr(null);
              setEditor((cur) => (cur ? { ...cur, name: e.target.value } : cur));
            }}
            onKeyDown={(e) => {
              if (isImeKey(e)) return;
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setEditor(null);
              }
            }}
          />
        </div>

        <div className="ns-tt-chain-stepshd">
          <span className="techo-label">停靠站點（步驟順序）</span>
          <span className="ns-tt-chain-total ns-tt-num">
            共 {editor.steps.length} 站 · {formatChainDuration(totalMin)}
          </span>
        </div>

        {leaves.length === 0 && (
          <p className="ns-tt-chain-err" role="alert">
            目前沒有可用分類，請先到「分類」分頁建立至少一個分類。
          </p>
        )}

        <div className="ns-tt-chain-steplist">
          {editor.steps.map((step, index) => {
            const cat = catById[step.categoryId] ?? null;
            const durOpen = openDurUid === step.uid;
            const isMissingCat = Boolean(step.categoryId) && !leaves.some((c) => c.id === step.categoryId);

            return (
              <div key={step.uid} className="ns-tt-chain-stepcard">
                <div className="ns-tt-chain-steptop">
                  <span className="ns-tt-chain-stepno ns-tt-num">第 {index + 1} 站</span>
                  <div className="ns-tt-chain-stepacts">
                    <button
                      type="button"
                      className="ns-tt-chain-stepbtn"
                      disabled={index === 0}
                      title={index === 0 ? "已經在第一站" : "上移一站"}
                      aria-label={`第 ${index + 1} 站上移`}
                      onClick={() => moveStep(index, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="ns-tt-chain-stepbtn"
                      disabled={index === editor.steps.length - 1}
                      title={index === editor.steps.length - 1 ? "已經在最後一站" : "下移一站"}
                      aria-label={`第 ${index + 1} 站下移`}
                      onClick={() => moveStep(index, 1)}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="ns-tt-chain-stepbtn is-danger"
                      disabled={editor.steps.length <= 1}
                      title={editor.steps.length <= 1 ? "至少保留 1 個步驟" : "移除此站"}
                      aria-label={`移除第 ${index + 1} 站`}
                      onClick={() => removeStep(step.uid)}
                    >
                      <IconClose size={12} />
                    </button>
                  </div>
                </div>

                <div className="ns-tt-chain-steprow">
                  <div className="ns-tt-chain-catpick">
                    <CategoryBadge cat={cat} size="sm" />
                    <span className="ns-select-wrap">
                      <Select
                        className="techo-input"
                        aria-label={`第 ${index + 1} 站分類`}
                        value={step.categoryId}
                        onChange={(v) => updateStep(step.uid, { categoryId: v })}
                      >
                        {isMissingCat && (
                          <option value={step.categoryId}>
                            {cat ? `${cat.name}（已封存）` : "原分類已刪除"}
                          </option>
                        )}
                        {groups.map(({ group, children }) =>
                          children.length > 0 ? (
                            <optgroup key={group.id} label={group.name}>
                              {children.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.name}
                                </option>
                              ))}
                            </optgroup>
                          ) : null,
                        )}
                      </Select>
                    </span>
                  </div>

                  <input
                    className="techo-input"
                    value={step.label}
                    placeholder={cat ? `步驟名（預設：${cat.name}）` : "步驟名稱（選填）"}
                    aria-label={`第 ${index + 1} 站步驟名稱`}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(e) => updateStep(step.uid, { label: e.target.value })}
                  />
                </div>

                <div className="ns-tt-chain-durrow">
                  <button
                    type="button"
                    className={"ns-tt-chain-durpill" + (durOpen ? " is-open" : "")}
                    aria-expanded={durOpen}
                    aria-label={`第 ${index + 1} 站預估時長 ${formatChainDuration(step.estimateMin)}，點擊展開自訂`}
                    onClick={() => setOpenDurUid((cur) => (cur === step.uid ? null : step.uid))}
                  >
                    <span>{formatChainDuration(step.estimateMin)}</span>
                    <span aria-hidden="true">{durOpen ? "▴" : "▾"}</span>
                  </button>
                  <div className="ns-tt-chain-quickmins" role="group" aria-label={`第 ${index + 1} 站常用分鐘`}>
                    {QUICK_MINS.map((m) => (
                      <button
                        key={m}
                        type="button"
                        className={"ns-tt-chain-qmin" + (step.estimateMin === m ? " is-on" : "")}
                        aria-pressed={step.estimateMin === m}
                        onClick={() => updateStep(step.uid, { estimateMin: m })}
                      >
                        {m}分
                      </button>
                    ))}
                  </div>
                </div>

                {durOpen && (
                  <div className="ns-tt-chain-durbox">
                    <DurationPicker
                      mode="matrix"
                      compact
                      allowNull={false}
                      liveCommit
                      maxMin={CHAIN_STEP_MAX}
                      value={step.estimateMin}
                      ariaLabel={`第 ${index + 1} 站預估時長`}
                      onChange={(next) => {
                        if (next !== null) {
                          updateStep(step.uid, {
                            estimateMin: Math.max(CHAIN_STEP_MIN, Math.min(CHAIN_STEP_MAX, next)),
                          });
                        }
                      }}
                    />
                  </div>
                )}

                <div className="ns-tt-chain-extras">
                  <input
                    className="techo-input"
                    value={step.note}
                    placeholder="備註（選填，發車時自動帶入）"
                    aria-label={`第 ${index + 1} 站備註`}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(e) => updateStep(step.uid, { note: e.target.value })}
                  />
                  <input
                    className="techo-input"
                    value={step.location}
                    placeholder="地點（選填）"
                    aria-label={`第 ${index + 1} 站地點`}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(e) => updateStep(step.uid, { location: e.target.value })}
                  />
                </div>
              </div>
            );
          })}
        </div>

        {editor.steps.length < CHAIN_STEPS_MAX && (
          <button type="button" className="ns-btn btn-text ns-btn--sm ns-tt-mgr-addbtn" onClick={addStep}>
            <IconPlus />
            新增一站
          </button>
        )}

        {formErr && (
          <p className="ns-tt-chain-err" role="alert">
            {formErr}
          </p>
        )}

        <div className="ns-tt-chain-edfoot">
          <button type="button" className="ns-btn btn-ghost" onClick={() => setEditor(null)} disabled={saving}>
            取消
          </button>
          <button
            type="button"
            className="ns-btn btn-seal"
            disabled={saving || leaves.length === 0}
            onClick={() => void onSave()}
          >
            {saving ? "儲存中…" : "儲存行為鏈"}
          </button>
        </div>
      </div>
    );
  }

  /* ───────── 清單模式 ───────── */
  if (!loaded) return null;

  const previewOf = (row: TimeChainRow): string =>
    row.steps
      .map((s) => `${resolveStepTitle(s, catById[s.categoryId]?.name)} ${s.estimateMin}分`)
      .join(" → ");

  return (
    <div className="ns-tt-chains-tab">
      <section className="ns-tt-chains-presets" aria-label="內建行為鏈範本">
        <div className="ns-tt-chains-presets-hd">
          <span className="ns-tt-chains-k">一鍵套用範本</span>
          <span className="ns-tt-panel-sub" style={{ margin: 0 }}>
            套入後可微調再儲存
          </span>
        </div>
        <div className="ns-tt-chains-preset-grid">
          {CHAIN_STARTER_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className="ns-tt-chains-preset"
              onClick={() => openFromPreset(p.id)}
              title={`套用範本「${p.name}」：${p.desc}`}
            >
              <span className="ns-tt-chains-preset-name">{p.name}</span>
              <span className="ns-tt-chains-preset-meta ns-tt-num">{p.summary}</span>
              <span className="ns-tt-chains-preset-desc">{p.desc}</span>
            </button>
          ))}
        </div>
      </section>

      {active.length === 0 ? (
        <EmptyState
          tone="first"
          inline
          title="還沒有自訂行為鏈"
          desc="可點上方範本一鍵套用，或自行串起每天固定的連續動作。"
          action={{ label: "新增行為鏈", icon: <IconPlus />, onClick: openCreateBlank }}
        />
      ) : (
        <div>
          <ManagerList label="行為鏈清單">
            {active.map((c, idx) => {
              const firstCat = c.steps[0] ? (catById[c.steps[0].categoryId] ?? null) : null;
              const total = chainTotalMin(c.steps);
              const menu: PopMenuItem[] = [
                { key: "edit", label: "編輯…", onSelect: () => openEdit(c) },
                { key: "archive", label: "封存", cut: true, onSelect: () => void archiveChain(c.id) },
                { key: "delete", label: "刪除", danger: true, onSelect: () => void deleteChain(c.id) },
              ];
              return [
                <ManagerRow
                  key={c.id}
                  name={c.name}
                  onRename={(nextName) =>
                    updateChain(c.id, { name: nextName }).then((res) => res !== null)
                  }
                  swatch={<CategoryBadge cat={firstCat} size="sm" />}
                  note={`${c.steps.length} 站・${formatChainDuration(total)}`}
                  onUp={idx > 0 ? () => moveChain(c.id, -1) : undefined}
                  onDown={idx < active.length - 1 ? () => moveChain(c.id, 1) : undefined}
                  menu={menu}
                  dataId={c.id}
                />,
                <li key={`${c.id}-sub`} className="ns-tt-chains-subrow">
                  <span className="ns-tt-chains-preview" title={previewOf(c)}>
                    {previewOf(c)}
                  </span>
                  <button
                    type="button"
                    className="ns-btn btn-ghost ns-btn--sm ns-tt-chains-runbtn"
                    title={`立即發車「${c.name}」`}
                    onClick={() => void runChain(c.id)}
                  >
                    ▶ 発車
                  </button>
                </li>,
              ];
            })}
          </ManagerList>
          <button type="button" className="ns-btn btn-text ns-btn--sm ns-tt-mgr-addbtn" onClick={openCreateBlank}>
            <IconPlus />
            新增行為鏈
          </button>
        </div>
      )}

      {archived.length > 0 && (
        <details className="ns-tt-mgr-archived" open={archOpen} onToggle={(e) => setArchOpen(e.currentTarget.open)}>
          <summary>
            已封存 {archived.length} 條<i aria-hidden="true">›</i>
          </summary>
          <div className="ns-tt-mgr-archived-list">
            {archived.map((c) => (
              <div key={c.id} className="ns-tt-mgr-row is-archived">
                <span className="ns-tt-mgr-archived-name">
                  {c.name}
                  <small>
                    {c.steps.length} 站・{formatChainDuration(chainTotalMin(c.steps))}
                  </small>
                </span>
                <button
                  type="button"
                  className="ns-btn btn-ghost ns-btn--sm"
                  onClick={() => void restoreChain(c.id)}
                >
                  還原
                </button>
                <button
                  type="button"
                  className="ns-btn btn-ghost ns-btn--sm ns-btn-danger"
                  onClick={() => void deleteChain(c.id)}
                >
                  刪除
                </button>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
