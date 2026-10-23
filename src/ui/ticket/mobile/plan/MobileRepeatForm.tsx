/**
 * MobileRepeatForm——手機的定期規則表單（全螢幕；骨架照 MobileEntryForm；③契約 §5.5、✎-4／✎-7／✎-8；原型題三手機；丙席擁有）。
 * 宿主＝MobileSheetHost（dialog.kind === "repeat" 時不包底部面板，直接畫這張）。根 `div.ns-tk-mform.ns-tk-mre`，portal 到 body。
 *
 * 由上而下（原型結論：頻率是這張表單的重點，放第一屏）：
 *   頂列「取消」・「支出｜收入｜轉帳」・「存」
 *   →（從一筆帳「設成定期…」來的）一行淡字「從 10/19 那筆帶過來的；那筆本身不會被重記」
 *   → 金額大字＋幣別 chip
 *   → 頻率區（固定展開）：「頻率 每月 5 日」・每日｜每週｜每月・星期 7 格／1–31 日格（7 欄）・起算日
 *   → 帳戶 chips（轉帳＝從／到）→ 分類兩層格子（收支）
 *   → 「更多欄位」折疊：時刻・終止日（選填）・備註・路線
 *   → 預覽一行（repeatLabel＋「第一班／下一班／從 X 起補記」）
 *   → 底部：編輯既有規則時「刪除這條規則」
 * 草稿在 store（`repeatDraft`／`setRepeatDraft`／`saveRepeatDraft`）；「取消」＝`onDone`（宿主接 `closeRepeatEditor`：從管理 sheet 開的回管理 sheet）。
 * 層級：和記一筆表單同為 46；從記一筆表單「設成定期…」開時後掛載、疊在它上面，存完回到那一筆（看得到新的「定期」列）。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTicketStore } from "../../../../store/ticketStore";
import { useNodeStore } from "../../../../store/nodeStore";
import { useUiStore } from "../../../../store/uiStore";
import { addDays, todayKey } from "../../../../lib/date";
import { roundelStyle } from "../../../common/roundel";
import { MobileDatePicker } from "../../../common/MobileDatePicker";
import { useBackLayer } from "../../../mobile/backStack";
import { shortDayKey } from "../../../common/DatePicker";
import {
  MAIN_CURRENCY,
  categoryLabel,
  categoryTree,
  orderAccounts,
  parseAmount,
  type AccountRow,
  type CategoryRow,
} from "../../../../domain/ticket";
import { repeatLabel, type RepeatDraft, type RepeatRow } from "../../../../domain/ticketPlan";
import {
  WEEKDAY_LABEL,
  WEEKDAY_ORDER,
  describeRule,
  firstFixedDate,
  fixedRule,
  nextFixedDate,
  serializeRule,
  type FixedRepeatRule,
} from "../../../../domain/repeat";
import { IconCaret, IconRight, MSheet, groupLabelOf, useImeGuard } from "../mobileBits";

const KINDS: { key: RepeatDraft["kind"]; label: string }[] = [
  { key: "expense", label: "支出" },
  { key: "income", label: "收入" },
  { key: "transfer", label: "轉帳" },
];
const SIGN: Record<RepeatDraft["kind"], string> = { expense: "", income: "＋", transfer: "⇄" };
const FREQS: { key: RepeatDraft["freq"]; label: string }[] = [
  { key: "daily", label: "每日" },
  { key: "weekly", label: "每週" },
  { key: "monthly", label: "每月" },
];
const DAYS_1_31: number[] = Array.from({ length: 31 }, (_, i) => i + 1);

/** 這天是星期幾（0＝日；本地 new Date(y,m-1,d)） */
function dowOf(day: string): number {
  return new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))).getDay();
}

/** 草稿 → 規則（預覽與「頻率」那一句用；不驗證——存檔時 store 會用 draftToRepeatInput 驗） */
function draftRule(d: RepeatDraft): FixedRepeatRule {
  const rule = fixedRule(d.freq, d.start, { byweekday: d.byweekday.slice().sort(), bymonthday: d.bymonthday.slice().sort((a, b) => a - b) });
  rule.until = d.until;
  return rule;
}

export function MobileRepeatForm({ onDone }: { onDone(): void }) {
  const draft = useTicketStore((s) => s.repeatDraft);
  const dialog = useTicketStore((s) => s.dialog);
  if (!draft || !dialog || dialog.kind !== "repeat") return null;
  return <RepeatForm d={draft} editId={dialog.id} onDone={onDone} />;
}

function RepeatForm({ d, editId, onDone }: { d: RepeatDraft; editId: string | null; onDone(): void }) {
  const setDraft = useTicketStore((s) => s.setRepeatDraft);
  const saveRepeatDraft = useTicketStore((s) => s.saveRepeatDraft);
  const deleteRepeat = useTicketStore((s) => s.deleteRepeat);
  const accounts = useTicketStore((s) => s.accounts);
  const accById = useTicketStore((s) => s.accById);
  const categories = useTicketStore((s) => s.categories);
  const catById = useTicketStore((s) => s.catById);
  const currencies = useTicketStore((s) => s.currencies);
  const curByCode = useTicketStore((s) => s.curByCode);
  const repeats = useTicketStore((s) => s.repeats);
  const fromEntry = useTicketStore((s) =>
    d.fromEntryId ? (s.entries.find((e) => e.id === d.fromEntryId) ?? s.statsEntries.find((e) => e.id === d.fromEntryId) ?? null) : null,
  );
  const routes = useNodeStore((s) => s.routes);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const today = todayKey(dayStartHour);
  const isNew = editId === null;
  const row = editId ? (repeats.find((r) => r.id === editId) ?? null) : null;

  const [sheet, setSheet] = useState<"currency" | "start" | "until" | null>(null);
  // 磨光①（主線手機殼契約 §1.5）：表單本身的返回層在宿主（ticket.dialog）；這裡的幣別／日期 sheet 疊在全螢幕表單上，
  // 要比 "full" 高才會先關它 ⇒ 登記成 "dialog"（同記帳表單）
  useBackLayer("ticket.repeat.pick", sheet !== null, () => setSheet(null), "dialog");
  const [more, setMore] = useState(!isNew && (d.note !== "" || d.routeId !== null || d.until !== null));
  const busy = useRef(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const kind = d.kind;
  const transfer = kind === "transfer";
  const catKind = kind === "income" ? "income" : "expense";
  const acc = d.accountId ? accById[d.accountId] : undefined;
  const toAcc = d.toAccountId ? accById[d.toAccountId] : undefined;
  const curCode = transfer ? (acc?.currency ?? d.currency) : d.currency;

  /* 帳戶 chips：未封存依群組順序；選中的即使已封存也列 */
  const chipAccounts = useMemo(() => {
    const live = orderAccounts(accounts.filter((a) => a.deleted_at === null && a.archived_at === null));
    for (const id of [d.accountId, d.toAccountId]) {
      if (id && accById[id] && accById[id].deleted_at === null && !live.some((a) => a.id === id)) live.push(accById[id]);
    }
    return live;
  }, [accounts, accById, d.accountId, d.toAccountId]);
  const dupName = (a: AccountRow) => accounts.filter((x) => x.name === a.name && x.deleted_at === null).length > 1;

  /* 分類兩層格子（同記一筆表單） */
  const tree = useMemo(() => categoryTree(categories, catKind, { includeArchived: false }), [categories, catKind]);
  const selCat = d.categoryId ? (catById[d.categoryId] ?? null) : null;
  const [openMain, setOpenMain] = useState<string | null>(() => (selCat ? (selCat.parent_id ?? selCat.id) : null));

  /* 選中的 chip 捲進橫捲列的可視範圍（只動水平） */
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.querySelectorAll<HTMLElement>(".ns-tk-mf-accts").forEach((el) => {
      const on = el.querySelector<HTMLElement>(".ns-tk-mchip.on");
      if (!on) return;
      const l = on.offsetLeft - el.offsetLeft;
      const r = l + on.offsetWidth;
      if (l < el.scrollLeft) el.scrollLeft = Math.max(0, l - 18);
      else if (r > el.scrollLeft + el.clientWidth) el.scrollLeft = r - el.clientWidth + 18;
    });
  }, [d.accountId, d.toAccountId, d.routeId, kind, more]);

  /* 開啟＝焦點進表單根（新規則且金額空著時由金額欄 autoFocus）；關閉時還回開它的元素 */
  useEffect(() => {
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!(isNew && d.amountText === "")) rootRef.current?.focus({ preventScroll: true });
    return () => {
      if (prev && prev.isConnected && prev !== document.body) prev.focus({ preventScroll: true });
    };
    // 只在開啟那一下
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      await saveRepeatDraft(); // 成功會自己 closeRepeatEditor；失敗 toast、表單留著
    } finally {
      busy.current = false;
    }
  };
  const amtIme = useImeGuard((e) => {
    e.preventDefault();
    void save();
  });

  /* 頻率：切到每週／每月時若還沒選日子，先帶起算日那天（省一步；存檔仍會擋「至少一天」） */
  const pickFreq = (freq: RepeatDraft["freq"]) => {
    const patch: Partial<RepeatDraft> = { freq };
    if (freq === "weekly" && d.byweekday.length === 0) patch.byweekday = [dowOf(d.start)];
    if (freq === "monthly" && d.bymonthday.length === 0) patch.bymonthday = [Number(d.start.slice(8, 10))];
    setDraft(patch);
  };
  const toggle = (list: readonly number[], v: number) => (list.indexOf(v) >= 0 ? list.filter((x) => x !== v) : list.concat(v));

  const rule = draftRule(d);
  const ruleText = describeRule(rule);
  const hasLate = d.freq === "monthly" && d.bymonthday.some((n) => n > 28);
  const pastStart = isNew && d.start < today;

  /* 預覽：repeatLabel 吃規則列；用草稿拼一列（金額看不懂就不印預覽句，只印班次） */
  const preview = (() => {
    const cur = curByCode[curCode];
    let amount: number | null = null;
    try {
      if (cur && d.amountText.trim() !== "") amount = parseAmount(d.amountText, cur, { allowNegative: kind === "expense", allowZero: true });
    } catch {
      amount = null;
    }
    const fake: RepeatRow = {
      id: editId ?? "draft",
      kind,
      account_id: d.accountId ?? "",
      to_account_id: transfer ? d.toAccountId : null,
      category_id: transfer ? null : d.categoryId,
      amount_minor: amount ?? 0,
      currency: curCode,
      note: d.note,
      route_id: d.routeId,
      rule: serializeRule(rule),
      hhmm: d.hhmm,
      next_on: null,
      paused_at: null,
      skipped_days: "[]",
      position: 0,
      import_id: null,
      import_source: null,
      import_utime: null,
      device_id: null,
      created_at: "",
      updated_at: "",
      synced_at: null,
      deleted_at: null,
    };
    const text = amount === null ? null : repeatLabel(fake, { accById, catById, curByCode });
    // 班次：新規則＝起算日起第一班（在過去 ⇒「從 X 起補記」）；編輯中＝規則沒變照游標，變了＝今天之後第一班（同 applyRepeatPatch）
    let nx: string;
    if (isNew) {
      const first = firstFixedDate(rule, d.start);
      nx = first === null ? "不會有班次" : first < today ? `從 ${shortDayKey(first)} 起補記` : first === today ? "第一班 今天" : `第一班 ${shortDayKey(first)}`;
    } else {
      const same = row !== null && row.rule === fake.rule;
      const next = same ? row.next_on : nextFixedDate(rule, today);
      nx = row?.paused_at ? "已暫停" : next === null ? "已結束" : `下一班 ${shortDayKey(next)}`;
    }
    return { text, nx };
  })();

  const pickCat = (c: CategoryRow) => setDraft({ categoryId: c.id });
  const mainCell = (p: CategoryRow, hasKids: boolean) => {
    const selIn = !!selCat && (selCat.id === p.id || selCat.parent_id === p.id);
    return (
      <button
        key={p.id}
        type="button"
        className={"ns-tk-mcell" + (selIn ? " on" : "") + (p.id === openMain && !selIn ? " open" : "")}
        aria-expanded={hasKids ? p.id === openMain : undefined}
        aria-pressed={selIn}
        onClick={() => {
          pickCat(p);
          if (hasKids) setOpenMain(openMain === p.id ? null : p.id);
          else setOpenMain(null);
        }}
      >
        {p.name}
      </button>
    );
  };
  const fullGrid = () => {
    const cells: ReactNode[] = [];
    const openIdx = tree.findIndex((t) => t.parent.id === openMain);
    const rowEnd = openIdx < 0 ? -1 : Math.min(tree.length - 1, Math.floor(openIdx / 4) * 4 + 3);
    tree.forEach((t, i) => {
      cells.push(mainCell(t.parent, t.children.length > 0));
      if (i === rowEnd && tree[openIdx].children.length > 0) {
        const op = tree[openIdx];
        cells.push(
          <div key={"subs-" + op.parent.id} className="ns-tk-msubs">
            <div className="hd">{op.parent.name} ›</div>
            <div className="ns-tk-mgrid">
              {op.children.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={"ns-tk-mcell" + (selCat?.id === c.id ? " on" : "")}
                  aria-pressed={selCat?.id === c.id}
                  onClick={() => pickCat(c)}
                >
                  {c.name}
                </button>
              ))}
            </div>
          </div>,
        );
      }
    });
    return <div className="ns-tk-mgrid">{cells}</div>;
  };

  const chips = (which: "from" | "to") => {
    const cur = which === "from" ? d.accountId : d.toAccountId;
    const list = which === "to" ? chipAccounts.filter((a) => a.id !== d.accountId) : chipAccounts;
    return (
      <div className="ns-tk-mf-accts" role="group" aria-label={which === "from" ? "帳戶" : "轉入帳戶"}>
        {list.map((a) => (
          <button
            key={a.id}
            type="button"
            className={"ns-tk-mchip" + (a.id === cur ? " on" : "")}
            aria-pressed={a.id === cur}
            onClick={() => setDraft(which === "from" ? { accountId: a.id } : { toAccountId: a.id })}
          >
            {a.name}
            {dupName(a) && <small>{groupLabelOf(a.group_key)}</small>}
          </button>
        ))}
        {list.length === 0 && <span className="ns-tk-mf-none">{which === "to" ? "只有一個帳戶，轉不出去" : "還沒有帳戶"}</span>}
      </div>
    );
  };

  const route = d.routeId ? (routes.find((r) => r.id === d.routeId) ?? null) : null;
  const moreSum = [
    d.hhmm,
    d.until ? `到 ${shortDayKey(d.until)} 止` : null,
    d.note.trim() ? "有備註" : "無備註",
    route ? `${route.code ? route.code + " " : ""}${route.name}` : "不掛路線",
  ]
    .filter(Boolean)
    .join(" · ");
  const dayLabel = (day: string) => (day === today ? "今天" : `${shortDayKey(day)} 週${WEEKDAY_LABEL[dowOf(day)]}`);

  return createPortal(
    <div ref={rootRef} className="ns-tk-mform ns-tk-mre" tabIndex={-1} data-kind={kind} role="dialog" aria-modal="true" aria-label={isNew ? "新增定期帳" : "定期帳"}>
      <div className="ns-tk-mf-top">
        <button type="button" className="ns-btn btn-ghost ns-tk-mbtn" onClick={onDone}>
          取消
        </button>
        <span className="ns-tk-mkind" role="group" aria-label="類型">
          {KINDS.map((k) => (
            <button key={k.key} type="button" aria-pressed={kind === k.key} onClick={() => setDraft({ kind: k.key })}>
              {k.label}
            </button>
          ))}
        </span>
        <button type="button" className="ns-btn btn-seal ns-tk-mbtn" onClick={() => void save()}>
          存
        </button>
      </div>

      <div className="ns-tk-mf-scroll">
        {fromEntry && <p className="ns-tk-mre-from">從 {shortDayKey(fromEntry.occurred_on)} 那筆帶入，原本那筆不會重複記</p>}

        <div className="ns-tk-mf-amt">
          <span className="sg">{SIGN[kind]}</span>
          <input
            className="ns-tk-mamtin"
            inputMode="decimal"
            autoComplete="off"
            enterKeyHint="done"
            autoFocus={isNew && d.amountText === ""}
            value={d.amountText}
            placeholder="0"
            aria-label="金額"
            onChange={(e) => setDraft({ amountText: e.target.value })}
            {...amtIme}
          />
          <button
            type="button"
            className="ns-tk-mcurchip"
            disabled={transfer || currencies.length < 2}
            aria-haspopup="dialog"
            aria-label={`幣別 ${curCode}`}
            onClick={() => setSheet("currency")}
          >
            {curCode}
          </button>
        </div>

        {/* 頻率區：固定展開 */}
        <div className="ns-tk-mre-freq">
          <p className="ns-tk-mf-lbl">
            頻率<em>{ruleText}</em>
          </p>
          <div className="ns-tk-mre-seg">
            <span className="ns-tk-mseg" role="group" aria-label="頻率">
              {FREQS.map((f) => (
                <button key={f.key} type="button" aria-pressed={d.freq === f.key} onClick={() => pickFreq(f.key)}>
                  {f.label}
                </button>
              ))}
            </span>
          </div>
          <div className="ns-tk-mre-detail">
            {d.freq === "daily" ? (
              <p className="ns-tk-mre-dailyhint">每天都記一筆</p>
            ) : d.freq === "weekly" ? (
              <div className="ns-tk-mre-wk" role="group" aria-label="星期幾">
                {WEEKDAY_ORDER.map((w) => (
                  <button key={w} type="button" aria-pressed={d.byweekday.indexOf(w) >= 0} onClick={() => setDraft({ byweekday: toggle(d.byweekday, w) })}>
                    {WEEKDAY_LABEL[w]}
                  </button>
                ))}
              </div>
            ) : (
              <>
                <div className="ns-tk-mre-days" role="group" aria-label="每月的哪幾天">
                  {DAYS_1_31.map((n) => (
                    <button
                      key={n}
                      type="button"
                      aria-pressed={d.bymonthday.indexOf(n) >= 0}
                      aria-label={`${n} 日`}
                      onClick={() => setDraft({ bymonthday: toggle(d.bymonthday, n) })}
                    >
                      {n}
                    </button>
                  ))}
                </div>
                {hasLate && <p className="ns-tk-mre-hint">遇到月底沒有這天，就記在當月最後一天</p>}
              </>
            )}
          </div>
          <div className="ns-tk-mf-field">
            <span className="lbl">起算日</span>
            <button type="button" className="ns-tk-mf-pick" aria-haspopup="dialog" onClick={() => setSheet("start")}>
              {dayLabel(d.start)}
              <IconRight size={11} />
            </button>
          </div>
          {pastStart && <p className="ns-tk-mre-hint is-past">起算日在過去：會補記從那天起的每一班</p>}
        </div>

        {transfer ? (
          <>
            <p className="ns-tk-mf-lbl">
              從<em>{acc?.name ?? "—"}</em>
            </p>
            {chips("from")}
            <p className="ns-tk-mf-lbl">
              到<em>{toAcc?.name ?? "—"}</em>
            </p>
            {chips("to")}
          </>
        ) : (
          <>
            <p className="ns-tk-mf-lbl">
              帳戶<em>{acc ? acc.name + (dupName(acc) ? ` · ${groupLabelOf(acc.group_key)}` : "") : "—"}</em>
            </p>
            {chips("from")}
            <p className="ns-tk-mf-lbl">
              分類<em>{selCat ? categoryLabel(selCat, catById) + (selCat.archived_at ? "（已封存）" : "") : "未選"}</em>
            </p>
            <div className="ns-tk-mf-cats">{fullGrid()}</div>
          </>
        )}

        <div className="ns-tk-mf-more">
          <button type="button" className="ns-tk-mf-moretog" aria-expanded={more} onClick={() => setMore(!more)}>
            更多欄位<span className="sum">{moreSum}</span>
            <IconCaret />
          </button>
          {more && (
            <div className="ns-tk-mf-morebody">
              <div className="ns-tk-mf-field">
                <span className="lbl">時刻</span>
                <input
                  type="time"
                  className="ns-tk-mf-time"
                  value={d.hhmm}
                  aria-label="記在幾點"
                  onChange={(e) => {
                    if (e.target.value) setDraft({ hhmm: e.target.value });
                  }}
                />
              </div>
              <div className="ns-tk-mf-field">
                <span className="lbl">結束日</span>
                <button type="button" className="ns-tk-mf-pick" aria-haspopup="dialog" onClick={() => setSheet("until")}>
                  {d.until ? dayLabel(d.until) : "（選填）"}
                  <IconRight size={11} />
                </button>
                {d.until && (
                  <button type="button" className="ns-btn ns-btn--sm btn-text ns-tk-mbtn ns-tk-mre-clr" onClick={() => setDraft({ until: null })}>
                    不設
                  </button>
                )}
              </div>
              <label className="ns-tk-mf-field top">
                <span className="lbl">備註</span>
                <textarea className="ns-tk-mf-note" rows={2} value={d.note} placeholder="備註" onChange={(e) => setDraft({ note: e.target.value })} />
              </label>
              <div className="ns-tk-mf-field">
                <span className="lbl">路線</span>
                <div className="ns-tk-mf-accts in-field" role="group" aria-label="路線">
                  <button
                    type="button"
                    className={"ns-tk-mchip" + (d.routeId === null ? " on" : "")}
                    aria-pressed={d.routeId === null}
                    onClick={() => setDraft({ routeId: null })}
                  >
                    不掛
                  </button>
                  {routes.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      className={"ns-tk-mchip" + (d.routeId === r.id ? " on" : "")}
                      aria-pressed={d.routeId === r.id}
                      onClick={() => setDraft({ routeId: r.id })}
                    >
                      <span className="roundel" aria-hidden style={roundelStyle(r.color)}>
                        {r.code ?? r.name.slice(0, 1)}
                      </span>
                      {r.name}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        <p className="ns-tk-mre-preview" aria-live="polite">
          <span className="t">{preview.text ?? `${ruleText} · 先填金額`}</span>
          <span className="nx">{preview.nx}</span>
        </p>
        <div className="ns-tk-mf-pad" />
      </div>

      {!isNew && editId && (
        <div className="ns-tk-mf-foot">
          <button
            type="button"
            className="ns-btn btn-ghost ns-btn-danger ns-tk-mbtn"
            onClick={() => {
              onDone();
              void deleteRepeat(editId); // 軟刪＋toast「復原」（store）
            }}
          >
            刪除這條規則
          </button>
        </div>
      )}

      {sheet === "currency" && (
        <MSheet title="幣別" over onClose={() => setSheet(null)}>
          {currencies.map((c) => (
            <button
              key={c.id}
              type="button"
              className={"m-sheet-item ns-tk-msheet-row" + (c.code === curCode ? " is-on" : "")}
              aria-pressed={c.code === curCode}
              onClick={() => {
                setDraft({ currency: c.code });
                setSheet(null);
              }}
            >
              {c.code}
              <small>
                {c.name}
                {c.is_main === 1 ? " · 主幣別" : ` · 1 ${c.code} ＝ ${c.rate_to_main} ${MAIN_CURRENCY}`}
              </small>
            </button>
          ))}
          <button type="button" className="m-sheet-item is-cancel" onClick={() => setSheet(null)}>
            取消
          </button>
        </MSheet>
      )}
      {sheet === "start" && (
        <MobileDatePicker
          title="從哪一天起算"
          value={d.start}
          quick={[
            { label: "今天", day: today },
            { label: "明天", day: addDays(today, 1) },
            { label: "下個月 1 號", day: firstOfNextMonth(today) },
          ]}
          onPick={(day) => {
            setDraft({ start: day, until: d.until !== null && d.until < day ? null : d.until });
            setSheet(null);
          }}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === "until" && (
        <MobileDatePicker
          title="記到哪一天為止"
          value={d.until}
          min={d.start}
          quick={[
            { label: "今年底", day: `${today.slice(0, 4)}-12-31` },
            { label: "一年後", day: addDays(d.start, 365) },
          ].filter((q) => q.day >= d.start)}
          onPick={(day) => {
            setDraft({ until: day });
            setSheet(null);
          }}
          onClose={() => setSheet(null)}
        />
      )}
    </div>,
    document.body,
  );
}

function firstOfNextMonth(day: string): string {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}
