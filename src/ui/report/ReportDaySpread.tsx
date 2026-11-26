/**
 * ReportDaySpread——運行報告「一日運行專頁（手帳跨頁 Daily Spread）」（v1.33 第三梯亮點一）。
 *
 * 取代舊版擠在表格夾縫裡的單日手風琴：
 *   - 頁首翻日導航列：左側 `← 返回運行報告`（桌機；手機頂欄由 MFullPage 承接）；
 *     右側 `‹ 前一天 ｜ [2026年11月18日（週三）]（點開標準 DatePicker／MobileDatePicker，非今天旁附「今天」） ｜ 後一天 ›`。
 *   - 桌機採用 Hobonichi / Jibun 左右雙頁手帳跨頁（左頁客觀足跡、中間細緻書脊裝訂虛線、右頁主觀日記全文與車窓の問い）；
 *     手機為清爽單欄滿版子頁（接入 `useBackLayer` 返回棧）。
 *   - 頁內鍵盤流（桌機非打字且無浮層開啟時）：`Escape` 返回總表、`ArrowLeft` 前一天、`ArrowRight` 後一天（至 `today` 停住）。
 *   - 隱私同步：售票口開啟金額遮罩或帳本鎖定時（`isTicketAmountMasked`），所有金額一律同步顯示 `****`。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NodeRow } from "../../domain";
import { fmtMonthDay } from "../../domain/notes";
import {
  formatReportMoney,
  formatReportSpreadDate,
  type ReportDaySpreadData,
  type ReportRouteRef,
} from "../../domain/report";
import { UNCAT_NAME } from "../../domain/ticket";
import { fmtDur } from "../../domain/timetable";
import { addDays } from "../../lib/date";
import { runAtomicNav } from "../../store/navHistoryStore";
import { useAttachmentStore } from "../../store/attachmentStore";
import { useNotesStore } from "../../store/notesStore";
import { useReportStore } from "../../store/reportStore";
import { useTagStore } from "../../store/tagStore";
import { isTicketAmountMasked, useTicketStore } from "../../store/ticketStore";
import { useUiStore } from "../../store/uiStore";
import { DatePicker, type DateQuick } from "../common/DatePicker";
import { MobileDatePicker } from "../common/MobileDatePicker";
import { EntityTagPills, TagPills } from "../common/TagPills";
import { IconCamera } from "../common/attachments/AttachmentCountBadge";
import { PhotoLightbox, type LightboxPhotoItem } from "../common/attachments/PhotoLightbox";
import { IconBack, IconChevron, IconEdit } from "../common/icons";
import { MOODS, type MoodOption } from "../complete/moods";
import { useBackLayer } from "../mobile/backStack";
import { MdBody } from "../notes/md/MdBody";
import { MobileMdBody } from "../notes/mobile/MobileMdBody";
import "../notes/notes-mobile.css";
import { useDiaryPickMarks } from "../notes/useDiaryPickMarks";
import { GNAV_ICONS } from "../sidebar/gnavIcons";
import { DateSeal, SealDone } from "../stamps";
import { RouteBadge } from "./ReportParts";
import {
  goDiaryDay,
  goIdealTecho,
  goNode,
  goTicketDay,
  goTicketEntry,
  goTimetableBlock,
  goTimetableDay,
  isLineOpen,
  type ReportShellKind,
} from "./reportJumps";

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return target.isContentEditable || target.closest('[contenteditable="true"]') !== null;
}

function hasOpenOverlayDom(): boolean {
  if (typeof document === "undefined") return false;
  return (
    document.querySelector(
      ".ns-popmenu, .ns-ctx-menu, .ns-qa-pop, .ns-defer-pop, .defer-pop, .ns-dp-pop, .ns-datepick, [role='dialog']",
    ) !== null
  );
}

function WindowArchIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3.5 13.5V6.2a4.5 4.5 0 0 1 9 0v7.3Z" />
      <path d="M3.5 9.5h9" />
    </svg>
  );
}

function StampMarkIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6" strokeDasharray="2 1.5" />
      <circle cx="8" cy="8" r="3.2" />
    </svg>
  );
}

function LocationPinIcon({ size = 11 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 1.5C5.5 1.5 3.5 3.4 3.5 5.9C3.5 9.1 8 14.2 8 14.2C8 14.2 12.5 9.1 12.5 5.9C12.5 3.4 10.5 1.5 8 1.5Z" />
      <circle cx="8" cy="5.9" r="1.5" />
    </svg>
  );
}

function moodOptionOf(value: "green" | "yellow" | "red" | null | undefined): MoodOption | null {
  if (!value) return null;
  return MOODS.find((o) => o.value === value) ?? null;
}

export interface ReportDaySpreadProps {
  day: string;
  today: string;
  shell: ReportShellKind;
  spread: ReportDaySpreadData | null;
  loading: boolean;
  routesById: Readonly<Record<string, NodeRow>>;
  onClose(): void;
}

export function ReportDaySpread({
  day,
  today,
  shell,
  spread,
  loading,
  routesById,
  onClose,
}: ReportDaySpreadProps) {
  const stepFocusedDay = useReportStore((s) => s.stepFocusedDay);
  const setFocusedDay = useReportStore((s) => s.setFocusedDay);
  const loadSingleDaySpread = useReportStore((s) => s.loadSingleDaySpread);
  const amountMasked = useTicketStore(isTicketAmountMasked);
  const attRevision = useAttachmentStore((s) => s.revision);
  const attRevRef = useRef(attRevision);

  const [datePickOpen, setDatePickOpen] = useState(false);
  const [photoIndex, setPhotoIndex] = useState<number | null>(null);
  const dateBtnRef = useRef<HTMLButtonElement | null>(null);
  const diaryPickMarks = useDiaryPickMarks();

  useBackLayer(
    "report.spread.date",
    shell === "mobile" && datePickOpen,
    () => setDatePickOpen(false),
    "dialog",
  );

  // 切換日期時確保日期浮層與燈箱收合
  useEffect(() => {
    setDatePickOpen(false);
    setPhotoIndex(null);
  }, [day]);

  // 附件同步或編輯變動時重拉當日跨頁（不影響初始載入）
  useEffect(() => {
    if (attRevRef.current === attRevision) return;
    attRevRef.current = attRevision;
    void loadSingleDaySpread(day, shell);
  }, [attRevision, day, shell, loadSingleDaySpread]);

  const quickDates = useMemo<readonly DateQuick[]>(
    () => [
      { label: "今天", day: today },
      { label: "昨天", day: addDays(today, -1) },
      { label: "前天", day: addDays(today, -2) },
    ],
    [today],
  );

  // 桌機頁內鍵盤流：Esc 返回總表、← 前一天、→ 後一天（至 today 停住）
  useEffect(() => {
    if (shell !== "desktop") return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229 || e.defaultPrevented) return;
      if (datePickOpen || photoIndex !== null) return;
      if (isEditableElement(e.target)) return;

      const ui = useUiStore.getState();
      if (
        ui.settingsOpen ||
        ui.quickJumpOpen ||
        ui.hotkeyGuideOpen ||
        ui.routeDialog !== null ||
        ui.confirm !== null ||
        ui.completeCardFor !== null
      ) {
        return;
      }
      const notes = useNotesStore.getState();
      if (notes.capture !== null || notes.preview !== null) return;
      if (hasOpenOverlayDom()) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;

      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        stepFocusedDay(-1, "desktop");
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (day < today) stepFocusedDay(1, "desktop");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [shell, day, today, datePickOpen, photoIndex, onClose, stepFocusedDay]);

  const activeSpread = spread?.day === day ? spread : null;
  const detail = activeSpread?.detail ?? null;
  const seals = detail?.seals ?? [];
  const time = detail?.time ?? null;
  const money = detail?.money ?? null;
  const dayNotes = activeSpread?.dayNotes ?? [];
  const workLogs = activeSpread?.workLogs ?? [];
  const moods = activeSpread?.moods ?? [];
  const diaries = activeSpread?.diaries ?? null;
  const reflections = activeSpread?.reflections ?? [];
  const photos = activeSpread?.photos ?? [];

  const lightboxItems = useMemo<LightboxPhotoItem[]>(
    () =>
      photos.map((p) => {
        const metaParts = [p.sourceLabel, p.timeLabel, p.location ? `@ ${p.location}` : null].filter(Boolean);
        return {
          id: p.attachmentId,
          photoData: p.photoData,
          caption: p.caption,
          width: p.width,
          height: p.height,
          byteSize: p.byteSize,
          sourceLabel: metaParts.join(" · "),
          jumpLabel: p.entityType === "ticket:entry" ? "前往這筆記帳 ›" : "前往這段時刻表 ›",
          onJump: () => {
            setPhotoIndex(null);
            if (p.entityType === "ticket:entry") {
              void goTicketEntry(day, p.entityId, shell);
            } else {
              void goTimetableBlock(day, p.entityId, shell);
            }
          },
        };
      }),
    [photos, day, shell],
  );

  const moodSummary = useMemo(() => {
    if (moods.length === 0) return [];
    return MOODS.map((opt) => ({
      opt,
      count: moods.filter((m) => m === opt.value).length,
    })).filter((x) => x.count > 0);
  }, [moods]);

  const notesOpen = isLineOpen("notes", shell);
  const timetableOpen = isLineOpen("timetable", shell);
  const ticketOpen = isLineOpen("ticket", shell);

  const isAtToday = day >= today;
  const sealDate = useMemo(() => {
    const [yy, mm, dd] = day.split("-").map(Number);
    return new Date(yy || 2026, (mm || 1) - 1, dd || 1);
  }, [day]);

  const resolveRoute = useCallback(
    (routeId: string | null | undefined): NodeRow | Pick<ReportRouteRef, "name" | "code" | "color"> | null => {
      if (!routeId) return null;
      return routesById[routeId] ?? activeSpread?.routes[routeId] ?? null;
    },
    [routesById, activeSpread],
  );

  const makeDesktopBackRef = useCallback(
    () => ({
      label: `${fmtMonthDay(day)}的運行報告`,
      restore: () => {
        void runAtomicNav(() => {
          useUiStore.getState().setPage("report");
          useReportStore.getState().setFocusedDay(day, "desktop");
        });
      },
    }),
    [day],
  );

  const handleMobileOpenTag = useCallback(
    (tagKey: string) => {
      void runAtomicNav(async () => {
        useUiStore.getState().setMobileTab("notes");
        await useTagStore.getState().openTagPage(tagKey, {
          label: `${fmtMonthDay(day)}的運行報告`,
          restore: () => {
            useUiStore.getState().setMobileTab("report");
            useReportStore.getState().setFocusedDay(day, "mobile");
          },
        });
      });
    },
    [day],
  );

  const pillOnPick = shell === "mobile" ? handleMobileOpenTag : undefined;

  const initialSkeleton = !activeSpread && loading;

  return (
    <div className="ns-rp-spread" data-shell-mode={shell} aria-label={`${formatReportSpreadDate(day)} 一日運行專頁`}>
      {/* 頁首翻日導航列 */}
      <nav className="ns-rp-spread-bar" aria-label="單日運行專頁導航">
        {shell === "desktop" && (
          <button type="button" className="ns-rp-spread-back" onClick={onClose}>
            <span className="arr" aria-hidden="true">
              ←
            </span>
            <span>返回運行報告</span>
          </button>
        )}

        <div className="ns-rp-spread-daynav">
          <button
            type="button"
            className="ns-rp-spread-step"
            onClick={() => stepFocusedDay(-1, shell)}
            aria-label="前一天"
            title={shell === "desktop" ? "前一天（←）" : "前一天"}
          >
            <IconBack size={11} />
            <span className="lbl">前一天</span>
          </button>

          <button
            ref={dateBtnRef}
            type="button"
            data-pop-toggle
            className={`ns-rp-spread-datebtn${datePickOpen ? " is-open" : ""}`}
            aria-expanded={datePickOpen}
            aria-haspopup="dialog"
            onClick={() => setDatePickOpen((v) => !v)}
            title="挑選歷史日期"
          >
            <span className="txt">{formatReportSpreadDate(day)}</span>
            {day === today && <span className="today-tag">今日</span>}
          </button>

          {day !== today && (
            <button
              type="button"
              className="ns-rp-spread-today"
              onClick={() => setFocusedDay(today, shell)}
            >
              今天
            </button>
          )}

          <button
            type="button"
            className="ns-rp-spread-step"
            disabled={isAtToday}
            onClick={() => stepFocusedDay(1, shell)}
            aria-label="後一天"
            title={
              isAtToday
                ? "已是今天"
                : shell === "desktop"
                  ? "後一天（→）"
                  : "後一天"
            }
          >
            <span className="lbl">後一天</span>
            <IconChevron size={11} />
          </button>
        </div>
      </nav>

      {shell === "desktop" && datePickOpen && (
        <DatePicker
          label="跳至哪一天的運行專頁"
          value={day}
          max={today}
          today={today}
          quick={quickDates}
          markValue
          anchor={dateBtnRef.current}
          {...(notesOpen ? diaryPickMarks : {})}
          onPick={(picked) => {
            setDatePickOpen(false);
            setFocusedDay(picked, "desktop");
          }}
          onClose={() => setDatePickOpen(false)}
        />
      )}

      {shell === "mobile" && datePickOpen && (
        <MobileDatePicker
          title="跳至哪一天的運行專頁"
          value={day}
          max={today}
          today={today}
          quick={quickDates}
          backId="report.spread.date"
          backKind="dialog"
          {...(notesOpen ? diaryPickMarks : {})}
          onPick={(picked) => {
            setDatePickOpen(false);
            setFocusedDay(picked, "mobile");
          }}
          onClose={() => setDatePickOpen(false)}
        />
      )}

      {/* 雙頁手帳本體（桌機左右雙頁跨頁 ／ 手機單欄展開） */}
      <div className="ns-rp-spread-book">
        {/* ═══ 左頁：客觀足跡 · 當日運行實績 ═══ */}
        <article className="ns-rp-spread-page ns-rp-spread-left" aria-label="客觀足跡 · 當日運行實績">
          <header className="ns-rp-spread-phead">
            <div className="ns-rp-spread-ptitle">
              <DateSeal date={sealDate} size={36} title={`日付印 ${day}`} />
              <div className="ns-rp-spread-pmeta">
                <span className="eyebrow">DAILY OPERATION LOG</span>
                <h2 className="h">客觀足跡 · 當日運行實績</h2>
              </div>
            </div>
          </header>

          {/* 當日小結條 ＋ 記事章 */}
          <div className="ns-rp-spread-summary" aria-label="當日運行小結">
            <div className="ns-rp-spread-metrics">
              <span className="m-item">
                <span className="k">済</span>
                <b className="v">{initialSkeleton ? "—" : seals.length}</b>
                <span className="u">張</span>
                {!initialSkeleton && seals.length > 0 && <SealDone small className="ns-rp-spread-seal" />}
              </span>

              {timetableOpen && (
                <>
                  <span className="sep" aria-hidden="true">
                    ·
                  </span>
                  <span className="m-item">
                    <span className="k">記錄</span>
                    <b className="v">{initialSkeleton || !time ? "—" : fmtDur(time.totalMs)}</b>
                  </span>
                </>
              )}

              {ticketOpen && (
                <>
                  <span className="sep" aria-hidden="true">
                    ·
                  </span>
                  <span className="m-item">
                    <span className="k">當日支出</span>
                    <b className="v is-amt">
                      {initialSkeleton || !money
                        ? "—"
                        : formatReportMoney(money.totalSpent, money.decimals, amountMasked)}
                    </b>
                  </span>
                </>
              )}
            </div>

            {dayNotes.length > 0 && (
              <div className="ns-rp-spread-stamps" aria-label="當日記事章">
                {dayNotes.map((note, idx) => (
                  <span key={`${note}-${idx}`} className="ns-rp-spread-stamp">
                    <StampMarkIcon size={12} />
                    <span>{note}</span>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* ① 當日蓋済車票 */}
          <section className="ns-rp-spread-sec" aria-label="當日蓋済車票">
            <header className="ns-rp-spread-shd">
              <span className="t">
                {GNAV_ICONS.today(14)}
                <span>當日蓋済車票</span>
              </span>
              <span className="sum">
                <b>{seals.length}</b> 張
              </span>
            </header>

            {initialSkeleton ? (
              <p className="ns-rp-spread-loading">讀取當日車票紀錄…</p>
            ) : seals.length === 0 ? (
              <p className="ns-rp-spread-empty">這天沒有蓋済車票</p>
            ) : (
              <ul className="ns-rp-spread-tickets">
                {seals.map((s) => {
                  const route = resolveRoute(s.routeId);
                  const moodOpt = moodOptionOf(s.mood);
                  return (
                    <li key={`${s.id}-${s.at}`}>
                      <div
                        role="button"
                        tabIndex={0}
                        className="ns-rp-spread-ticket"
                        onClick={() => void goNode(s.nodeId, shell)}
                        onKeyDown={(ev) => {
                          if (ev.key === "Enter" || ev.key === " ") {
                            ev.preventDefault();
                            void goNode(s.nodeId, shell);
                          }
                        }}
                      >
                        <RouteBadge route={route} temp={!route} />
                        <div className="tkt-main">
                          <span className="nm">{s.name}</span>
                          {s.tagKeys.length > 0 && (
                            <TagPills keys={s.tagKeys} compact max={2} onPick={pillOnPick} className="tkt-tags" />
                          )}
                        </div>
                        {moodOpt && (
                          <span
                            className={`ns-rp-mood-badge is-${moodOpt.value}`}
                            style={{ color: moodOpt.color }}
                            title={`心情：${moodOpt.label}`}
                            aria-label={`心情：${moodOpt.label}`}
                          >
                            {moodOpt.glyph}
                          </span>
                        )}
                        {s.dueOn && <span className="tag-occ">定期</span>}
                        <span className="clk">{s.clock}</span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            {/* 當日心情三燈彙總（由原日記當天足跡無損交接；MOODS：順暢／平穩／吃力） */}
            {moods.length > 0 && (
              <div className="ns-rp-spread-moodbar" aria-label="當日心情三燈">
                <span className="moodbar-lbl">心情</span>
                <div className="moodbar-dots">
                  {moods.map((m, idx) => {
                    const opt = moodOptionOf(m);
                    if (!opt) return null;
                    return (
                      <span
                        key={`${m}-${idx}`}
                        className={`ns-rp-mood-badge is-${opt.value}`}
                        style={{ color: opt.color }}
                        title={opt.label}
                        aria-label={opt.label}
                      >
                        {opt.glyph}
                      </span>
                    );
                  })}
                </div>
                <span className="moodbar-sum">
                  {moodSummary.map((x, idx) => (
                    <span key={x.opt.value} className="moodbar-stat">
                      {idx > 0 && <span className="sep">·</span>}
                      <span>{x.opt.label}</span>
                      <b>{x.count}</b>
                    </span>
                  ))}
                </span>
              </div>
            )}
          </section>

          {/* ①′ 當日乘務記錄（手寫體正文，由原日記當天足跡無損交接） */}
          {workLogs.length > 0 && (
            <section className="ns-rp-spread-sec" aria-label="乘務記錄">
              <header className="ns-rp-spread-shd">
                <span className="t">
                  <IconEdit size={14} />
                  <span>乘務記錄</span>
                </span>
                <span className="sum">
                  <b>{workLogs.length}</b> 則
                </span>
              </header>

              <ul className="ns-rp-spread-worklogs">
                {workLogs.map((l) => (
                  <li key={l.id} className="ns-rp-spread-wlog">
                    <span className="wlog-clk">{l.clock}</span>
                    <div className="wlog-main">
                      <p className="wlog-hw">{l.body}</p>
                      {l.nodeMissing ? (
                        <span className="wlog-of is-gone">{l.nodeName}</span>
                      ) : (
                        <button
                          type="button"
                          className="wlog-of is-link"
                          onClick={() => void goNode(l.nodeId, shell)}
                        >
                          {l.nodeName}
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* ② 當日時間投入 */}
          {timetableOpen && (
            <section className="ns-rp-spread-sec" aria-label="當日時間投入">
              <header className="ns-rp-spread-shd">
                <span className="t">
                  {GNAV_ICONS.timetable(14)}
                  <span>當日時間投入</span>
                </span>
                {time && (
                  <span className="sum">
                    <b>{fmtDur(time.totalMs)}</b>
                  </span>
                )}
                <button
                  type="button"
                  className="ns-rp-spread-go"
                  onClick={() => void goTimetableDay(day, shell)}
                >
                  前往當日時刻表 ›
                </button>
              </header>

              {initialSkeleton || !time ? (
                <p className="ns-rp-spread-loading">讀取時間塊台帳…</p>
              ) : (
                <>
                  {time.cats.length > 0 && (
                    <div className="ns-rp-dtime-cats">
                      <div className="ns-rp-stack" role="img" aria-label="當日主分類時間占比">
                        {time.cats.map((x, i) => (
                          <i
                            key={x.id}
                            className={`s${i + 1}`}
                            style={{ flexGrow: x.ms }}
                            title={`${x.name} ${fmtDur(x.ms)}`}
                          />
                        ))}
                      </div>
                      <ul className="ns-rp-lg">
                        {time.cats.map((x, i) => (
                          <li key={x.id}>
                            <i className={`s${i + 1}`} aria-hidden="true" />
                            <span className="nm">{x.name}</span>
                            <span className="num">{fmtDur(x.ms)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {time.blocks.length === 0 ? (
                    <p className="ns-rp-spread-empty">這天沒有已記錄的時間塊</p>
                  ) : (
                    <ul className="ns-rp-spread-ledger">
                      {time.blocks.map((b) => {
                        const route = resolveRoute(b.routeId);
                        const subText = [b.taskName, b.note].filter(Boolean).join(" · ");
                        return (
                          <li key={`${b.id}-${b.startClock}`} className="ns-rp-spread-block">
                            <span className="span-clk">
                              {b.startClock}–{b.running || !b.endClock ? "運行中" : b.endClock}
                            </span>
                            <div className="blk-main">
                              <div className="blk-head">
                                <span className="cat-nm">{b.categoryName}</span>
                                {b.location && (
                                  <span className="ns-rp-spread-loc" title={b.location}>
                                    <LocationPinIcon size={11} />
                                    <span>{b.location}</span>
                                  </span>
                                )}
                                {route && <RouteBadge route={route} />}
                                <EntityTagPills
                                  entityType="timetable:block"
                                  entityId={b.id}
                                  compact
                                  max={2}
                                  onPick={pillOnPick}
                                />
                              </div>
                              {subText && <p className="blk-sub">{subText}</p>}
                            </div>
                            <span className="dur">{fmtDur(b.durMs)}</span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </>
              )}
            </section>
          )}

          {/* ③ 當日收支明細 */}
          {ticketOpen && (
            <section className="ns-rp-spread-sec" aria-label="當日收支明細">
              <header className="ns-rp-spread-shd">
                <span className="t">
                  {GNAV_ICONS.ticket(14)}
                  <span>當日收支明細</span>
                </span>
                {money && (
                  <span className="sum">
                    <b className="is-amt">{formatReportMoney(money.totalSpent, money.decimals, amountMasked)}</b>
                  </span>
                )}
                <button
                  type="button"
                  className="ns-rp-spread-go"
                  onClick={() => void goTicketDay(day, shell)}
                >
                  前往當日售票口 ›
                </button>
              </header>

              {initialSkeleton || !money ? (
                <p className="ns-rp-spread-loading">讀取當日帳目…</p>
              ) : money.entries.length === 0 ? (
                <p className="ns-rp-spread-empty">這天沒有支出紀錄</p>
              ) : (
                <ul className="ns-rp-spread-ledger">
                  {money.entries.map((e) => {
                    const route = resolveRoute(e.routeId);
                    const itemText = e.item?.trim() ?? "";
                    const noteText = e.note.trim();
                    const subText = [itemText && e.category !== UNCAT_NAME ? e.category : null, noteText]
                      .filter(Boolean)
                      .join(" · ");
                    return (
                      <li key={e.id} className="ns-rp-spread-expense">
                        <div className="exp-main">
                          <div className="exp-head">
                            <span className="cat-nm">{itemText || e.category}</span>
                            {route && <RouteBadge route={route} />}
                            {e.tagKeys && e.tagKeys.length > 0 && (
                              <TagPills keys={e.tagKeys} compact max={2} onPick={pillOnPick} />
                            )}
                            {e.clock && <span className="exp-clk">{e.clock}</span>}
                          </div>
                          {subText && <p className="exp-note">{subText}</p>}
                        </div>
                        <span className="amt">
                          {formatReportMoney(e.minor, money.decimals, amountMasked)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          )}

          {/* ④ 當日生活掠影（售票口票根＋時刻表活動相片；僅有相片時才渲染，無相片零佔位） */}
          {photos.length > 0 && (
            <section className="ns-rp-spread-sec ns-rp-spread-photos" aria-label="當日生活掠影">
              <header className="ns-rp-spread-shd">
                <span className="t">
                  <IconCamera size={14} />
                  <span>當日生活掠影</span>
                </span>
                <span className="sum">
                  <b>{photos.length}</b> 張
                </span>
              </header>

              <div className="ns-rp-photo-strip">
                {photos.map((p, idx) => (
                  <button
                    key={p.attachmentId}
                    type="button"
                    className="ns-rp-photo-card"
                    onClick={() => setPhotoIndex(idx)}
                    title={p.caption || p.sourceLabel}
                  >
                    <span className="ns-rp-photo-thumb">
                      <img src={p.photoData} alt={p.caption || p.sourceLabel} loading="lazy" />
                      <span className="ns-rp-photo-kind">
                        {p.entityType === "ticket:entry" ? "票根" : "時刻表"}
                      </span>
                    </span>
                    <span className="ns-rp-photo-meta">
                      <span className="src">{p.sourceLabel.replace(/^(售票口|時刻表)\s*·\s*/, "")}</span>
                      {p.location ? (
                        <span className="sub">@{p.location}</span>
                      ) : p.caption ? (
                        <span className="sub">{p.caption}</span>
                      ) : p.timeLabel ? (
                        <span className="sub is-num">{p.timeLabel}</span>
                      ) : null}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}
        </article>

        {/* ═══ 右頁：主觀手札 · 當日日記全文 ＆ 車窓の問い ═══ */}
        <article className="ns-rp-spread-page ns-rp-spread-right" aria-label="主觀手札 · 當日日記與車窓の問い">
          <header className="ns-rp-spread-phead">
            <div className="ns-rp-spread-ptitle">
              <div className="ns-rp-spread-pmeta">
                <span className="eyebrow">PASSENGER JOURNAL &amp; WINDOW</span>
                <h2 className="h">主觀手札 · 當日日記 ＆ 車窓の問い</h2>
              </div>
            </div>
          </header>

          {/* ① 當日日記全文 */}
          {notesOpen && (
            <section className="ns-rp-spread-sec ns-rp-spread-diary" aria-label="當日日記全文">
              <header className="ns-rp-spread-shd">
                <span className="t">
                  {GNAV_ICONS.notes(14)}
                  <span>當日日記</span>
                </span>
                {diaries && diaries.length > 0 && (
                  <button
                    type="button"
                    className="ns-rp-spread-go"
                    onClick={() =>
                      void goDiaryDay(day, shell, {
                        editEntryId: diaries[diaries.length - 1]!.id,
                      })
                    }
                  >
                    編輯當日日記 ›
                  </button>
                )}
              </header>

              {diaries === null ? (
                <p className="ns-rp-spread-loading">展讀當日手札…</p>
              ) : diaries.length === 0 ? (
                <div className="ns-rp-spread-diary-blank">
                  <p className="blank-lead">這頁手札還留著空白。</p>
                  <p className="blank-sub">把今天的風景、心情或旅途片段記下來，日後翻閱時會成為溫柔的座標。</p>
                  <button
                    type="button"
                    className="ns-rp-spread-writebtn"
                    onClick={() => void goDiaryDay(day, shell, { openDraft: true })}
                  >
                    寫下這天的日記 ›
                  </button>
                </div>
              ) : (
                <div className="ns-rp-spread-diary-entries">
                  {diaries.map((entry, idx) => (
                    <div
                      key={entry.id}
                      className={`ns-rp-spread-entry${idx > 0 ? " is-next" : ""}`}
                    >
                      <div className="entry-meta">
                        <span className="dia-dot" aria-hidden="true" />
                        <span className="written">
                          {entry.clock ? `寫於 ${entry.clock}` : "當日手札"}
                          {entry.isBackfilled ? "（補記）" : ""}
                        </span>
                        <EntityTagPills
                          entityType="note"
                          entityId={entry.id}
                          compact
                          max={2}
                          onPick={pillOnPick}
                        />
                        {diaries.length > 1 && (
                          <button
                            type="button"
                            className="entry-edit"
                            onClick={() => void goDiaryDay(day, shell, { editEntryId: entry.id })}
                          >
                            編輯此篇 ›
                          </button>
                        )}
                      </div>

                      {entry.title && <h3 className="entry-title">{entry.title}</h3>}

                      {shell === "desktop" ? (
                        <div className="ns-notes-read ns-notes-md ns-rp-spread-md">
                          <MdBody
                            body={entry.body}
                            backRef={makeDesktopBackRef}
                            empty="（此篇尚無內文）"
                          />
                        </div>
                      ) : (
                        <div className="ns-notes-mread ns-rp-spread-md">
                          <MobileMdBody
                            body={entry.body}
                            placeholder="（此篇尚無內文）"
                            onOpenTag={handleMobileOpenTag}
                          />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* ② 當日「車窓の問い」問答手札（有回答時溫柔呈現；無則不畫冗餘空框） */}
          {reflections.length > 0 && (
            <section className="ns-rp-spread-sec ns-rp-spread-window" aria-label="車窓の問い">
              <header className="ns-rp-spread-shd">
                <span className="t">
                  <WindowArchIcon size={14} />
                  <span>車窓の問い</span>
                </span>
                <button
                  type="button"
                  className="ns-rp-spread-go"
                  onClick={() => void goIdealTecho(shell)}
                >
                  前往理想手札 ›
                </button>
              </header>

              <div className="ns-rp-spread-reflections">
                {reflections.map((ref) => (
                  <div key={ref.id} className="ns-rp-spread-refl">
                    <span className="refl-cat">{ref.categoryLabel}</span>
                    <p className="refl-q">{ref.question}</p>
                    <p className="refl-a">{ref.answer}</p>
                  </div>
                ))}
              </div>
            </section>
          )}
        </article>
      </div>

      {photoIndex !== null && lightboxItems.length > 0 && (
        <PhotoLightbox
          items={lightboxItems}
          index={photoIndex}
          onIndexChange={setPhotoIndex}
          onClose={() => setPhotoIndex(null)}
          backId="report.spread.photo"
        />
      )}
    </div>
  );
}
