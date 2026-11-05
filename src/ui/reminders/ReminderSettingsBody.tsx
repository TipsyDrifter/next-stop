/**
 * ReminderSettingsBody——提醒頁的本體（⑨ 契約 §2；長相＝prototypes/提醒-設定與通知.html）。兩殼同一份：
 * 桌機設定〈提醒〉籤（settings/RemindersTab.tsx）、手機「更多 › 提醒」（mobile/MobileMore.tsx）。
 *
 * `shell` 只管排版（窄的桌機視窗也走手機殼）；文案與權限看真實平台 `onAndroid()`（同 NoticeSettings 的分法）。
 * 即選即存，沒有主鈕（視覺規範 §2.3）。資料：`reminderStore`；只有「跑太久」是時刻表自己的鍵（鍵不變，開關搬到這裡）。
 * 權限（只有 Android）：放在頁首下面。問過還是 denied＝系統不會再跳窗，改寫「到系統設定開啟」；回前景再查一次，設定改好就收掉。
 * 「可能會晚幾分鐘」跟在最吃準時的那一列底下（排了時刻；它關著就跟著跑太久；兩個都關＝不寫）。
 */
import { useEffect, useMemo, useState } from "react";
import {
  LATE_DAYS_OPTIONS,
  TIMED_BEFORE_OPTIONS,
  clockForDay,
  type ReminderRecent,
  type ReminderSettings,
} from "../../domain/reminders";
import { MIN, fmtClock } from "../../domain/timetable";
import { addDays, clockInstant, dayKeyOf, dayWindow, parseClockInput, todayKey } from "../../lib/date";
import { askNotificationPermissionOnce } from "../../lib/notify";
import { useReminderStore } from "../../store/reminderStore";
import { useTimetableStore } from "../../store/timetableStore";
import { useUiStore } from "../../store/uiStore";
import { ClockInput } from "../common/ClockInput";
import { Toggle } from "../common/Toggle";
import { noticePermission, type NoticePermission } from "../timetable/notice";
import { onAndroid } from "../timetable/ttNoticeBridge";
import { openReminderTarget } from "./openReminderTarget";
import { refreshReminders } from "./reminderRuntime";
import "./reminders.css";

type Shell = "desktop" | "mobile";
type BoolKey = { [K in keyof ReminderSettings]: ReminderSettings[K] extends boolean ? K : never }[keyof ReminderSettings];

/** 「更多」那一列右側的「N 項開著」（含時刻表自己那把跑太久） */
export function useReminderOnCount(): number {
  const s = useReminderStore((st) => st.settings);
  const longRun = useTimetableStore((st) => st.noticeLongRunEnabled);
  const keys: BoolKey[] = ["dueEve", "dueDay", "late", "timed", "review", "routine", "repeat", "sync", "backup"];
  return keys.filter((k) => s[k]).length + (longRun ? 1 : 0);
}

/** 存的值不在選項裡（舊版或手改）也要看得到，不偷偷跳成別的值（同 NoticeTab 的保險上限） */
function withCurrent(options: readonly number[], value: number): number[] {
  return options.includes(value) ? [...options] : [...options, value].sort((a, b) => a - b);
}

function Row({ title, when, children }: { title: React.ReactNode; when: string; children: React.ReactNode }) {
  return (
    <div className="ns-rm-row">
      <span className="ns-rm-row-tx">
        <span className="ns-rm-row-t">{title}</span>
        <small className="ns-rm-row-w">{when}</small>
      </span>
      {children}
    </div>
  );
}

function Group({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <section className="ns-rm-grp" aria-label={name}>
      <span className="techo-label ns-rm-grp-k" aria-hidden="true">
        {name}
      </span>
      <div className="ns-rm-rows">{children}</div>
    </section>
  );
}

/** 開關與設定一一對應的那種列 */
function Sw({ k, title, when }: { k: BoolKey; title: string; when: string }) {
  const on = useReminderStore((s) => s.settings[k]);
  const update = useReminderStore((s) => s.update);
  return (
    <Row title={title} when={when}>
      <Toggle on={on} onFlip={() => void update({ [k]: !on })} label={title} />
    </Row>
  );
}

/** 「早上」「晚上」：框裡打的是營業日表記，存之前照目前日界線正規化（01:00 在日界線 03:00 下存 25:00） */
function ClockField({ k, label }: { k: "morning" | "evening"; label: string }) {
  const value = useReminderStore((s) => s.settings[k]);
  const update = useReminderStore((s) => s.update);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  // 只拿來把時刻換成毫秒給 ClockInput；開著頁面跨日也不必換，固定第一次算到的那天
  const [day] = useState(() => todayKey(dayStartHour));
  const { lo, hi } = useMemo(() => {
    const w = dayWindow(day, dayStartHour);
    return { lo: Date.parse(w.start), hi: Date.parse(w.end) - MIN };
  }, [day, dayStartHour]);
  const ms = clockInstant(day, clockForDay(value, dayStartHour)) ?? lo;
  return (
    <span className="ns-rm-clock-item">
      <span className="ns-rm-clock-k">{label}</span>
      <ClockInput
        variant="compact"
        dateLabel={false}
        refDay={day}
        label={`${label}的提醒時刻`}
        value={ms}
        lo={lo}
        hi={hi}
        onChange={(next) => {
          const t = parseClockInput(fmtClock(next), dayStartHour);
          if (t !== null && t !== value) void update({ [k]: t });
        }}
      />
    </span>
  );
}

/** 列裡的下拉：開關關著就鎖住（§1.8：title 說為什麼） */
function NumSelect({
  label,
  value,
  options,
  disabled,
  format,
  onChange,
}: {
  label: string;
  value: number;
  options: readonly number[];
  disabled: boolean;
  format(n: number): string;
  onChange(n: number): void;
}) {
  return (
    <span className="ns-select-wrap ns-rm-numwrap">
      <select
        className="techo-input ns-rm-num"
        aria-label={label}
        value={String(value)}
        disabled={disabled}
        title={disabled ? "開關打開才能改" : undefined}
        onChange={(e) => onChange(Number(e.target.value))}
      >
        {withCurrent(options, value).map((n) => (
          <option key={n} value={String(n)}>
            {format(n)}
          </option>
        ))}
      </select>
    </span>
  );
}

/* ───────── 最近的提醒 ───────── */

function recentDay(at: number, dayStartHour: number): string {
  const key = dayKeyOf(new Date(at).toISOString(), dayStartHour);
  const today = todayKey(dayStartHour);
  if (key === today) return "今天";
  if (key === addDays(today, -1)) return "昨天";
  const [, m, d] = key.split("-").map(Number);
  return `${m}/${d}`;
}

/** 締切、誤點那幾個字上赭（其他一律墨）；只標開頭那個字樣，票名裡剛好也有的不管 */
function RecentTitle({ r }: { r: ReminderRecent }) {
  if (r.kind !== "due-eve" && r.kind !== "due-day" && r.kind !== "late") return <>{r.title}</>;
  const word = r.kind === "late" ? "誤點" : "締切";
  const at = r.title.indexOf(word);
  if (at < 0) return <>{r.title}</>;
  return (
    <>
      {r.title.slice(0, at)}
      <em>{word}</em>
      {r.title.slice(at + word.length)}
    </>
  );
}

function RecentList({ shell }: { shell: Shell }) {
  const recent = useReminderStore((s) => s.recent);
  const dayStartHour = useUiStore((s) => s.dayStartHour);
  return (
    <section className="ns-rm-recent" aria-label="最近的提醒">
      <span className="techo-label ns-rm-recent-k" aria-hidden="true">
        最近的提醒
      </span>
      {recent.length === 0 ? (
        <p className="ns-note ns-rm-empty">還沒有提醒。</p>
      ) : (
        <ul className="ns-rm-list">
          {recent.map((r, i) => (
            <li key={`${r.at}-${i}`}>
              <button type="button" className="ns-rm-item" onClick={() => void openReminderTarget(r.target, shell)}>
                <span className="ns-rm-item-w">
                  <span className="ns-rm-item-hm">{fmtClock(r.at)}</span>
                  <span className="ns-rm-item-d">{recentDay(r.at, dayStartHour)}</span>
                </span>
                <span className="ns-rm-item-tx">
                  <span className="ns-rm-item-t">
                    <RecentTitle r={r} />
                  </span>
                  <span className="ns-rm-item-b">{r.body}</span>
                </span>
                <span className="ns-rm-item-go" aria-hidden="true">
                  ›
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ───────── 權限（Android） ───────── */

function PermissionRow() {
  const [perm, setPerm] = useState<NoticePermission>("granted");
  const [refused, setRefused] = useState(false);

  useEffect(() => {
    let alive = true;
    const check = () => {
      void noticePermission().then((p) => {
        if (alive) setPerm(p);
      });
    };
    check();
    // 使用者可能從系統設定開好才回來
    document.addEventListener("visibilitychange", check);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", check);
    };
  }, []);

  if (perm === "granted") return null;
  return (
    <div className="ns-rm-hint">
      <span className="ns-rm-warn">需要允許通知</span>
      {refused ? (
        <span className="ns-note">到系統設定開啟</span>
      ) : (
        <button
          type="button"
          className="ns-btn btn-ghost ns-btn--sm"
          onClick={() => {
            void askNotificationPermissionOnce().then((r) => {
              if (r === "granted") {
                setPerm("granted");
                void refreshReminders({ force: true });
              } else if (r === "denied") {
                setRefused(true);
              }
            });
          }}
        >
          允許通知
        </button>
      )}
    </div>
  );
}

/* ───────── 本體 ───────── */

export function ReminderSettingsBody({ shell }: { shell: Shell }) {
  const android = onAndroid();
  const load = useReminderStore((s) => s.load);
  const settings = useReminderStore((s) => s.settings);
  const update = useReminderStore((s) => s.update);
  const exactAlarm = useReminderStore((s) => s.exactAlarm);
  const longRun = useTimetableStore((s) => s.noticeLongRunEnabled);
  const setLongRun = useTimetableStore((s) => s.setNoticeLongRunEnabled);

  useEffect(() => {
    void load();
  }, [load]);

  const lateHint = android && !exactAlarm ? <p className="ns-rm-warn ns-rm-sub">提醒可能會晚幾分鐘</p> : null;

  return (
    <div className="ns-rm">
      <p className="ns-note ns-rm-head">
        開關只記在這台{android ? "手機" : "電腦"}。
        {!android && (
          <>
            <br />
            App 要開著才收得到，縮到系統匣也算；開 App 時補當天漏掉的。
          </>
        )}
      </p>
      {android && <PermissionRow />}

      <div className="ns-rm-grp ns-rm-clock" role="group" aria-label="提醒時刻">
        <span className="techo-label ns-rm-grp-k" aria-hidden="true">
          提醒時刻
        </span>
        <div className="ns-rm-clock-items">
          <ClockField k="morning" label="早上" />
          <ClockField k="evening" label="晚上" />
        </div>
      </div>

      <Group name="車票">
        <Sw k="dueEve" title="締切前一天" when="前一天晚上" />
        <Sw k="dueDay" title="締切當天" when="當天早上" />
        <Row
          title={
            <>
              誤點滿
              <NumSelect
                label="誤點滿幾天提醒"
                value={settings.lateDays}
                options={LATE_DAYS_OPTIONS}
                disabled={!settings.late}
                format={String}
                onChange={(lateDays) => void update({ lateDays })}
              />
              天
            </>
          }
          when="早上，只響一次"
        >
          <Toggle on={settings.late} onFlip={() => void update({ late: !settings.late })} label="誤點提醒" />
        </Row>
        <Row
          title={
            <>
              排了時刻：
              <NumSelect
                label="排了時刻，什麼時候提醒"
                value={settings.timedBefore}
                options={TIMED_BEFORE_OPTIONS}
                disabled={!settings.timed}
                format={(n) => (n === 0 ? "開始時" : `開始前 ${n} 分鐘`)}
                onChange={(timedBefore) => void update({ timedBefore })}
              />
            </>
          }
          when="每一班都響"
        >
          <Toggle on={settings.timed} onFlip={() => void update({ timed: !settings.timed })} label="排了時刻的提醒" />
        </Row>
        {settings.timed && lateHint}
      </Group>

      <Group name="方針">
        <Sw k="review" title="週末回顧" when="這週最後一天晚上" />
      </Group>

      <Group name="時刻表">
        <Row title="跑太久" when="超過預計時間">
          <Toggle on={longRun} onFlip={() => void setLongRun(!longRun)} label="跑太久" />
        </Row>
        {!settings.timed && longRun && lateHint}
        <Sw k="routine" title="作息範本時段" when="每段開始時" />
      </Group>

      <Group name="售票口">
        <Sw k="repeat" title="定期帳當天" when="當天早上" />
      </Group>

      <Group name="系統">
        <Sw k="sync" title="同步出狀況" when="停住或連續失敗時" />
        <Sw k="backup" title="備份失敗" when="連續失敗時" />
      </Group>

      {android && <p className="ns-note ns-rm-tail">鎖定畫面的顯示內容，依手機通知設定而定。</p>}

      <RecentList shell={shell} />
    </div>
  );
}
