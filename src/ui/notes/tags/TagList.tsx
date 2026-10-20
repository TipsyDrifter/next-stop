/**
 * TagList——荷札頁的分組清單（桌機；旅客筆記車次③契約 0-20、§5.2；原型 app.js listHtml／itemRow、styles.css:429-463）。
 *
 *   `section.ns-notes-taggroup` ×（空段不畫）：h4「車票・列車車廂 N」「筆記 N」「日記 N」（別線「別處 N」）
 *     車票列 `li.ns-notes-tagitem.node`：路線色點＋名稱＋（列車／車廂小標）＋ 看父層時 `span.ns-notes-rel`（它實際掛的子荷札）＋ 執行日
 *       已完成＝`.done` 淡化＋小済，收在 `details.ns-notes-donefold`「已完成 N」（預設收合）
 *     筆記列 `.note`：標題＋摘要（荷札字 `.ns-notes-mark`）；日記列 `.diary`：「10/5（日）」大字＋摘要
 *   空 ⇒ `p.ns-notes-tagempty`「還沒有東西掛著這個荷札」
 * 資料：`tagRepo.listUnder(key)`（index 一變就重查——掛、摘、改名、同步進來都會換 index）；分組排序＝`groupTaggedItems`。
 * 鍵盤：NotesView 的 ↑↓／Enter 經 `apiRef` 在列間移選取（`.is-sel`）、開選中列；滑鼠點列＝開。
 */
import { Fragment, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { tagRepo } from "../../../data/tagRepo";
import type { TaggedItem } from "../../../data/tagRepository";
import { fmtShortDay, noteTitle, weekdayZh } from "../../../domain/notes";
import { groupTaggedItems, snippetAround, type GroupedTaggedItem } from "../../../domain/tags";
import { useNodeStore } from "../../../store/nodeStore";
import { useTagStore } from "../../../store/tagStore";
import { useUiStore } from "../../../store/uiStore";
import { IconCaret, RouteDot, dayOf } from "../notesBits";
import { TagName } from "./TagChip";
import { goDiary, goNode, goNote } from "./jump";
import { useOtherSections } from "./otherEntities";

const NO_ITEMS: readonly GroupedTaggedItem[] = [];

export interface TagListApi {
  move(delta: 1 | -1): void;
  open(): void;
}

const KIND_LABEL: Record<string, string> = { train: "列車", car: "車廂" };

function openItem(it: GroupedTaggedItem): void {
  if (it.kind === "node") void goNode(it.id);
  else if (it.kind === "note") {
    if (it.note.kind === "diary" && it.note.entry_date) void goDiary(it.id, it.note.entry_date);
    else void goNote(it.id);
  }
}

function Snippet({ body, keys }: { body: string; keys: readonly string[] }) {
  const sn = snippetAround(body, keys, 16);
  return (
    <span className="sn">
      {sn.pre}
      {sn.tag && (
        <>
          {" "}
          <b className="ns-notes-mark">{sn.tag}</b>{" "}
        </>
      )}
      {sn.post}
    </span>
  );
}

function Rel({ rel }: { rel: string | null }) {
  if (!rel) return null;
  return (
    <span className="ns-notes-rel">
      {rel.split("、").map((r, i) => (
        <span key={i} className="ns-notes-reltag">
          <TagName name={r} />
        </span>
      ))}
    </span>
  );
}

export function TagList({ tagKey, apiRef }: { tagKey: string; apiRef: MutableRefObject<TagListApi | null> }) {
  const index = useTagStore((s) => s.index);
  const routes = useNodeStore((s) => s.routes);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  const [items, setItems] = useState<TaggedItem[] | null>(null);
  const [doneOpen, setDoneOpen] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  // 換荷札：清選取、收已完成
  useEffect(() => {
    setSel(null);
    setDoneOpen(false);
    setItems(null);
  }, [tagKey]);

  useEffect(() => {
    let alive = true;
    tagRepo
      .listUnder(tagKey)
      .then((rows) => alive && setItems(rows))
      .catch((e: unknown) => {
        console.warn("TagList：listUnder 失敗", e);
        if (alive) setItems([]);
      });
    return () => {
      alive = false;
    };
  }, [tagKey, index]);

  const hasKids = !!index?.byKey[tagKey]?.children.length;
  const groups = useMemo(
    () => (items ? groupTaggedItems(items, hasKids ? tagKey : null, (k) => useTagStore.getState().nameOf(k)) : null),
    [items, hasKids, tagKey],
  );
  // 別線實體依登記分段（時刻表⑥ 0-6；沒有任何線登記＝一段「別處」、順序同 groups.other）
  const otherSections = useOtherSections(groups?.other ?? NO_ITEMS, "desktop");

  /** 鍵盤能走到的列（已完成收著就不算） */
  const flat = useMemo(() => {
    if (!groups) return [] as GroupedTaggedItem[];
    return [
      ...groups.nodes.open,
      ...(doneOpen ? groups.nodes.done : []),
      ...groups.notes,
      ...groups.diaries,
      ...otherSections.flatMap((s) => s.rows.map((r) => r.it)),
    ];
  }, [groups, doneOpen, otherSections]);

  const rowId = (it: GroupedTaggedItem) => `${it.kind}:${it.id}`;
  /** 別線的列：有登記的 `open` 就叫它；node／note 照 openItem */
  const openRow = (it: GroupedTaggedItem) => {
    if (it.kind !== "other") return openItem(it);
    for (const s of otherSections) for (const r of s.rows) if (r.it === it) r.row?.open?.();
  };

  apiRef.current = {
    move(delta) {
      if (!flat.length) return;
      let i = flat.findIndex((it) => rowId(it) === sel);
      i = i < 0 ? (delta > 0 ? 0 : flat.length - 1) : Math.min(flat.length - 1, Math.max(0, i + delta));
      setSel(rowId(flat[i]));
    },
    open() {
      const it = flat.find((x) => rowId(x) === sel);
      if (it) openRow(it);
    },
  };

  useEffect(() => {
    if (!sel) return;
    boxRef.current?.querySelector<HTMLElement>(`[data-rid="${CSS.escape(sel)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!groups) return <div ref={boxRef} className="ns-notes-taglist" aria-busy="true" />;
  const total = groups.nodes.open.length + groups.nodes.done.length + groups.notes.length + groups.diaries.length + groups.other.length;
  if (!total)
    return (
      <div ref={boxRef} className="ns-notes-taglist">
        <p className="ns-notes-tagempty">還沒有東西掛著這個荷札</p>
      </div>
    );

  const row = (it: GroupedTaggedItem, extraCls: string, children: ReactNode) => (
    <li key={rowId(it)}>
      <button
        type="button"
        data-rid={rowId(it)}
        className={`ns-notes-tagitem ${extraCls}${sel === rowId(it) ? " is-sel" : ""}`}
        onClick={() => {
          setSel(rowId(it));
          openRow(it);
        }}
      >
        {children}
      </button>
    </li>
  );

  const nodeRow = (it: GroupedTaggedItem) => {
    if (it.kind !== "node") return null;
    const n = it.node;
    const route = n.route_id ? routes.find((r) => r.id === n.route_id) : null;
    const done = n.status === "done";
    return row(
      it,
      `node${done ? " done" : ""}`,
      <>
        <RouteDot route={route} />
        <span className="main">
          <span className="nm">{n.name}</span>
          {KIND_LABEL[n.kind] && <span className="kd">{KIND_LABEL[n.kind]}</span>}
          <Rel rel={it.rel} />
        </span>
        <span className="dt">{n.scheduled_on ? fmtShortDay(n.scheduled_on) : ""}</span>
        {done ? (
          <span className="ns-notes-sumi" aria-label="済">
            済
          </span>
        ) : (
          <span className="ns-notes-sumislot" />
        )}
      </>,
    );
  };

  const noteRow = (it: GroupedTaggedItem) => {
    if (it.kind !== "note") return null;
    const x = it.note;
    if (x.kind === "diary") {
      const d = x.entry_date ?? dayOf(x.noted_at, dayStartHour);
      return row(
        it,
        "diary",
        <>
          <span className="bd">
            <span className="dd">{fmtShortDay(d)}</span>
            <span className="wk">（{weekdayZh(d)}）</span>
          </span>
          <span className="main">
            <Rel rel={it.rel} />
            <Snippet body={x.body} keys={it.matched} />
          </span>
        </>,
      );
    }
    return row(
      it,
      "note",
      <>
        <span className="main">
          <span className="nm">{noteTitle(x)}</span>
          <Rel rel={it.rel} />
          <Snippet body={x.body} keys={it.matched} />
        </span>
        <span className="dt">{fmtShortDay(dayOf(x.noted_at, dayStartHour))}</span>
      </>,
    );
  };

  const section = (label: string, count: number, body: ReactNode) =>
    count ? (
      <section className="ns-notes-taggroup" aria-label={label}>
        <h4>
          {label}
          <span className="n">{count}</span>
          <span className="rule" />
        </h4>
        {body}
      </section>
    ) : null;

  return (
    <div ref={boxRef} className="ns-notes-taglist">
      {section(
        "車票・列車車廂",
        groups.nodes.open.length + groups.nodes.done.length,
        <>
          {groups.nodes.open.length > 0 && <ul className="ns-notes-tagrows">{groups.nodes.open.map(nodeRow)}</ul>}
          {groups.nodes.done.length > 0 && (
            <details className="ns-notes-donefold" open={doneOpen} onToggle={(e) => setDoneOpen(e.currentTarget.open)}>
              <summary>
                <IconCaret size={11} />
                已完成 <span className="n">{groups.nodes.done.length}</span>
              </summary>
              <ul className="ns-notes-tagrows">{groups.nodes.done.map(nodeRow)}</ul>
            </details>
          )}
        </>,
      )}
      {section("筆記", groups.notes.length, <ul className="ns-notes-tagrows">{groups.notes.map(noteRow)}</ul>)}
      {section("日記", groups.diaries.length, <ul className="ns-notes-tagrows">{groups.diaries.map(noteRow)}</ul>)}
      {otherSections.map((sec) => (
        <Fragment key={sec.title}>
          {section(
            sec.title,
            sec.rows.length,
            <ul className="ns-notes-tagrows">
              {sec.rows.map(({ it, row: r }) =>
                it.kind !== "other" ? null : r?.open ? (
                  row(
                    it,
                    "other",
                    <span className="main">
                      <span className="nm">{r.label}</span>
                      {r.sub && <span className="sn">{r.sub}</span>}
                    </span>,
                  )
                ) : (
                  <li key={rowId(it)}>
                    <span className="ns-notes-tagitem other" data-rid={rowId(it)}>
                      <span className="main">
                        <span className="nm">{r ? r.label : it.entityType}</span>
                        {r?.sub && <span className="sn">{r.sub}</span>}
                      </span>
                    </span>
                  </li>
                ),
              )}
            </ul>,
          )}
        </Fragment>
      ))}
    </div>
  );
}
