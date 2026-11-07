/**
 * realizeFields——實現小表單的欄位（壬 D-主-515、D-主-520；兩殼共用一份草稿 `useRealizeDraft`，欄位長相分殼）。
 *   開票：票名・放哪（收件匣／一條路線）・日期（可空）
 *   開路線：路線名・幹線（一條都沒有＝一句話、按鈕停用）
 *   寫日記：內文（預填願望名）・日期（預設今天、不能未來）
 *   記時間：備註（預填願望名）・日期（預設今天、不能未來）・分類（時刻表子分類，必選）・開始／結束（不能超過現在）
 * 桌機：`.ns-tk-fields` 欄位骨架＋底線下拉；手機：`.ns-wr-mf` 列＋chip 橫捲（分類多，手機也用下拉）。
 * Enter（名稱欄，IME 組字中不算）＝送出；內文是多行，Enter 換行。
 */
import type { CompositionEvent, KeyboardEvent, ReactNode } from "react";
import { DateChip } from "../common/DateChip";
import { ClockInput } from "../common/ClockInput";
import { BLOCKED_TEXT, REALIZE_TEXT, type RealizeDraft } from "./waitroomParts";

type Ime = {
  onKeyDown(e: KeyboardEvent<HTMLElement>): void;
  onCompositionStart(e: CompositionEvent<HTMLElement>): void;
  onCompositionEnd(e: CompositionEvent<HTMLElement>): void;
};

export function RealizeFields({ d, shell, ime }: { d: RealizeDraft; shell: "desktop" | "mobile"; ime: Ime }) {
  const t = REALIZE_TEXT[d.action];
  const m = shell === "mobile";
  const field = ({ label, children, top }: { label: string; children: ReactNode; top?: boolean }) =>
    m ? (
      <div className={"ns-wr-mf" + (top ? " top" : "")}>
        <span className="lbl">{label}</span>
        {children}
      </div>
    ) : (
      <div className={"field" + (top ? " top" : "")}>
        <span className="lbl">{label}</span>
        <div>{children}</div>
      </div>
    );

  const textField =
    d.action === "diary" ? (
      <textarea
        className={m ? "ns-wr-min is-area" : "ns-tk-textin"}
        aria-label={t.field}
        rows={m ? 3 : 2}
        value={d.name}
        onChange={(e) => d.setName(e.target.value)}
      />
    ) : (
      <input
        className={m ? "ns-wr-min" : "ns-tk-textin"}
        aria-label={t.field}
        autoComplete="off"
        enterKeyHint="done"
        value={d.name}
        onChange={(e) => d.setName(e.target.value)}
        {...ime}
      />
    );

  const chips = (label: string, items: { id: string | null; name: string }[], value: string | null, pick: (id: string | null) => void) => (
    <div className="ns-wr-mchips" role="group" aria-label={label}>
      {items.map((it) => (
        <button
          key={it.id ?? "none"}
          type="button"
          className={"chip ns-chip" + (value === it.id ? " is-on" : "")}
          aria-pressed={value === it.id}
          onClick={() => pick(it.id)}
        >
          {it.name}
        </button>
      ))}
    </div>
  );
  const select = (label: string, value: string, onChange: (v: string) => void, children: ReactNode) => (
    <span className="ns-select-wrap">
      <select className="techo-input" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        {children}
      </select>
    </span>
  );
  const clock = (label: string, value: number, onChange: (ms: number) => void, last = false) => (
    <ClockInput
      key={`${label}-${d.day}`}
      variant={m ? "mobile" : "compact"}
      quick={m ? [] : undefined}
      label={label}
      value={value}
      lo={d.lo}
      hi={d.hi}
      refDay={d.day ?? undefined}
      dateLabel="other"
      onChange={onChange}
      onEnter={last ? () => void d.submit() : undefined}
    />
  );
  const pastDay = (
    <DateChip date={d.day} onPick={(v) => v && d.setDay(v)} quick="backward" allowPast max={d.today} />
  );

  return (
    <>
      {field({ label: t.field, top: d.action === "diary", children: textField })}
      {d.action === "ticket" && (
        <>
          {field({
            label: "放哪",
            children: m
              ? chips("放哪", [{ id: null, name: "收件匣" }, ...d.liveRoutes.map((r) => ({ id: r.id, name: r.name }))], d.routeId, d.setRouteId)
              : select("放哪", d.routeId ?? "", (v) => d.setRouteId(v || null), (
                  <>
                    <option value="">收件匣</option>
                    {d.liveRoutes.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </>
                )),
          })}
          {field({ label: "日期", children: <DateChip date={d.day} onPick={d.setDay} quick="forward" clearable /> })}
        </>
      )}
      {d.action === "route" &&
        field({
          label: "幹線",
          children:
            d.blocked === "noLine" ? (
              <span className="ns-wr-hint">{BLOCKED_TEXT.noLine}</span>
            ) : m ? (
              chips("幹線", d.liveLines.map((l) => ({ id: l.id, name: l.name })), d.lineId, (id) => id && d.setLineId(id))
            ) : (
              select("幹線", d.lineId ?? "", d.setLineId, d.liveLines.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              )))
            ),
        })}
      {d.action === "diary" && field({ label: "日期", children: pastDay })}
      {d.action === "time" && (
        <>
          {field({ label: "日期", children: pastDay })}
          {field({
            label: "分類",
            children:
              d.blocked === "noCat" ? (
                <span className="ns-wr-hint">{BLOCKED_TEXT.noCat}</span>
              ) : (
                select("分類", d.catId ?? "", d.setCatId, d.timeCats.groups.map((g) => (
                  <optgroup key={g.group.id} label={g.group.name}>
                    {g.items.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </optgroup>
                )))
              ),
          })}
          {d.day &&
            (m ? (
              <>
                {/* 手機：開始、結束各一列（兩顆框並排放不下；常用時刻 chip 不給，起訖靠錶盤） */}
                {field({ label: "開始", children: clock("開始", d.span.start, d.setStart) })}
                {field({ label: "結束", children: clock("結束", d.span.end, d.setEnd, true) })}
              </>
            ) : (
              field({
                label: "起訖",
                children: (
                  <span className="ns-wr-span" key={d.day}>
                    {clock("開始", d.span.start, d.setStart)}
                    <span className="sep" aria-hidden>
                      –
                    </span>
                    {clock("結束", d.span.end, d.setEnd, true)}
                  </span>
                ),
              })
            ))}
          {d.blocked === "badSpan" && <p className="ns-wr-hint is-err">{BLOCKED_TEXT.badSpan}</p>}
        </>
      )}
    </>
  );
}
