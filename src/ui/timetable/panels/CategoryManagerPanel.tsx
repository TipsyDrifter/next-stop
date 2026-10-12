/**
 * CategoryManagerPanel——「分類與設定」面板（車次①a 契約 §5.4、0-5；丙席）。
 * 依組列出：每組標題列（組名可改、↑↓ 排序、「＋ 分類」）；每個子分類一列 `div.ns-tt-mgr-row`：
 * Badge＋名稱（點了變輸入框，Enter／blur 存、Esc 還原）＋預設長度 select＋色盤 8 顆 swatch＋↑↓；底部「＋ 新增分組」。
 * 下方「設定」段：「長時間運行的保險上限」select；「運行中」開關一列——Android 寫「通知欄顯示運行中」
 * （沒有通知權限時「需要允許通知」＋按鈕），桌機寫「系統匣顯示運行中」、不問權限（①a 補充契約 §4；同一個設定鍵）。
 * 分流看真實平台（`onAndroid()`），不看排版：桌機視窗拉窄成手機排版也還是系統匣。
 * ①a 不提供刪除、封存、搬組、換圓牌字（新分類圓牌＝名稱第一個字，repository 自己取）。
 * 不動任何集中檔（設定頁沒有三線插槽，契約 0-5）。
 */
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { MIN, colorSlot, fmtDur, groupedCategories, type TimeCategoryRow } from "../../../domain/timetable";
import { askNotificationPermissionOnce } from "../../../lib/notify";
import { LONG_RUN_MAX_DEFAULT, useTimetableStore } from "../../../store/timetableStore";
import { CategoryBadge } from "../CategoryBadge";
import { noticePermission, onAndroid, type NoticePermission } from "../notice";
import { Sub, type PanelProps } from "./controls";

const DEFAULT_MIN_OPTIONS: readonly { v: number | null; label: string }[] = [
  { v: null, label: "無" },
  { v: 30, label: "30 分" },
  { v: 60, label: "1h" },
  { v: 90, label: "1h30" },
  { v: 120, label: "2h" },
  { v: 180, label: "3h" },
  { v: 240, label: "4h" },
  { v: 300, label: "5h" },
  { v: 360, label: "6h" },
  { v: 480, label: "8h" },
  { v: 600, label: "10h" },
  { v: 720, label: "12h" },
];

const LONG_RUN_OPTIONS: readonly { v: number; label: string }[] = [
  { v: 0, label: "關" },
  { v: 480, label: "8h" },
  { v: 600, label: "10h" },
  { v: 720, label: "12h" },
  { v: LONG_RUN_MAX_DEFAULT, label: "14h（預設）" },
  { v: 960, label: "16h" },
  { v: 1200, label: "20h" },
  { v: 1440, label: "24h" },
];

const SWATCHES = [1, 2, 3, 4, 5, 6, 7, 8] as const;

function isImeKey(e: KeyboardEvent<HTMLElement>): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229;
}

/** 名稱：點了變輸入框；Enter／blur 存、Esc 還原；空字串不存 */
function EditableName({ value, onSave, label, big = false }: { value: string; onSave(name: string): void; label: string; big?: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const cancelled = useRef(false);
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  const commit = (): void => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    setEditing(false);
    const t = draft.trim();
    if (t && t !== value) onSave(t);
    else setDraft(value);
  };

  if (!editing) {
    return (
      <button type="button" className={"ns-tt-mgr-name" + (big ? " is-group" : "")} onClick={() => setEditing(true)} aria-label={`${label}：${value}（點了改名）`}>
        {value}
      </button>
    );
  }
  return (
    <input
      className={"ns-tt-input ns-tt-mgr-name-input" + (big ? " is-group" : "")}
      value={draft}
      autoFocus
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (isImeKey(e)) return;
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          cancelled.current = true;
          setDraft(value);
          setEditing(false);
        }
      }}
      aria-label={label}
      enterKeyHint="done"
      spellCheck={false}
      autoComplete="off"
    />
  );
}

/** 新增分類／分組的一列輸入 */
function AddRow({ placeholder, onAdd, onCancel }: { placeholder: string; onAdd(name: string): void; onCancel(): void }) {
  const [text, setText] = useState("");
  const submit = (): void => {
    const t = text.trim();
    if (!t) return;
    onAdd(t);
    setText("");
  };
  return (
    <div className="ns-tt-mgr-add">
      <input
        className="ns-tt-input"
        value={text}
        autoFocus
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (isImeKey(e)) return;
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
        enterKeyHint="done"
        spellCheck={false}
        autoComplete="off"
      />
      <button type="button" className="ns-btn btn-seal ns-btn--sm" disabled={!text.trim()} onClick={submit}>
        新增
      </button>
      <button type="button" className="ns-btn btn-ghost ns-btn--sm" onClick={onCancel}>
        取消
      </button>
    </div>
  );
}

function CategoryRow({ cat, index, count }: { cat: TimeCategoryRow; index: number; count: number }) {
  const updateCategory = useTimetableStore((s) => s.updateCategory);
  const moveCategory = useTimetableStore((s) => s.moveCategory);
  const cur = cat.default_min ?? null;
  const opts = DEFAULT_MIN_OPTIONS.some((o) => o.v === cur) ? DEFAULT_MIN_OPTIONS : [...DEFAULT_MIN_OPTIONS, { v: cur, label: fmtDur((cur ?? 0) * MIN) }];
  const slot = colorSlot(cat.color_idx);
  return (
    <div className="ns-tt-mgr-row">
      <CategoryBadge cat={cat} size="sm" />
      <EditableName value={cat.name} label="分類名稱" onSave={(name) => void updateCategory(cat.id, { name })} />
      <span className="ns-tt-mgr-moves">
        <button type="button" className="ns-tt-mgr-move" disabled={index === 0} aria-label={`${cat.name} 往上`} onClick={() => void moveCategory(cat.id, -1)}>
          ↑
        </button>
        <button type="button" className="ns-tt-mgr-move" disabled={index >= count - 1} aria-label={`${cat.name} 往下`} onClick={() => void moveCategory(cat.id, 1)}>
          ↓
        </button>
      </span>
      <div className="ns-tt-mgr-tools">
        <label className="ns-tt-mgr-def">
          <span className="ns-tt-mgr-def-k">預設長度</span>
          <select
            className="ns-tt-select"
            value={cur === null ? "" : String(cur)}
            onChange={(e) => void updateCategory(cat.id, { defaultMin: e.target.value === "" ? null : Number(e.target.value) })}
          >
            {opts.map((o) => (
              <option key={o.v === null ? "none" : o.v} value={o.v === null ? "" : String(o.v)}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <span className="ns-tt-swatches" role="group" aria-label={`${cat.name} 的顏色`}>
          {SWATCHES.map((n) => (
            <button
              key={n}
              type="button"
              className={"ns-tt-swatch" + (slot === n ? " is-on" : "")}
              style={{ "--c": `var(--ns-tt-cat-${n})` } as CSSProperties}
              aria-label={`第 ${n} 色`}
              aria-pressed={slot === n}
              onClick={() => {
                if (slot !== n) void updateCategory(cat.id, { colorIdx: n });
              }}
            />
          ))}
        </span>
      </div>
    </div>
  );
}

export function CategoryManagerPanel(_props: PanelProps) {
  const categories = useTimetableStore((s) => s.categories);
  const longRunMaxMin = useTimetableStore((s) => s.longRunMaxMin);
  const noticeEnabled = useTimetableStore((s) => s.noticeEnabled);
  const setLongRunMax = useTimetableStore((s) => s.setLongRunMax);
  const setNoticeEnabled = useTimetableStore((s) => s.setNoticeEnabled);
  const createCategory = useTimetableStore((s) => s.createCategory);
  const updateCategory = useTimetableStore((s) => s.updateCategory);
  const moveCategory = useTimetableStore((s) => s.moveCategory);

  /** 正在新增：`{ parentId }`（null＝新增分組） */
  const [adding, setAdding] = useState<{ parentId: string | null } | null>(null);
  // 真實平台：Android＝OS 常駐通知（要權限）；桌機＝系統匣（不需要通知權限）
  const android = onAndroid();
  const [perm, setPerm] = useState<NoticePermission>("granted");
  useEffect(() => {
    if (!android) return;
    let alive = true;
    void noticePermission().then((p) => {
      if (alive) setPerm(p);
    });
    return () => {
      alive = false;
    };
  }, [android]);

  const groups = groupedCategories(categories);
  const longRunOpts = LONG_RUN_OPTIONS.some((o) => o.v === longRunMaxMin)
    ? LONG_RUN_OPTIONS
    : [...LONG_RUN_OPTIONS, { v: longRunMaxMin, label: fmtDur(longRunMaxMin * MIN) }];

  const add = (parentId: string | null, name: string): void => {
    setAdding(null);
    void createCategory({ parentId, name, colorIdx: 1, defaultMin: null });
  };

  return (
    <div className="ns-tt-panel ns-tt-panel-mgr">
      {groups.map(({ group, children }, gi) => (
        <section key={group.id} className="ns-tt-mgr-group">
          <div className="ns-tt-mgr-group-head">
            <EditableName value={group.name} label="分組名稱" big onSave={(name) => void updateCategory(group.id, { name })} />
            <span className="ns-tt-mgr-moves">
              <button type="button" className="ns-tt-mgr-move" disabled={gi === 0} aria-label={`${group.name} 往上`} onClick={() => void moveCategory(group.id, -1)}>
                ↑
              </button>
              <button
                type="button"
                className="ns-tt-mgr-move"
                disabled={gi >= groups.length - 1}
                aria-label={`${group.name} 往下`}
                onClick={() => void moveCategory(group.id, 1)}
              >
                ↓
              </button>
            </span>
            <button type="button" className="ns-btn btn-ghost ns-btn--sm" onClick={() => setAdding({ parentId: group.id })}>
              ＋ 分類
            </button>
          </div>
          {adding?.parentId === group.id && <AddRow placeholder="新分類的名稱" onAdd={(name) => add(group.id, name)} onCancel={() => setAdding(null)} />}
          {children.length === 0 && adding?.parentId !== group.id && <Sub>這一組還沒有分類</Sub>}
          {children.map((c, i) => (
            <CategoryRow key={c.id} cat={c} index={i} count={children.length} />
          ))}
        </section>
      ))}
      {adding !== null && adding.parentId === null ? (
        <AddRow placeholder="新分組的名稱" onAdd={(name) => add(null, name)} onCancel={() => setAdding(null)} />
      ) : (
        <button type="button" className="ns-btn btn-ghost ns-tt-mgr-addgroup" onClick={() => setAdding({ parentId: null })}>
          ＋ 新增分組
        </button>
      )}

      <section className="ns-tt-mgr-settings">
        <h4 className="ns-tt-mgr-sec">設定</h4>
        <label className="ns-tt-setting">
          <span className="ns-tt-setting-k">長時間運行的保險上限</span>
          <select className="ns-tt-select" value={String(longRunMaxMin)} onChange={(e) => void setLongRunMax(Number(e.target.value))}>
            {longRunOpts.map((o) => (
              <option key={o.v} value={String(o.v)}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <Sub>分類沒設預設長度時，跑超過這麼久就在回來時問一聲</Sub>
        <div className="ns-tt-setting">
          <span className="ns-tt-setting-k">{android ? "通知欄顯示運行中" : "系統匣顯示運行中"}</span>
          <button
            type="button"
            role="switch"
            aria-checked={noticeEnabled}
            className={"ns-tt-toggle" + (noticeEnabled ? " is-on" : "")}
            onClick={() => void setNoticeEnabled(!noticeEnabled)}
          >
            <span className="ns-tt-toggle-knob" aria-hidden="true" />
            <span className="ns-tt-toggle-text">{noticeEnabled ? "開" : "關"}</span>
          </button>
        </div>
        {android && noticeEnabled && perm !== "granted" && (
          <div className="ns-tt-setting is-hint">
            <span className="ns-tt-setting-k is-warn">需要允許通知</span>
            <button
              type="button"
              className="ns-btn btn-ghost ns-btn--sm"
              onClick={() => {
                void askNotificationPermissionOnce().then((r) => {
                  if (r === "granted") setPerm("granted");
                  else if (r === "denied") setPerm("denied");
                });
              }}
            >
              允許通知
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
