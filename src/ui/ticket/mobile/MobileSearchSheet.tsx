/**
 * MobileSearchSheet——售票口手機的搜尋＋篩選 sheet（②契約 §5.3、0-14、0-15；丙席擁有）。由 MobileTicketOffice 合計帶的放大鏡開、自己持有開關。
 *
 * 骨架沿 MSheet（`.m-sheet-veil.techo-veil.ns-tk-mveil > .m-sheet.ns-tk-msheet`，portal 到 body）；頂部不放標題、放搜尋框：
 *   頂：搜尋框（autoFocus、inputmode=search、IME 組字中不查、去抖 150ms）＋「完成」
 *   五段：期間（全部／本月／今年／自訂＋兩個 MobileDatePicker）／帳戶（chips 橫捲，含「封存」分區）／
 *         分類（支出、收入兩組格子：主分類格整勾＝含子分類；格右 › 展開子分類單勾）／類型（四顆 toggle）／路線（全部／未掛／各路線）
 *   底：「清除全部」・「看結果（N）」
 * 條件一改 store 就查（`patchFilter`／`setFilterText`），N＝`results.length`。
 * 關 sheet（完成／暗幕／看結果）：有任何條件 ⇒ `openSearch`（切清單、清單畫結果，月份列換成 chips 列）；全空 ⇒ `closeSearch`。
 */
import { useEffect, useRef, useState, type CompositionEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTicketStore } from "../../../store/ticketStore";
import { useNodeStore } from "../../../store/nodeStore";
import { useUiStore } from "../../../store/uiStore";
import { todayKey } from "../../../lib/date";
import { roundelStyle } from "../../common/roundel";
import { MobileDatePicker } from "../../common/MobileDatePicker";
import {
  UNCAT_EXPENSE_ID,
  UNCAT_INCOME_ID,
  archivedAccounts,
  categoryTree,
  groupAccounts,
  monthOf,
  monthRange,
  type CategoryKind,
  type EntryKind,
} from "../../../domain/ticket";
import { EMPTY_FILTER, dayStep, isFilterActive, shortDay, type EntryFilter } from "../../../domain/ticketView";
import { IconRight } from "./mobileBits";

export interface MobileSearchSheetProps {
  onClose(): void;
}

const DEBOUNCE_MS = 150;
const KINDS: readonly { k: EntryKind; label: string }[] = [
  { k: "expense", label: "支出" },
  { k: "income", label: "收入" },
  { k: "transfer", label: "轉帳" },
  { k: "adjust", label: "校正" },
];

/** 放大鏡（16 viewBox／1.3 筆觸，同 mobileBits 的圖示語彙）；合計帶的搜尋鈕也用這支 */
export const IconSearch = ({ size = 18 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.3"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="7" cy="7" r="4.4" />
    <path d="M10.3 10.3 13.6 13.6" />
  </svg>
);

type PeriodKind = "all" | "month" | "year" | "custom";

export function MobileSearchSheet({ onClose }: MobileSearchSheetProps) {
  const filter = useTicketStore((s) => s.filter);
  const results = useTicketStore((s) => s.results);
  const accounts = useTicketStore((s) => s.accounts);
  const categories = useTicketStore((s) => s.categories);
  const patchFilter = useTicketStore((s) => s.patchFilter);
  const setFilterText = useTicketStore((s) => s.setFilterText);
  const routes = useNodeStore((s) => s.routes);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const today = todayKey(dayStartHour);

  /* ── 關鍵字：本地字＋去抖；組字中不查（IME 守門，同 MobileToday 的作法） ── */
  const [text, setText] = useState(filter.text);
  const composing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingText = useRef<string | null>(null);
  const flush = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const t = pendingText.current;
    pendingText.current = null;
    if (t !== null && t !== useTicketStore.getState().filter.text) return setFilterText(t);
    return Promise.resolve();
  };
  const queue = (t: string) => {
    pendingText.current = t;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), DEBOUNCE_MS);
  };
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  // 外面清掉（例如「清除全部」）時跟著清
  useEffect(() => {
    if (filter.text === "" && pendingText.current === null) setText("");
  }, [filter.text]);

  const close = async () => {
    await flush();
    const st = useTicketStore.getState();
    if (isFilterActive(st.filter)) st.openSearch();
    else st.closeSearch();
    onClose();
  };

  const clearAll = () => {
    if (timer.current) clearTimeout(timer.current);
    pendingText.current = null;
    setText("");
    setCustomOpen(false);
    void patchFilter({ ...EMPTY_FILTER });
  };

  /* ── 期間 ── */
  const thisMonth = monthOf(today);
  const mr = monthRange(thisMonth);
  const y = today.slice(0, 4);
  const yr = { from: `${y}-01-01`, toExcl: `${Number(y) + 1}-01-01` };
  const [customOpen, setCustomOpen] = useState(false);
  const periodKind: PeriodKind =
    filter.from === null && filter.toExcl === null
      ? customOpen
        ? "custom"
        : "all"
      : filter.from === mr.from && filter.toExcl === mr.toExcl && !customOpen
        ? "month"
        : filter.from === yr.from && filter.toExcl === yr.toExcl && !customOpen
          ? "year"
          : "custom";
  const setPeriod = (k: PeriodKind) => {
    setCustomOpen(k === "custom");
    if (k === "all") void patchFilter({ from: null, toExcl: null });
    else if (k === "month") void patchFilter({ from: mr.from, toExcl: mr.toExcl });
    else if (k === "year") void patchFilter({ from: yr.from, toExcl: yr.toExcl });
  };
  const [picking, setPicking] = useState<"from" | "to" | null>(null);
  const toIncl = filter.toExcl !== null ? dayStep(filter.toExcl, -1) : null;

  /* ── 帳戶／分類／路線 ── */
  const live = groupAccounts(accounts).flatMap((g) => g.accounts);
  const archived = archivedAccounts(accounts);
  const [openCat, setOpenCat] = useState<string | null>(null);
  const toggleCat = (id: string) => {
    const has = filter.categoryIds.indexOf(id) >= 0;
    void patchFilter({ categoryIds: has ? filter.categoryIds.filter((x) => x !== id) : [...filter.categoryIds, id] });
  };
  const toggleKind = (k: EntryKind) => {
    const has = filter.kinds.indexOf(k) >= 0;
    void patchFilter({ kinds: has ? filter.kinds.filter((x) => x !== k) : [...filter.kinds, k] });
  };
  const liveRoutes = routes.filter((r) => r.deleted_at === null);

  const n = isFilterActive(filter) ? (results?.length ?? 0) : 0;

  const chip = (key: string, on: boolean, label: ReactNode, onClick: () => void) => (
    <button key={key} type="button" className={"ns-tk-mchip" + (on ? " on" : "")} aria-pressed={on} onClick={onClick}>
      {label}
    </button>
  );

  const catGroup = (kind: CategoryKind) => {
    const tree = categoryTree(categories, kind, { includeArchived: false });
    // 未分類排最後（同統計：未分類固定最後）
    const uncat = tree.filter((t) => t.parent.id === UNCAT_EXPENSE_ID || t.parent.id === UNCAT_INCOME_ID);
    const main = tree.filter((t) => t.parent.id !== UNCAT_EXPENSE_ID && t.parent.id !== UNCAT_INCOME_ID).concat(uncat);
    const out: ReactNode[] = [];
    const cols = 3;
    main.forEach((t, i) => {
      const on = filter.categoryIds.indexOf(t.parent.id) >= 0;
      const subsOn = t.children.filter((c) => filter.categoryIds.indexOf(c.id) >= 0).length;
      out.push(
        <div key={t.parent.id} className={"ns-tk-msc" + (on ? " on" : "") + (openCat === t.parent.id ? " open" : "")}>
          <button type="button" className="pick" aria-pressed={on} onClick={() => toggleCat(t.parent.id)}>
            <span className="nm">{t.parent.name}</span>
            {t.children.length > 0 && <small>{on ? "含子分類" : subsOn ? `已勾 ${subsOn} 個子分類` : `${t.children.length} 個子分類`}</small>}
          </button>
          {t.children.length > 0 && (
            <button
              type="button"
              className="more"
              aria-label={`${t.parent.name}的子分類`}
              aria-expanded={openCat === t.parent.id}
              onClick={() => setOpenCat(openCat === t.parent.id ? null : t.parent.id)}
            >
              <IconRight size={11} />
            </button>
          )}
        </div>,
      );
      // 展開的子分類插在那一列的下方（整列寬）
      const rowEnd = i % cols === cols - 1 || i === main.length - 1;
      if (rowEnd) {
        const rowStart = i - (i % cols);
        const opened = main.slice(rowStart, i + 1).find((x) => x.parent.id === openCat && x.children.length > 0);
        if (opened) {
          out.push(
            <div key={"subs-" + opened.parent.id} className="ns-tk-msubs">
              <p className="hd">{opened.parent.name} › 單選子分類</p>
              <div className="ns-tk-mgrid">
                {opened.children.map((c) => {
                  const cOn = filter.categoryIds.indexOf(c.id) >= 0;
                  return (
                    <button key={c.id} type="button" className={"ns-tk-mcell" + (cOn ? " on" : "")} aria-pressed={cOn} onClick={() => toggleCat(c.id)}>
                      {c.name}
                    </button>
                  );
                })}
              </div>
            </div>,
          );
        }
      }
    });
    return out;
  };

  return createPortal(
    <div className="m-sheet-veil techo-veil ns-tk-mveil" role="presentation" onClick={() => void close()}>
      <div
        className="m-sheet ns-card ns-tk-msheet ns-tk-msearch-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="搜尋與篩選"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ns-tk-msheet-grip" aria-hidden />
        <div className="ns-tk-ms-top">
          <label className="ns-tk-ms-field">
            <IconSearch size={15} />
            <input
              type="search"
              inputMode="search"
              enterKeyHint="search"
              autoFocus
              aria-label="搜尋"
              placeholder="搜尋備註、分類、帳戶、金額…"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                if (!composing.current) queue(e.target.value);
              }}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={(e: CompositionEvent<HTMLInputElement>) => {
                composing.current = false;
                queue(e.currentTarget.value);
              }}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                if (e.nativeEvent.isComposing || e.keyCode === 229 || composing.current) return; // 組字中的 Enter 是選字
                e.preventDefault();
                void close();
              }}
            />
            {text !== "" && (
              <button
                type="button"
                className="clr"
                aria-label="清掉關鍵字"
                onClick={() => {
                  setText("");
                  queue("");
                }}
              >
                ×
              </button>
            )}
          </label>
          <button type="button" className="ns-tk-mbtn quiet" onClick={() => void close()}>
            完成
          </button>
        </div>

        <div className="ns-tk-ms-body">
          <Sec title="期間">
            <div className="ns-tk-mchips">
              {chip("all", periodKind === "all", "全部", () => setPeriod("all"))}
              {chip("month", periodKind === "month", "本月", () => setPeriod("month"))}
              {chip("year", periodKind === "year", "今年", () => setPeriod("year"))}
              {chip("custom", periodKind === "custom", "自訂", () => setPeriod("custom"))}
            </div>
            {periodKind === "custom" && (
              <div className="ns-tk-ms-range">
                <button type="button" className="ns-tk-ms-date" onClick={() => setPicking("from")}>
                  <small>從</small>
                  {filter.from ? `${filter.from.slice(0, 4)}/${shortDay(filter.from)}` : "最早"}
                </button>
                <span className="dash" aria-hidden>
                  –
                </span>
                <button type="button" className="ns-tk-ms-date" onClick={() => setPicking("to")}>
                  <small>到</small>
                  {toIncl ? `${toIncl.slice(0, 4)}/${shortDay(toIncl)}` : "今天"}
                </button>
              </div>
            )}
          </Sec>

          <Sec title="帳戶">
            <div className="ns-tk-mchips is-scroll">
              {chip("all", filter.accountId === null, "全部", () => void patchFilter({ accountId: null }))}
              {live.map((a) => chip(a.id, filter.accountId === a.id, a.name, () => void patchFilter({ accountId: filter.accountId === a.id ? null : a.id })))}
              {archived.length > 0 && (
                <span className="ns-tk-ms-sep" aria-hidden>
                  封存
                </span>
              )}
              {archived.map((a) =>
                chip(
                  a.id,
                  filter.accountId === a.id,
                  <span className="is-arch">{a.name}</span>,
                  () => void patchFilter({ accountId: filter.accountId === a.id ? null : a.id }),
                ),
              )}
            </div>
          </Sec>

          <Sec title="分類">
            <p className="ns-tk-ms-sub">支出</p>
            <div className="ns-tk-ms-cats">{catGroup("expense")}</div>
            <p className="ns-tk-ms-sub">收入</p>
            <div className="ns-tk-ms-cats">{catGroup("income")}</div>
          </Sec>

          <Sec title="類型">
            <div className="ns-tk-mchips">{KINDS.map((x) => chip(x.k, filter.kinds.indexOf(x.k) >= 0, x.label, () => toggleKind(x.k)))}</div>
          </Sec>

          <Sec title="路線">
            <div className="ns-tk-mchips is-scroll">
              {chip("all", filter.routeId === null, "全部", () => void patchFilter({ routeId: null }))}
              {chip("none", filter.routeId === "none", "未掛", () => void patchFilter({ routeId: filter.routeId === "none" ? null : "none" }))}
              {liveRoutes.map((r) =>
                chip(
                  r.id,
                  filter.routeId === r.id,
                  <>
                    <span className="roundel" aria-hidden style={roundelStyle(r.color)}>
                      {r.code ?? r.name.slice(0, 1)}
                    </span>
                    {r.name}
                  </>,
                  () => void patchFilter({ routeId: filter.routeId === r.id ? null : r.id }),
                ),
              )}
            </div>
          </Sec>
        </div>

        <div className="ns-tk-ms-foot">
          <button type="button" className="ns-tk-mbtn" onClick={clearAll} disabled={!isFilterActive(filter) && text === ""}>
            清除全部
          </button>
          <button type="button" className="ns-tk-mbtn primary" onClick={() => void close()}>
            看結果（{n}）
          </button>
        </div>
        {/* 挑日子的面板 portal 到 body，但 React 事件仍沿這棵樹冒泡：放在 sheet 裡面，點它的暗幕才不會冒到外層暗幕、把整張 sheet 關掉 */}
        {picking && (
          <MobileDatePicker
            title={picking === "from" ? "從哪一天" : "到哪一天"}
            value={picking === "from" ? filter.from : toIncl}
            max={today}
            min={picking === "to" && filter.from ? filter.from : undefined}
            quick={
              picking === "from"
                ? [
                    { label: "本月 1 號", day: mr.from },
                    { label: "今年 1/1", day: yr.from },
                  ]
                : [{ label: "今天", day: today }]
            }
            onPick={(day) => {
              setPicking(null);
              if (picking === "from") {
                const p: Partial<EntryFilter> = { from: day };
                // 從 晚於 到 ⇒ 到 跟著挪到同一天（不留空區間）
                if (toIncl !== null && day > toIncl) p.toExcl = dayStep(day, 1);
                void patchFilter(p);
              } else void patchFilter({ toExcl: dayStep(day, 1) });
            }}
            onClose={() => setPicking(null)}
          />
        )}
      </div>
    </div>,
    document.body,
  );
}

function Sec({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="ns-tk-ms-sec" aria-label={title}>
      <p className="ns-tk-ms-lbl">{title}</p>
      {children}
    </section>
  );
}
